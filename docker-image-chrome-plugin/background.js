// background.js
// 代理 fetch，解决 CORS 问题，并输出详细日志

// DEFAULT_PROXY_BASE 和 TRACKING_URL 从 config.js 中获取

let tasks = [];
let history = [];
let isChinaIP = null;

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
 */
async function parseResponse(resp, responseType) {
  if (responseType === 'json') return await resp.json();
  if (responseType === 'arrayBuffer') return await resp.arrayBuffer();
  return await resp.text();
}

// 代理fetch通过中转服务器（Docker Registry 必须走代理以避免 CORS）
async function proxyFetch(url, options = {}, responseType = 'json') {
  // Docker Registry 相关请求必须走代理（避免 Cloudflare R2 的 CORS 问题）
  const isDockerRegistry = /docker\.io|auth\.docker\.io|cloudflare\.docker\.com|docker-images-prod/.test(url);

  let useProxy = isDockerRegistry; // Docker Registry 强制代理
  if (!isDockerRegistry) {
    useProxy = await checkGeoLocation(); // 其他请求按地理位置判断
  }

  // 定义尝试顺序
  const strategies = useProxy ? ['proxy', 'direct'] : ['direct', 'proxy'];
  const errors = [];

  console.log(`[ProxyFetch] Starting fetch for ${url}. Strategy order: ${strategies.join(' -> ')}, Force Proxy: ${isDockerRegistry}`);

  for (const strategy of strategies) {
    try {
      if (strategy === 'proxy') {
        const proxyUrl = DEFAULT_PROXY_BASE + encodeURIComponent(url);
        console.log(`[ProxyFetch] Attempting PROXY: ${proxyUrl}`);
        const resp = await fetch(proxyUrl, options);

        if (resp.ok) {
          console.log('[ProxyFetch] PROXY success');
          return await parseResponse(resp, responseType);
        } else {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`${resp.status} ${errText}`);
        }
      } else { // direct
        console.log(`[ProxyFetch] Attempting DIRECT: ${url}`);
        const resp = await fetch(url, options);

        if (resp.ok) {
          console.log('[ProxyFetch] DIRECT success');
          return await parseResponse(resp, responseType);
        } else {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`${resp.status} ${errText}`);
        }
      }
    } catch (err) {
      console.warn(`[ProxyFetch] ${strategy.toUpperCase()} failed: ${err.message}`);
      errors.push(`${strategy.toUpperCase()}: ${err.message}`);
    }
  }

  // 若所有策略都失败
  const finalError = `All strategies failed. Details: [ ${errors.join(' | ')} ]`;
  console.error(`[ProxyFetch] ${finalError}`);
  throw new Error(finalError);
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

async function getDockerToken(image) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`;
  const data = await proxyFetch(url, {}, 'json');
  return data.token;
}

async function fetchManifest(image, tagOrDigest, arch = 'amd64') {
  const token = await getDockerToken(image);
  let url = `https://registry-1.docker.io/v2/${image}/manifests/${tagOrDigest}`;
  let manifest = await proxyFetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    }
  }, 'json');
  let tryCount = 0;
  while (!manifest.layers && manifest.manifests && tryCount < 5) {
    const found = manifest.manifests.find(m => m.platform && m.platform.architecture === arch);
    if (!found) throw new Error('未找到匹配架构的manifest: ' + arch);
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
 * 下载单个layer（支持分片下载和进度回调）
 * @param {string} image 镜像名称
 * @param {Object} layer layer对象
 * @param {string} token 认证token
 * @param {Function} progressCallback 进度回调函数
 * @returns {Promise<ArrayBuffer>} layer的二进制数据
 */
async function downloadSingleLayer(image, layer, token, progressCallback) {
  const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
  return await proxyFetch(url, { headers: { 'Authorization': `Bearer ${token}` } }, 'arrayBuffer');
}

async function runDownloadTask(task) {
  console.log('[Docker Download Plugin] Starting runDownloadTask for:', task.image, task.tag, task.arch);
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
    const token = await getDockerToken(task.image);
    const layersData = [];
    const downloadedLayers = [];
    let parentId = '';

    // 首先下载config文件
    console.log('[Docker Download Plugin] Downloading config file...');
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
          // 下载单层
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
            // Optional: Update UI or wait briefly
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