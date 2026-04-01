// content-script.js
// 监听页面加载，识别DockerHub镜像tag列表页面，并在每个架构旁插入下载按钮

/**
 * 通过 background 脚本进行请求（由 background 决定是否走代理）
 * @param {string} url 原始目标URL
 * @param {object} options fetch参数
 * @param {string} responseType 'text' | 'arrayBuffer'
 * @returns {Promise<{ok, status, contentType, body}>}
 */
function proxyFetch(url, options = {}, responseType = 'text') {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'proxy-fetch',
        url: url, // 传递原始 URL
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
  return new Blob([new Uint8Array([0x54, 0x41, 0x52])], { type: 'application/x-tar' }); // 仅占位
}

// 后续：支持config文件下载、进度回调、错误处理等

// 全局下载任务队列
window.dockerDownloadTasks = window.dockerDownloadTasks || [];

// 供popup获取任务
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'docker-download-tasks-get') {
    sendResponse({ tasks: window.dockerDownloadTasks });
  }
});

function syncTasksToStorage() {
  chrome.storage.local.set({ dockerDownloadTasks: window.dockerDownloadTasks });
}

// 启动下载任务
function startDownloadTask({ image, tag, arch, layers }) {
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
  chrome.runtime.sendMessage({ type: 'docker-download-tasks-update', tasks: window.dockerDownloadTasks }, function() {
    // 忽略运行时错误（Service Worker 可能休眠）
    if (chrome.runtime.lastError) {
      console.log('[Docker Download] Task update message ignored:', chrome.runtime.lastError.message);
    }
  });
  syncTasksToStorage();
  return task;
}

function updateLayerStatus(task, layerIndex, status) {
  task.layers[layerIndex].status = status;
  task.finished = task.layers.filter(l => l.status === 'done').length;
  task.running = task.layers.filter(l => l.status === 'downloading').length;
  task.pending = task.layers.filter(l => l.status === 'pending').length;
  chrome.runtime.sendMessage({ type: 'docker-download-tasks-update', tasks: window.dockerDownloadTasks }, function() {
    // 忽略运行时错误（Service Worker 可能休眠）
    if (chrome.runtime.lastError) {
      console.log('[Docker Download] Task update message ignored:', chrome.runtime.lastError.message);
    }
  });
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

(function () {
  const CONTENT_SCRIPT_SENTINEL = 'data-docker-download-content-script-initialized';
  if (document.documentElement.hasAttribute(CONTENT_SCRIPT_SENTINEL)) {
    console.log('[Docker Download Plugin] Content script already initialized, skipping duplicate bootstrap');
    return;
  }
  document.documentElement.setAttribute(CONTENT_SCRIPT_SENTINEL, 'true');

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

  // 检查是否有 tag 块或架构行
  function hasTagBlocks() {
    const tagBlocks = document.querySelectorAll('div[data-testid^="repotagsImageList-"]');
    if (tagBlocks.length > 0) return true;

    // 检查是否有架构行
    const archRows = document.querySelectorAll('tr td.osArchItem, .architecture-row, [class*="arch"]');
    return archRows.length > 0;
  }

  let injectionTimer = null;
  let injectionObserver = null;
  let pollingTimer = null;
  let bootstrapTimer = null;

  function isTagsPage() {
    return /\/tags(\/|$|\?)/.test(location.pathname);
  }

  function scheduleInjection(reason = 'unknown', delay = 150) {
    if (!isTagsPage()) return;
    if (injectionTimer) {
      clearTimeout(injectionTimer);
    }
    injectionTimer = setTimeout(() => {
      console.log(`[Docker Download Plugin] Running scheduled injection (${reason})`);
      injectDownloadButtons();
    }, delay);
  }

  function whenBodyReady(callback, attempts = 60) {
    if (document.body) {
      callback();
      return;
    }

    if (attempts <= 0) {
      console.warn('[Docker Download Plugin] document.body not ready, skipping callback');
      return;
    }

    setTimeout(() => whenBodyReady(callback, attempts - 1), 100);
  }

  // 尝试注入按钮
  function tryInjectButtons() {
    // 直接尝试注入，不再提前检查
    // 因为页面内容是异步加载的，hasTagBlocks() 可能误报
    injectDownloadButtons();

    // 检查是否实际注入了按钮
    const buttons = document.querySelectorAll('.docker-download-btn');
    return buttons.length > 0;
  }

  // 使用 MutationObserver 监听 DOM 变化
  function setupMutationObserver() {
    if (!document.body) {
      console.log('[Docker Download Plugin] document.body not ready, delaying observer setup');
      whenBodyReady(setupMutationObserver);
      return null;
    }

    if (injectionObserver) {
      injectionObserver.disconnect();
    }

    injectionObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.type === 'characterData') {
          scheduleInjection('mutation-update');
          return;
        }

        if (mutation.addedNodes.length > 0) {
          // 检查新添加的节点是否包含 tag 块
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查节点本身或其子元素
              const hasTagBlock = node.querySelector && (
                node.querySelector('div[data-testid^="repotagsImageList-"]') ||
                node.querySelector('td.osArchItem') ||
                node.querySelector('[class*="arch"]')
              );

              // 或者节点本身就是 tag 块
              const isTagBlock = node.getAttribute &&
                node.getAttribute('data-testid') &&
                node.getAttribute('data-testid').startsWith('repotagsImageList-');

              if (hasTagBlock || isTagBlock) {
                console.log('[Docker Download Plugin] MutationObserver detected tag block, injecting buttons');
                scheduleInjection('mutation-add');
                return;
              }
            }
          }
        }
      }
    });

    // 开始监听整个 document 的变化
    injectionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    return injectionObserver;
  }

  // 增强的等待函数（MutationObserver + 轮询双保险）
  function waitForTagTable(callback) {
    if (!isTagsPage()) return;
    if (!document.body) {
      whenBodyReady(() => waitForTagTable(callback));
      return;
    }

    let injected = false;
    let attempts = 0;
    const maxAttempts = 120; // 120 次（120秒）

    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }

    // 立即尝试一次
    if (tryInjectButtons()) {
      console.log('[Docker Download Plugin] Buttons injected immediately on page load');
      injected = true;
    }

    // 设置 MutationObserver
    const observer = setupMutationObserver();

    // 同时使用轮询作为备用（MutationObserver 可能遗漏某些情况）
    pollingTimer = setInterval(() => {
      attempts++;
      console.log(`[Docker Download Plugin] Polling attempt ${attempts}/${maxAttempts}`);

      if (injected) {
        clearInterval(pollingTimer);
        pollingTimer = null;
        console.log('[Docker Download Plugin] Initial button injection completed; keeping observer active for later DOM updates');
        return;
      }

      if (tryInjectButtons()) {
        console.log('[Docker Download Plugin] Buttons injected via polling');
        injected = true;
        clearInterval(pollingTimer);
        pollingTimer = null;
        return;
      }

      // 超过最大尝试次数
      if (attempts >= maxAttempts) {
        clearInterval(pollingTimer);
        pollingTimer = null;
        console.warn('[Docker Download Plugin] No tag blocks found after 120 seconds');
        console.log('[Docker Download Plugin] Page URL:', location.href);
        console.log('[Docker Download Plugin] Ready state:', document.readyState);

        // 最后尝试：直接查找并注入
        console.log('[Docker Download Plugin] Last attempt: forcing injection');
        injectDownloadButtons();
      }
    }, 1000); // 每 1000ms 检查一次
  }

  // 从URL获取镜像名称和tag
  function getImageAndTagFromURL() {
    // 官方架构前缀列表（这些不是命名空间，而是官方镜像的架构变体）
    const officialArchPrefixes = [
      'arm32v5', 'arm32v6', 'arm32v7', 'arm64v8', 'amd64', 'i386',
      'ppc64le', 's390x', 'riscv64', 'windows-amd64', 'windows-arm64'
    ];

    let image = '';
    let tag = 'latest';

    const officialMatch = location.pathname.match(/^\/_\/([^\/\s]+)/);
    if (officialMatch) {
      // 官方镜像：/_/python -> library/python
      image = `library/${officialMatch[1]}`;
    } else {
      // 尝试多种 URL 格式
      const oldUrlMatch = location.pathname.match(/\/r\/([^/]+)\/([^/]+)/);
      const newUrlMatch = location.pathname.match(/\/repository\/docker\/r\/([^/]+)\/([^/]+)/) ||
                        location.pathname.match(/\/repository\/docker\/([^/]+)\/([^/]+)/);

      const match = oldUrlMatch || newUrlMatch;

      if (match) {
        const namespace = match[1];
        const imageName = match[2];

        // 检查是否是官方架构前缀
        if (officialArchPrefixes.includes(namespace)) {
          // 这是官方镜像的架构页面：/r/arm32v7/redis -> library/redis
          image = `library/${imageName}`;
          console.log(`[Docker Download] Detected official architecture page: ${namespace}/${imageName} -> library/${imageName}`);
        } else {
          // 这是真正的用户镜像：/r/username/redis -> username/redis
          image = `${namespace}/${imageName}`;
          console.log(`[Docker Download] Detected user image: ${namespace}/${imageName}`);
        }
      } else {
        // Fallback: 从 URL 路径提取最后两个 segments
        const segments = location.pathname.split('/').filter(s =>
          s && s !== 'tags' && s !== 'r' && s !== 'repository' && s !== 'docker' && !officialArchPrefixes.includes(s)
        );
        if (segments.length >= 2) {
          const secondLast = segments[segments.length - 2];
          const last = segments[segments.length - 1];
          // 再次检查是否是官方架构前缀
          if (officialArchPrefixes.includes(secondLast)) {
            // /arm32v7/redis -> library/redis
            image = `library/${last}`;
            console.log(`[Docker Download] Fallback: official arch ${secondLast}/${last} -> library/${last}`);
          } else if (secondLast && last) {
            image = `${secondLast}/${last}`;
            console.log(`[Docker Download] Fallback image extraction: ${image}`);
          }
        }
      }
    }

    // 再次兜底检查：如果是官方镜像页面
    if (!image && location.pathname.includes('/_/')) {
      const parts = location.pathname.split('/_/');
      if (parts.length > 1) {
        const name = parts[1].split('/')[0];
        if (name) image = `library/${name}`;
      }
    }

    // 尝试从URL中提取tag
    const tagMatch = location.pathname.match(/\/tags\/([^/]+)/);
    if (tagMatch) {
      tag = tagMatch[1];
    }

    return { image, tag };
  }

  // 遍历所有tag块，为每个架构行插入下载按钮，按钮携带正确tag
  function injectDownloadButtons() {
    console.log('[Docker Download Plugin] Starting button injection');
    injectStyle();
    const buttonCountBefore = document.querySelectorAll('.docker-download-btn').length;

    // 支持多种DockerHub页面结构
    // 1. 旧版: div[data-testid^="repotagsImageList-"]
    // 2. 新版: 直接查找包含架构行的表格
    const tagBlocks = document.querySelectorAll('div[data-testid^="repotagsImageList-"], div.tag-block');
    const tables = document.querySelectorAll('table');

    console.log('[Docker Download Plugin] Found tag blocks:', tagBlocks.length, 'tables:', tables.length);

    // 如果找到旧版tag blocks，先尝试旧逻辑，但不要提前 return。
    // Docker Hub 首次进入时可能先渲染占位 tag block，再异步渲染真实表格。
    if (tagBlocks.length > 0) {
      tagBlocks.forEach((tagBlock, index) => {
        console.log(`[Docker Download Plugin] Processing tag block ${index + 1}:`, tagBlock);
        processTagBlock(tagBlock, 'latest');
      });
    }

    // 新版页面结构：直接处理表格
    tables.forEach((table, index) => {
      const metadata = getTableColumnMetadata(table);
      if (!metadata.hasArchColumn) return;

      console.log(`[Docker Download Plugin] Processing table ${index + 1} with architecture cells`);

      // 从URL获取镜像名称和tag
      const { image, tag: defaultTag } = getImageAndTagFromURL();

      // 遍历该表格下所有架构行
      const rows = table.querySelectorAll('tbody tr, tr, .architecture-row');
      rows.forEach(row => {
        const tag = extractTagFromRow(row, metadata.tagColumnIndex, defaultTag);
        const archCell = resolveArchCell(row, metadata.archColumnIndex);
        processArchCell(row, image, tag, archCell);
      });
    });

    // Model / OCI artifact 风格：无 OS/ARCH 列，按 tag 卡片注入单按钮
    injectModelTagButtons();

    const buttonCountAfter = document.querySelectorAll('.docker-download-btn').length;
    console.log(`[Docker Download Plugin] Injection complete. Buttons before: ${buttonCountBefore}, after: ${buttonCountAfter}`);
  }

  function findTagCardCandidates() {
    const commandNodes = Array.from(document.querySelectorAll('div, span, code, p')).filter(node => {
      if (!(node instanceof HTMLElement)) return false;
      const text = (node.textContent || '').trim();
      if (!text || text.length > 240) return false;
      return /docker\s+model\s+pull\s+[a-z0-9/_-]+:[^\s]+/i.test(text);
    });

    const cards = [];
    const seen = new Set();

    commandNodes.forEach(node => {
      const cardRoot = node.closest('.MuiCard-root');
      if (cardRoot) {
        if (!seen.has(cardRoot)) {
          seen.add(cardRoot);
          cards.push(cardRoot);
        }
        return;
      }

      let current = node.parentElement;
      while (current && current !== document.body) {
        const text = (current.textContent || '').trim();
        const hasDigestSection = /digest/i.test(text);
        const hasTypeSection = /type/i.test(text);
        const hasModelType = /type\s*model/i.test(text) || /model/i.test(text);
        const hasPullCommand = /docker\s+model\s+pull\s+[a-z0-9/_-]+:[^\s]+/i.test(text);

        if (hasDigestSection && hasTypeSection && hasModelType && hasPullCommand) {
          if (!seen.has(current)) {
            seen.add(current);
            cards.push(current);
          }
          break;
        }

        current = current.parentElement;
      }
    });

    return cards;
  }

  function extractTagFromCard(card, defaultTag) {
    const text = (card.textContent || '').trim();
    const pullMatch = text.match(/docker\s+model\s+pull\s+([a-z0-9/_-]+):([^\s]+)/i) ||
      text.match(/docker\s+pull\s+([a-z0-9/_-]+):([^\s]+)/i);
    if (pullMatch && pullMatch[2]) {
      return pullMatch[2].trim();
    }

    const normalizedLines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const tagIndex = normalizedLines.findIndex(line => line.toUpperCase() === 'TAG');
    if (tagIndex !== -1 && normalizedLines[tagIndex + 1]) {
      return normalizedLines[tagIndex + 1];
    }

    return defaultTag;
  }

  function resolveModelButtonAnchor(card) {
    const commandCode = Array.from(card.querySelectorAll('code')).find(el =>
      /docker\s+model\s+pull/i.test((el.textContent || '').trim())
    );
    if (commandCode) {
      const pre = commandCode.closest('pre');
      if (pre && pre.parentElement) {
        return pre.parentElement;
      }
      if (commandCode.parentElement) {
        return commandCode.parentElement;
      }
    }

    const compactCommandBlock = Array.from(card.querySelectorAll('div, span, p')).find(el => {
      const text = (el.textContent || '').trim();
      return /docker\s+model\s+pull/i.test(text) && text.length < 80;
    });
    if (compactCommandBlock && compactCommandBlock.parentElement) {
      return compactCommandBlock.parentElement;
    }

    const tagHeader = Array.from(card.querySelectorAll('*')).find(el =>
      (el.textContent || '').trim().toUpperCase() === 'TAG'
    );
    if (tagHeader && tagHeader.parentElement) {
      return tagHeader.parentElement;
    }

    return card;
  }

  function injectModelTagButtons() {
    const { image, tag: defaultTag } = getImageAndTagFromURL();
    if (!image) return;
    if (document.querySelector('td.osArchItem, .arch-cell') || Array.from(document.querySelectorAll('th, td, div, span')).some(el => /OS\/ARCH/i.test((el.textContent || '').trim()))) {
      return;
    }

    const cards = findTagCardCandidates();
    console.log('[Docker Download Plugin] Model tag card candidates:', cards.length);

    cards.forEach(card => {
      const tag = extractTagFromCard(card, defaultTag);
      const anchor = resolveModelButtonAnchor(card);
      if (!anchor) return;

      card.querySelectorAll('.docker-download-btn, .docker-download-unsupported').forEach(el => el.remove());

      const unsupportedHint = document.createElement('span');
      unsupportedHint.className = 'docker-download-unsupported';
      unsupportedHint.textContent = 'Model 暂不支持下载';
      unsupportedHint.title = `${image}:${tag} 属于 Docker Model / OCI artifact，当前插件暂不支持下载`;
      unsupportedHint.style.display = 'inline-block';
      unsupportedHint.style.marginLeft = '8px';
      unsupportedHint.style.fontSize = '12px';
      unsupportedHint.style.color = '#8a6d3b';
      unsupportedHint.style.whiteSpace = 'nowrap';
      unsupportedHint.style.verticalAlign = 'middle';
      anchor.appendChild(unsupportedHint);
    });
  }

  function getTableColumnMetadata(table) {
    const headerCells = Array.from(table.querySelectorAll('thead th, tr th'));
    const headerTexts = headerCells.map(cell => cell.textContent.trim().toUpperCase());
    const tagColumnIndex = headerTexts.findIndex(text => text.includes('TAG'));
    const archColumnIndex = headerTexts.findIndex(text => text.includes('OS/ARCH'));
    const hasArchColumn = archColumnIndex !== -1 || !!table.querySelector('td.osArchItem');

    return {
      tagColumnIndex,
      archColumnIndex,
      hasArchColumn
    };
  }

  function extractTagFromRow(row, tagColumnIndex, defaultTag) {
    if (!row || !row.querySelectorAll) return defaultTag;

    const cells = Array.from(row.querySelectorAll('td'));
    const tagCell = tagColumnIndex >= 0 ? cells[tagColumnIndex] : cells[0];
    if (!tagCell) return defaultTag;

    const tagLink = tagCell.querySelector('a');
    const tagText = (tagLink ? tagLink.textContent : tagCell.textContent || '')
      .split('\n')
      .map(text => text.trim())
      .find(Boolean);

    return tagText || defaultTag;
  }

  function isArchitectureText(text) {
    return /(linux|windows|darwin)\s*\/\s*[a-z0-9_/-]+/i.test(text) ||
      /\b(amd64|arm64|arm\/v7|armhf|armel|386|i386|x86_64|ppc64le|s390x|riscv64)\b/i.test(text);
  }

  function normalizeRequestedArchitecture(archText) {
    const normalized = (archText || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/^(linux|windows|darwin)\//, '');

    if (!normalized) return '';

    if (normalized.includes('amd64') || normalized.includes('x86_64') || normalized.includes('x86-64') || normalized === 'x64') {
      return 'amd64';
    }

    if (normalized.includes('arm64') || normalized.includes('aarch64')) {
      const variantMatch = normalized.match(/arm64\/(v\d+)/);
      return variantMatch ? `arm64/${variantMatch[1]}` : 'arm64';
    }

    if (/^arm\/v\d+/.test(normalized)) {
      return normalized.match(/^arm\/(v\d+)/) ? `arm/${normalized.match(/^arm\/(v\d+)/)[1]}` : 'arm';
    }

    if (normalized.includes('armhf') || normalized.includes('armel')) {
      return 'arm';
    }

    if (normalized === 'arm' || normalized.includes('/arm')) {
      return 'arm';
    }

    if (normalized.includes('386') || normalized.includes('i386') || normalized === 'x86') {
      return '386';
    }

    if (normalized.includes('ppc64le')) {
      return 'ppc64le';
    }

    if (normalized.includes('s390x')) {
      return 's390x';
    }

    if (normalized.includes('riscv64')) {
      return 'riscv64';
    }

    return normalized;
  }

  function resolveArchCell(row, archColumnIndex) {
    if (!row || !row.querySelectorAll) return null;

    const explicitArchCell = row.querySelector('td.osArchItem, .arch-cell');
    if (explicitArchCell) return explicitArchCell;

    const cells = Array.from(row.querySelectorAll('td'));
    if (archColumnIndex >= 0 && cells[archColumnIndex]) {
      return cells[archColumnIndex];
    }

    return cells.find(cell => isArchitectureText(cell.textContent.trim())) || null;
  }

  // 处理单个tag块（旧版页面结构）
  function processTagBlock(tagBlock, defaultTag) {
    // 获取tag名
    let tag = '';
    const tagNav = tagBlock.parentElement.querySelector('a[data-testid="navToImage"], .tag-name');
    if (tagNav) tag = tagNav.textContent.trim();
    if (!tag) {
      const tagMatch = location.pathname.match(/\/tags\/([^/]+)/);
      tag = tagMatch ? tagMatch[1] : defaultTag;
    }

    // 遍历该tag块下所有架构行
    const rows = tagBlock.querySelectorAll('tr, .architecture-row');
    const { image } = getImageAndTagFromURL();

    rows.forEach(row => {
      processArchCell(row, image, tag);
    });
  }

  // 处理单个架构单元格
  function processArchCell(row, image, tag, archCellOverride = null) {
    const archCell = archCellOverride || row.querySelector('td.osArchItem, .arch-cell');
    if (!archCell) return;
    if (archCell.querySelector('.docker-download-btn')) return;

    // 提取架构信息，支持多种格式
    let archText = archCell.textContent.trim();
    if (!isArchitectureText(archText)) return;
    const originalArch = archText;
    const arch = normalizeRequestedArchitecture(archText);

    console.log(`[Docker Download] Processing: ${image}:${tag} (${arch})`);

    const btn = document.createElement('button');
    btn.className = 'docker-download-btn';
    btn.innerHTML = downloadSvg;
    btn.title = `下载该架构镜像（${tag}，${originalArch}）`;

    // 在按钮点击事件里，直接发起后台下载请求
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      try {
        // 使用回调函数处理响应，避免 "Receiving end does not exist" 错误
        chrome.runtime.sendMessage({ type: 'start-download', image, tag, arch }, function(response) {
          // 检查是否有运行时错误
          if (chrome.runtime.lastError) {
            console.error('[Docker Download] Runtime error:', chrome.runtime.lastError);
            showNotification('插件后台连接失败，请刷新页面后重试！', 'error');
            return;
          }
          if (response && response.ok) {
            btn.disabled = true;
            btn.querySelector('path').setAttribute('fill', '#aaa');
            btn.title = '已提交后台下载';
            showNotification(`开始下载 ${image}:${tag} (${originalArch})，请在插件弹窗中查看进度`, 'success');
            setTimeout(() => {
              btn.disabled = false;
              btn.title = `下载该架构镜像（${tag}，${originalArch}）`;
              btn.querySelector('path').setAttribute('fill', '#333');
            }, 2000);
          } else if (response && response.reason) {
            showNotification(`下载失败: ${response.reason}`, 'error');
          }
        });
      } catch (err) {
        showNotification('插件后台已失效，请刷新页面或重新加载插件后重试！\n错误信息：' + (err && err.message ? err.message : err), 'error');
      }
    };

    // 插入按钮到合适位置
    const p = archCell.querySelector('p');
    if (p) {
      p.appendChild(btn);
    } else {
      archCell.appendChild(btn);
    }
  }

  // 调试信息
  console.log('[Docker Download Plugin] Content script loaded on:', location.href);
  console.log('[Docker Download Plugin] Pathname:', location.pathname);
  console.log('[Docker Download Plugin] Ready state:', document.readyState);

  function bootstrapInjection(reason) {
    if (!isTagsPage()) return;
    whenBodyReady(() => {
      console.log(`[Docker Download Plugin] Bootstrapping injection (${reason})`);
      setupMutationObserver();
      scheduleInjection(`${reason}-immediate`, 0);
      waitForTagTable(injectDownloadButtons);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[Docker Download Plugin] DOMContentLoaded fired');
      bootstrapInjection('dom-content-loaded');
    });
  } else {
    // DOM 已经加载完成
    console.log('[Docker Download Plugin] DOM already loaded');
    bootstrapInjection('initial-load');
  }

  window.addEventListener('load', () => {
    bootstrapInjection('window-load');
  });

  window.addEventListener('pageshow', () => {
    bootstrapInjection('pageshow');
  });

  // 监听 SPA 页面跳转（DockerHub 为 SPA，需监听页面变化）
  let lastUrl = location.href;

  // 1. 监听浏览器前进/后退
  window.addEventListener('popstate', () => {
    console.log('[Docker Download Plugin] Popstate event detected');
    scheduleInjection('popstate', 50);
    waitForTagTable(injectDownloadButtons);
  });

  // 2. Hook history.pushState 和 history.replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    console.log('[Docker Download Plugin] pushState called');
    scheduleInjection('pushstate', 50);
    waitForTagTable(injectDownloadButtons);
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    console.log('[Docker Download Plugin] replaceState called');
    scheduleInjection('replacestate', 50);
    waitForTagTable(injectDownloadButtons);
  };

  // 3. 使用 setInterval 作为备用方案（捕获其他可能的路由变化）
  setInterval(() => {
    if (location.href !== lastUrl) {
      console.log('[Docker Download Plugin] URL changed (polling):', location.href);
      lastUrl = location.href;
      bootstrapInjection('url-polling');
    }
  }, 1000);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const clickable = target.closest('button, a, span, div');
    const text = clickable ? clickable.textContent.trim() : '';
    if (/^\+\d+\s+more\.\.\.$/i.test(text) || /^\+\d+\s+more/i.test(text)) {
      console.log('[Docker Download Plugin] Detected "more" expansion click');
      scheduleInjection('expand-more', 150);
      waitForTagTable(injectDownloadButtons);
    }
  }, true);

  // 首次进入页面时，持续几秒重试启动逻辑，覆盖 Docker Hub 首屏水合较慢的情况。
  if (!bootstrapTimer) {
    let bootstrapAttempts = 0;
    bootstrapTimer = setInterval(() => {
      bootstrapAttempts++;
      if (!isTagsPage()) return;
      if (document.querySelector('.docker-download-btn')) {
        clearInterval(bootstrapTimer);
        bootstrapTimer = null;
        return;
      }
      bootstrapInjection(`bootstrap-retry-${bootstrapAttempts}`);
      if (bootstrapAttempts >= 10) {
        clearInterval(bootstrapTimer);
        bootstrapTimer = null;
      }
    }, 1000);
  }

  // 监听来自background的下载任务状态更新
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'download-status-update') {
      showNotification(message.message, message.status === 'success' ? 'success' : 'error');
    }

    // 处理文件下载请求（备用方案）
    if (message.type === 'download-file') {
      try {
        const data = new Uint8Array(message.data);
        const blob = new Blob([data], { type: 'application/x-tar' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = message.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        sendResponse({ success: true });
      } catch (error) {
        console.error('Content script file download failed:', error);
        sendResponse({ success: false, error: error.message });
      }
      return true; // 保持消息通道开放
    }
  });

  // 显示通知函数
  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.position = 'fixed';
    notification.style.bottom = '20px';
    notification.style.right = '20px';

    // 根据类型设置颜色
    switch (type) {
      case 'success':
        notification.style.backgroundColor = '#4caf50';
        break;
      case 'error':
        notification.style.backgroundColor = '#f44336';
        break;
      case 'warning':
        notification.style.backgroundColor = '#ff9800';
        break;
      default:
        notification.style.backgroundColor = '#2196f3';
    }

    notification.style.color = 'white';
    notification.style.padding = '12px 20px';
    notification.style.borderRadius = '4px';
    notification.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
    notification.style.zIndex = '10000';
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s';
    notification.innerText = message;

    document.body.appendChild(notification);

    // 显示通知
    setTimeout(() => {
      notification.style.opacity = '1';
    }, 10);

    // 3秒后隐藏
    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 300);
    }, 3000);
  }
})();
