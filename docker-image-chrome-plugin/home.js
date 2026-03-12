document.addEventListener('DOMContentLoaded', function () {
  const activeList = document.getElementById('active-list');
  const historyList = document.getElementById('history-list');
  const registryHost = document.getElementById('registry-host');
  const proxySummary = document.getElementById('proxy-summary');
  const authSummary = document.getElementById('auth-summary');
  const authStatus = document.getElementById('auth-status');
  const registryUrlText = document.getElementById('registry-url-text');
  const registryBase = typeof getProxyRegistryServiceUrl === 'function'
    ? getProxyRegistryServiceUrl()
    : 'http://123.57.165.38:3000';

  document.getElementById('refresh-home').addEventListener('click', loadAll);
  document.getElementById('save-auth-btn').addEventListener('click', saveDockerAuth);

  document.addEventListener('click', function (event) {
    if (event.target.classList.contains('retry-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'retry-download', image, tag, arch }, () => loadTasks());
    }

    if (event.target.classList.contains('delete-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'delete-history', image, tag, arch }, () => loadTasks());
    }

    if (event.target.classList.contains('delete-active-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'delete-active-task', image, tag, arch }, () => loadTasks());
    }
  });

  async function loadAll() {
    loadTasks();
    loadDockerAuth();
    loadProxySummary();
  }

  function fmtTime(value) {
    if (!value) return '-';
    return new Date(value).toLocaleString('zh-CN');
  }

  function getStatusBadge(status) {
    if (status === 'completed' || status === 'done') return '<span class="badge ok">已完成</span>';
    if (status === 'failed') return '<span class="badge err">失败</span>';
    return '<span class="badge warn">进行中</span>';
  }

  function renderTask(task, type) {
    const progress = task.total > 0 ? Math.round((task.finished / task.total) * 100) : 0;
    const errorMessage = task.errorMessage ? `<p class="muted" style="margin-top: 10px; color: #b42318;">${task.errorMessage}</p>` : '';
    const actionHtml = type === 'active'
      ? `<button class="tiny-btn danger delete-active-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">取消任务</button>`
      : (task.status === 'failed'
        ? `<button class="tiny-btn primary retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">重试</button>
           <button class="tiny-btn danger delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">删除记录</button>`
        : `<button class="tiny-btn danger delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">删除记录</button>`);

    return `
      <article class="task">
        <div class="task-top">
          <div class="task-title">${task.image}:${task.tag} <span class="muted">[${task.arch}]</span></div>
          ${getStatusBadge(task.status)}
        </div>
        <div class="task-meta">
          <span>层数 ${task.finished || 0} / ${task.total || 0}</span>
          <span>${fmtTime(task.updatedAt || task.startTime)}</span>
        </div>
        <div class="progress"><span style="width: ${progress}%"></span></div>
        ${errorMessage}
        <div class="task-actions">${actionHtml}</div>
      </article>
    `;
  }

  function loadTasks() {
    chrome.runtime.sendMessage({ type: 'get-tasks' }, function (response) {
      const tasks = response?.tasks || [];
      const history = response?.history || [];

      document.getElementById('active-count').textContent = String(tasks.length);
      document.getElementById('history-count').textContent = String(history.length);
      document.getElementById('failed-count').textContent = String(history.filter(item => item.status === 'failed').length);
      document.getElementById('done-count').textContent = String(history.filter(item => item.status === 'completed' || item.status === 'done').length);

      activeList.innerHTML = tasks.length
        ? tasks.map(task => renderTask(task, 'active')).join('')
        : '<div class="empty">当前没有正在进行的下载任务。</div>';

      historyList.innerHTML = history.length
        ? history.slice(0, 8).map(task => renderTask(task, 'history')).join('')
        : '<div class="empty">还没有历史任务。</div>';
    });
  }

  function loadDockerAuth() {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], function (result) {
      document.getElementById('docker-username').value = result.dockerUsername || '';
      document.getElementById('docker-password').value = '';
      authSummary.textContent = result.dockerUsername ? '已配置' : '未配置';
      authStatus.textContent = result.dockerUsername
        ? `当前账号: ${result.dockerUsername}`
        : '未配置认证，下载公开镜像时通常不需要。';
      authStatus.style.color = result.dockerUsername ? '#166534' : '#667286';
    });
  }

  function saveDockerAuth() {
    const username = document.getElementById('docker-username').value.trim();
    const password = document.getElementById('docker-password').value.trim();

    if (!username || !password) {
      authStatus.textContent = '请填写用户名和密码或访问令牌。';
      authStatus.style.color = '#b42318';
      return;
    }

    chrome.storage.local.set({ dockerUsername: username, dockerPassword: password }, function () {
      if (chrome.runtime.lastError) {
        authStatus.textContent = `保存失败: ${chrome.runtime.lastError.message}`;
        authStatus.style.color = '#b42318';
        return;
      }

      authStatus.textContent = `认证已更新: ${username}`;
      authStatus.style.color = '#166534';
      authSummary.textContent = '已配置';
      document.getElementById('docker-password').value = '';
    });
  }

  async function loadProxySummary() {
    registryHost.textContent = registryBase.replace(/^https?:\/\//, '');
    registryUrlText.textContent = registryBase;

    try {
      const response = await fetch(`${registryBase}/api/proxies`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const proxies = payload.proxies || [];
      const onlineCount = proxies.filter(item => item.healthy).length;
      proxySummary.textContent = onlineCount
        ? `当前在线 ${onlineCount} 个节点，可由记录服务动态选路`
        : '当前没有健康节点，插件会回退到静态代理配置';
    } catch (error) {
      proxySummary.textContent = `无法读取代理记录服务状态: ${error.message}`;
    }
  }

  loadAll();
  setInterval(loadTasks, 1500);
});
