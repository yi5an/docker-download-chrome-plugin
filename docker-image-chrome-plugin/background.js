// background.js
// 代理 fetch，解决 CORS 问题，并输出详细日志

console.log('[Background] Script starting...');

// 检查依赖
console.log('[Background] getFallbackProxyConfig type:', typeof getFallbackProxyConfig);
console.log('[Background] DEFAULT_PROXY_BASE:', DEFAULT_PROXY_BASE);
console.log('[Background] Proxy registry service:', typeof getProxyRegistryServiceUrl === 'function' ? getProxyRegistryServiceUrl() : 'unavailable');

// DEFAULT_PROXY_BASE 和代理记录服务配置从 config.js 中获取

let tasks = [];
let history = [];
let isChinaIP = null;
let geoInfo = null;

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
async function getCachedDockerToken(image, forceRefresh = false, proxyRoute = null, requestMeta = null) {
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
  const token = await getDockerToken(image, useAuth, proxyRoute, requestMeta);

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
async function refreshToken(image, proxyRoute = null, requestMeta = null) {
  console.log(`[Token] Refreshing token for ${image}`);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  return await getCachedDockerToken(image, true, proxyRoute, requestMeta);
}

// ==================== Service Worker 保活机制 ====================
// Chrome Manifest V3 的 Service Worker 会在空闲约 30 秒后终止
// 使用 chrome.alarms API 实现可靠的保活机制

let activeDownloadCount = 0;
const KEEPALIVE_ALARM_NAME = 'docker-download-keepalive';

function ensureTaskKeepAlive(task) {
  if (task && task.keepAliveStarted) {
    return;
  }
  startKeepAlive();
  if (task) {
    task.keepAliveStarted = true;
  }
}

function releaseTaskKeepAlive(task) {
  if (task && !task.keepAliveStarted) {
    return;
  }
  stopKeepAlive();
  if (task) {
    task.keepAliveStarted = false;
  }
}

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
const FETCH_TIMEOUT = 1800000; // 单次请求超时：1800 秒，与代理服务器保持一致
const LAYER_DOWNLOAD_CONCURRENCY = 2; // 稳定性优先：降低单镜像层并发下载数
const GEO_LOOKUP_TIMEOUT_MS = 8000;
const PROXY_REGISTRY_TIMEOUT_MS = 8000;
const LIFECYCLE_REPORT_TIMEOUT_MS = 5000;
const PREPARING_STAGE_TIMEOUT_MS = 30000;

/**
 * 检测是否需要使用代理（仅限中国出口IP）
 */
async function checkGeoLocation() {
  if (isChinaIP !== null) return isChinaIP;

  try {
    const resp = await fetchWithTimeout('http://ip-api.com/json/', {}, GEO_LOOKUP_TIMEOUT_MS);
    const data = await resp.json();
    if (resp._cleanupTimeout) resp._cleanupTimeout();
    geoInfo = data;
    isChinaIP = (data.countryCode === 'CN');
    console.log(`[GeoCheck] Country: ${data.countryCode}, Use Proxy: ${isChinaIP}`);
  } catch (err) {
    console.warn('[GeoCheck] Failed to detect location, defaulting to proxy', err);
    isChinaIP = true; // 失败时默认使用代理以防万一
    geoInfo = {
      countryCode: 'CN',
      country: 'Unknown'
    };
  }
  return isChinaIP;
}

/**
 * 获取地理信息
 */
async function getGeoInfo() {
  if (!geoInfo) {
    await checkGeoLocation();
  }
  return geoInfo || {};
}

function buildRegistryUrl(pathname) {
  if (!PROXY_REGISTRY_CONFIG || typeof getProxyRegistryServiceUrl !== 'function') {
    return '';
  }
  return `${getProxyRegistryServiceUrl()}${pathname}`;
}

async function requestBestProxy(downloadMeta) {
  const geo = await getGeoInfo();
  const registryUrl = buildRegistryUrl(PROXY_REGISTRY_CONFIG.select);

  if (!registryUrl) {
    throw new Error('代理记录服务未配置');
  }

  try {
    const url = new URL(registryUrl);
    if (geo.countryCode) {
      url.searchParams.set('countryCode', geo.countryCode);
    }
    if (downloadMeta.image) {
      url.searchParams.set('image', downloadMeta.image);
    }
    if (downloadMeta.tag) {
      url.searchParams.set('tag', downloadMeta.tag);
    }
    if (downloadMeta.arch) {
      url.searchParams.set('arch', downloadMeta.arch);
    }

    const resp = await fetchWithTimeout(url.toString(), {}, PROXY_REGISTRY_TIMEOUT_MS);
    if (!resp.ok) {
      const errText = await readErrorBody(resp);
      throw new Error(`代理记录服务返回 ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    if (resp._cleanupTimeout) resp._cleanupTimeout();
    if (data && data.proxy && data.proxy.baseUrl) {
      return data.proxy;
    }
    throw new Error('代理记录服务没有返回已注册代理');
  } catch (err) {
    console.error('[ProxyRegistry] Failed to acquire registered proxy:', err.message);
    throw new Error(`无法从代理记录服务获取代理: ${err.message}`);
  }
}

async function reportDownloadLifecycle(eventType, payload) {
  if (!PROXY_REGISTRY_CONFIG || typeof getProxyRegistryServiceUrl !== 'function') {
    return;
  }

  const endpointMap = {
    start: PROXY_REGISTRY_CONFIG.downloadsStart,
    complete: PROXY_REGISTRY_CONFIG.downloadsComplete,
    fail: PROXY_REGISTRY_CONFIG.downloadsFail
  };

  const endpoint = endpointMap[eventType];
  if (!endpoint) return;

  try {
    const resp = await fetchWithTimeout(buildRegistryUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, LIFECYCLE_REPORT_TIMEOUT_MS);
    if (resp._cleanupTimeout) resp._cleanupTimeout();
    console.log(`[Track] Reported ${eventType}: ${payload.image}:${payload.tag} (${payload.arch})`);
  } catch (err) {
    console.error(`[Track] Failed to report ${eventType}:`, err);
  }
}

/**
 * 解析响应数据
 * @throws {Error} 如果响应包含 Docker Registry 错误（如 UNAUTHORIZED），抛出带状态的错误
 */
async function parseResponse(resp, responseType) {
  try {
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
  } finally {
    // body 读取完成（无论成功还是失败），清理超时计时器
    if (resp._cleanupTimeout) resp._cleanupTimeout();
  }
}

// 读取错误响应体并清理超时
async function readErrorBody(resp) {
  try {
    return await resp.text();
  } catch (_) {
    return resp.statusText;
  } finally {
    if (resp._cleanupTimeout) resp._cleanupTimeout();
  }
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
    // 注意：不在这里 clearTimeout
    // 超时保护需要覆盖整个请求生命周期（包括 body 读取阶段）
    // 调用方负责在 body 读取完成后调用 resp._cleanupTimeout()
    resp._cleanupTimeout = () => clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[Fetch] Request aborted (timeout): ${url.substring(0, 100)}`);
      throw new Error(`请求超时 (${timeout / 1000}秒)`);
    }
    console.error(`[Fetch] Request failed:`, {
      url: url.substring(0, 100),
      error: err.message,
      name: err.name,
      stack: err.stack ? err.stack.substring(0, 200) : 'no stack'
    });
    throw err;
  }
}

// 代理fetch通过中转服务器。
// 一旦调用方明确要求走代理，就严格只走代理，不再回退直连。
async function proxyFetch(url, options = {}, responseType = 'json', timeout = FETCH_TIMEOUT, skipCache = false, strategyMode = 'auto', proxyRoute = null, requestMeta = null) {
  const isDockerRegistry = /docker\.io|auth\.docker\.io|cloudflare\.docker\.com|docker-images-prod\//.test(url);
  const isCloudflareRegistry = /production\.cloudflare\.docker\.com/.test(url);
  const hasExplicitProxyRoute = !!(proxyRoute && (proxyRoute.baseUrl || proxyRoute.base));
  const forceProxy = hasExplicitProxyRoute || strategyMode === 'proxy-only';

  // 检测地域（会话级别缓存）
  const isChina = await checkGeoLocation();

  let useProxy = isChina;

  // 检测是否需要切换代理（连续502错误时切换）
  let currentProxyConfig = proxyRoute || getFallbackProxyConfig(isChina);
  const fiftyTwoErrors = await chrome.storage.local.get(['proxyFiftyTwoErrors']) || { proxyFiftyTwoErrors: 0 };

  // 如果检测到连续3次502错误，尝试切换到另一个代理
  if (fiftyTwoErrors.proxyFiftyTwoErrors >= 3) {
    const newIsChina = !isChina;
    currentProxyConfig = proxyRoute || getFallbackProxyConfig(newIsChina);
    console.log(`[ProxyFetch] Detected consecutive 502 errors, switching from ${isChina ? 'China' : 'Overseas'} to ${newIsChina ? 'China' : 'Overseas'} proxy`);

    // 重置计数
    chrome.storage.local.set({ proxyFiftyTwoErrors: 0 });
  }

  // 定义尝试顺序
  // Docker Hub 相关请求也优先直连，只有直连失败才回退代理。
  const preferDirect = isDockerRegistry || isCloudflareRegistry || !useProxy;
  let strategies = preferDirect ? ['direct', 'proxy'] : ['proxy', 'direct'];
  if (forceProxy) {
    strategies = ['proxy'];
  } else if (strategyMode === 'direct-only') {
    strategies = ['direct'];
  } else if (strategyMode === 'proxy-only') {
    strategies = ['proxy'];
  }
  const errors = [];

  // 如果需要跳过缓存，通过 HTTP header 通知代理服务器
  // 注意：不使用 URL 参数，因为 Docker Registry 可能不接受额外的查询参数
  let proxyUrl = url;
  if (skipCache) {
    options.headers = options.headers || {};
    options.headers['X-Skip-Cache'] = 'true';
  }
  if (requestMeta) {
    options.headers = options.headers || {};
    if (requestMeta.downloadId) options.headers['X-Download-Id'] = requestMeta.downloadId;
    if (requestMeta.image) options.headers['X-Image'] = requestMeta.image;
    if (requestMeta.tag) options.headers['X-Tag'] = requestMeta.tag;
    if (requestMeta.arch) options.headers['X-Arch'] = requestMeta.arch;
  }

  console.log(`[ProxyFetch] Starting fetch for ${url}. Strategy order: ${strategies.join(' -> ')}, StrategyMode: ${strategyMode}, ForcedProxy: ${forceProxy}, DockerHubRequest: ${isDockerRegistry || isCloudflareRegistry}, Timeout: ${timeout}ms, SkipCache: ${skipCache}, SkipCacheByHeader: ${skipCache}`);

  // 根据地域获取动态代理配置
  // 注意：502错误检测和代理切换已在前面处理（第247-257行）
  let proxyConfig = currentProxyConfig || getFallbackProxyConfig(isChina);
  const proxyBaseUrl = proxyConfig.baseUrl || proxyConfig.base || '';
  const proxyPath = proxyConfig.proxyPath || proxyConfig.proxy || '/proxy?url=';
  let dynamicProxyBase = `${proxyBaseUrl}${proxyPath}`;

  console.log(`[ProxyFetch] Using proxy: ${dynamicProxyBase}`);

  async function recordDirectFailure(errorMessage) {
    if (!(isDockerRegistry || isCloudflareRegistry)) return;
    try {
      const existing = await chrome.storage.local.get(['directFetchFailures']);
      const failures = existing.directFetchFailures || [];
      failures.unshift({
        url,
        error: errorMessage,
        timeout,
        skipCache,
        ts: Date.now()
      });
      if (failures.length > 20) failures.length = 20;
      chrome.storage.local.set({ directFetchFailures: failures });
    } catch (storageError) {
      console.warn('[ProxyFetch] Failed to persist direct fetch failure:', storageError);
    }
  }

  async function recordProxyUsage(strategy, targetUrl, status = 'ok') {
    try {
      const existing = await chrome.storage.local.get(['proxyUsageLog']);
      const entries = existing.proxyUsageLog || [];
      entries.unshift({
        strategy,
        url: targetUrl,
        status,
        ts: Date.now()
      });
      if (entries.length > 50) entries.length = 50;
      chrome.storage.local.set({ proxyUsageLog: entries });
    } catch (storageError) {
      console.warn('[ProxyFetch] Failed to persist proxy usage log:', storageError);
    }
  }

  for (const strategy of strategies) {
    try {
      if (strategy === 'proxy') {
        // 使用带 nocache 参数的 URL（如果需要跳过缓存）
        const actualProxyUrl = dynamicProxyBase + encodeURIComponent(proxyUrl);
        console.log(`[ProxyFetch] Attempting PROXY: ${actualProxyUrl}`);
        const resp = await fetchWithTimeout(actualProxyUrl, options, timeout);

        if (resp.ok) {
          console.log('[ProxyFetch] PROXY success');
          await recordProxyUsage('proxy', actualProxyUrl);
          return await parseResponse(resp, responseType);
        } else {
          const errText = await readErrorBody(resp);
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
          await recordProxyUsage('direct', url);
          return await parseResponse(resp, responseType);
        } else {
          const errText = await readErrorBody(resp);
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
      if (strategy === 'direct') {
        await recordDirectFailure(err.message);
      } else if (strategy === 'proxy') {
        await recordProxyUsage('proxy', dynamicProxyBase + encodeURIComponent(proxyUrl), 'failed');
      }
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

  // 如果是502错误，增加计数
  if (finalError.message.includes('502') || finalError.message.includes('Bad Gateway') || finalError.message.includes('请求超时 (300秒)')) {
    const currentCount = await chrome.storage.local.get(['proxyFiftyTwoErrors']) || { proxyFiftyTwoErrors: 0 };
    const newCount = currentCount.proxyFiftyTwoErrors + 1;
    chrome.storage.local.set({ proxyFiftyTwoErrors: newCount });
    console.log(`[ProxyFetch] 502 error count increased to ${newCount}`);
  }

  throw finalError;
}

// 加载历史
chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
  tasks = data.dockerDownloadTasks || [];
  history = data.dockerDownloadHistory || [];
  reconcilePersistedTasks();
});

function isDockerHubTagsUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'hub.docker.com' && /\/tags(\/|$)/.test(parsed.pathname);
  } catch (err) {
    console.warn('[ContentScript] Failed to parse URL:', url, err);
    return false;
  }
}

async function ensureContentScriptInjected(tabId, url, reason = 'unknown') {
  if (!tabId || !isDockerHubTagsUrl(url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js']
    });
    console.log(`[ContentScript] Injected content scripts into tab ${tabId} (${reason}): ${url}`);
  } catch (err) {
    console.warn(`[ContentScript] Injection skipped/failed for tab ${tabId} (${reason}):`, err?.message || err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const targetUrl = changeInfo.url || tab.url;
  if (changeInfo.status === 'complete' || changeInfo.url) {
    ensureContentScriptInjected(tabId, targetUrl, `tabs.onUpdated:${changeInfo.status || 'url'}`);
  }
});

function reconcilePersistedTasks() {
  const activeStatuses = new Set(['preparing', 'downloading', 'packing', 'packaging']);
  const staleTasks = tasks.filter(task => activeStatuses.has(task.status) && !task.history);
  if (!staleTasks.length) {
    return;
  }

  for (const task of staleTasks) {
    task.status = 'failed';
    task.errorMessage = task.errorMessage || '扩展后台已重启，任务已中断';
    task.running = 0;
    task.pending = 0;
    task.updatedAt = Date.now();
    task.endTime = Date.now();
    task.keepAliveStarted = false;
    history = history.filter(h => taskKey(h.image, h.tag, h.arch) !== taskKey(task.image, task.tag, task.arch));
    history.unshift({ ...task, history: true });
  }

  if (history.length > 100) {
    history.length = 100;
  }
  tasks = tasks.filter(task => !staleTasks.includes(task));
  syncTasks();
}

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

function notifyActiveTabDownloadStatus(message, status = 'progress') {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'download-status-update',
        status,
        message
      });
    }
  });
}

function openDownloadHelperTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tab || !tab.id) {
        reject(new Error('download helper tab was not created'));
        return;
      }
      resolve(tab);
    });
  });
}

function finalizeCompletedTask(task) {
  if (!task || task.history || task.status === 'completed') {
    return;
  }

  task.status = 'completed';
  task.finished = task.total;
  task.running = 0;
  task.pending = 0;
  task.errorMessage = '';
  task.endTime = Date.now();
  task.updatedAt = Date.now();
  moveTaskToHistory(task);
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

async function getDockerToken(image, useAuth = false, proxyRoute = null, requestMeta = null) {
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
      const data = await proxyFetch(url, { headers }, 'json', FETCH_TIMEOUT, false, 'proxy-only', proxyRoute, requestMeta);

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
        return getDockerToken(image, false, proxyRoute, requestMeta);
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
function parseArchitectureSpec(arch) {
  const normalized = (arch || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^(linux|windows|darwin)\//, '');

  if (!normalized) {
    return {
      original: arch,
      normalized: 'amd64',
      architecture: 'amd64',
      variant: ''
    };
  }

  if (normalized === 'x64' || normalized.includes('amd64') || normalized.includes('x86_64') || normalized.includes('x86-64')) {
    return {
      original: arch,
      normalized: 'amd64',
      architecture: 'amd64',
      variant: ''
    };
  }

  if (normalized.includes('aarch64') || normalized.includes('arm64')) {
    const variantMatch = normalized.match(/arm64\/(v\d+)/);
    const variant = variantMatch ? variantMatch[1] : '';
    return {
      original: arch,
      normalized: variant ? `arm64/${variant}` : 'arm64',
      architecture: 'arm64',
      variant
    };
  }

  if (/^arm\/v\d+/.test(normalized)) {
    const variant = normalized.split('/')[1] || '';
    return {
      original: arch,
      normalized: variant ? `arm/${variant}` : 'arm',
      architecture: 'arm',
      variant
    };
  }

  if (['armhf', 'armel', 'arm-32', 'arm'].includes(normalized)) {
    return {
      original: arch,
      normalized: 'arm',
      architecture: 'arm',
      variant: ''
    };
  }

  if (['i386', 'i686', 'x86', '386'].includes(normalized)) {
    return {
      original: arch,
      normalized: '386',
      architecture: '386',
      variant: ''
    };
  }

  if (['ppc64le', 's390x', 'riscv64'].includes(normalized)) {
    return {
      original: arch,
      normalized,
      architecture: normalized,
      variant: ''
    };
  }

  return {
    original: arch,
    normalized,
    architecture: normalized,
    variant: ''
  };
}

/**
 * 获取 DockerHub 镜像的 manifest/config/layers，支持多架构
 * @param {string} image 镜像名（如 library/ubuntu）
 * @param {string} tagOrDigest 镜像tag或digest（如 latest）
 * @param {string} arch 架构（如 amd64、arm64、arm、v7）
 * @returns {Promise<object>} manifest对象
 */
async function fetchManifest(image, tagOrDigest, arch = 'amd64', proxyRoute = null, requestMeta = null) {
  const requestedArch = parseArchitectureSpec(arch);
  console.log(`[fetchManifest] Requested architecture: ${requestedArch.normalized}`);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });

  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);
  const token = await getDockerToken(image, useAuth, proxyRoute, requestMeta);

  let url = `https://registry-1.docker.io/v2/${image}/manifests/${tagOrDigest}`;

  // 尝试获取manifest
  let manifest = await proxyFetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    }
  }, 'json', FETCH_TIMEOUT, false, 'proxy-only', proxyRoute, requestMeta);

  // 如果401且配置了认证，可能镜像是公开的，尝试不使用认证
  if (manifest && manifest.error && manifest.error.toLowerCase().includes('unauthorized') && useAuth) {
    console.log('[fetchManifest] Auth failed, trying without auth...');
    const publicToken = await getDockerToken(image, false, proxyRoute, requestMeta);
    manifest = await proxyFetch(url, {
      headers: {
        'Authorization': `Bearer ${publicToken}`,
        'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
      }
    }, 'json', FETCH_TIMEOUT, false, 'proxy-only', proxyRoute, requestMeta);
  }
  let tryCount = 0;
  while (!manifest.layers && manifest.manifests && tryCount < 5) {
    // 使用更灵活的匹配逻辑
    const found = manifest.manifests.find(m => {
      if (!m.platform) return false;
      const manifestArch = (m.platform.architecture || '').toLowerCase();
      const manifestVariant = (m.platform.variant || '').toLowerCase();

      if (manifestArch !== requestedArch.architecture) {
        return false;
      }

      if (requestedArch.variant) {
        return manifestVariant === requestedArch.variant;
      }

      if (requestedArch.architecture === 'arm') {
        if (!manifestVariant || ['v5', 'v6', 'v7'].includes(manifestVariant)) {
          console.log(`[fetchManifest] Found arm with compatible variant: ${manifestVariant || 'none'}`);
          return true;
        }
        return false;
      }

      return true;
    });

    if (!found) {
      // 列出所有可用的架构，方便调试
      const availableArchs = manifest.manifests
        .map(m => m.platform ? `${m.platform.architecture}${m.platform.variant ? '/' + m.platform.variant : ''}` : 'unknown')
        .join(', ');
      throw new Error(`未找到匹配架构的manifest: ${requestedArch.normalized} (可用架构: ${availableArchs})`);
    }

    url = `https://registry-1.docker.io/v2/${image}/manifests/${found.digest}`;
    manifest = await proxyFetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': found.mediaType || 'application/vnd.docker.distribution.manifest.v2+json'
      }
    }, 'json', FETCH_TIMEOUT, false, 'proxy-only', proxyRoute, requestMeta);
    tryCount++;
  }
  if (!manifest.layers) throw new Error('manifest.layers is not iterable，实际值：' + JSON.stringify(manifest));
  return manifest;
}

/**
 * 下载单个layer（支持自动刷新 token 和指数退避重试）
 * @param {string} image 镜像名称
 * @param {Object} layer layer对象
 * @param {string} token 认证token（可能过期，会自动刷新）
 * @param {Function} progressCallback 进度回调函数
 * @returns {Promise<ArrayBuffer>} layer的二进制数据
 */
async function downloadSingleLayer(image, layer, token, progressCallback, proxyRoute = null, requestMeta = null) {
  const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
  const timeout = FETCH_TIMEOUT; // 大文件下载与代理服务使用相同超时
  const shortDigest = layer.digest.substring(7, 19);

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  // 最大重试次数和退避时间
  const maxRetries = 8;
  const baseDelay = 1000; // 1秒基础延迟

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const currentToken = await getCachedDockerToken(image, false, proxyRoute, requestMeta);
      console.log(`[Download] Attempt ${attempt + 1}/${maxRetries} downloading layer ${shortDigest}...`);
      console.log(`[Download] Token length: ${currentToken.length}`);

      // 设置请求头
      const headers = {
        'Authorization': `Bearer ${currentToken}`,
        'Accept': 'application/vnd.docker.image.rootfs.diff.tar.gzip,application/vnd.docker.image.rootfs.diff.tar,application/vnd.docker.image.rootfs.undefined,application/vnd.oci.image.manifest.v1+json'
      };

      // 如果是重试，跳过代理缓存
      const skipCache = attempt > 0;
      if (skipCache) {
        headers['X-Skip-Cache'] = 'true';
        console.log(`[Download] Retrying with skip cache: ${attempt}`);
      }

      const startTime = Date.now();
      const strategyMode = 'proxy-only';
      console.log(`[Download] Layer ${shortDigest} using strategy mode: ${strategyMode}`);
      const data = await proxyFetch(url, { headers }, 'arrayBuffer', timeout, skipCache, strategyMode, proxyRoute, requestMeta);
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      console.log(`[Download] Layer ${shortDigest} downloaded successfully in ${duration}s`);

      // 返回下载的数据
      return data;
    } catch (err) {
      const retryDelay = baseDelay * Math.pow(2, attempt); // 指数退避：1s, 2s, 4s, 8s, 16s

      console.warn(`[Download] Attempt ${attempt + 1}/${maxRetries} failed for layer ${shortDigest}: ${err.message}`);

      // 如果是最后一次重试，直接抛出错误
      if (attempt === maxRetries - 1) {
        console.error(`[Download] All retries exhausted for layer ${shortDigest}`);
        throw new Error(`Layer ${shortDigest} download failed after ${maxRetries} attempts: ${err.message}`);
      }

      // 认证错误立即重试（跳过等待）
      if (err.isAuthError || (err.message && (err.message.includes('401') || err.message.includes('UNAUTHORIZED')))) {
        console.log(`[Download] Refreshing token due to 401 error...`);
        continue; // 直接进行下一次重试
      }

      // 超时错误立即重试
      if (err.message && err.message.includes('timeout')) {
        console.log(`[Download] Timeout error, immediate retry...`);
        continue; // 直接进行下一次重试
      }

      // 客户端到代理链路抖动（扩展侧常见为 Failed to fetch）等待后重试
      if (err.message && (
        err.message.includes('Failed to fetch') ||
        err.message.includes('Network request failed') ||
        err.message.includes('ERR_CONNECTION_RESET') ||
        err.message.includes('ERR_CONNECTION_CLOSED') ||
        err.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
        err.message.includes('客户端连接已断开')
      )) {
        console.log(`[Download] Client/proxy connection jitter, waiting ${retryDelay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      // 网络错误（Connection refused, DNS resolution failed 等）需要等待
      if (err.message && (
        err.message.includes('Connection refused') ||
        err.message.includes('DNS resolution failed') ||
        err.message.includes('NetworkError') ||
        err.name === 'AbortError'
      )) {
        console.log(`[Download] Network error, waiting ${retryDelay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      // 502 Bad Gateway 错误 - 代理服务器重启
      if (err.message && (
        err.message.includes('502') ||
        err.message.includes('Bad Gateway') ||
        err.message.includes(`请求超时 (${FETCH_TIMEOUT / 1000}秒)`) // 特定于我们的超时提示
      )) {
        console.log(`[Download] 502 Bad Gateway - Proxy restart detected, waiting ${retryDelay / 1000}s before retry...`);

        // 增加更长的等待时间，让代理服务器有时间恢复
        const proxyRestartDelay = Math.max(retryDelay, 5000); // 至少等待5秒
        await new Promise(resolve => setTimeout(resolve, proxyRestartDelay));
        continue;
      }

      // 其他服务器错误（500, 503, 504）需要等待
      if (err.message && (
        err.message.includes('500') ||
        err.message.includes('503') ||
        err.message.includes('504')
      )) {
        console.log(`[Download] Server error, waiting ${retryDelay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      // 默认情况下不等待，直接重试
      console.log(`[Download] Generic error, retrying without delay...`);
    }
  }

  // 这里不应该到达，但为了完整性
  throw new Error(`Layer ${layer.digest.substring(7, 19)} download failed after ${maxRetries} attempts`);
}

async function runDownloadTask(task) {
  console.log('[Docker Download Plugin] Starting runDownloadTask for:', task.image, task.tag, task.arch);

  // 启动保活机制，防止 Service Worker 被终止
  ensureTaskKeepAlive(task);

  task.status = 'downloading';
  task.finished = 0;
  task.running = 0;
  task.pending = task.total;
  task.layers.forEach(l => l.status = 'pending');
  task.startTime = Date.now();
  syncTasks();
  try {
    const recalcTaskStats = () => {
      task.finished = task.layers.filter(l => l.status === 'done').length;
      task.running = task.layers.filter(l => l.status === 'downloading').length;
      task.pending = task.layers.filter(l => l.status === 'pending').length;
      task.updatedAt = Date.now();
    };

    console.log('[Docker Download Plugin] Getting token for:', task.image);
    // 使用缓存的 token 获取函数，会自动检查过期
    const requestMeta = {
      downloadId: task.downloadId,
      image: task.image,
      tag: task.tag,
      arch: task.arch
    };
    let token = await getCachedDockerToken(task.image, false, task.proxyRoute, requestMeta);
    const layersData = [];
    const downloadedLayers = [];
    let parentId = '';

    // 首先下载config文件
    console.log('[Docker Download Plugin] Downloading config file...');
    console.log('[Docker Download Plugin] Config digest:', task.manifest.config.digest);
    try {
      const configBuf = await downloadSingleLayer(task.image, { digest: task.manifest.config.digest }, token, null, task.proxyRoute, requestMeta);
      downloadedLayers.push({
        layerData: configBuf,
        layerId: 'config',
        digest: task.manifest.config.digest
      });
      console.log('[Docker Download Plugin] Config file downloaded');
    } catch (err) {
      console.error('[Docker Download Plugin] Config download failed:', err);
      throw new Error(`下载配置文件失败: ${err.message}`);
    }

    const layerIdByIndex = new Array(task.layers.length);
    for (let i = 0; i < task.layers.length; i++) {
      const layerId = await sha256Hash(`${parentId}\n${task.layers[i].digest}\n`);
      parentId = layerId;
      layerIdByIndex[i] = layerId;
    }

    const downloadedLayersByIndex = new Array(task.layers.length);
    const workerCount = Math.max(1, Math.min(LAYER_DOWNLOAD_CONCURRENCY, task.layers.length));
    let nextLayerIndex = 0;
    let firstError = null;

    async function layerWorker(workerId) {
      while (true) {
        if (task.canceled) return;
        if (firstError) return;

        const layerIndex = nextLayerIndex;
        nextLayerIndex++;
        if (layerIndex >= task.layers.length) return;

        const currentLayer = task.layers[layerIndex];
        currentLayer.status = 'downloading';
        recalcTaskStats();
        syncTasks();

        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'download-status-update',
              status: 'progress',
              message: `正在并行下载 ${task.image}:${task.tag} (${task.arch})，进度: ${task.finished}/${task.layers.length}，并发: ${task.running}/${workerCount}`
            });
          }
        });

        try {
          const buf = await downloadSingleLayer(task.image, currentLayer, token, null, task.proxyRoute, requestMeta);
          downloadedLayersByIndex[layerIndex] = {
            layerData: buf,
            layerId: layerIdByIndex[layerIndex],
            digest: currentLayer.digest
          };
          currentLayer.status = 'done';
        } catch (err) {
          currentLayer.status = 'failed';
          if (!firstError) {
            firstError = new Error(`下载层 ${currentLayer.digest.substring(7, 19)} 失败: ${err.message}`);
            task.status = 'failed';
            task.errorMessage = firstError.message;
            task.updatedAt = Date.now();
            task.canceled = true;
          }
        } finally {
          recalcTaskStats();
          syncTasks();
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, (_, idx) => layerWorker(idx + 1)));

    if (task.canceled) {
      throw new Error('Task canceled by user');
    }
    if (firstError) {
      throw firstError;
    }

    for (let i = 0; i < downloadedLayersByIndex.length; i++) {
      const item = downloadedLayersByIndex[i];
      if (!item) {
        throw new Error(`层下载结果缺失: index=${i}`);
      }
      downloadedLayers.push(item);
    }

    // 打包为tar文件
    task.status = 'packaging';
    syncTasks();

    notifyActiveTabDownloadStatus(`${task.image}:${task.tag} (${task.arch}) 下载完成，正在打包文件...`, 'progress');

    try {
      notifyActiveTabDownloadStatus(`${task.image}:${task.tag} (${task.arch}) 下载完成，正在打包文件...`, 'progress');

      // 使用全局函数packToTar（从docker-download.js中获取）

      // 打包为tar文件
      const tarBlob = await packToTar(downloadedLayers, task.manifest, task.image, task.tag);

      // 保存文件
      const safeArch = (task.arch || 'amd64').replace(/\//g, '-');
      const filename = `${task.image.replace(/\//g, '-')}-${task.tag}-${safeArch}.tar`;

      // 方案修改：SW无法使用URL.createObjectURL，且Data URL受限于字符串长度。
      // 使用IndexedDB存储Blob，然后打开一个扩展页面(download.html)来读取Blob并触发下载。

      const blobKey = `task-${task.id}`;
      console.log('[Download] Storing blob to IDB key:', blobKey);

      await storeBlobInDB(blobKey, tarBlob);

      const downloadHelperTab = await openDownloadHelperTab(
        `download.html?key=${encodeURIComponent(blobKey)}&filename=${encodeURIComponent(filename)}`
      );
      console.log('[Download] Opened download helper tab:', downloadHelperTab.id);

    } catch (error) {
      notifyActiveTabDownloadStatus(`打包文件失败: ${error.message}`, 'error');

      throw error;
    }

    finalizeCompletedTask(task);
    reportDownloadLifecycle('complete', {
      downloadId: task.downloadId,
      image: task.image,
      tag: task.tag,
      arch: task.arch,
      size: task.manifest.layers.reduce((sum, layer) => sum + Number(layer.size || 0), 0),
      proxyId: task.proxyRoute?.proxyId || '',
      selectedProxy: task.proxyRoute || null,
      completedAt: new Date().toISOString()
    });
    notifyActiveTabDownloadStatus(`打包完成，正在启动下载: ${task.image}:${task.tag} (${task.arch})`, 'success');
  } catch (err) {
    task.status = 'failed';
    task.errorMessage = err.message || '下载过程中发生未知错误';
    moveTaskToHistory(task);
    reportDownloadLifecycle('fail', {
      downloadId: task.downloadId,
      image: task.image,
      tag: task.tag,
      arch: task.arch,
      size: task.manifest?.layers?.reduce((sum, layer) => sum + Number(layer.size || 0), 0) || 0,
      proxyId: task.proxyRoute?.proxyId || '',
      selectedProxy: task.proxyRoute || null,
      failedAt: new Date().toISOString(),
      error: task.errorMessage
    });
  } finally {
    // 无论成功或失败，都要停止保活机制
    releaseTaskKeepAlive(task);
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

chrome.runtime.onInstalled.addListener((details) => {
  const manifestVersion = chrome.runtime.getManifest().version;
  const previousVersion = details.previousVersion || '';

  if (details.reason === 'install') {
    chrome.storage.local.set({
      onboardingState: {
        completed: false,
        startedAt: Date.now(),
        version: manifestVersion
      }
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Docker Download Plugin] Failed to persist onboarding state:', chrome.runtime.lastError.message);
      }

      chrome.tabs.create({
        url: chrome.runtime.getURL(`welcome.html?source=install&version=${encodeURIComponent(manifestVersion)}`),
        active: true
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Docker Download Plugin] Failed to open welcome page:', chrome.runtime.lastError.message);
        }
      });
    });
    return;
  }

  if (details.reason === 'update' && previousVersion && previousVersion !== manifestVersion) {
    chrome.storage.local.set({
      onboardingState: {
        completed: true,
        lastUpdateSeenAt: Date.now(),
        version: manifestVersion,
        previousVersion
      }
    }, () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`welcome.html?source=update&from=${encodeURIComponent(previousVersion)}&version=${encodeURIComponent(manifestVersion)}`),
        active: true
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Docker Download Plugin] Failed to open update guide page:', chrome.runtime.lastError.message);
        }
      });
    });
  }
});

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
    const downloadId = crypto.randomUUID();
    const task = {
      id: taskId,
      downloadId,
      image: msg.image, tag: msg.tag, arch: msg.arch,
      total: 0,
      finished: 0, running: 0, pending: 0,
      status: 'preparing', // 新增状态：准备中
      layers: [],
      createdAt: Date.now(), updatedAt: Date.now(),
      startTime: Date.now(),
      history: false
    };
    ensureTaskKeepAlive(task);
    tasks.push(task);
    syncTasks();
    updateBadge(); // 更新图标角标

    const preparingTimeoutId = setTimeout(() => {
      const stillPreparing = tasks.some(t => t.id === task.id) && task.status === 'preparing';
      if (!stillPreparing) return;
      task.status = 'failed';
      task.errorMessage = `准备阶段超时（${PREPARING_STAGE_TIMEOUT_MS / 1000}秒）`;
      task.updatedAt = Date.now();
      moveTaskToHistory(task);
      reportDownloadLifecycle('fail', {
        downloadId,
        image: msg.image,
        tag: msg.tag,
        arch: msg.arch,
        size: 0,
        proxyId: task.proxyRoute?.proxyId || '',
        selectedProxy: task.proxyRoute || null,
        failedAt: new Date().toISOString(),
        error: task.errorMessage
      });
      releaseTaskKeepAlive(task);
    }, PREPARING_STAGE_TIMEOUT_MS);

    // 2. 尝试自动打开插件弹出层（需要 Chrome 127+）
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch(err => {
        console.warn('[Docker Download Plugin] Failed to open popup automatically:', err);
      });
    }

    // 3. 异步选择代理、上报并获取清单
    Promise.all([requestBestProxy({ image: msg.image, tag: msg.tag, arch: msg.arch }), getGeoInfo()]).then(async ([proxyRoute, geo]) => {
      task.proxyRoute = proxyRoute;
      task.updatedAt = Date.now();
      syncTasks();

      await reportDownloadLifecycle('start', {
        downloadId,
        image: msg.image,
        tag: msg.tag,
        arch: msg.arch,
        sourceUrl: sender?.tab?.url || '',
        size: 0,
        proxyId: proxyRoute?.proxyId || '',
        selectedProxy: proxyRoute || null,
        clientGeo: {
          countryCode: geo.countryCode || '',
          country: geo.country || '',
          region: geo.regionName || '',
          city: geo.city || ''
        },
        pluginVersion: chrome.runtime.getManifest().version,
        startedAt: new Date().toISOString()
      });

      return fetchManifest(msg.image, msg.tag, msg.arch, proxyRoute, {
        downloadId,
        image: msg.image,
        tag: msg.tag,
        arch: msg.arch
      });
    }).then(manifest => {
      clearTimeout(preparingTimeoutId);
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
      clearTimeout(preparingTimeoutId);
      console.error('[Docker Download Plugin] Manifest fetch failed:', err);
      task.status = 'failed';
      task.errorMessage = `获取清单失败: ${err.message}`;
      moveTaskToHistory(task);
      reportDownloadLifecycle('fail', {
        downloadId,
        image: msg.image,
        tag: msg.tag,
        arch: msg.arch,
        size: 0,
        proxyId: task.proxyRoute?.proxyId || '',
        selectedProxy: task.proxyRoute || null,
        failedAt: new Date().toISOString(),
        error: task.errorMessage
      });
      releaseTaskKeepAlive(task);
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
