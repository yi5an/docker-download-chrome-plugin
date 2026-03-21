document.addEventListener('DOMContentLoaded', async function () {
  const locale = await getPreferredLocale();
  const messages = getMessages(locale);

  applyStaticTranslations(messages, locale);

  const activeTasksContainer = document.getElementById('active-tasks-container');
  const historyTasksContainer = document.getElementById('history-tasks-container');
  const saveAuthBtn = document.getElementById('save-auth-btn');
  const openHomeBtn = document.getElementById('open-home-btn');
  const openWelcomeBtn = document.getElementById('open-welcome-btn');
  const languageToggleBtn = document.getElementById('language-toggle');

  loadDockerAuth();
  loadTasks();
  setInterval(loadTasks, 1000);

  languageToggleBtn.textContent = locale === 'zh-CN' ? 'EN' : '中文';
  languageToggleBtn.addEventListener('click', async () => {
    const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    await savePreferredLocale(nextLocale);
    window.location.reload();
  });

  if (saveAuthBtn) {
    saveAuthBtn.addEventListener('click', saveDockerAuth);
  }

  if (openHomeBtn) {
    openHomeBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('home.html') });
    });
  }

  if (openWelcomeBtn) {
    openWelcomeBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    });
  }

  function loadDockerAuth() {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], function (result) {
      const usernameInput = document.getElementById('docker-username');
      const passwordInput = document.getElementById('docker-password');
      const authStatus = document.getElementById('auth-status');

      usernameInput.placeholder = messages.auth.usernamePlaceholder;
      passwordInput.placeholder = messages.auth.passwordPlaceholder;

      if (result.dockerUsername) {
        usernameInput.value = result.dockerUsername;
      }

      if (result.dockerPassword) {
        passwordInput.value = result.dockerPassword;
      }

      if (result.dockerUsername) {
        authStatus.textContent = `${messages.auth.configuredPrefix}: ${result.dockerUsername}`;
        authStatus.style.color = '#52c41a';
      } else {
        authStatus.textContent = messages.auth.notConfiguredHint;
        authStatus.style.color = '#f5222d';
      }
    });
  }

  function saveDockerAuth() {
    const usernameInput = document.getElementById('docker-username');
    const passwordInput = document.getElementById('docker-password');
    const authStatus = document.getElementById('auth-status');

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
      authStatus.textContent = messages.auth.fillCredentialsError;
      authStatus.style.color = '#f5222d';
      return;
    }

    chrome.storage.local.set(
      { dockerUsername: username, dockerPassword: password },
      function () {
        if (chrome.runtime.lastError) {
          authStatus.textContent = `${messages.auth.saveFailedPrefix}: ${chrome.runtime.lastError.message}`;
          authStatus.style.color = '#f5222d';
        } else {
          authStatus.textContent = `${messages.auth.savedPrefix}: ${username}`;
          authStatus.style.color = '#52c41a';
          passwordInput.value = '';
        }
      }
    );
  }

  function loadTasks() {
    chrome.runtime.sendMessage({ type: 'get-tasks' }, function (response) {
      if (!response) {
        return;
      }

      renderTasks(activeTasksContainer, response.tasks || [], 'active');
      renderTasks(historyTasksContainer, response.history || [], 'history');
    });
  }

  function renderTasks(container, tasks, type) {
    container.innerHTML = '';

    if (tasks.length === 0) {
      container.innerHTML = `<div class="empty-state"><p>${type === 'active' ? messages.empty.active : messages.empty.history}</p></div>`;
      return;
    }

    tasks.forEach(task => {
      const taskElement = document.createElement('div');
      taskElement.className = 'task-item';

      const progress = task.total > 0 ? Math.round((task.finished / task.total) * 100) : 0;
      let timeInfo = '';

      if (task.startTime) {
        const startTime = new Date(task.startTime);
        const languageTag = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
        const formattedTime = startTime.toLocaleTimeString(languageTag, { hour: '2-digit', minute: '2-digit' });
        timeInfo = `${messages.timeStartedLabel}: ${formattedTime}`;
      }

      const statusInfo = getStatusInfo(task, type);

      taskElement.innerHTML = `
        <div class="task-header">
          <h3 class="task-title">${task.image}:${task.tag} <small>[${task.arch}]</small></h3>
          <span class="task-status ${statusInfo.statusClass}">${statusInfo.statusText}</span>
        </div>
        <div class="task-info">
          ${timeInfo} | ${messages.totalLayersLabel}: ${task.total || 0} | ${messages.finishedLayersLabel}: ${task.finished || 0}
        </div>
        <div class="progress-bar">
          <div class="progress-inner" style="width: ${progress}%"></div>
        </div>
        ${renderLayerInfo(task)}
        ${task.errorMessage ? `<div class="error-message">${task.errorMessage}</div>` : ''}
        ${renderTaskActions(task, type)}
      `;

      container.appendChild(taskElement);
    });
  }

  function getStatusInfo(task, type) {
    if (type === 'active') {
      if (task.status === 'preparing') {
        return { statusText: messages.status.preparing, statusClass: 'status-downloading' };
      }
      if (task.status === 'downloading') {
        return { statusText: messages.status.downloading, statusClass: 'status-downloading' };
      }
      if (task.status === 'packing') {
        return { statusText: messages.status.packing, statusClass: 'status-downloading' };
      }
      if (task.status === 'completed' || task.status === 'done') {
        return { statusText: messages.status.completed, statusClass: 'status-completed' };
      }
      if (task.status === 'failed') {
        return { statusText: messages.status.failed, statusClass: 'status-failed' };
      }
    } else {
      if (task.status === 'completed' || task.status === 'done') {
        return { statusText: messages.status.completed, statusClass: 'status-completed' };
      }
      if (task.status === 'failed') {
        return { statusText: messages.status.failed, statusClass: 'status-failed' };
      }
    }

    return { statusText: task.status || '-', statusClass: 'status-downloading' };
  }

  function renderLayerInfo(task) {
    if (!task.layers || task.layers.length === 0) {
      return '';
    }

    return `
      <div class="layer-list">
        ${task.layers.map(layer => `
          <div class="layer-item">
            <span class="layer-digest">${layer.digest.substring(0, 16)}...</span>
            <span class="layer-status">${getLayerStatusText(layer.status)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function getLayerStatusText(status) {
    switch (status) {
      case 'pending':
        return messages.layerStatus.pending;
      case 'downloading':
        return messages.layerStatus.downloading;
      case 'done':
        return messages.layerStatus.done;
      case 'failed':
        return messages.layerStatus.failed;
      default:
        return status;
    }
  }

  function renderTaskActions(task, type) {
    if (type === 'active') {
      if (task.status === 'completed' || task.status === 'done') {
        return `<div class="task-actions">${messages.actions.fileSaved}</div>`;
      }

      return `
        <div class="task-actions">
          <button class="delete-active-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}" style="background-color: #ff4d4f; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">${messages.actions.cancelDownload}</button>
        </div>
      `;
    }

    if (task.status === 'completed' || task.status === 'done') {
      return `
        <div class="task-actions">
          <button class="delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.deleteRecord}</button>
        </div>
      `;
    }

    return `
      <div class="task-actions">
        <button class="retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.retry}</button>
        <button class="delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.deleteRecord}</button>
      </div>
    `;
  }

  document.addEventListener('click', function (event) {
    if (event.target.classList.contains('retry-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'retry-download', image, tag, arch }, function (response) {
        if (response && response.ok) {
          loadTasks();
        }
      });
    }

    if (event.target.classList.contains('delete-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'delete-history', image, tag, arch }, function (response) {
        if (response && response.ok) {
          loadTasks();
        }
      });
    }

    if (event.target.classList.contains('delete-active-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage({ type: 'delete-active-task', image, tag, arch }, function (response) {
        if (response && response.ok) {
          loadTasks();
        }
      });
    }
  });
});

function detectSystemLocale() {
  const raw = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage)
    ? chrome.i18n.getUILanguage()
    : (navigator.language || 'en');

  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function getPreferredLocale() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(detectSystemLocale());
      return;
    }

    chrome.storage.local.get(['preferredLanguage'], (result) => {
      resolve(result.preferredLanguage || detectSystemLocale());
    });
  });
}

function savePreferredLocale(locale) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.set({ preferredLanguage: locale }, () => resolve());
  });
}

function applyStaticTranslations(messages) {
  document.documentElement.lang = messages.lang;
  document.title = messages.pageTitle;
  document.querySelector('.popup-topbar h1').textContent = messages.headerTitle;
  document.getElementById('open-home-btn').textContent = messages.openHomeButton;
  document.getElementById('open-welcome-btn').textContent = messages.openWelcomeButton;
  document.querySelector('#active-tasks h2').textContent = messages.activeTasksTitle;
  document.querySelector('#history-tasks h2').textContent = messages.historyTasksTitle;
  document.getElementById('auth-panel-title').textContent = messages.auth.sectionTitle;
  document.getElementById('auth-panel-body').textContent = messages.auth.sectionBody;
  document.getElementById('save-auth-btn').textContent = messages.auth.saveButton;
}

function getMessages(locale) {
  const dict = {
    'zh-CN': {
      lang: 'zh-CN',
      pageTitle: 'Docker镜像下载器',
      headerTitle: 'Docker镜像下载器',
      openHomeButton: '打开主页面',
      openWelcomeButton: '查看使用指引',
      activeTasksTitle: '活动任务',
      historyTasksTitle: '历史记录',
      auth: {
        sectionTitle: 'Docker Hub 认证',
        sectionBody: '用于下载私有镜像（如 mcp/playwright）',
        saveButton: '保存认证信息',
        usernamePlaceholder: 'Docker Hub 用户名或访问令牌',
        passwordPlaceholder: '密码或访问令牌',
        configuredPrefix: '已配置',
        notConfiguredHint: '未配置（下载私有镜像时需要）',
        fillCredentialsError: '请填写用户名和密码',
        saveFailedPrefix: '保存失败',
        savedPrefix: '已保存'
      },
      empty: {
        active: '没有正在进行的下载任务',
        history: '没有历史下载记录'
      },
      timeStartedLabel: '开始时间',
      totalLayersLabel: '总层数',
      finishedLayersLabel: '已完成',
      status: {
        preparing: '准备中',
        downloading: '下载中',
        packing: '打包中',
        completed: '已完成',
        failed: '失败'
      },
      layerStatus: {
        pending: '等待中',
        downloading: '下载中',
        done: '已完成',
        failed: '失败'
      },
      actions: {
        fileSaved: '下载已完成，文件已保存',
        cancelDownload: '取消下载',
        retry: '重试',
        deleteRecord: '删除记录'
      }
    },
    en: {
      lang: 'en',
      pageTitle: 'Docker Image Downloader',
      headerTitle: 'Docker Image Downloader',
      openHomeButton: 'Open home page',
      openWelcomeButton: 'Open guide',
      activeTasksTitle: 'Active Tasks',
      historyTasksTitle: 'History',
      auth: {
        sectionTitle: 'Docker Hub Authentication',
        sectionBody: 'Used for private images such as mcp/playwright',
        saveButton: 'Save credentials',
        usernamePlaceholder: 'Docker Hub username or access token',
        passwordPlaceholder: 'Password or access token',
        configuredPrefix: 'Configured',
        notConfiguredHint: 'Not configured (required for private images)',
        fillCredentialsError: 'Please enter both username and password',
        saveFailedPrefix: 'Save failed',
        savedPrefix: 'Saved'
      },
      empty: {
        active: 'There are no active download tasks',
        history: 'There is no download history yet'
      },
      timeStartedLabel: 'Started',
      totalLayersLabel: 'Layers',
      finishedLayersLabel: 'Finished',
      status: {
        preparing: 'Preparing',
        downloading: 'Downloading',
        packing: 'Packing',
        completed: 'Completed',
        failed: 'Failed'
      },
      layerStatus: {
        pending: 'Pending',
        downloading: 'Downloading',
        done: 'Done',
        failed: 'Failed'
      },
      actions: {
        fileSaved: 'Download complete, file saved',
        cancelDownload: 'Cancel download',
        retry: 'Retry',
        deleteRecord: 'Delete record'
      }
    }
  };

  return dict[locale] || dict.en;
}
