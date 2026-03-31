const fetch = require('node-fetch');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 初始化 Express 应用
const app = express();

// 代理配置（可通过环境变量控制）
const SERVICE_PORT = parseInt(process.env.PORT || '7001', 10);
const USE_PROXY = process.env.USE_PROXY === 'true';
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const REGISTRY_SERVICE_URL = process.env.REGISTRY_SERVICE_URL || 'http://127.0.0.1:3000';
const PROXY_NODE_ID = process.env.PROXY_NODE_ID || cryptoSafeRandomId('proxy');
const PUBLIC_HOST = (process.env.PUBLIC_HOST || process.env.PUBLIC_IP || '').trim();
let PROXY_PUBLIC_BASE_URL = (process.env.PROXY_PUBLIC_BASE_URL || '').trim();
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const SPEED_TEST_INTERVAL_MS = parseInt(process.env.SPEED_TEST_INTERVAL_MS || '300000', 10);
const SPEED_TEST_TARGET = process.env.SPEED_TEST_TARGET || 'https://registry-1.docker.io/v2/';
const SPEED_TEST_IMAGE = process.env.SPEED_TEST_IMAGE || 'library/busybox';
const SPEED_TEST_TAG = process.env.SPEED_TEST_TAG || 'latest';

// 缓存配置（可通过环境变量控制）
const CACHE_BLOB = process.env.CACHE_BLOB !== 'false'; // 默认启用缓存blob，只有明确设置为false时才禁用
const CACHE_BLOB_MAX_SIZE = parseInt(process.env.CACHE_BLOB_MAX_SIZE || '200') * 1024 * 1024; // blob缓存大小限制（MB），默认200MB

// 新增：内存和连接配置
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '1800') * 1000; // 请求超时（秒），默认1800秒（30分钟）
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '20'); // 最大并发请求数，默认20
const MAX_RESPONSE_SIZE = parseInt(process.env.MAX_RESPONSE_SIZE || '10000') * 1024 * 1024; // 最大响应大小限制（MB），默认10GB
const STREAM_THRESHOLD = parseInt(process.env.STREAM_THRESHOLD || '50') * 1024 * 1024; // 流式处理阈值（MB），默认50MB

console.log(`[Config] Blob caching: ${CACHE_BLOB ? 'ENABLED' : 'DISABLED'}, Max size: ${(CACHE_BLOB_MAX_SIZE / 1024 / 1024).toFixed(2)} MB`);
console.log(`[Config] Request timeout: ${REQUEST_TIMEOUT / 1000}s, Max concurrent: ${MAX_CONCURRENT_REQUESTS}`);
console.log(`[Config] Stream threshold: ${(STREAM_THRESHOLD / 1024 / 1024).toFixed(2)} MB, Max response: ${(MAX_RESPONSE_SIZE / 1024 / 1024).toFixed(2)} MB`);
console.log(`[Config] Proxy registry service: ${REGISTRY_SERVICE_URL}`);
console.log(`[Config] Proxy node id: ${PROXY_NODE_ID}`);
console.log(`[Config] Proxy public base URL: ${PROXY_PUBLIC_BASE_URL || '(auto-detect pending)'}`);

// 根据环境变量决定是否使用代理
const proxyAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : null;

// ==================== 定时清理和健康检查 ====================
// 每30秒清理一次超时的请求
setInterval(() => {
    const now = Date.now();
    for (const [id, request] of activeConnections) {
        if (now - request.startTime > REQUEST_TIMEOUT) {
            console.log(`[Cleanup] Force cleanup request ${id}`);
            request.controller.abort();
        }
    }
}, 30000);

// 定期内存报告
setInterval(() => {
    const memory = checkMemoryUsage();
    const requestCount = activeRequests.size;
    console.log(`[Health] Memory: ${memory.percentage.toFixed(2)}%, Active requests: ${requestCount}`);
}, 60000);

const fs = require('fs');
const path = require('path');
const { AbortController } = require('node-abort-controller');

process.on('uncaughtException', (error) => {
    console.error('[Fatal] uncaughtException:', error && error.stack ? error.stack : error);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

function cryptoSafeRandomId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const proxyRegistryState = {
    registered: false,
    lastHeartbeatAt: null,
    location: {
        countryCode: '',
        country: '',
        region: '',
        city: ''
    },
    lastSpeedTest: {
        bandwidthMbps: 0,
        latencyMs: 0,
        testedAt: null,
        target: SPEED_TEST_TARGET
    },
    transferSamples: []
};

let heartbeatTimer = null;

function isPublicHostname(hostname) {
    if (!hostname) return false;
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (['localhost', '0.0.0.0'].includes(normalized)) return false;
    if (normalized === '::1' || normalized === '[::1]') return false;
    if (normalized.startsWith('127.')) return false;
    if (normalized.startsWith('10.')) return false;
    if (normalized.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return false;
    if (normalized.endsWith('.local')) return false;
    return true;
}

function normalizePublicBaseUrl(input) {
    if (!input) return '';
    try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }
        if (!isPublicHostname(url.hostname)) {
            return '';
        }
        url.hash = '';
        url.search = '';
        url.pathname = '';
        return url.toString().replace(/\/$/, '');
    } catch (error) {
        return '';
    }
}

async function detectPublicBaseUrl() {
    const configured = normalizePublicBaseUrl(PROXY_PUBLIC_BASE_URL);
    if (configured) {
        return configured;
    }

    if (PROXY_PUBLIC_BASE_URL) {
        return PROXY_PUBLIC_BASE_URL.replace(/\/$/, '');
    }

    if (isPublicHostname(PUBLIC_HOST)) {
        return `http://${PUBLIC_HOST}:${SERVICE_PORT}`;
    }

    const providers = [
        'https://api.ipify.org',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
    ];

    for (const provider of providers) {
        try {
            const response = await fetch(provider, { timeout: 8000 });
            const ip = (await response.text()).trim();
            if (isPublicHostname(ip)) {
                return `http://${ip}:${SERVICE_PORT}`;
            }
        } catch (error) {
            console.warn(`[Config] Failed to detect public IP via ${provider}:`, error.message);
        }
    }

    return '';
}

async function postToRegistry(pathname, payload) {
    try {
        const response = await fetch(`${REGISTRY_SERVICE_URL}${pathname}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeout: 15000
        });
        if (!response.ok) {
            const text = await response.text().catch(() => response.statusText);
            throw new Error(`${response.status} ${text}`);
        }
        return await response.json().catch(() => ({}));
    } catch (error) {
        console.error(`[Registry] POST ${pathname} failed:`, error.message);
        throw error;
    }
}

async function runSpeedTest() {
    const startedAt = Date.now();
    try {
        const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${SPEED_TEST_IMAGE}:pull`, {
            method: 'GET',
            timeout: 15000,
            agent: proxyAgent || undefined
        });
        const tokenPayload = await tokenResponse.json();
        const token = tokenPayload.token || tokenPayload.access_token || '';
        const manifestStartedAt = Date.now();
        const manifestResponse = await fetch(`https://registry-1.docker.io/v2/${SPEED_TEST_IMAGE}/manifests/${SPEED_TEST_TAG}`, {
            method: 'GET',
            timeout: 15000,
            agent: proxyAgent || undefined,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.docker.distribution.manifest.list.v2+json'
            }
        });
        const manifestBuffer = await manifestResponse.buffer();
        const durationMs = Math.max(Date.now() - manifestStartedAt, 1);
        const manifestThroughput = (manifestBuffer.length * 8) / durationMs / 1000;

        const sampleBandwidths = proxyRegistryState.transferSamples.map(sample => sample.mbps).filter(value => Number.isFinite(value) && value > 0);
        if (manifestThroughput > 0) {
            sampleBandwidths.push(manifestThroughput);
        }
        const averageBandwidth = sampleBandwidths.length
            ? sampleBandwidths.reduce((sum, value) => sum + value, 0) / sampleBandwidths.length
            : 0;
        const bandwidthMbps = Number(Math.max(averageBandwidth, manifestThroughput > 0 ? 0.01 : 0).toFixed(2));

        proxyRegistryState.lastSpeedTest = {
            bandwidthMbps,
            latencyMs: durationMs,
            testedAt: new Date().toISOString(),
            target: `https://registry-1.docker.io/v2/${SPEED_TEST_IMAGE}/manifests/${SPEED_TEST_TAG}`
        };
    } catch (error) {
        proxyRegistryState.lastSpeedTest = {
            bandwidthMbps: proxyRegistryState.lastSpeedTest.bandwidthMbps || 0,
            latencyMs: proxyRegistryState.lastSpeedTest.latencyMs || 0,
            testedAt: new Date().toISOString(),
            target: proxyRegistryState.lastSpeedTest.target || SPEED_TEST_TARGET
        };
        console.warn('[Registry] Speed test failed:', error.message);
    }

    return proxyRegistryState.lastSpeedTest;
}

async function lookupLocation() {
    const hostname = new URL(PROXY_PUBLIC_BASE_URL).hostname;
    const providers = [
        {
            name: 'ip-api',
            url: `http://ip-api.com/json/${encodeURIComponent(hostname)}?lang=zh-CN`,
            parse(payload) {
                if (payload && payload.status === 'success') {
                    return {
                        countryCode: payload.countryCode || '',
                        country: payload.country || '',
                        region: payload.regionName || '',
                        city: payload.city || ''
                    };
                }
                return null;
            }
        },
        {
            name: 'ipwho.is',
            url: `https://ipwho.is/${encodeURIComponent(hostname)}`,
            parse(payload) {
                if (payload && payload.success !== false) {
                    return {
                        countryCode: payload.country_code || '',
                        country: payload.country || '',
                        region: payload.region || '',
                        city: payload.city || ''
                    };
                }
                return null;
            }
        },
        {
            name: 'ipapi.co',
            url: `https://ipapi.co/${encodeURIComponent(hostname)}/json/`,
            parse(payload) {
                if (payload && !payload.error) {
                    return {
                        countryCode: payload.country_code || '',
                        country: payload.country_name || '',
                        region: payload.region || '',
                        city: payload.city || ''
                    };
                }
                return null;
            }
        }
    ];

    try {
        for (const provider of providers) {
            try {
                const response = await fetch(provider.url, {
                    timeout: 8000
                });
                const payload = await response.json();
                const location = provider.parse(payload);
                if (location && (location.countryCode || location.country || location.region || location.city)) {
                    proxyRegistryState.location = location;
                    return proxyRegistryState.location;
                }
            } catch (error) {
                console.warn(`[Registry] ${provider.name} location lookup failed:`, error.message);
            }
        }
    } catch (error) {
        console.warn('[Registry] Location lookup failed:', error.message);
    }

    return proxyRegistryState.location;
}

async function registerProxyNode() {
    PROXY_PUBLIC_BASE_URL = await detectPublicBaseUrl();
    if (!PROXY_PUBLIC_BASE_URL) {
        throw new Error('Unable to determine a public PROXY_PUBLIC_BASE_URL. Set PROXY_PUBLIC_BASE_URL or PUBLIC_HOST/PUBLIC_IP explicitly.');
    }

    const [speedTest, location] = await Promise.all([runSpeedTest(), lookupLocation()]);
    const result = await postToRegistry('/api/proxies/register', {
        proxyId: PROXY_NODE_ID,
        name: PROXY_NODE_ID,
        baseUrl: PROXY_PUBLIC_BASE_URL,
        proxyPath: '/proxy?url=',
        trackPath: '/track',
        status: 'online',
        connectivity: 'reachable',
        provider: USE_PROXY ? `upstream:${PROXY_URL}` : 'direct',
        location,
        speedTest,
        capabilities: {
            blobCache: CACHE_BLOB,
            maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
            maxResponseSize: MAX_RESPONSE_SIZE
        }
    });
    proxyRegistryState.registered = true;
    console.log('[Registry] Proxy node registered:', result.validation?.checkedUrl || PROXY_PUBLIC_BASE_URL);
}

async function sendHeartbeat(options = {}) {
    const includeSpeedTest = options.includeSpeedTest !== false;
    const speedTest = includeSpeedTest ? await runSpeedTest() : proxyRegistryState.lastSpeedTest;
    const totalBytes = trafficStats.totalBytes;
    const heartbeat = await postToRegistry('/api/proxies/heartbeat', {
        proxyId: PROXY_NODE_ID,
        status: 'online',
        connectivity: 'reachable',
        location: proxyRegistryState.location,
        speedTest,
        traffic: {
            bytesIn: totalBytes,
            bytesOut: totalBytes,
            totalBytes,
            requestCount: trafficStats.totalRequests,
            lastReportedAt: new Date().toISOString()
        },
        health: {
            healthy: true,
            successRate: trafficStats.totalRequests > 0
                ? Number(((trafficStats.cacheHits + trafficStats.cacheMisses) / trafficStats.totalRequests).toFixed(2))
                : 1,
            failureCount: 0,
            lastError: ''
        },
        trafficSnapshot: {
            bytesIn: totalBytes,
            bytesOut: totalBytes,
            totalBytes,
            requestCount: trafficStats.totalRequests,
            timestamp: new Date().toISOString()
        },
        lastHeartbeatAt: new Date().toISOString()
    });
    proxyRegistryState.lastHeartbeatAt = heartbeat?.proxy?.lastHeartbeatAt || new Date().toISOString();
}

function scheduleHeartbeat(delayMs = 2000) {
    if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
    }

    heartbeatTimer = setTimeout(() => {
        sendHeartbeat({ includeSpeedTest: false }).catch(err => {
            console.warn('[Registry] Scheduled heartbeat failed:', err.message);
        });
    }, delayMs);
}

async function reportProxyDownloadEvent(payload) {
    try {
        await postToRegistry('/api/proxies/download-events', {
            proxyId: PROXY_NODE_ID,
            ...payload
        });
    } catch (error) {
        console.warn('[Registry] Failed to report proxy download event:', error.message);
    }
}

// ==================== 连接管理和并发控制 ====================
const activeRequests = new Set();
const activeConnections = new Map();

// 内存监控
function checkMemoryUsage() {
    const heapUsed = process.memoryUsage().heapUsed / 1024 / 1024;
    const heapTotal = process.memoryUsage().heapTotal / 1024 / 1024;
    const rss = process.memoryUsage().rss / 1024 / 1024;  // 实际物理内存使用
    const percentage = (heapUsed / heapTotal) * 100;
    const rssPercentage = (rss / 512) * 100;  // 基于总限制512MB的百分比

    // 警告基于实际物理内存使用，而不是堆内存比例
    if (rss > 400) {  // 超过400MB时警告
        console.warn(`[Memory] High RSS usage: ${rss.toFixed(2)}MB (${rssPercentage.toFixed(2)}% of 512MB), Heap: ${heapUsed.toFixed(2)}MB / ${heapTotal.toFixed(2)}MB`);
    }

    return { used: heapUsed, total: heapTotal, rss, percentage, rssPercentage };
}

// 请求控制器
class RequestController {
    constructor() {
        this.id = Date.now();
        this.startTime = Date.now();
        this.aborted = false;
        this.controller = new AbortController();
    }

    async cleanup() {
        this.aborted = true;
        this.controller.abort();
        activeRequests.delete(this.id);
        console.log(`[RequestController] Request ${this.id} cleaned up, duration: ${Date.now() - this.startTime}ms`);
    }

    get signal() {
        return this.controller.signal;
    }
}

// ==================== 流量统计 ====================
const TRAFFIC_LOG_PATH = path.join(__dirname, 'traffic.log');

const trafficStats = {
    totalRequests: 0,
    totalBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    byDomain: {},
    byDate: {},
    startTime: new Date().toISOString()
};

const recentProxyRequests = [];

function appendRecentProxyRequest(entry) {
    recentProxyRequests.unshift({
        id: cryptoSafeRandomId('req'),
        timestamp: new Date().toISOString(),
        ...entry
    });
    if (recentProxyRequests.length > 100) {
        recentProxyRequests.length = 100;
    }
}

function recordTraffic(url, bytes, fromCache) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const domain = new URL(url).hostname;

    // 总体统计
    trafficStats.totalRequests++;
    trafficStats.totalBytes += bytes;

    // 缓存统计
    if (fromCache) {
        trafficStats.cacheHits++;
    } else {
        trafficStats.cacheMisses++;
    }

    // 域名统计
    if (!trafficStats.byDomain[domain]) {
        trafficStats.byDomain[domain] = { requests: 0, bytes: 0 };
    }
    trafficStats.byDomain[domain].requests++;
    trafficStats.byDomain[domain].bytes += bytes;

    // 日期统计
    if (!trafficStats.byDate[date]) {
        trafficStats.byDate[date] = { requests: 0, bytes: 0 };
    }
    trafficStats.byDate[date].requests++;
    trafficStats.byDate[date].bytes += bytes;

    // 记录到日志文件
    const logEntry = {
        timestamp: now.toISOString(),
        url,
        domain,
        bytes,
        fromCache
    };

    try {
        fs.appendFileSync(TRAFFIC_LOG_PATH, JSON.stringify(logEntry) + '\n');
    } catch (err) {
        console.error('[Traffic] Failed to write log:', err);
    }

    scheduleHeartbeat();
}

function recordTransferSample(bytes, durationMs) {
    if (!bytes || !durationMs || durationMs <= 0) {
        return;
    }

    const mbps = Number((((bytes * 8) / durationMs) / 1000).toFixed(2));
    if (!Number.isFinite(mbps) || mbps <= 0) {
        return;
    }

    proxyRegistryState.transferSamples.unshift({
        mbps,
        bytes,
        durationMs,
        timestamp: new Date().toISOString()
    });

    if (proxyRegistryState.transferSamples.length > 12) {
        proxyRegistryState.transferSamples.length = 12;
    }
}

// ==================== LRU 缓存实现（支持持久化）====================
class LRUCache {
    constructor(maxSize = 100, maxBytes = 500 * 1024 * 1024, persistPath = null) { // 默认100项或500MB
        this.maxSize = maxSize;
        this.maxBytes = maxBytes;
        this.persistPath = persistPath;
        this.cache = new Map();
        this.currentBytes = 0;
        this.hits = 0;
        this.misses = 0;
        this.pendingSave = false; // 防抖，避免频繁写入

        // 如果指定了持久化路径，从文件加载缓存
        if (this.persistPath) {
            this.loadFromDisk();
        }
    }

    // 从磁盘加载缓存
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.persistPath)) {
                console.log(`[Cache] No cache file found, starting fresh`);
                return;
            }

            const data = fs.readFileSync(this.persistPath, 'utf-8');
            const entries = JSON.parse(data);

            let totalBytes = 0;
            let validCount = 0;
            let expiredCount = 0;

            for (const [key, value] of Object.entries(entries)) {
                // 检查是否过期
                if (this.isExpired(key, value)) {
                    expiredCount++;
                    continue;
                }

                // 确保从磁盘加载的值有正确的结构
                const cachedValue = { ...value, accessCount: value.accessCount || 0 };
                this.cache.set(key, cachedValue);
                totalBytes += value.size || 0;
                validCount++;
            }

            this.currentBytes = totalBytes;
            console.log(`[Cache] Loaded ${validCount} entries from disk (${expiredCount} expired), total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
        } catch (err) {
            console.error(`[Cache] Failed to load from disk:`, err);
        }
    }

    // 保存缓存到磁盘
    saveToDisk() {
        if (!this.persistPath) return;

        try {
            const entries = {};
            for (const [key, value] of this.cache.entries()) {
                // 只保存必要数据，减少文件大小
                entries[key] = {
                    data: value.data,
                    contentType: value.contentType,
                    size: value.size,
                    timestamp: value.timestamp,
                    accessCount: value.accessCount || 0
                };
            }

            const json = JSON.stringify(entries, null, 2);
            fs.writeFileSync(this.persistPath, json, 'utf-8');
            console.log(`[Cache] Saved ${this.cache.size} entries to disk, total: ${(this.currentBytes / 1024 / 1024).toFixed(2)} MB`);
        } catch (err) {
            console.error(`[Cache] Failed to save to disk:`, err);
        }
    }

    // 检查缓存项是否过期
    isExpired(key, value) {
        // Token 缓存项不使用过期时间，但应该更频繁地检查
        if (key.includes('auth.docker.io/token')) {
            const age = Date.now() - (value.timestamp || Date.now());
            const maxAge = 5 * 60 * 1000; // 5 分钟
            return age > maxAge;
        }
        // 对于非 token 缓存项，检查是否超过 30 分钟
        const age = Date.now() - (value.timestamp || Date.now());
        const maxAge = 30 * 60 * 1000; // 30 分钟
        return age > maxAge;
    }

    get(key) {
        if (this.cache.has(key)) {
            const value = this.cache.get(key);

            // 检查缓存项是否过期
            if (this.isExpired(key, value)) {
                console.log(`[Cache] EXPIRED for key: ${key}, removing...`);
                this.cache.delete(key);
                this.currentBytes -= value.size || 0;
                this.misses++;
                this.scheduleSave();
                return null;
            }

            this.hits++;
            // 增加访问次数
            value.accessCount = (value.accessCount || 0) + 1;
            // LRU: 移到最后（保持Map顺序，访问多的在后面）
            this.cache.delete(key);
            this.cache.set(key, value);

            return value;
        }
        this.misses++;
        return null;
    }

    set(key, value, size = 0) {
        // 如果已存在，删除旧值
        if (this.cache.has(key)) {
            const oldValue = this.cache.get(key);
            this.currentBytes -= oldValue.size || 0;
            this.cache.delete(key);
        }

        // 添加新值（继承原有的访问次数）
        const existingAccessCount = value.accessCount || 0;
        this.cache.set(key, { ...value, size, timestamp: Date.now(), accessCount: existingAccessCount });
        this.currentBytes += size;

        // 检查是否需要淘汰
        this.evict();

        // 异步保存到磁盘
        this.scheduleSave();
    }

    // 调度保存，避免频繁写入
    scheduleSave() {
        if (!this.persistPath) return;

        if (!this.pendingSave) {
            this.pendingSave = true;
            setTimeout(() => {
                this.saveToDisk();
                this.pendingSave = false;
            }, 5000); // 5秒后保存
        }
    }

    evict() {
        // 按数量淘汰（淘汰访问次数最少的）
        while (this.cache.size > this.maxSize) {
            const entries = Array.from(this.cache.entries());
            // 按访问次数排序，淘汰最少的
            entries.sort((a, b) => (a[1].accessCount || 0) - (b[1].accessCount || 0));

            const firstKey = entries[0][0];
            const value = entries[0][1];
            this.currentBytes -= value.size || 0;
            this.cache.delete(firstKey);

            console.log(`[Cache] Evicted ${firstKey} (accessCount: ${value.accessCount || 0})`);
        }

        // 按大小淘汰（优先淘汰访问次数少的）
        while (this.currentBytes > this.maxBytes && this.cache.size > 0) {
            const entries = Array.from(this.cache.entries());
            // 按访问次数排序
            entries.sort((a, b) => (a[1].accessCount || 0) - (b[1].accessCount || 0));

            const firstKey = entries[0][0];
            const value = entries[0][1];
            this.currentBytes -= value.size || 0;
            this.cache.delete(firstKey);

            console.log(`[Cache] Evicted by size: ${firstKey} (accessCount: ${value.accessCount || 0}, size: ${(value.size / 1024 / 1024).toFixed(2)} MB)`);
        }
    }

    clear() {
        this.cache.clear();
        this.currentBytes = 0;
        this.hits = 0;
        this.misses = 0;

        // 清空持久化文件
        if (this.persistPath) {
            this.saveToDisk();
        }
    }

    // 清理过期缓存
    cleanupExpired() {
        const expiredKeys = [];

        for (const [key, value] of this.cache.entries()) {
            if (this.isExpired(key, value)) {
                expiredKeys.push(key);
                this.currentBytes -= value.size || 0;
            }
        }

        for (const key of expiredKeys) {
            this.cache.delete(key);
        }

        if (expiredKeys.length > 0) {
            console.log(`[Cache] Cleaned up ${expiredKeys.length} expired entries`);
            this.saveToDisk();
        }
    }

    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            currentBytes: this.currentBytes,
            maxBytes: this.maxBytes,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0
                ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    getEntries() {
        return Array.from(this.cache.entries()).map(([key, value]) => ({
            key,
            size: value.size,
            timestamp: new Date(value.timestamp).toISOString(),
            age: Math.floor((Date.now() - value.timestamp) / 1000), // 秒
            accessCount: value.accessCount || 0
        }));
    }
}

// 缓存持久化文件路径
const CACHE_PERSIST_PATH = path.join(__dirname, 'cache-persist.json');

console.log(`[Cache] Cache persist path: ${CACHE_PERSIST_PATH}`);
console.log(`[Cache] Cache file exists: ${fs.existsSync(CACHE_PERSIST_PATH)}`);

// 创建缓存实例（支持持久化）
const responseCache = new LRUCache(
    200, // 最多200个缓存项
    1024 * 1024 * 1024, // 最多1GB
    CACHE_PERSIST_PATH // 持久化路径
);

// 定期清理过期缓存（每30分钟执行一次）
setInterval(() => {
    console.log('[Cache] Running periodic cleanup...');
    responseCache.cleanupExpired();
}, 30 * 60 * 1000);

// 进程退出时保存缓存
process.on('SIGINT', () => {
    console.log('[Cache] Saving cache before exit...');
    responseCache.saveToDisk();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Cache] Saving cache before exit...');
    responseCache.saveToDisk();
    process.exit(0);
});

// ==================== 辅助函数 ====================
function logToFile(msg) {
    fs.appendFileSync('debug.log', new Date().toISOString() + ' ' + msg + '\n');
}

// 追踪日志文件
const TRACKING_LOG_PATH = path.join(__dirname, 'tracking.log');

function logTracking(data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        ...data
    };
    try {
        fs.appendFileSync(TRACKING_LOG_PATH, JSON.stringify(logEntry) + '\n');
        console.log('[Tracking] Logged:', logEntry);
    } catch (err) {
        console.error('[Tracking] Failed to write log:', err);
    }
}

// ==================== Express 中间件 ====================
app.use(express.json());
app.use((req, res, next) => {
    // 诊断日志：记录所有请求的来源
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`[Request] Received ${req.method} ${req.path} from ${clientIP}`);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Skip-Cache, X-Download-Id, X-Image, X-Tag, X-Arch');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'docker-download-proxy',
        proxyNodeId: PROXY_NODE_ID,
        registered: proxyRegistryState.registered,
        now: new Date().toISOString()
    });
});

// ==================== 代理 GET 请求（带缓存） ====================
const crypto = require('crypto');

// 生成 Authorization header 的短哈希，用于缓存键
function getAuthHash(authHeader) {
    if (!authHeader) return 'no-auth';
    // 只取 token 的前 16 个字符作为标识，避免完整的 token 作为缓存键
    const token = authHeader.replace('Bearer ', '');
    return crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const skipCache = req.query._nocache || req.headers['x-skip-cache'] === 'true';
    const startTime = Date.now();
    const downloadMetadata = {
        downloadId: req.headers['x-download-id'] || '',
        image: req.headers['x-image'] || '',
        tag: req.headers['x-tag'] || '',
        arch: req.headers['x-arch'] || '',
        targetUrl: targetUrl || ''
    };

    // 检查并发限制
    if (activeRequests.size >= MAX_CONCURRENT_REQUESTS) {
        console.error('[proxy] 最大并发请求数已达到:', MAX_CONCURRENT_REQUESTS);
        return res.status(429).send('Too Many Requests');
    }

    // 检查内存使用
    const memory = checkMemoryUsage();
    if (memory.rss > 480) {  // 超过480MB时拒绝新请求
        console.error('[proxy] 内存使用过高:', memory.rss.toFixed(2) + 'MB (' + memory.rssPercentage.toFixed(2) + '%)');
        return res.status(503).send('Service Temporarily Unavailable');
    }

    // 检查是否是 blob 下载请求（layer 文件）
    const isBlobRequest = targetUrl && targetUrl.includes('/blobs/');
    // 检查是否是 manifest 请求
    const isManifestRequest = targetUrl && targetUrl.includes('/manifests/');
    // 计算预估文件大小（从URL或header中获取）
    const isLargeFile = isBlobRequest && targetUrl.includes('sha256:');

    // 检查是否应该跳过blob缓存（根据配置）
    const shouldSkipBlobCache = isBlobRequest && (!CACHE_BLOB || false);

    // 创建请求控制器
    const requestController = new RequestController();
    activeRequests.add(requestController.id);

    // 跟踪响应是否已发送，避免重复发送
    let responseSent = false;
    const sendErrorResponse = (status, message) => {
        if (!responseSent && !res.headersSent) {
            responseSent = true;
            return res.status(status).send(message);
        }
    };

    console.log('[proxy] 原始请求:', req.originalUrl);
    console.log('[proxy] 解析目标:', targetUrl);
    const skipCacheByHeader = req.headers['x-skip-cache'] === 'true';
    const skipCacheByUrl = !!req.query._nocache;
    console.log('[proxy] 跳过缓存:', skipCache ? '是' : '否', `(header: ${skipCacheByHeader}, url: ${skipCacheByUrl})`);
    console.log('[proxy] 请求类型:', isBlobRequest ? 'blob' : (isManifestRequest ? 'manifest' : 'other'));
    console.log('[proxy] 流式处理:', isLargeFile ? '启用' : '禁用');
    logToFile(`[Request] Original: ${req.originalUrl}`);
    logToFile(`[Request] Target: ${targetUrl}`);

    if (!targetUrl) {
        console.error('[proxy] 缺少url参数');
        requestController.cleanup();
        responseSent = true;
        return res.status(400).send('Missing url param');
    }

    try {
        // 清理 URL：移除 _nocache 参数（用于白名单检查和缓存键）
        const cleanUrl = targetUrl.replace(/[?&]_nocache=\d+/, '');

        // 白名单检查
        if (!/^https:\/\/((registry-1|auth)\.docker\.io|docker-images-prod\..*\.r2\.cloudflarestorage\.com|production\.cloudflare\.docker\.com)\//.test(cleanUrl)) {
            console.error('[proxy] 非法目标:', targetUrl);
            responseSent = true;
            requestController.cleanup();
            return res.status(403).send('Forbidden');
        }

        // 构建缓存键（使用干净的 URL，不包含 _nocache 参数，同时包含 Authorization header 的哈希）
        // 这样不同 token 的请求会有不同的缓存，避免 token 过期导致的 401 缓存问题
        const authHash = getAuthHash(req.headers['authorization']);
        const cacheKey = `${cleanUrl}#${authHash}`;

        console.log('[proxy] 缓存键 (auth hash):', authHash);
        console.log('[proxy] 清理后的 URL (用于缓存):', cleanUrl);

        // 检查缓存（如果需要跳过缓存则不检查）
        // 注意：blob 请求根据配置决定是否使用缓存
        if (!skipCache && !shouldSkipBlobCache) {
            const cached = responseCache.get(cacheKey);
            if (cached) {
                console.log('[Cache] HIT for:', cleanUrl, 'auth:', authHash);
                logToFile(`[Cache] HIT: ${cleanUrl}`);

                // 记录流量（来自缓存）
                recordTraffic(cleanUrl, cached.size, true);
                if (downloadMetadata.downloadId) {
                    reportProxyDownloadEvent({
                        ...downloadMetadata,
                        status: 'cache-hit',
                        fromCache: true,
                        bytes: cached.size
                    });
                }
                appendRecentProxyRequest({
                    url: cleanUrl,
                    type: isBlobRequest ? 'blob' : (isManifestRequest ? 'manifest' : 'other'),
                    status: 200,
                    fromCache: true,
                    bytes: cached.size,
                    durationMs: Date.now() - startTime
                });
                recordTransferSample(cached.size, Date.now() - startTime);

                console.log('[proxy] 从缓存发送响应');

                // 发送缓存响应
                responseSent = true;
                res.status(200);
                res.set('X-Cache', 'HIT');
                if (cached.contentType) res.set('content-type', cached.contentType);
                res.send(cached.data);
                requestController.cleanup();
                return;
            }
        } else if (shouldSkipBlobCache) {
            if (isBlobRequest) {
                console.log('[Cache] SKIPPED (blob request, disabled by config)');
            } else {
                console.log('[Cache] SKIPPED for:', cleanUrl, '(cache disabled)');
            }
        } else {
            console.log('[Cache] SKIPPED for:', cleanUrl);
        }

        console.log('[Cache] MISS for:', cleanUrl);
        logToFile(`[Cache] MISS: ${cleanUrl}`);

        // 调试：打印收到的所有请求头
        console.log('[proxy] 收到的请求头:', JSON.stringify(req.headers, null, 2));

        // 检查 Authorization header 的内容
        const authHeader = req.headers['authorization'];
        console.log('[proxy] Authorization header:', authHeader ? 'Present' : 'Missing');
        if (authHeader) {
          console.log('[proxy] Authorization type:', authHeader.split(' ')[0]);
          console.log('[proxy] Token length:', authHeader.length);
        }

        // 缓存未命中，发起实际请求
        const headers = {};
        // 注意：Express 会将 header 名称转为小写
        if (req.headers['authorization']) {
            headers['Authorization'] = req.headers['authorization'];
        }
        if (req.headers['accept']) {
            headers['Accept'] = req.headers['accept'];
        }

        const logHeaders = { ...headers };
        if (logHeaders['Authorization']) logHeaders['Authorization'] = 'Bearer ******';
        console.log('[proxy] 发起fetch:', cleanUrl, logHeaders);
        console.log('[proxy] 使用代理:', USE_PROXY ? PROXY_URL : '直连');

        const fetchOptions = {
            headers: {
                'User-Agent': 'docker-download-extension/1.0',
                ...headers
            },
            timeout: 120000, // 120秒超时
            redirect: 'follow' // 跟随重定向
        };
        if (proxyAgent) {
            fetchOptions.agent = proxyAgent;
        }

        const resp = await fetch(cleanUrl, fetchOptions);
        const contentType = resp.headers.get('content-type');
        const contentLength = parseInt(resp.headers.get('content-length') || '0');

        console.log('[proxy] 响应状态:', resp.status, 'content-type:', contentType, 'content-length:', contentLength);

        // 检查响应大小限制
        if (contentLength > MAX_RESPONSE_SIZE) {
            console.error('[proxy] 响应过大，超过限制:', contentLength, '>', MAX_RESPONSE_SIZE);
            requestController.cleanup();
            return res.status(413).send('Payload Too Large');
        }

        let responseData;
        let isFromCache = false;

        // 缓存策略检查
        const shouldCache = resp.status === 200 && !isLargeFile && contentLength < CACHE_BLOB_MAX_SIZE;

        if (shouldCache) {
            // 对于小文件，先读取整个响应到内存进行缓存
            responseData = await resp.buffer();

            responseCache.set(cacheKey, {
                data: responseData,
                contentType: contentType,
                status: resp.status
            }, responseData.length);

            console.log('[Cache] Cached:', cleanUrl, 'auth:', authHash, 'size:', responseData.length);
            isFromCache = true;
        } else if (resp.status !== 200) {
            console.log('[Cache] NOT cached (non-200 response):', resp.status);
            // 对于非200响应，仍需要读取数据以释放内存
            responseData = await resp.buffer();
        } else if (isLargeFile) {
            console.log('[Stream] Using streaming for large file:', contentLength, 'bytes');

            // 流式处理大文件
            res.status(resp.status);
            res.set('X-Cache', 'MISS');
            if (contentType) res.set('content-type', contentType);

            // 设置Transfer-Encoding: chunked
            res.setHeader('Transfer-Encoding', 'chunked');

            // 使用流式传输
            let bytesWritten = 0;
            try {
                await new Promise((resolve, reject) => {
                    resp.body.on('data', chunk => {
                        if (requestController.aborted) {
                            resp.body.destroy();
                            return reject(new Error('Request aborted'));
                        }

                        res.write(chunk);
                        bytesWritten += chunk.length;

                        // 记录进度
                        if (bytesWritten % (10 * 1024 * 1024) === 0) { // 每10MB记录一次
                            console.log(`[Stream] Progress: ${bytesWritten} / ${contentLength}`);
                        }
                    });

                    resp.body.on('end', resolve);
                    resp.body.on('error', reject);

                    // 超时处理
                    setTimeout(() => {
                        if (!requestController.aborted) {
                            reject(new Error('Request timeout'));
                        }
                    }, REQUEST_TIMEOUT);
                });

                // 正常完成
                res.end();
                responseSent = true;
                recordTraffic(cleanUrl, bytesWritten, false);
                if (downloadMetadata.downloadId) {
                    reportProxyDownloadEvent({
                        ...downloadMetadata,
                        status: 'completed',
                        fromCache: false,
                        bytes: bytesWritten
                    });
                }
                appendRecentProxyRequest({
                    url: cleanUrl,
                    type: 'blob',
                    status: resp.status,
                    fromCache: false,
                    bytes: bytesWritten,
                    durationMs: Date.now() - startTime
                });
                recordTransferSample(bytesWritten, Date.now() - startTime);
                const duration = Date.now() - startTime;
                console.log('[proxy] 流式传输完成，耗时:', duration, 'ms');
                requestController.cleanup();
                return;
            } catch (err) {
                console.error('[Stream] 流式传输失败:', err.message);
                // 流式传输失败时，不要尝试发送错误响应（可能已经发送了部分数据）
                // 只是清理资源
                requestController.cleanup();
                throw err;  // 让外层catch处理
            }
        } else {
            // 对于小但不需要缓存的文件
            responseData = await resp.buffer();
            console.log('[Stream] Small file but not cached:', responseData.length);
        }

        // 记录流量（来自网络）
        recordTraffic(cleanUrl, responseData.length, false);
        if (downloadMetadata.downloadId) {
            reportProxyDownloadEvent({
                ...downloadMetadata,
                status: resp.status === 200 ? 'completed' : 'upstream-error',
                fromCache: false,
                bytes: responseData.length
            });
        }
        appendRecentProxyRequest({
            url: cleanUrl,
            type: isBlobRequest ? 'blob' : (isManifestRequest ? 'manifest' : 'other'),
            status: resp.status,
            fromCache: false,
            bytes: responseData.length,
            durationMs: Date.now() - startTime
        });
        recordTransferSample(responseData.length, Date.now() - startTime);

        // 发送响应
        if (!responseSent) {
            res.status(resp.status);
            res.set('X-Cache', 'MISS');
            if (contentType) res.set('content-type', contentType);
            res.send(responseData);
            responseSent = true;
        }

        const duration = Date.now() - startTime;
        console.log('[proxy] 请求完成，耗时:', duration, 'ms');

    } catch (err) {
        console.error('[proxy] 错误:', err && err.stack ? err.stack : err);
        if (downloadMetadata.downloadId) {
            reportProxyDownloadEvent({
                ...downloadMetadata,
                status: 'failed',
                fromCache: false,
                bytes: 0
            });
        }
        appendRecentProxyRequest({
            url: targetUrl || '',
            type: isBlobRequest ? 'blob' : (isManifestRequest ? 'manifest' : 'other'),
            status: 'error',
            fromCache: false,
            bytes: 0,
            durationMs: Date.now() - startTime,
            error: err.message || 'Unknown error'
        });
        // 使用安全的方式发送错误响应
        if (!responseSent) {
            sendErrorResponse(500, err.message || 'Internal server error');
        }
        requestController.cleanup();
    } finally {
        // 确保清理资源
        if (!responseSent) {
            requestController.cleanup();
        }
    }
});

// ==================== 追踪 API ====================
app.post('/track', async (req, res) => {
    const { image, tag, arch } = req.body;

    console.log('[Tracking] Received:', { image, tag, arch });
    logToFile(`[Tracking] Received: ${image}:${tag} (${arch})`);

    if (!image || !tag) {
        console.error('[Tracking] Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: image, tag' });
    }

    try {
        logTracking({ image, tag, arch });
        console.log('[Tracking] Logged successfully');
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Tracking] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 流量统计 API ====================
app.get('/api/traffic-stats', (req, res) => {
    try {
        res.json({
            ...trafficStats,
            uptime: Math.floor((Date.now() - new Date(trafficStats.startTime).getTime()) / 1000),
            cacheHitRate: trafficStats.cacheHits + trafficStats.cacheMisses > 0
                ? ((trafficStats.cacheHits / (trafficStats.cacheHits + trafficStats.cacheMisses)) * 100).toFixed(2) + '%'
                : '0%'
        });
    } catch (err) {
        console.error('[Traffic Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 缓存管理 API ====================
app.get('/api/cache-stats', (req, res) => {
    try {
        const stats = responseCache.getStats();
        res.json(stats);
    } catch (err) {
        console.error('[Cache Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/cache-entries', (req, res) => {
    try {
        const entries = responseCache.getEntries();
        res.json(entries);
    } catch (err) {
        console.error('[Cache Entries API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/cache-clear', (req, res) => {
    try {
        responseCache.clear();
        console.log('[Cache] Cleared');
        res.json({ success: true, message: 'Cache cleared' });
    } catch (err) {
        console.error('[Cache Clear API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 追踪统计 API ====================
app.get('/api/tracking-stats', (req, res) => {
    try {
        if (!fs.existsSync(TRACKING_LOG_PATH)) {
            return res.json({ total: 0, unique: 0, data: [] });
        }

        const logs = fs.readFileSync(TRACKING_LOG_PATH, 'utf-8')
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        const stats = {};
        const archStats = {};
        const dailyStats = {};

        logs.forEach(log => {
            const key = `${log.image}:${log.tag}`;
            if (!stats[key]) {
                stats[key] = { count: 0, archs: new Set(), firstSeen: log.timestamp, lastSeen: log.timestamp };
            }
            stats[key].count++;
            stats[key].archs.add(log.arch || 'unknown');
            if (log.timestamp > stats[key].lastSeen) {
                stats[key].lastSeen = log.timestamp;
            }

            const arch = log.arch || 'unknown';
            archStats[arch] = (archStats[arch] || 0) + 1;

            const date = log.timestamp.split('T')[0];
            dailyStats[date] = (dailyStats[date] || 0) + 1;
        });

        const data = Object.entries(stats)
            .map(([key, value]) => ({
                image: key,
                count: value.count,
                archs: Array.from(value.archs),
                firstSeen: value.firstSeen,
                lastSeen: value.lastSeen
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);

        res.json({
            total: logs.length,
            unique: Object.keys(stats).length,
            data,
            archStats,
            dailyStats
        });
    } catch (err) {
        console.error('[Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/node-status', (req, res) => {
    try {
        res.json({
            proxyNodeId: PROXY_NODE_ID,
            registered: proxyRegistryState.registered,
            lastHeartbeatAt: proxyRegistryState.lastHeartbeatAt,
            lastSpeedTest: proxyRegistryState.lastSpeedTest,
            service: {
                port: SERVICE_PORT,
                host: HOST,
                publicBaseUrl: PROXY_PUBLIC_BASE_URL,
                registryServiceUrl: REGISTRY_SERVICE_URL,
                upstreamProxyEnabled: USE_PROXY,
                upstreamProxyUrl: USE_PROXY ? PROXY_URL : '',
                cacheBlobEnabled: CACHE_BLOB
            },
            traffic: {
                totalRequests: trafficStats.totalRequests,
                totalBytes: trafficStats.totalBytes,
                cacheHits: trafficStats.cacheHits,
                cacheMisses: trafficStats.cacheMisses
            },
            cache: responseCache.getStats(),
            recentRequests: recentProxyRequests.slice(0, 20)
        });
    } catch (err) {
        console.error('[Node Status API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 静态文件服务 ====================
app.get('/dashboard', (req, res) => {
    res.redirect('/traffic-dashboard');
});

app.get('/traffic-dashboard', (req, res) => {
    const dashboardPath = path.join(__dirname, 'traffic-dashboard.html');
    if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
    } else {
        res.status(404).send('Traffic dashboard not found');
    }
});

app.get('/', (req, res) => {
    res.redirect('/traffic-dashboard');
});

app.use((err, req, res, next) => {
    console.error('[Express] Unhandled route error:', err && err.stack ? err.stack : err);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({
        error: err && err.message ? err.message : 'Internal Server Error'
    });
});

// ==================== 启动服务器 ====================
const HOST = '0.0.0.0'; // 监听所有接口，方便外网访问

app.listen(SERVICE_PORT, HOST, () => {
    console.log(`Proxy server running at http://0.0.0.0:${SERVICE_PORT}`);
    console.log(`Server is accessible from:`);
    console.log(`  - Local: http://0.0.0.0:${SERVICE_PORT}`);
    console.log(`  - External: http://${require('os').hostname()}:${SERVICE_PORT}`);
    console.log(`  - Public health check target: ${PROXY_PUBLIC_BASE_URL}/health`);
    console.log(`\n网络配置:`);
    console.log(`  - 代理模式: ${USE_PROXY ? '已启用' : '已禁用（直连）'}`);
    if (USE_PROXY) {
        console.log(`  - 代理地址: ${PROXY_URL}`);
    }
    console.log(`\n功能列表:`);
    console.log(`  - Traffic statistics: /api/traffic-stats`);
    console.log(`  - Cache management: /api/cache-stats, /api/cache-entries, /api/cache-clear`);
    console.log(`  - Tracking: /api/tracking-stats`);
    console.log(`  - Node Operations Dashboard: /traffic-dashboard`);
    console.log(`  - /dashboard redirects to /traffic-dashboard`);
    console.log(`\n缓存配置:`);
    console.log(`  - Max items: ${responseCache.maxSize}`);
    console.log(`  - Max size: ${(responseCache.maxBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`\n提示: 通过环境变量控制代理`);
    console.log(`  启用代理: PORT=${SERVICE_PORT} USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 node service.js`);
    console.log(`  禁用代理: PORT=${SERVICE_PORT} node service.js`);
    console.log(`  公网部署请确保已放行 TCP ${SERVICE_PORT}，否则记录服务注册校验会超时`);
    console.log(`  心跳间隔: ${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s, 测速间隔: ${Math.round(SPEED_TEST_INTERVAL_MS / 1000)}s`);

    registerProxyNode()
        .then(() => sendHeartbeat({ includeSpeedTest: false }))
        .catch(err => {
            console.error('[Registry] Initial registration/heartbeat failed:', err.message);
            console.error(`[Registry] Check whether ${PROXY_PUBLIC_BASE_URL}/health is publicly reachable and the cloud firewall/security group allows TCP ${SERVICE_PORT}`);
            process.exit(1);
        });

    setInterval(() => {
        sendHeartbeat({ includeSpeedTest: false }).catch(err => {
            console.warn('[Registry] Heartbeat failed:', err.message);
        });
    }, HEARTBEAT_INTERVAL_MS);

    setInterval(() => {
        runSpeedTest()
            .then(() => sendHeartbeat({ includeSpeedTest: false }))
            .catch(err => {
                console.warn('[Registry] Scheduled speed test failed:', err.message);
            });
    }, SPEED_TEST_INTERVAL_MS);
});
