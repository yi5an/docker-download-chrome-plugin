// background.js
// 代理 fetch，解决 CORS 问题，并输出详细日志

// PROXY_BASE 从 config.js 中获取，该文件在 manifest.json 中已配置为先于 background.js 加载

let tasks = [];
let history = [];

// 代理fetch通过中转服务器
async function proxyFetch(url, options = {}, responseType = 'json') {
  const proxyUrl = PROXY_BASE + encodeURIComponent(url);
  const resp = await fetch(proxyUrl, options);
  if (!resp.ok) throw new Error('proxy fetch failed: ' + url);
  if (responseType === 'json') return await resp.json();
  if (responseType === 'arrayBuffer') return await resp.arrayBuffer();
  return await resp.text();
}

// 加载历史
chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
  tasks = data.dockerDownloadTasks || [];
  history = data.dockerDownloadHistory || [];
});

function syncTasks() {
  chrome.storage.local.set({dockerDownloadTasks: tasks, dockerDownloadHistory: history});
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
    console.log('[Docker Download Plugin] Getting token for:', task.image);
    const token = await getDockerToken(task.image);
    const layersData = [];
    const downloadedLayers = [];
    let parentId = '';

    // 首先下载config文件
    console.log('[Docker Download Plugin] Downloading config file...');
    try {
      const configBuf = await downloadSingleLayer(task.image, {digest: task.manifest.config.digest}, token);
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
      syncTasks();
      return;
    }

    for (let i = 0; i < task.layers.length; i++) {
      task.layers[i].status = 'downloading';
      task.running = 1;
      syncTasks();
      
      // 向content-script发送下载进度更新
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'download-status-update',
            status: 'progress',
            message: `正在下载 ${task.image}:${task.tag} (${task.arch})，进度: ${i+1}/${task.layers.length}`
          });
        }
      });
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
      } catch (err) {
        task.layers[i].status = 'failed';
        task.status = 'failed';
        task.errorMessage = `下载层 ${task.layers[i].digest.substring(7, 19)} 失败: ${err.message}`;
        syncTasks();
        
        // 向content-script发送下载失败消息
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'download-status-update',
              status: 'error',
              message: `下载失败: ${err.message}`
            });
          }
        });
        
        throw err;
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
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
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
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
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

      // 将Blob转换为ArrayBuffer，然后分块转为base64 data URL
      const arrayBuffer = await tarBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 使用更安全的base64编码方法，避免栈溢出
      function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000; // 32KB chunks
        let binary = '';

        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }

        return btoa(binary);
      }

      const base64String = arrayBufferToBase64(arrayBuffer);

      const url = `data:application/x-tar;base64,${base64String}`;
      
      // 使用chrome.downloads API下载文件
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(`保存文件失败: ${chrome.runtime.lastError.message}`);
          task.status = 'failed';
          task.errorMessage = `保存文件失败: ${chrome.runtime.lastError.message}`;
          syncTasks();
          // 向content-script发送下载失败消息
          chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs && tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'download-status-update',
                status: 'error',
                message: `下载失败: ${chrome.runtime.lastError.message}`
              });
            }
          });
        } else {
          task.status = 'completed';
          task.endTime = Date.now();
          // 移到历史记录
          task.history = true;
          history.push(task);
          tasks = tasks.filter(t => t.id !== task.id);
          syncTasks();
          // 向content-script发送下载成功消息
          chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs && tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'download-status-update',
                status: 'success',
                message: `下载完成: ${task.image}:${task.tag} (${task.arch})`
              });
            }
          });
        }
        task.downloadId = downloadId;
      });
    } catch (error) {
      console.error('打包文件失败:', error);
      task.status = 'failed';
      task.errorMessage = `打包文件失败: ${error.message}`;
      syncTasks();
      
      // 向content-script发送打包失败消息
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
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
    syncTasks();
  }
  task.history = true;
  task.updatedAt = Date.now();
  history.unshift({...task});
  if (history.length > 100) history.length = 100;
  tasks = tasks.filter(t => t.id !== task.id);
  syncTasks();
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
    console.log('[Docker Download Plugin] Starting download task for:', msg.image, msg.tag, msg.arch);

    if (findTask(msg.image, msg.tag, msg.arch)) {
      console.log('[Docker Download Plugin] Task already exists');
      sendResponse({ok: false, reason: '任务已存在'});
      return;
    }

    console.log('[Docker Download Plugin] Fetching manifest...');
    fetchManifest(msg.image, msg.tag, msg.arch).then(manifest => {
      console.log('[Docker Download Plugin] Manifest fetched:', manifest);
      const task = {
        id: Date.now() + Math.random(),
        image: msg.image, tag: msg.tag, arch: msg.arch,
        total: manifest.layers.length,
        finished: 0, running: 0, pending: manifest.layers.length,
        status: 'downloading',
        layers: manifest.layers.map(l => ({digest: l.digest, status: 'pending'})),
        createdAt: Date.now(), updatedAt: Date.now(),
        startTime: Date.now(),
        history: false,
        manifest: manifest
      };
      console.log('[Docker Download Plugin] Task created:', task);
      tasks.push(task);
      syncTasks();
      console.log('[Docker Download Plugin] Current tasks count:', tasks.length);

      // 异步启动下载任务，不阻塞响应
      setTimeout(() => {
        runDownloadTask(task).catch(err => {
          console.error('[Docker Download Plugin] Download task failed:', err);
          task.status = 'failed';
          task.errorMessage = err.message;
          syncTasks();
        });
      }, 0);

      sendResponse({ok: true});
    }).catch(err => {
      console.error('[Docker Download Plugin] Manifest fetch failed:', err);
      sendResponse({ok: false, reason: err.message});
    });
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
      sendResponse({ok: true});
    } else {
      sendResponse({ok: false, reason: '历史任务不存在'});
    }
    return true;
  }
  if (msg.type === 'delete-history') {
    history = history.filter(h => !(h.image === msg.image && h.tag === msg.tag && h.arch === msg.arch));
    syncTasks();
    sendResponse({ok: true});
    return true;
  }
  if (msg.type === 'get-tasks') {
    console.log('[Docker Download Plugin] Sending tasks:', tasks.length, 'history:', history.length);
    sendResponse({tasks, history});
    return true;
  }
});