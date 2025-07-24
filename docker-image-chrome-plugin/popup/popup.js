import { PROXY_BASE } from '../config.js';

function renderTasks(tasks, history) {
  const list = document.getElementById('task-list');
  let html = '';
  if (tasks && tasks.length > 0) {
    html += '<h3>进行中任务</h3>';
    html += tasks.map(task => renderTask(task, false)).join('');
  }
  if (history && history.length > 0) {
    html += '<h3>历史任务</h3>';
    html += history.map(task => renderTask(task, true)).join('');
  }
  if (!html) html = '<div style="color:#888;">暂无下载任务</div>';
  list.innerHTML = html;
}

function renderTask(task, isHistory) {
  const percent = task.total ? Math.round((task.finished / task.total) * 100) : 0;
  return `
    <div class="task">
      <div class="task-title">${task.image}:${task.tag} <span style="font-size:12px;color:#888;">[${task.arch}]</span></div>
      <div class="task-meta">
        总层数: ${task.total}，
        已完成: <span class="status-done">${task.finished}</span>，
        下载中: <span class="status-downloading">${task.running}</span>，
        等待: <span class="status-pending">${task.pending}</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-inner" style="width:${percent}%;"></div></div>
      <div class="layer-list">
        ${task.layers.map((layer, i) => `
          <div class="layer-item">
            <span style="font-family:monospace;">${layer.digest.slice(0, 12)}</span>
            <span class="layer-status status-${layer.status}">${layer.status}</span>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:6px;">
        ${isHistory
          ? `<button class="retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">重新下载</button>
             <button class="delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">删除</button>`
          : `<button class="retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}" disabled>下载中</button>`
        }
      </div>
    </div>
  `;
}

// popup 打开时主动获取
chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
  renderTasks(data.dockerDownloadTasks || [], data.dockerDownloadHistory || []);
});

// 实时监听 storage 变化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.dockerDownloadTasks || changes.dockerDownloadHistory)) {
    chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
      renderTasks(data.dockerDownloadTasks || [], data.dockerDownloadHistory || []);
    });
  }
});

// 事件委托：重试/删除
document.addEventListener('click', e => {
  if (e.target.classList.contains('retry-btn') && !e.target.disabled) {
    const {image, tag, arch} = e.target.dataset;
    chrome.runtime.sendMessage({type: 'retry-download', image, tag, arch});
  }
  if (e.target.classList.contains('delete-btn')) {
    const {image, tag, arch} = e.target.dataset;
    chrome.runtime.sendMessage({type: 'delete-history', image, tag, arch});
  }
}); 