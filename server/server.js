const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const maxmind = require('maxmind');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registry-data.json');
const LEGACY_DOWNLOADS_FILE = path.join(__dirname, 'downloads.json');
const HEARTBEAT_STALE_MS = parseInt(process.env.HEARTBEAT_STALE_MS || '180000', 10);
const PROXY_VALIDATION_TIMEOUT_MS = parseInt(process.env.PROXY_VALIDATION_TIMEOUT_MS || '8000', 10);
const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || path.join(DATA_DIR, 'GeoLite2-City.mmdb');

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function createDefaultStore() {
  return {
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    proxies: {},
    downloads: {},
    proxyDownloadEvents: [],
    trafficSnapshots: []
  };
}

function createLegacyDownloads() {
  return { total: 0, details: [] };
}

ensureDir(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(createDefaultStore(), null, 2));
}
if (!fs.existsSync(LEGACY_DOWNLOADS_FILE)) {
  fs.writeFileSync(LEGACY_DOWNLOADS_FILE, JSON.stringify(createLegacyDownloads(), null, 2));
}

function readJson(filePath, fallbackFactory) {
  try {
    if (!fs.existsSync(filePath)) {
      const initial = fallbackFactory();
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
      return initial;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`[Data] Failed to read ${filePath}:`, error);
    return fallbackFactory();
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readStore() {
  const store = readJson(DATA_FILE, createDefaultStore);
  return pruneOfflineProxies(store);
}

function writeStore(store) {
  pruneOfflineProxies(store);
  store.meta.updatedAt = new Date().toISOString();
  writeJson(DATA_FILE, store);
}

function summarizeLocation(location = {}) {
  return {
    countryCode: location.countryCode || '',
    country: location.country || '',
    region: location.region || '',
    city: location.city || ''
  };
}

function hasLocation(location = {}) {
  return !!(location.countryCode || location.country || location.region || location.city);
}

let geoReaderPromise = null;
let geoReaderWarned = false;

function getGeoReader() {
  if (!geoReaderPromise) {
    if (!fs.existsSync(GEOIP_DB_PATH)) {
      if (!geoReaderWarned) {
        console.warn(`[Geo] MaxMind database not found at ${GEOIP_DB_PATH}`);
        geoReaderWarned = true;
      }
      geoReaderPromise = Promise.resolve(null);
    } else {
      geoReaderPromise = maxmind.open(GEOIP_DB_PATH)
        .then(reader => {
          console.log(`[Geo] Loaded MaxMind database: ${GEOIP_DB_PATH}`);
          return reader;
        })
        .catch(error => {
          console.warn(`[Geo] Failed to load MaxMind database ${GEOIP_DB_PATH}:`, error.message);
          return null;
        });
    }
  }
  return geoReaderPromise;
}

function normalizeClientIp(ip = '') {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  if (ip === '::1') {
    return '127.0.0.1';
  }
  return ip;
}

function getRequestIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return normalizeClientIp(forwardedFor.split(',')[0].trim());
  }
  return normalizeClientIp(req.ip || req.socket?.remoteAddress || '');
}

function isPublicIp(ip = '') {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') return false;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

function isProxyHealthy(proxy) {
  if (!proxy) return false;
  if (proxy.status !== 'online') return false;
  if (!proxy.lastHeartbeatAt) return false;
  return Date.now() - new Date(proxy.lastHeartbeatAt).getTime() <= HEARTBEAT_STALE_MS;
}

function pruneOfflineProxies(store) {
  let changed = false;
  for (const [proxyId, proxy] of Object.entries(store.proxies || {})) {
    if (!isProxyHealthy(proxy)) {
      delete store.proxies[proxyId];
      changed = true;
    }
  }
  if (changed) {
    store.meta.updatedAt = nowIso();
  }
  return store;
}

function computeDownloadMetrics(record) {
  const finishedAt = record.completedAt || record.failedAt || null;
  const startedAt = record.startedAt || record.requestedAt || null;
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const finishedMs = finishedAt ? new Date(finishedAt).getTime() : NaN;
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
    ? finishedMs - startedMs
    : 0;
  const averageSpeedBytes = durationMs > 0 && Number(record.size || 0) > 0
    ? Number((record.size / (durationMs / 1000)).toFixed(2))
    : 0;

  return {
    ...record,
    durationMs,
    averageSpeedBytes
  };
}

function normalizeProxy(proxyId, payload, existing = {}) {
  const now = nowIso();
  return {
    proxyId,
    name: payload.name || existing.name || proxyId,
    baseUrl: payload.baseUrl || existing.baseUrl || '',
    proxyPath: payload.proxyPath || existing.proxyPath || '/proxy?url=',
    trackPath: payload.trackPath || existing.trackPath || '/track',
    provider: payload.provider || existing.provider || '',
    location: {
      ...summarizeLocation(existing.location),
      ...summarizeLocation(payload.location)
    },
    tags: Array.isArray(payload.tags) ? payload.tags : (existing.tags || []),
    status: payload.status || existing.status || 'online',
    connectivity: payload.connectivity || existing.connectivity || 'unknown',
    speedTest: {
      bandwidthMbps: Number.isFinite(payload.speedTest?.bandwidthMbps) ? payload.speedTest.bandwidthMbps : (existing.speedTest?.bandwidthMbps || 0),
      latencyMs: Number.isFinite(payload.speedTest?.latencyMs) ? payload.speedTest.latencyMs : (existing.speedTest?.latencyMs || 0),
      testedAt: payload.speedTest?.testedAt || existing.speedTest?.testedAt || null,
      target: payload.speedTest?.target || existing.speedTest?.target || ''
    },
    traffic: {
      bytesIn: Number(payload.traffic?.bytesIn || existing.traffic?.bytesIn || 0),
      bytesOut: Number(payload.traffic?.bytesOut || existing.traffic?.bytesOut || 0),
      totalBytes: Number(payload.traffic?.totalBytes || existing.traffic?.totalBytes || 0),
      requestCount: Number(payload.traffic?.requestCount || existing.traffic?.requestCount || 0),
      lastReportedAt: payload.traffic?.lastReportedAt || existing.traffic?.lastReportedAt || now
    },
    health: {
      successRate: Number.isFinite(payload.health?.successRate) ? payload.health.successRate : (existing.health?.successRate || 0),
      lastError: payload.health?.lastError || existing.health?.lastError || '',
      failureCount: Number(payload.health?.failureCount || existing.health?.failureCount || 0),
      healthy: payload.health?.healthy !== undefined ? !!payload.health.healthy : (existing.health?.healthy ?? true)
    },
    capabilities: {
      blobCache: payload.capabilities?.blobCache !== undefined ? !!payload.capabilities.blobCache : (existing.capabilities?.blobCache ?? false),
      maxConcurrentRequests: Number(payload.capabilities?.maxConcurrentRequests || existing.capabilities?.maxConcurrentRequests || 0),
      maxResponseSize: Number(payload.capabilities?.maxResponseSize || existing.capabilities?.maxResponseSize || 0)
    },
    recentDownloads: Array.isArray(existing.recentDownloads) ? existing.recentDownloads : [],
    createdAt: existing.createdAt || now,
    registeredAt: existing.registeredAt || now,
    lastHeartbeatAt: payload.lastHeartbeatAt || now,
    updatedAt: now
  };
}

async function lookupProxyLocation(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    const lookupTarget = net.isIP(hostname) ? hostname : (await dns.lookup(hostname)).address;
    return await lookupIpLocation(lookupTarget);
  } catch (error) {
    console.warn(`[Geo] Failed to resolve proxy location for ${baseUrl}:`, error.message);
  }

  return summarizeLocation({});
}

async function lookupIpLocation(ip) {
  if (!isPublicIp(ip)) {
    return summarizeLocation({});
  }

  try {
    const reader = await getGeoReader();
    if (!reader) {
      return summarizeLocation({});
    }

    const record = reader.get(ip);
    const location = {
      countryCode: record?.country?.iso_code || '',
      country: record?.country?.names?.['zh-CN'] || record?.country?.names?.en || '',
      region: record?.subdivisions?.[0]?.names?.['zh-CN'] || record?.subdivisions?.[0]?.names?.en || '',
      city: record?.city?.names?.['zh-CN'] || record?.city?.names?.en || ''
    };

    return summarizeLocation(location);
  } catch (error) {
    console.warn(`[Geo] MaxMind lookup failed for IP ${ip}:`, error.message);
  }

  return summarizeLocation({});
}

function getProxyScore(proxy, requestedCountry = '') {
  const bandwidth = Number(proxy.speedTest?.bandwidthMbps || 0);
  const latency = Number(proxy.speedTest?.latencyMs || 0);
  const totalBytes = Number(proxy.traffic?.totalBytes || 0);
  const successRate = Number(proxy.health?.successRate || 0);
  const failureCount = Number(proxy.health?.failureCount || 0);
  const heartbeatAgeMs = proxy.lastHeartbeatAt ? (Date.now() - new Date(proxy.lastHeartbeatAt).getTime()) : Number.MAX_SAFE_INTEGER;
  const countryMatch = requestedCountry && proxy.location?.countryCode === requestedCountry ? 1 : 0;

  let score = 0;
  score += Math.min(bandwidth, 500) * 8;
  score += latency > 0 ? Math.max(0, 160 - Math.min(latency, 160)) * 2 : 0;
  score += Math.min(successRate, 1) * 120;
  score -= Math.min(failureCount, 20) * 15;
  score -= Math.min(totalBytes / (1024 * 1024 * 512), 200);
  score -= Math.min(heartbeatAgeMs / 1000, 300);
  score += countryMatch ? 40 : 0;
  score += hasLocation(proxy.location) ? 5 : 0;
  return Number(score.toFixed(2));
}

function pickBestProxy(store, options = {}) {
  const proxies = Object.values(store.proxies).filter(isProxyHealthy);
  if (!proxies.length) {
    return null;
  }

  const requestedCountry = (options.countryCode || '').toUpperCase();
  const scored = proxies
    .map(proxy => ({
      proxy,
      score: getProxyScore(proxy, requestedCountry)
    }))
    .sort((a, b) => b.score - a.score);

  const topScore = scored[0]?.score ?? -Infinity;
  const topCandidates = scored.filter(entry => Math.abs(entry.score - topScore) <= 5);
  const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)] || scored[0];
  return selected ? selected.proxy : null;
}

function appendProxyDownloadEvent(store, proxyId, payload) {
  const entry = {
    id: payload.eventId || crypto.randomUUID(),
    proxyId,
    downloadId: payload.downloadId || '',
    image: payload.image || '',
    tag: payload.tag || '',
    arch: payload.arch || '',
    targetUrl: payload.targetUrl || '',
    bytes: Number(payload.bytes || 0),
    status: payload.status || 'observed',
    fromCache: !!payload.fromCache,
    timestamp: payload.timestamp || nowIso()
  };

  store.proxyDownloadEvents.unshift(entry);
  if (store.proxyDownloadEvents.length > 2000) {
    store.proxyDownloadEvents.length = 2000;
  }

  const proxy = store.proxies[proxyId];
  if (proxy) {
    proxy.recentDownloads = Array.isArray(proxy.recentDownloads) ? proxy.recentDownloads : [];
    proxy.recentDownloads.unshift(entry);
    if (proxy.recentDownloads.length > 100) {
      proxy.recentDownloads.length = 100;
    }
  }
}

function updateLegacyDownloads(download) {
  const legacy = readJson(LEGACY_DOWNLOADS_FILE, createLegacyDownloads);
  legacy.total += 1;
  legacy.details.push({
    image: download.image,
    tag: download.tag,
    arch: download.arch,
    timestamp: download.startedAt || nowIso(),
    ip: download.clientIp || ''
  });
  writeJson(LEGACY_DOWNLOADS_FILE, legacy);
}

function buildDownloadRecord(downloadId, payload, existing = {}) {
  return computeDownloadMetrics({
    downloadId,
    image: payload.image || existing.image || '',
    tag: payload.tag || existing.tag || '',
    arch: payload.arch || existing.arch || '',
    size: Number(payload.size || existing.size || 0),
    sourceUrl: payload.sourceUrl || existing.sourceUrl || '',
    proxyId: payload.proxyId || existing.proxyId || '',
    selectedProxy: payload.selectedProxy || existing.selectedProxy || null,
    clientGeo: {
      ...summarizeLocation(existing.clientGeo),
      ...summarizeLocation(payload.clientGeo)
    },
    clientIp: payload.clientIp || existing.clientIp || '',
    requestedAt: existing.requestedAt || payload.requestedAt || nowIso(),
    startedAt: payload.startedAt || existing.startedAt || nowIso(),
    completedAt: payload.completedAt || existing.completedAt || null,
    failedAt: payload.failedAt || existing.failedAt || null,
    status: payload.status || existing.status || 'started',
    success: payload.success !== undefined ? !!payload.success : (existing.success || false),
    error: payload.error || existing.error || '',
    pluginVersion: payload.pluginVersion || existing.pluginVersion || '',
    metadata: {
      ...(existing.metadata || {}),
      ...(payload.metadata || {})
    },
    events: Array.isArray(existing.events) ? existing.events : []
  });
}

async function enrichDownloadsWithLocation(store, downloads) {
  let changed = false;

  for (const download of downloads) {
    if (!hasLocation(download.clientGeo) && isPublicIp(download.clientIp)) {
      const location = await lookupIpLocation(download.clientIp);
      if (hasLocation(location)) {
        download.clientGeo = location;
        if (store.downloads[download.downloadId]) {
          store.downloads[download.downloadId].clientGeo = location;
        }
        changed = true;
      }
    }
  }

  if (changed) {
    writeStore(store);
  }

  return downloads;
}

function appendDownloadEvent(download, type, payload = {}) {
  download.events.unshift({
    type,
    timestamp: payload.timestamp || nowIso(),
    detail: payload.detail || '',
    proxyId: payload.proxyId || download.proxyId || '',
    size: Number(payload.size || 0),
    error: payload.error || ''
  });
  if (download.events.length > 50) {
    download.events.length = 50;
  }
}

function sanitizeProxyResponse(proxy) {
  return {
    proxyId: proxy.proxyId,
    name: proxy.name,
    baseUrl: proxy.baseUrl,
    proxyPath: proxy.proxyPath,
    trackPath: proxy.trackPath,
    provider: proxy.provider,
    location: proxy.location,
    speedTest: proxy.speedTest,
    status: proxy.status,
    connectivity: proxy.connectivity,
    traffic: proxy.traffic,
    capabilities: proxy.capabilities,
    lastHeartbeatAt: proxy.lastHeartbeatAt
  };
}

async function validateProxyBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      return {
        ok: true,
        checkedUrl: `${baseUrl}/health`,
        attempts: 0,
        note: 'loopback validation bypassed for local testing'
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Invalid baseUrl: ${error.message}`
    };
  }

  const candidates = ['/health', '/api/traffic-stats'];
  const errors = [];
  const attempts = 5;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const pathname of candidates) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROXY_VALIDATION_TIMEOUT_MS);

      try {
        const response = await fetch(`${baseUrl}${pathname}`, {
          method: 'GET',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          return {
            ok: true,
            checkedUrl: `${baseUrl}${pathname}`,
            attempts: attempt
          };
        }

        errors.push(`attempt${attempt}:${pathname}:${response.status}`);
      } catch (error) {
        clearTimeout(timeoutId);
        errors.push(`attempt${attempt}:${pathname}:${error.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return {
    ok: false,
    error: `Validation failed for ${baseUrl}. Tried: ${errors.join(', ')}`
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'proxy-registry', now: nowIso() });
});

app.post('/api/proxies/register', (req, res) => {
  const { proxyId, baseUrl } = req.body || {};
  if (!proxyId || !baseUrl) {
    return res.status(400).json({ error: 'Missing proxyId or baseUrl' });
  }

  Promise.all([validateProxyBaseUrl(baseUrl), lookupProxyLocation(baseUrl)]).then(([validation, lookedUpLocation]) => {
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.error
      });
    }

    const store = readStore();
    const proxy = normalizeProxy(proxyId, {
      ...req.body,
      location: hasLocation(req.body.location) ? req.body.location : lookedUpLocation
    }, store.proxies[proxyId]);
    proxy.connectivity = 'reachable';
    proxy.health = {
      ...proxy.health,
      healthy: true,
      lastError: ''
    };
    store.proxies[proxyId] = proxy;
    writeStore(store);

    res.json({
      success: true,
      validation,
      proxy: sanitizeProxyResponse(proxy)
    });
  }).catch(error => {
    res.status(500).json({ error: error.message });
  });
});

app.post('/api/proxies/heartbeat', (req, res) => {
  const { proxyId } = req.body || {};
  if (!proxyId) {
    return res.status(400).json({ error: 'Missing proxyId' });
  }

  const store = readStore();
  const existing = store.proxies[proxyId] || {};
  const payload = { ...req.body };
  if (!hasLocation(payload.location) && hasLocation(existing.location)) {
    payload.location = existing.location;
  }
  const proxy = normalizeProxy(proxyId, payload, existing);
  proxy.lastHeartbeatAt = req.body.lastHeartbeatAt || nowIso();
  store.proxies[proxyId] = proxy;

  if (req.body.trafficSnapshot) {
    store.trafficSnapshots.unshift({
      id: crypto.randomUUID(),
      proxyId,
      timestamp: req.body.trafficSnapshot.timestamp || nowIso(),
      bytesIn: Number(req.body.trafficSnapshot.bytesIn || 0),
      bytesOut: Number(req.body.trafficSnapshot.bytesOut || 0),
      totalBytes: Number(req.body.trafficSnapshot.totalBytes || 0),
      requestCount: Number(req.body.trafficSnapshot.requestCount || 0)
    });
    if (store.trafficSnapshots.length > 5000) {
      store.trafficSnapshots.length = 5000;
    }
  }

  writeStore(store);
  res.json({ success: true, proxy: sanitizeProxyResponse(proxy) });
});

app.post('/api/proxies/download-events', (req, res) => {
  const { proxyId } = req.body || {};
  if (!proxyId) {
    return res.status(400).json({ error: 'Missing proxyId' });
  }

  const store = readStore();
  appendProxyDownloadEvent(store, proxyId, req.body);
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/proxies/select', (req, res) => {
  const store = readStore();
  const proxy = pickBestProxy(store, {
    countryCode: req.query.countryCode || req.query.region
  });

  if (!proxy) {
    return res.status(404).json({ error: 'No healthy proxy available' });
  }

  res.json({
    success: true,
    proxy: sanitizeProxyResponse(proxy),
    strategy: 'weighted-score-with-country-bonus-and-random-tie-break'
  });
});

app.get('/api/proxies', (req, res) => {
  const store = readStore();
  const proxies = Object.values(store.proxies).map(proxy => ({
    ...sanitizeProxyResponse(proxy),
    healthy: isProxyHealthy(proxy)
  }));
  res.json({ total: proxies.length, proxies });
});

app.post('/api/downloads/start', async (req, res) => {
  const { downloadId, image, tag, arch } = req.body || {};
  if (!downloadId || !image || !tag || !arch) {
    return res.status(400).json({ error: 'Missing downloadId/image/tag/arch' });
  }

  const clientIp = getRequestIp(req);
  const clientGeo = hasLocation(req.body.clientGeo) ? req.body.clientGeo : await lookupIpLocation(clientIp);
  const store = readStore();
  const existing = store.downloads[downloadId] || {};
  const download = buildDownloadRecord(downloadId, {
    ...req.body,
    clientIp,
    clientGeo,
    status: 'started',
    startedAt: nowIso()
  }, existing);
  appendDownloadEvent(download, 'started', { proxyId: req.body.proxyId });
  store.downloads[downloadId] = download;
  writeStore(store);
  updateLegacyDownloads(download);

  res.json({ success: true, download });
});

app.post('/api/downloads/complete', (req, res) => {
  const { downloadId } = req.body || {};
  if (!downloadId) {
    return res.status(400).json({ error: 'Missing downloadId' });
  }

  const store = readStore();
  const existing = store.downloads[downloadId];
  if (!existing) {
    return res.status(404).json({ error: 'Download not found' });
  }

  const download = buildDownloadRecord(downloadId, {
    ...req.body,
    status: 'completed',
    success: true,
    completedAt: nowIso()
  }, existing);
  appendDownloadEvent(download, 'completed', { proxyId: req.body.proxyId });
  store.downloads[downloadId] = download;
  writeStore(store);

  res.json({ success: true, download });
});

app.post('/api/downloads/fail', (req, res) => {
  const { downloadId } = req.body || {};
  if (!downloadId) {
    return res.status(400).json({ error: 'Missing downloadId' });
  }

  const store = readStore();
  const existing = store.downloads[downloadId];
  if (!existing) {
    return res.status(404).json({ error: 'Download not found' });
  }

  const download = buildDownloadRecord(downloadId, {
    ...req.body,
    status: 'failed',
    success: false,
    failedAt: nowIso()
  }, existing);
  appendDownloadEvent(download, 'failed', {
    proxyId: req.body.proxyId,
    error: req.body.error || ''
  });
  store.downloads[downloadId] = download;
  writeStore(store);

  res.json({ success: true, download });
});

app.get('/api/downloads', async (req, res) => {
  const store = readStore();
  const downloads = await enrichDownloadsWithLocation(store, Object.values(store.downloads)
    .map(computeDownloadMetrics)
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0)));
  res.json({ total: downloads.length, downloads });
});

app.get('/api/downloads/:downloadId', async (req, res) => {
  const store = readStore();
  const download = store.downloads[req.params.downloadId];
  if (!download) {
    return res.status(404).json({ error: 'Download not found' });
  }
  const [enrichedDownload] = await enrichDownloadsWithLocation(store, [computeDownloadMetrics(download)]);
  res.json({ download: enrichedDownload });
});

app.get('/api/events', (req, res) => {
  const store = readStore();
  const limit = Math.min(Number(req.query.limit || 50), 200);
  res.json({
    total: store.proxyDownloadEvents.length,
    events: store.proxyDownloadEvents.slice(0, limit)
  });
});

app.get('/api/stats', (req, res) => {
  const store = readStore();
  const proxies = Object.values(store.proxies);
  const downloads = Object.values(store.downloads);
  const healthyProxyCount = proxies.filter(isProxyHealthy).length;
  const completedDownloads = downloads.filter(item => item.status === 'completed').length;
  const failedDownloads = downloads.filter(item => item.status === 'failed').length;
  const totalTraffic = proxies.reduce((sum, proxy) => sum + (proxy.traffic.totalBytes || 0), 0);
  const successRate = downloads.length ? Number(((completedDownloads / downloads.length) * 100).toFixed(2)) : 0;

  res.json({
    proxies: {
      total: proxies.length,
      healthy: healthyProxyCount,
      unhealthy: proxies.length - healthyProxyCount
    },
    downloads: {
      total: downloads.length,
      completed: completedDownloads,
      failed: failedDownloads,
      inProgress: downloads.filter(item => item.status === 'started').length,
      successRate
    },
    traffic: {
      totalBytes: totalTraffic
    },
    meta: {
      updatedAt: store.meta.updatedAt
    }
  });
});

app.get('/install-proxy.sh', (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'proxy_server', 'install_proxy_service.sh');
  res.type('text/x-shellscript');
  res.sendFile(scriptPath);
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.listen(PORT, () => {
  console.log(`Proxy registry service running at http://localhost:${PORT}`);
});
