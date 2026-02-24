// background.js
// 代理 fetch，解决 CORS 问题，并输出详细日志

// DEFAULT_PROXY_BASE 和 TRACKING_URL 从 config.js 中获取

let tasks = [];
let history = [];
let isChinaIP = null;

// ==================== Token 缓存机制 ====================
// Docker Registry token 通常只有 5 分钟有效期
// 需要缓存并在过期前自动刷新

const tokenCache = new Map(); // image -> { token, expiresAt }
const TOKEN_EXPIRY_MS = 4 * 60 * 1000; // 4 分钟（留 1 分钟缓冲）

/**
 * 获取 Docker Token（带缓存和自动刷新）
 * @param {string} image 镜像名
 * @param {boolean} forceRefresh 是否强制刷新
 * @returns {Promise<string>} token
 */
async function getCachedDockerToken(image, forceRefresh = false) {
  const now = Date.now();
  const cached = tokenCache.get(image);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  // 如果缓存存在且未过期，直接返回
  if (!forceRefresh && cached && cached.expiresAt > now) {
    console.log(`[Token] Using cached token for ${image}, expires in ${Math.round((cached.expiresAt - now) / 1000)}s`);
    return cached.token;
  }

  // 获取新 token（考虑是否使用认证）
  console.log(`[Token] Fetching new token for ${image} (forceRefresh: ${forceRefresh})`);
  const token = await getDockerToken(image, useAuth);

  // 缓存 token
  tokenCache.set(image, {
    token,
    expiresAt: now + TOKEN_EXPIRY_MS
  });

  console.log(`[Token] Token cached for ${image}, will expire in ${TOKEN_EXPIRY_MS / 1000}s`);
  return token;
}

/**
 * 刷新指定镜像的 token
 * @param {string} image 镜像名
 * @returns {Promise<string>} 新 token
 */
async function refreshToken(image) {
  console.log(`[Token] Refreshing token for ${image}`);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  return await getCachedDockerToken(image, true);
}

// ==================== Service Worker 保活机制 ====================
// Chrome Manifest V3 的 Service Worker 会在空闲约 30 秒后终止
// 使用 chrome.alarms API 实现可靠的保活机制

let activeDownloadCount = 0;
const KEEPALIVE_ALARM_NAME = 'docker-download-keepalive';

/**
 * 启动保活机制
 * 使用 chrome.alarms 实现更可靠的保活
 */
function startKeepAlive() {
  activeDownloadCount++;
  console.log('[KeepAlive] Started, active downloads:', activeDownloadCount);

  // 创建或更新 alarm（每 20 秒触发一次）
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    delayInMinutes: 0.3,  // 约 18 秒后首次触发
    periodInMinutes: 0.3  // 每 18 秒触发一次
  });
}

/**
 * 停止保活机制
 * 当所有下载任务完成时调用
 */
function stopKeepAlive() {
  activeDownloadCount--;
  console.log('[KeepAlive] Stopping, remaining downloads:', activeDownloadCount);

  if (activeDownloadCount <= 0) {
    activeDownloadCount = 0;
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME, (wasCleared) => {
      console.log('[KeepAlive] Alarm cleared:', wasCleared);
    });
  }
}

// 监听 alarm 事件
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    // 执行一个简单的操作来保持 Service Worker 活跃
    chrome.storage.local.get('__keepalive__', () => {
      console.log('[KeepAlive] Heartbeat via alarm, active downloads:', activeDownloadCount);
    });
  }
});

// ==================== 超时控制配置 ====================
const FETCH_TIMEOUT = 120000; // 单次请求超时：120 秒
const CHUNK_TIMEOUT = 60000;  // 分片下载超时：60 秒

/**
 * 检测是否需要使用代理（仅限中国出口IP）
 */
async function checkGeoLocation() {
  if (isChinaIP !== null) return isChinaIP;

  try {
    const resp = await fetch('http://ip-api.com/json/');
    const data = await resp.json();
    isChinaIP = (data.countryCode === 'CN');
    console.log(`[GeoCheck] Country: ${data.countryCode}, Use Proxy: ${isChinaIP}`);
  } catch (err) {
    console.warn('[GeoCheck] Failed to detect location, defaulting to proxy', err);
    isChinaIP = true; // 失败时默认使用代理以防万一
  }
  return isChinaIP;
}

/**
 * 上报下载信息到后端
 */
async function reportDownload(image, tag, arch) {
  // 如果 TRACKING_URL 为空，则跳过追踪
  if (!TRACKING_URL) {
    console.log(`[Track] Tracking disabled, skipping report for ${image}:${tag} (${arch})`);
    return;
  }

  try {
    await fetch(TRACKING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, tag, arch })
    });
    console.log(`[Track] Reported: ${image}:${tag} (${arch})`);
  } catch (err) {
    console.error('[Track] Failed to report download:', err);
  }
}

/**
 * 解析响应数据
 * @throws {Error} 如果响应包含 Docker Registry 错误（如 UNAUTHORIZED），抛出带状态的错误
 */
async function parseResponse(resp, responseType) {
  if (responseType === 'json') {
    const data = await resp.json();
    // 检查是否是 Docker Registry 错误响应
    if (data && data.errors && Array.isArray(data.errors)) {
      const errorMsg = data.errors.map(e => e.message || e.code).join(', ');
      const hasAuthError = data.errors.some(e => e.code === 'UNAUTHORIZED');
      if (hasAuthError) {
        const error = new Error(`401 UNAUTHORIZED: ${errorMsg}`);
        error.status = 401;
        error.isAuthError = true;
        throw error;
      }
    }
    return data;
  }
  if (responseType === 'arrayBuffer') return await resp.arrayBuffer();
  return await resp.text();
}

/**
 * 带超时控制的 fetch
 * @param {string} url 请求 URL
 * @param {Object} options fetch 选项
 * @param {number} timeout 超时时间（毫秒）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(`[Fetch] Request timeout after ${timeout}ms: ${url.substring(0, 100)}...`);
  }, timeout);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`请求超时 (${timeout / 1000}秒)`);
    }
    throw err;
  }
}

// 代理fetch通过中转服务器（Docker Registry 必须走代理以避免 CORS）
async function proxyFetch(url, options = {}, responseType = 'json', timeout = FETCH_TIMEOUT, skipCache = false) {
  // Docker Registry 相关请求必须走代理（避免 Cloudflare R2 的 CORS 问题）
  const isDockerRegistry = /docker\.io|auth\.docker\.io|cloudflare\.docker\.com|docker-images-prod/.test(url);

  let useProxy = isDockerRegistry; // Docker Registry 强制代理
  if (!isDockerRegistry) {
    useProxy = await checkGeoLocation(); // 其他请求按地理位置判断
  }

  // 定义尝试顺序
  const strategies = useProxy ? ['proxy', 'direct'] : ['direct', 'proxy'];
  const errors = [];

  // 如果需要跳过缓存，通过 HTTP header 通知代理服务器
  // 注意：不使用 URL 参数，因为 Docker Registry 可能不接受额外的查询参数
  let proxyUrl = url;
  if (skipCache) {
    options.headers = options.headers || {};
    options.headers['X-Skip-Cache'] = 'true';
  }

  console.log(`[ProxyFetch] Starting fetch for ${url}. Strategy order: ${strategies.join(' -> ')}, Force Proxy: ${isDockerRegistry}, Timeout: ${timeout}ms, SkipCache: ${skipCache}, SkipCacheByHeader: ${skipCache}`);

  for (const strategy of strategies) {
    try {
      if (strategy === 'proxy') {
        // 使用带 nocache 参数的 URL（如果需要跳过缓存）
        const actualProxyUrl = DEFAULT_PROXY_BASE + encodeURIComponent(proxyUrl);
        console.log(`[ProxyFetch] Attempting PROXY: ${actualProxyUrl}`);
        const resp = await fetchWithTimeout(actualProxyUrl, options, timeout);

        if (resp.ok) {
          console.log('[ProxyFetch] PROXY success');
          return await parseResponse(resp, responseType);
        } else {
          const errText = await resp.text().catch(() => resp.statusText);
          // 检查是否是认证错误
          if (resp.status === 401 || errText.includes('UNAUTHORIZED')) {
            const error = new Error(`401 UNAUTHORIZED: ${errText}`);
            error.status = 401;
            error.isAuthError = true;
            throw error;
          }
          throw new Error(`${resp.status} ${errText}`);
        }
      } else { // direct
        console.log(`[ProxyFetch] Attempting DIRECT: ${url}`);
        const resp = await fetchWithTimeout(url, options, timeout);

        if (resp.ok) {
          console.log('[ProxyFetch] DIRECT success');
          return await parseResponse(resp, responseType);
        } else {
          const errText = await resp.text().catch(() => resp.statusText);
          // 检查是否是认证错误
          if (resp.status === 401 || errText.includes('UNAUTHORIZED')) {
            const error = new Error(`401 UNAUTHORIZED: ${errText}`);
            error.status = 401;
            error.isAuthError = true;
            throw error;
          }
          throw new Error(`${resp.status} ${errText}`);
        }
      }
    } catch (err) {
      console.warn(`[ProxyFetch] ${strategy.toUpperCase()} failed: ${err.message}`);
      // 如果是认证错误，立即抛出，不尝试其他策略
      if (err.isAuthError) {
        console.error(`[ProxyFetch] Authentication error, not retrying with other strategy`);
        throw err;
      }
      errors.push(`${strategy.toUpperCase()}: ${err.message}`);
    }
  }

  // 若所有策略都失败
  const finalError = new Error(`All strategies failed. Details: [ ${errors.join(' | ')} ]`);
  console.error(`[ProxyFetch] ${finalError.message}`);
  throw finalError;
}

// 加载历史
chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
  tasks = data.dockerDownloadTasks || [];
  history = data.dockerDownloadHistory || [];
});

function syncTasks() {
  chrome.storage.local.set({ dockerDownloadTasks: tasks, dockerDownloadHistory: history });
  updateBadge();
}

function moveTaskToHistory(task) {
  task.history = true;
  task.updatedAt = Date.now();
  // Avoid duplicates in history
  history = history.filter(h => taskKey(h.image, h.tag, h.arch) !== taskKey(task.image, task.tag, task.arch));
  history.unshift({ ...task });
  if (history.length > 100) history.length = 100;
  tasks = tasks.filter(t => t.id !== task.id);
  syncTasks();
}

function updateBadge() {
  const count = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed').length;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#1890ff' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function taskKey(image, tag, arch) {
  return `${image}:${tag}:${arch}`;
}
function findTask(image, tag, arch) {
  return tasks.find(t => taskKey(t.image, t.tag, t.arch) === taskKey(image, tag, arch));
}

async function getDockerToken(image, useAuth = false) {
  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });

  const hasAuth = !!(auth.dockerUsername && auth.dockerPassword);

  // 如果配置了认证且请求使用认证，使用Basic Auth
  const headers = {};
  if (useAuth && hasAuth) {
    console.log(`[getDockerToken] Using Docker Hub auth for user: ${auth.dockerUsername}`);
    const credentials = btoa(`${auth.dockerUsername}:${auth.dockerPassword}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  // 尝试不同的scope
  const scopes = [
    `repository:${image}:pull`,
    `repository:${image}:pull,push`,
    `repository:${image}:*,pull`
  ];

  let lastError;

  for (const scope of scopes) {
    const url = `https://auth.docker.io/token?service=registry.docker.io&scope=${scope}`;
    console.log(`[getDockerToken] Fetching token for image: ${image}, scope: ${scope}`);
    console.log(`[getDockerToken] Token URL: ${url.replace(image, '***')}`);

    try {
      const data = await proxyFetch(url, { headers }, 'json');

      if (!data || !data.token) {
        console.log(`[getDockerToken] No token in response for scope: ${scope}`);
        continue;
      }

      console.log(`[getDockerToken] Token fetched successfully, expires_in: ${data.expires_in || 'unknown'}s`);
      console.log(`[getDockerToken] Token prefix: ${data.token.substring(0, 20)}...`);
      return data.token;
    } catch (err) {
      console.log(`[getDockerToken] Failed for scope ${scope}: ${err.message}`);
      lastError = err;

      // 如果401且配置了认证，尝试不使用认证（可能镜像是公开的）
      if (err.isAuthError && useAuth) {
        console.log(`[getDockerToken] Auth failed, trying without auth...`);
        return getDockerToken(image, false);
      }
    }
  }

  throw new Error(`Failed to get token for image: ${image}. Last error: ${lastError?.message || 'unknown'}`);
}

/**
 * 规范化架构名称到 Docker Registry 标准架构
 * @param {string} arch 输入的架构名称
 * @returns {string} 标准化的架构名称
 */
function normalizeArchitecture(arch) {
  // 架构别名映射表
  const archAliases = {
    // ARM 32位 变体
    'v7': 'arm',
    'arm/v7': 'arm',
    'arm/v6': 'arm',
    'armhf': 'arm',
    'armel': 'arm',
    'arm-32': 'arm',

    // ARM 64位 变体
    'aarch64': 'arm64',
    'arm64/v8': 'arm64',
    'arm/v8': 'arm64',

    // AMD64/x86 变体
    'x86_64': 'amd64',
    'x86-64': 'amd64',
    'x64': 'amd64',

    // 386 变体
    'i386': '386',
    'i686': '386',
    'x86': '386',

    // 其他架构保持不变
    'ppc64le': 'ppc64le',
    's390x': 's390x',
    'riscv64': 'riscv64'
  };

  // 如果输入已经是标准架构，直接返回
  if (['amd64', 'arm64', 'arm', '386', 'ppc64le', 's390x', 'riscv64'].includes(arch)) {
    return arch;
  }

  // 查找别名映射
  return archAliases[arch] || arch;
}

/**
 * 获取 DockerHub 镜像的 manifest/config/layers，支持多架构
 * @param {string} image 镜像名（如 library/ubuntu）
 * @param {string} tagOrDigest 镜像tag或digest（如 latest）
 * @param {string} arch 架构（如 amd64、arm64、arm、v7）
 * @returns {Promise<object>} manifest对象
 */
async function fetchManifest(image, tagOrDigest, arch = 'amd64') {
  // 规范化架构名称（处理 v7 → arm, arm/v7 → arm 等）
  arch = normalizeArchitecture(arch);
  console.log(`[fetchManifest] Normalized architecture: ${arch}`);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });

  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);
  const token = await getDockerToken(image, useAuth);

  let url = `https://registry-1.docker.io/v2/${image}/manifests/${tagOrDigest}`;

  // 尝试获取manifest
  let manifest = await proxyFetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    }
  }, 'json');

  // 如果401且配置了认证，可能镜像是公开的，尝试不使用认证
  if (manifest && manifest.error && manifest.error.toLowerCase().includes('unauthorized') && useAuth) {
    console.log('[fetchManifest] Auth failed, trying without auth...');
    const publicToken = await getDockerToken(image, false);
    manifest = await proxyFetch(url, {
      headers: {
        'Authorization': `Bearer ${publicToken}`,
        'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
      }
    }, 'json');
  }
  let tryCount = 0;
  while (!manifest.layers && manifest.manifests && tryCount < 5) {
    // 使用更灵活的匹配逻辑
    const found = manifest.manifests.find(m => {
      if (!m.platform) return false;

      // 优先精确匹配 architecture
      if (m.platform.architecture === arch) return true;

      // 特殊处理：如果请求 arm，也匹配 arm/v7 等
      if (arch === 'arm' && m.platform.architecture === 'arm') {
        // 检查 variant 是否兼容（v6, v7 等）
        const variant = m.platform.variant || '';
        if (!variant || ['v6', 'v7', 'v5'].includes(variant)) {
          console.log(`[fetchManifest] Found arm with variant: ${variant}`);
          return true;
        }
      }

      return false;
    });

    if (!found) {
      // 列出所有可用的架构，方便调试
      const availableArchs = manifest.manifests
        .map(m => m.platform ? `${m.platform.architecture}${m.platform.variant ? '/' + m.platform.variant : ''}` : 'unknown')
        .join(', ');
      throw new Error(`未找到匹配架构的manifest: ${arch} (可用架构: ${availableArchs})`);
    }

    url = `https://registry-1.docker.io/v2/${image}/manifests/${found.digest}`;
    manifest = await proxyFetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': found.mediaType || 'application/vnd.docker.distribution.manifest.v2+json'
      }
    }, 'json');
    tryCount++;
  }
  if (!manifest.layers) throw new Error('manifest.layers is not iterable，实际值：' + JSON.stringify(manifest));
  return manifest;
}

/**
 * 下载单个layer（支持自动刷新 token 和重试）
 * @param {string} image 镜像名称
 * @param {Object} layer layer对象
 * @param {string} token 认证token（可能过期，会自动刷新）
 * @param {Function} progressCallback 进度回调函数
 * @returns {Promise<ArrayBuffer>} layer的二进制数据
 */
async function downloadSingleLayer(image, layer, token, progressCallback) {
  const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
  const timeout = 300000; // 大文件下载使用 5 分钟超时
  const shortDigest = layer.digest.substring(7, 19);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  // 第一次尝试
  try {
    console.log(`[Download] Downloading layer ${shortDigest}...`);
    console.log(`[Download] Token length: ${token.length}`);
    return await proxyFetch(url, { headers: { 'Authorization': `Bearer ${token}` } }, 'arrayBuffer', timeout, false);
  } catch (err) {
    // 如果是认证错误（401），尝试刷新 token 后重试，并跳过缓存
    if (err.isAuthError || (err.message && (err.message.includes('401') || err.message.includes('UNAUTHORIZED')))) {
      console.log(`[Download] Got 401 for layer ${shortDigest}, refreshing token and skipping cache...`);

      // 刷新 token（考虑是否使用认证）
      const newToken = await getDockerToken(image, useAuth);

      // 使用新 token 重试，并跳过代理服务器缓存
      console.log(`[Download] Retrying layer ${shortDigest} with new token (skip cache)...`);
      try {
        return await proxyFetch(url, { headers: { 'Authorization': `Bearer ${newToken}` } }, 'arrayBuffer', timeout, true);
      } catch (retryErr) {
        console.error(`[Download] Retry failed for layer ${shortDigest}:`, retryErr.message);
        throw retryErr;
      }
    }

    // 其他错误直接抛出
    console.error(`[Download] Failed to download layer ${shortDigest}:`, err.message);
    throw err;
  }
}

async function runDownloadTask(task) {
  console.log('[Docker Download Plugin] Starting runDownloadTask for:', task.image, task.tag, task.arch);

  // 启动保活机制，防止 Service Worker 被终止
  startKeepAlive();

  task.status = 'downloading';
  task.finished = 0;
  task.running = 0;
  task.pending = task.total;
  task.layers.forEach(l => l.status = 'pending');
  task.startTime = Date.now();
  syncTasks();
  try {
    // 上報下載信息
    reportDownload(task.image, task.tag, task.arch);

    console.log('[Docker Download Plugin] Getting token for:', task.image);
    // 使用缓存的 token 获取函数，会自动检查过期
    let token = await getCachedDockerToken(task.image);
    const layersData = [];
    const downloadedLayers = [];
    let parentId = '';

    // 首先下载config文件
    console.log('[Docker Download Plugin] Downloading config file...');
    console.log('[Docker Download Plugin] Config digest:', task.manifest.config.digest);
    try {
      const configBuf = await downloadSingleLayer(task.image, { digest: task.manifest.config.digest }, token);
      downloadedLayers.push({
        layerData: configBuf,
        layerId: 'config',
        digest: task.manifest.config.digest
      });
      console.log('[Docker Download Plugin] Config file downloaded');
    } catch (err) {
      console.error('[Docker Download Plugin] Config download failed:', err);
      task.status = 'failed';
      task.errorMessage = `下载配置文件失败: ${err.message}`;
      moveTaskToHistory(task);
      return;
    }

    for (let i = 0; i < task.layers.length; i++) {
      if (task.canceled) {
        throw new Error('Task canceled by user');
      }
      task.layers[i].status = 'downloading';
      task.running = 1;
      syncTasks();

      // 在下载每个 layer 前，检查 token 是否即将过期，主动刷新
      token = await getCachedDockerToken(task.image);
      console.log('[Docker Download Plugin] Token refreshed before downloading layer:', task.layers[i].digest.substring(0, 16));

      // 向content-script发送下载进度更新
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'download-status-update',
            status: 'progress',
            message: `正在下载 ${task.image}:${task.tag} (${task.arch})，进度: ${i + 1}/${task.layers.length}`
          });
        }
      });
      let retryCount = 0;
      const maxRetries = 3;
      let lastError = null;

      while (retryCount < maxRetries) {
        try {
          // 每次重试前都获取最新的 token（可能是刷新后的）
          token = await getCachedDockerToken(task.image);

          // 下载单层（内部会自动处理 401 并刷新 token）
          const buf = await downloadSingleLayer(task.image, task.layers[i], token);

          // 生成layer ID
          const layerId = await sha256Hash(`${parentId}\n${task.layers[i].digest}\n`);
          parentId = layerId;

          // 保存下载的数据
          downloadedLayers.push({
            layerData: buf,
            layerId: layerId,
            digest: task.layers[i].digest
          });

          task.layers[i].status = 'done';
          lastError = null;
          break; // Success, exit retry loop
        } catch (err) {
          lastError = err;
          retryCount++;
          console.warn(`[Download] Layer ${i} failed (Attempt ${retryCount}/${maxRetries}): ${err.message}`);

          if (retryCount < maxRetries) {
            // 如果是认证错误，强制刷新 token
            if (err.isAuthError || (err.message && err.message.includes('401'))) {
              console.log(`[Download] Forcing token refresh after 401 error...`);
              token = await refreshToken(task.image);
            }
            // 等待后重试
            await new Promise(r => setTimeout(r, 1000 * retryCount)); // Exponential backoff-ish
          }
        }
      }

      if (lastError) {
        task.layers[i].status = 'failed';
        task.status = 'failed';
        task.errorMessage = `下载层 ${task.layers[i].digest.substring(7, 19)} 失败 (重试${maxRetries}次): ${lastError.message}`;
        moveTaskToHistory(task);

        // 向content-script发送下载失败消息
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'download-status-update',
              status: 'error',
              message: `下载失败: ${lastError.message}`
            });
          }
        });

        throw lastError;
      }
      task.finished = task.layers.filter(l => l.status === 'done').length;
      task.running = 0;
      task.pending = task.layers.filter(l => l.status === 'pending').length;
      syncTasks();
    }

    // 打包为tar文件
    task.status = 'packaging';
    syncTasks();

    // 向content-script发送打包状态更新
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'download-status-update',
          status: 'progress',
          message: `${task.image}:${task.tag} (${task.arch}) 下载完成，正在打包文件...`
        });
      }
    });

    try {
      // 向content-script发送打包状态更新
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'download-status-update',
            status: 'progress',
            message: `${task.image}:${task.tag} (${task.arch}) 下载完成，正在打包文件...`
          });
        }
      });

      // 使用全局函数packToTar（从docker-download.js中获取）

      // 打包为tar文件
      const tarBlob = await packToTar(downloadedLayers, task.manifest, task.image, task.tag);

      // 保存文件
      const filename = `${task.image.replace(/\//g, '-')}-${task.tag}-${task.arch}.tar`;

      // 方案修改：SW无法使用URL.createObjectURL，且Data URL受限于字符串长度。
      // 使用IndexedDB存储Blob，然后打开一个扩展页面(download.html)来读取Blob并触发下载。

      const blobKey = `task-${task.id}`;
      console.log('[Download] Storing blob to IDB key:', blobKey);

      await storeBlobInDB(blobKey, tarBlob);

      // 打开中转页面触发下载
      // 不需要active: true，后台打开即可？Chrome限制可能要求active，先试后台
      chrome.tabs.create({
        url: `download.html?key=${encodeURIComponent(blobKey)}&filename=${encodeURIComponent(filename)}`,
        active: false
      }, (tab) => {
        // 任务在tab中处理
        // 我们在这里标记background任务完成
        // 实际上无法得知saveAs是否取消，但至少打包完成
        console.log('[Download] Opened download helper tab:', tab.id);

        task.status = 'completed';
        task.endTime = Date.now();
        moveTaskToHistory(task);

        // 向content-script发送下载成功消息 (打包完成)
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'download-status-update',
              status: 'success',
              message: `打包完成，正在启动下载: ${task.image}:${task.tag} (${task.arch})`
            });
          }
        });
      });

    } catch (error) {
      // 向content-script发送打包失败消息
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'download-status-update',
            status: 'error',
            message: `打包文件失败: ${error.message}`
          });
        }
      });

      throw error;
    }

    task.status = 'completed';
    task.finished = task.total;
    task.running = 0;
    task.pending = 0;
    task.endTime = Date.now();
    syncTasks();
  } catch (err) {
    task.status = 'failed';
    task.errorMessage = err.message || '下载过程中发生未知错误';
    moveTaskToHistory(task);
  } finally {
    // 无论成功或失败，都要停止保活机制
    stopKeepAlive();
  }
}

/**
 * 计算SHA256哈希
 * @param {string} data 要计算哈希的字符串
 * @returns {Promise<string>} 哈希结果
 */
async function sha256Hash(data) {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Docker Download Plugin] Received message:', msg);

  if (msg.type === 'start-download') {
    console.log('[Docker Download Plugin] Received start-download for:', msg.image, msg.tag, msg.arch);

    if (findTask(msg.image, msg.tag, msg.arch)) {
      sendResponse({ ok: false, reason: '任务已存在' });
      return;
    }

    // 1. 立即创建一个“准备中”的任务，确保用户在弹出层能立即看到
    const taskId = Date.now() + Math.random();
    const task = {
      id: taskId,
      image: msg.image, tag: msg.tag, arch: msg.arch,
      total: 0,
      finished: 0, running: 0, pending: 0,
      status: 'preparing', // 新增状态：准备中
      layers: [],
      createdAt: Date.now(), updatedAt: Date.now(),
      startTime: Date.now(),
      history: false
    };
    tasks.push(task);
    syncTasks();
    updateBadge(); // 更新图标角标

    // 2. 尝试自动打开插件弹出层（需要 Chrome 127+）
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch(err => {
        console.warn('[Docker Download Plugin] Failed to open popup automatically:', err);
      });
    }

    // 3. 异步获取清单并开始下载
    fetchManifest(msg.image, msg.tag, msg.arch).then(manifest => {
      console.log('[Docker Download Plugin] Manifest fetched, updating task');
      task.status = 'downloading';
      task.manifest = manifest;
      task.total = manifest.layers.length;
      task.pending = manifest.layers.length;
      task.layers = manifest.layers.map(l => ({ digest: l.digest, status: 'pending' }));
      task.updatedAt = Date.now();
      syncTasks();

      // 启动下载流程
      setTimeout(() => {
        runDownloadTask(task).catch(err => {
          console.error('[Docker Download Plugin] Download task failed:', err);
          task.status = 'failed';
          task.errorMessage = err.message;
          moveTaskToHistory(task);
        });
      }, 0);
    }).catch(err => {
      console.error('[Docker Download Plugin] Manifest fetch failed:', err);
      task.status = 'failed';
      task.errorMessage = `获取清单失败: ${err.message}`;
      moveTaskToHistory(task);
    });

    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'retry-download') {
    const h = history.find(h => taskKey(h.image, h.tag, h.arch) === taskKey(msg.image, msg.tag, msg.arch));
    if (h) {
      h.history = false;
      h.status = 'downloading';
      h.finished = 0;
      h.running = 0;
      h.pending = h.total;
      h.layers.forEach(l => l.status = 'pending');
      h.id = Date.now() + Math.random();
      h.startTime = Date.now();
      h.updatedAt = Date.now();
      tasks.push(h);
      history = history.filter(x => x !== h);
      syncTasks();
      runDownloadTask(h);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: '历史任务不存在' });
    }
    return true;
  }
  if (msg.type === 'delete-history') {
    history = history.filter(h => !(h.image === msg.image && h.tag === msg.tag && h.arch === msg.arch));
    syncTasks();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'get-tasks') {
    console.log('[Docker Download Plugin] Sending tasks:', tasks.length, 'history:', history.length);
    sendResponse({ tasks, history });
    return true;
  }
  if (msg.type === 'delete-active-task') {
    // 查找并删除/取消active active任务
    const activeTaskIndex = tasks.findIndex(t => t.image === msg.image && t.tag === msg.tag && t.arch === msg.arch);
    if (activeTaskIndex !== -1) {
      const task = tasks[activeTaskIndex];
      // 标记为已取消，runDownloadTask 循环中会检测状态
      task.canceled = true;
      // 从active任务列表移除
      tasks.splice(activeTaskIndex, 1);
      // 不移入Active历史，直接丢弃? 或者移入History标记为Canceled?
      // 用户意图是“删除”，所以应该彻底清除
      syncTasks();
      updateBadge();
      console.log('[Docker Download Plugin] Task canceled and removed:', msg.image);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: 'Task not found' });
    }
    return true;
  }
  if (msg.type === 'proxy-fetch') {
    proxyFetch(msg.url, msg.options, msg.responseType)
      .then(body => {
        if (msg.responseType === 'arrayBuffer') {
          sendResponse({ ok: true, body: Array.from(new Uint8Array(body)) });
        } else {
          sendResponse({ ok: true, body: body });
        }
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
});

// IndexedDB Helper for Background
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('docker-plugin-db', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeBlobInDB(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const store = tx.objectStore('blobs');
    const req = store.put(blob, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}