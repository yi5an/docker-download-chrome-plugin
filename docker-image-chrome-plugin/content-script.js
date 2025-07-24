// content-script.js
// 监听页面加载，识别DockerHub镜像tag列表页面，并在每个架构旁插入下载按钮（SVG图标，紧贴文本一行显示）

// 通过中转服务器代理 fetch，解决 CORS 问题
const PROXY_BASE = 'http://123.57.165.38:7000/proxy?url=';
/**
 * @param {string} url 原始目标URL
 * @param {object} options fetch参数
 * @param {string} responseType 'text' | 'arrayBuffer'
 * @returns {Promise<{ok, status, contentType, body}>}
 */
function proxyFetch(url, options = {}, responseType = 'text') {
  const proxyUrl = PROXY_BASE + encodeURIComponent(url);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'proxy-fetch',
        url: proxyUrl,
        options,
        responseType
      },
      resp => {
        if (!resp || !resp.ok) {
          reject(new Error(resp && resp.error ? resp.error : 'proxy fetch failed'));
        } else {
          resolve(resp);
        }
      }
    );
  });
}

// docker 镜像下载核心逻辑（支持多架构manifest list）
// 依赖：proxyFetch、pako、tar-js（后续完善）

/**
 * 获取 DockerHub 镜像的 manifest/config/layers，支持多架构
 * @param {string} image 镜像名（如 library/ubuntu）
 * @param {string} tag 镜像tag（如 latest）
 * @param {string} arch 架构（如 amd64、arm64）
 * @returns {Promise<object>} manifest对象
 */
async function fetchManifest(image, tagOrDigest, arch = 'amd64') {
  const token = await getDockerToken(image);
  let url = `https://registry-1.docker.io/v2/${image}/manifests/${tagOrDigest}`;
  let resp = await proxyFetch(
    url,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
      }
    },
    'text'
  );
  if (!resp.ok) throw new Error('获取manifest失败');
  let manifest = JSON.parse(resp.body);

  // 递归/循环，直到manifest有layers字段
  let tryCount = 0;
  while (!manifest.layers && manifest.manifests && tryCount < 5) {
    const found = manifest.manifests.find(m => m.platform && m.platform.architecture === arch);
    if (!found) throw new Error('未找到匹配架构的manifest: ' + arch);
    url = `https://registry-1.docker.io/v2/${image}/manifests/${found.digest}`;
    resp = await proxyFetch(
      url,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': found.mediaType || 'application/vnd.docker.distribution.manifest.v2+json'
        }
      },
      'text'
    );
    if (!resp.ok) throw new Error('获取架构manifest失败');
    manifest = JSON.parse(resp.body);
    tryCount++;
  }
  if (!manifest.layers) throw new Error('manifest.layers is not iterable，实际值：' + JSON.stringify(manifest));
  return manifest;
}

/**
 * 获取 DockerHub 镜像下载token
 * @param {string} image 镜像名
 * @returns {Promise<string>} token
 */
async function getDockerToken(image) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`;
  const resp = await proxyFetch(url, {}, 'text');
  if (!resp.ok) throw new Error('获取token失败');
  const data = JSON.parse(resp.body);
  return data.token;
}

/**
 * 下载镜像所有layer（伪实现，后续完善分片、进度、解压等）
 * @param {string} image 镜像名
 * @param {Array} layers 镜像layer数组
 * @param {string} token 认证token
 * @returns {Promise<ArrayBuffer[]>} 所有layer的二进制数据
 */
async function downloadLayers(image, layers, token) {
  // 这里只做伪实现，后续需分片、进度、gzip解压
  const results = [];
  for (const layer of layers) {
    const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
    const resp = await proxyFetch(
      url,
      { headers: { 'Authorization': `Bearer ${token}` } },
      'arrayBuffer'
    );
    if (!resp.ok) throw new Error('下载layer失败:' + layer.digest);
    // resp.body 是 Uint8Array 的 Array
    results.push(new Uint8Array(resp.body).buffer);
  }
  return results;
}

/**
 * 打包为tar文件（伪实现，后续用tar-js等库实现）
 * @param {ArrayBuffer[]} layersData 所有layer的二进制数据
 * @returns {Blob} tar文件Blob
 */
function packToTar(layersData) {
  // 这里只做伪实现，后续用tar-js等库实现真正打包
  // return new Blob([...layersData], {type: 'application/x-tar'});
  // 占位：实际应将各layer和config等文件打包为标准docker镜像tar结构
  return new Blob([new Uint8Array([0x54,0x41,0x52])], {type: 'application/x-tar'}); // 仅占位
}

// 后续：支持config文件下载、进度回调、错误处理等

// 全局下载任务队列
window.dockerDownloadTasks = window.dockerDownloadTasks || [];

// 供popup获取任务
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'docker-download-tasks-get') {
    sendResponse({tasks: window.dockerDownloadTasks});
  }
});

function syncTasksToStorage() {
  chrome.storage.local.set({dockerDownloadTasks: window.dockerDownloadTasks});
}

// 启动下载任务
function startDownloadTask({image, tag, arch, layers}) {
  const task = {
    id: Date.now() + Math.random(),
    image, tag, arch,
    total: layers.length,
    finished: 0,
    running: 0,
    pending: layers.length,
    status: 'downloading',
    layers: layers.map(layer => ({
      digest: layer.digest,
      status: 'pending'
    }))
  };
  window.dockerDownloadTasks.push(task);
  chrome.runtime.sendMessage({type: 'docker-download-tasks-update', tasks: window.dockerDownloadTasks});
  syncTasksToStorage();
  return task;
}

function updateLayerStatus(task, layerIndex, status) {
  task.layers[layerIndex].status = status;
  task.finished = task.layers.filter(l => l.status === 'done').length;
  task.running = task.layers.filter(l => l.status === 'downloading').length;
  task.pending = task.layers.filter(l => l.status === 'pending').length;
  chrome.runtime.sendMessage({type: 'docker-download-tasks-update', tasks: window.dockerDownloadTasks});
  syncTasksToStorage();
}

// 单层下载
async function downloadSingleLayer(image, layer, token) {
  const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
  const resp = await proxyFetch(
    url,
    { headers: { 'Authorization': `Bearer ${token}` } },
    'arrayBuffer'
  );
  if (!resp.ok) throw new Error('下载layer失败:' + layer.digest);
  return new Uint8Array(resp.body).buffer;
}

(function() {
  // SVG图标字符串
  const downloadSvg = `
    <svg t="1753283428326" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1493" width="20" height="20" style="vertical-align:middle;">
      <path d="M341.333333 640a42.666667 42.666667 0 0 1-42.666666 42.666667H256a170.666667 170.666667 0 0 1-40.277333-336.554667 298.709333 298.709333 0 0 1 570.154666-81.408A213.333333 213.333333 0 0 1 725.333333 682.666667a42.666667 42.666667 0 0 1 0.042667-85.333334 128 128 0 0 0 36.394667-250.794666l-38.144-11.264-15.914667-36.437334a213.376 213.376 0 0 0-407.296 58.026667l-7.381333 58.368-57.173334 13.824A85.418667 85.418667 0 0 0 256 597.333333h42.666667a42.666667 42.666667 0 0 1 42.666666 42.666667z m321.706667 87.338667a42.666667 42.666667 0 0 1 0 60.330666l-120.917333 120.832c-16.682667 16.64-43.690667 16.64-60.373334 0l-120.917333-120.832a42.666667 42.666667 0 0 1 60.330667-60.330666L469.333333 775.509333V426.666667a42.666667 42.666667 0 0 1 85.333334 0v348.714666l48.042666-48.042666a42.666667 42.666667 0 0 1 60.330667 0z" fill="#333333" p-id="1494"></path>
    </svg>
  `;

  // 注入全局样式，控制按钮位置和悬停效果
  function injectStyle() {
    if (document.getElementById('docker-download-btn-style')) return;
    const style = document.createElement('style');
    style.id = 'docker-download-btn-style';
    style.textContent = `
      .docker-download-btn {
        display: inline-flex;
        align-items: center;
        background: none;
        border: none;
        padding: 0;
        margin: 0 0 0 6px;
        cursor: pointer;
        z-index: 10;
        outline: none;
        vertical-align: middle;
      }
      .docker-download-btn .icon path {
        transition: fill 0.2s;
      }
      .docker-download-btn:hover .icon path {
        fill: #1890ff !important;
      }
    `;
    document.head.appendChild(style);
  }

  // 等待页面主要内容加载，检测tag块出现
  function waitForTagTable(callback) {
    const interval = setInterval(() => {
      const tagBlocks = document.querySelectorAll('div[data-testid^="repotagsImageList-"]');
      if (tagBlocks.length > 0) {
        clearInterval(interval);
        callback();
      }
    }, 500);
  }

  // 遍历所有tag块，为每个架构行插入下载按钮，按钮携带正确tag
  function injectDownloadButtons() {
    injectStyle();
    document.querySelectorAll('div[data-testid^="repotagsImageList-"]').forEach(tagBlock => {
      // 获取tag名（在上方同级的a[data-testid="navToImage"]内）
      let tag = '';
      const tagNav = tagBlock.parentElement.querySelector('a[data-testid="navToImage"]');
      if (tagNav) tag = tagNav.textContent.trim();
      if (!tag) tag = 'latest';
      // 遍历该tag块下所有架构行
      tagBlock.querySelectorAll('tr').forEach(row => {
        const archCell = row.querySelector('td.osArchItem');
        if (!archCell) return;
        if (archCell.querySelector('.docker-download-btn')) return;
        const arch = archCell.textContent.trim().split('/').pop();
        const match = location.pathname.match(/\/r\/([^/]+)\/([^/]+)/);
        const image = match ? `${match[1]}/${match[2]}` : '';
        const btn = document.createElement('button');
        btn.className = 'docker-download-btn';
        btn.innerHTML = downloadSvg;
        btn.title = `下载该架构镜像（${tag}）`;
        // 在按钮点击事件里，直接发起后台下载请求
        btn.onclick = function(e) {
          e.stopPropagation();
          try {
            chrome.runtime.sendMessage({type: 'start-download', image, tag, arch});
            btn.disabled = true;
            btn.querySelector('path').setAttribute('fill', '#aaa');
            btn.title = '已提交后台下载';
            setTimeout(() => {
              btn.disabled = false;
              btn.title = `下载该架构镜像（${tag}）`;
              btn.querySelector('path').setAttribute('fill', '#333');
            }, 2000);
          } catch (err) {
            alert('插件后台已失效，请刷新页面或重新加载插件后重试！\n错误信息：' + (err && err.message ? err.message : err));
          }
        };
        const p = archCell.querySelector('p');
        if (p) {
          p.appendChild(btn);
        } else {
          archCell.appendChild(btn);
        }
      });
    });
  }

  // 入口
  waitForTagTable(injectDownloadButtons);

  // 监听SPA页面跳转（DockerHub为SPA，需监听页面变化）
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      waitForTagTable(injectDownloadButtons);
    }
  }, 1000);
})(); 