document.addEventListener('DOMContentLoaded', async function () {
  const SPONSOR_DISMISS_KEY = 'sponsorPlacementState';
  const locale = await getPreferredLocale();
  const messages = getMessages(locale);

  applyStaticTranslations(messages);

  const activeList = document.getElementById('active-list');
  const historyList = document.getElementById('history-list');
  const registryHost = document.getElementById('registry-host');
  const registryHostChip = document.getElementById('registry-host-chip');
  const proxySummary = document.getElementById('proxy-summary');
  const authSummary = document.getElementById('auth-summary');
  const authStatus = document.getElementById('auth-status');
  const registryUrlText = document.getElementById('registry-url-text');
  const versionEl = document.getElementById('extension-version');
  const refreshBtn = document.getElementById('refresh-home');
  const languageToggleBtn = document.getElementById('language-toggle');
  const reopenOnboardingBtn = document.getElementById('reopen-onboarding');
  const sponsorCard = document.getElementById('home-sponsor-card');
  const dismissSponsorBtn = document.getElementById('dismiss-home-sponsor');
  const registryBase = typeof getProxyRegistryServiceUrl === 'function'
    ? getProxyRegistryServiceUrl()
    : 'http://123.57.165.38:3000';

  try {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = manifest.version || '-';
  } catch (error) {
    versionEl.textContent = '-';
  }

  languageToggleBtn.textContent = locale === 'zh-CN' ? 'EN' : '中文';
  languageToggleBtn.addEventListener('click', async function () {
    const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    await savePreferredLocale(nextLocale);
    window.location.reload();
  });

  reopenOnboardingBtn.addEventListener('click', function () {
    window.location.href = 'welcome.html?source=manual';
  });

  if (await isSponsorDismissed(SPONSOR_DISMISS_KEY)) {
    sponsorCard.classList.add('is-hidden');
  }

  dismissSponsorBtn.addEventListener('click', async function () {
    await setSponsorDismissed(SPONSOR_DISMISS_KEY);
    sponsorCard.classList.add('is-hidden');
  });

  refreshBtn.addEventListener('click', async function () {
    refreshBtn.textContent = messages.refreshingButton;
    refreshBtn.disabled = true;

    try {
      await loadAll();
    } finally {
      refreshBtn.textContent = messages.refreshButton;
      refreshBtn.disabled = false;
    }
  });

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
    await loadProxySummary();
  }

  function fmtTime(value) {
    if (!value) return '-';
    const languageTag = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
    return new Date(value).toLocaleString(languageTag);
  }

  function getStatusBadge(status) {
    if (status === 'completed' || status === 'done') {
      return `<span class="badge ok">${messages.badges.completed}</span>`;
    }
    if (status === 'failed') {
      return `<span class="badge err">${messages.badges.failed}</span>`;
    }
    return `<span class="badge warn">${messages.badges.running}</span>`;
  }

  function renderTask(task, type) {
    const progress = task.total > 0 ? Math.round((task.finished / task.total) * 100) : 0;
    const errorMessage = task.errorMessage
      ? `<p class="muted" style="margin-top: 10px; color: #b42318;">${task.errorMessage}</p>`
      : '';

    const actionHtml = type === 'active'
      ? `<button class="tiny-btn danger delete-active-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.cancelTask}</button>`
      : (task.status === 'failed'
        ? `<button class="tiny-btn primary retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.retry}</button>
           <button class="tiny-btn danger delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.deleteRecord}</button>`
        : `<button class="tiny-btn danger delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">${messages.actions.deleteRecord}</button>`);

    return `
      <article class="task">
        <div class="task-top">
          <div class="task-title">${task.image}:${task.tag} <span class="muted">[${task.arch}]</span></div>
          ${getStatusBadge(task.status)}
        </div>
        <div class="task-meta">
          <span>${messages.layersLabel} ${task.finished || 0} / ${task.total || 0}</span>
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
        : `<div class="empty">${messages.empty.active}</div>`;

      historyList.innerHTML = history.length
        ? history.slice(0, 8).map(task => renderTask(task, 'history')).join('')
        : `<div class="empty">${messages.empty.history}</div>`;
    });
  }

  function loadDockerAuth() {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], function (result) {
      document.getElementById('docker-username').value = result.dockerUsername || '';
      document.getElementById('docker-password').value = '';
      document.getElementById('docker-username').placeholder = messages.auth.usernamePlaceholder;
      document.getElementById('docker-password').placeholder = messages.auth.passwordPlaceholder;
      authSummary.textContent = result.dockerUsername ? messages.auth.configured : messages.auth.notConfigured;
      authStatus.textContent = result.dockerUsername
        ? `${messages.auth.currentAccountPrefix} ${result.dockerUsername}`
        : messages.auth.publicImageHint;
      authStatus.style.color = result.dockerUsername ? '#166534' : '#667286';
    });
  }

  function saveDockerAuth() {
    const username = document.getElementById('docker-username').value.trim();
    const password = document.getElementById('docker-password').value.trim();

    if (!username || !password) {
      authStatus.textContent = messages.auth.fillCredentialsError;
      authStatus.style.color = '#b42318';
      return;
    }

    chrome.storage.local.set({ dockerUsername: username, dockerPassword: password }, function () {
      if (chrome.runtime.lastError) {
        authStatus.textContent = `${messages.auth.saveFailedPrefix}: ${chrome.runtime.lastError.message}`;
        authStatus.style.color = '#b42318';
        return;
      }

      authStatus.textContent = `${messages.auth.updatedPrefix}: ${username}`;
      authStatus.style.color = '#166534';
      authSummary.textContent = messages.auth.configured;
      document.getElementById('docker-password').value = '';
    });
  }

  async function loadProxySummary() {
    const hostText = registryBase.replace(/^https?:\/\//, '');
    registryHost.textContent = hostText;
    registryHostChip.textContent = hostText;
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
        ? messages.proxy.onlineSummary(onlineCount)
        : messages.proxy.noHealthyNodes;
    } catch (error) {
      proxySummary.textContent = `${messages.proxy.loadFailedPrefix}: ${error.message}`;
    }
  }

  loadAll();
  setInterval(loadTasks, 1500);
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

function isSponsorDismissed(key) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(false);
      return;
    }

    chrome.storage.local.get([key], (result) => {
      resolve(Boolean(result[key]?.dismissed));
    });
  });
}

function setSponsorDismissed(key) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.set({
      [key]: {
        dismissed: true,
        dismissedAt: Date.now()
      }
    }, () => resolve());
  });
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) {
    element.textContent = value;
  }
}

function setHtml(selector, value) {
  const element = document.querySelector(selector);
  if (element) {
    element.innerHTML = value;
  }
}

function setNodeText(nodes, index, selector, value) {
  const node = nodes[index];
  if (!node) {
    return;
  }

  const target = selector ? node.querySelector(selector) : node;
  if (target) {
    target.textContent = value;
  }
}

function applyStaticTranslations(messages) {
  document.documentElement.lang = messages.lang;
  document.title = messages.pageTitle;

  setHtml('.top-pills .pill:first-child', `${messages.versionLabel} <strong id="extension-version">-</strong>`);
  setHtml('.top-pills .pill:last-child', `${messages.proxyServiceLabel} <strong id="registry-host-chip">-</strong>`);

  setText('.brand-copy span', messages.brandTagline);
  setText('.eyebrow', messages.heroEyebrow);
  setText('h1', messages.heroTitle);
  setText('.lead', messages.heroLead);
  setText('.hero-actions .btn', messages.demoButton);
  setText('#refresh-home', messages.refreshButton);
  setText('.tiny-actions a:nth-child(1)', messages.welcomePageButton);
  setText('.tiny-actions a:nth-child(2)', messages.popupButton);
  setText('#reopen-onboarding', messages.reopenGuideButton);

  setText('.hero-grid .metric:nth-child(1) .label', messages.metrics.flow.label);
  setText('.hero-grid .metric:nth-child(1) .value', messages.metrics.flow.value);
  setText('.hero-grid .metric:nth-child(2) .label', messages.metrics.troubleshooting.label);
  setText('.hero-grid .metric:nth-child(2) .value', messages.metrics.troubleshooting.value);
  setText('.hero-grid .metric:nth-child(3) .label', messages.metrics.output.label);
  setText('.hero-grid .metric:nth-child(3) .value', messages.metrics.output.value);

  setText('.hero-aside .signal:first-child .label', messages.proxy.cardLabel);
  setText('.hero-aside .signal:nth-child(2) .label', messages.auth.cardLabel);
  setText('.hero-aside .signal:nth-child(2) .sub', messages.auth.cardSub);
  setText('.quick-panel .label', messages.rhythm.label);
  setText('.quick-panel p', messages.rhythm.body);

  messages.stats.forEach((label, index) => {
    setText(`.stats .stat:nth-child(${index + 1}) .label`, label);
  });

  setText('.layout .stack:first-child .panel:first-child .section-head h2', messages.activeTasks.title);
  setText('.layout .stack:first-child .panel:first-child .section-head p', messages.activeTasks.body);
  setText('.layout .stack:first-child .panel:last-child .section-head h2', messages.history.title);
  setText('.layout .stack:first-child .panel:last-child .section-head p', messages.history.body);

  setText('.layout .stack:last-child .panel:first-child .section-head h2', messages.config.title);
  setText('.layout .stack:last-child .panel:first-child .section-head p', messages.config.body);
  const configCards = document.querySelectorAll('.config-card');
  setNodeText(configCards, 0, 'h3', messages.auth.sectionTitle);
  setNodeText(configCards, 0, 'p', messages.auth.sectionBody);
  setText('#save-auth-btn', messages.auth.saveButton);
  setNodeText(configCards, 1, 'h3', messages.proxy.sectionTitle);
  setNodeText(configCards, 1, 'p:last-child', messages.proxy.sectionBody);

  setText('.layout .stack:last-child .panel:last-child .section-head h2', messages.help.title);
  setText('.layout .stack:last-child .panel:last-child .section-head p', messages.help.body);

  const helpCards = document.querySelectorAll('.help-card');
  messages.help.cards.forEach((card, index) => {
    setNodeText(helpCards, index, 'h3', card.title);
    setNodeText(helpCards, index, 'p', card.body);
  });

  setText('#home-sponsor-kicker', messages.sponsor.kicker);
  setText('#home-sponsor-title', messages.sponsor.title);
  setText('#home-sponsor-body', messages.sponsor.body);
  setText('#home-sponsor-point-1', messages.sponsor.points[0]);
  setText('#home-sponsor-point-2', messages.sponsor.points[1]);
  setText('#home-sponsor-cta', messages.sponsor.cta);
  setText('#dismiss-home-sponsor', messages.sponsor.dismissButton);
}

function getMessages(locale) {
  const dict = {
    'zh-CN': {
      lang: 'zh-CN',
      pageTitle: 'Docker 镜像一键下载器',
      versionLabel: '版本',
      proxyServiceLabel: '代理服务',
      brandTagline: '主控台：先确认状态，再开始下载',
      heroEyebrow: 'Extension Home',
      heroTitle: '先看状态，再去下载。',
      heroLead: '这里是插件的主控页。开始下载前，可以先确认代理记录服务、Docker Hub 认证和任务状态；需要重试、清理历史或补认证时，也都可以在这里完成。',
      demoButton: '打开示例 tags',
      refreshButton: '刷新状态',
      refreshingButton: '刷新中...',
      welcomePageButton: '查看欢迎页',
      popupButton: '打开任务弹出层',
      reopenGuideButton: '重新打开使用引导',
      metrics: {
        flow: { label: '建议流程', value: '先看状态，再打开 tags 页面开始下载' },
        troubleshooting: { label: '排障重点', value: '优先看 401、429、代理节点和架构是否匹配' },
        output: { label: '交付结果', value: '任务完成后会得到可直接导入的 tar 包' }
      },
      proxy: {
        cardLabel: '代理记录服务',
        sectionTitle: '代理记录服务',
        sectionBody: '插件会从这里获取可用代理，并上报下载开始、完成和失败等任务记录。',
        onlineSummary: (count) => `当前在线 ${count} 个节点，可由记录服务动态选路`,
        noHealthyNodes: '当前没有健康节点，插件会回退到静态代理配置',
        loadFailedPrefix: '无法读取代理记录服务状态'
      },
      auth: {
        cardLabel: 'Docker Hub 认证',
        cardSub: '只有私有镜像、受限仓库或匿名限流时，才需要补认证。',
        sectionTitle: 'Docker Hub 认证',
        sectionBody: '只有私有镜像、受限仓库，或者频繁遇到匿名限流时，才需要填写。',
        saveButton: '保存认证',
        configured: '已配置',
        notConfigured: '未配置',
        currentAccountPrefix: '当前账号:',
        publicImageHint: '未配置认证，下载公开镜像时通常不需要。',
        fillCredentialsError: '请填写用户名和密码或访问令牌。',
        saveFailedPrefix: '保存失败',
        updatedPrefix: '认证已更新',
        usernamePlaceholder: 'Docker Hub 用户名或访问令牌',
        passwordPlaceholder: '密码或访问令牌'
      },
      rhythm: {
        label: '当前节奏',
        body: '主页负责判断“现在能不能顺利下”。真正发起下载，还是在 Docker Hub tags 页面右侧的下载按钮。'
      },
      stats: ['活动任务', '历史任务', '失败任务', '已完成'],
      activeTasks: {
        title: '活动任务',
        body: '这里显示正在下载或打包中的任务，也可以直接取消。'
      },
      history: {
        title: '最近历史',
        body: '保留最近 8 条任务，方便快速重试，也方便回看失败原因。'
      },
      config: {
        title: '配置',
        body: '开始下载前，先把认证和代理服务状态确认清楚。'
      },
      help: {
        title: '帮助',
        body: '出问题时先看这几条，通常能很快缩小排查范围。',
        cards: [
          {
            title: '怎么开始下载',
            body: '打开 Docker Hub 的 tags 页面，找到目标 tag 和架构，点击行右侧下载按钮。下载结果是 tar 包，可以直接 docker load -i image.tar。'
          },
          {
            title: '什么时候要配置认证',
            body: '只有私有镜像、受限仓库，或者匿名拉取触发限流时，才需要补 Docker Hub 账号或访问令牌。'
          },
          {
            title: '为什么会失败',
            body: '最常见的原因是 401、429、代理节点不可用，或者目标 tag、架构不存在。失败原因会直接显示在任务卡片里。'
          }
        ]
      },
      sponsor: {
        kicker: '赞助推荐位',
        title: '这里更适合放开发者相关的赞助推荐，而不是弹窗广告。',
        body: '比如云服务器、镜像代理托管、团队协作或开发工具联盟链接，都比打断下载流程的广告更适合这个插件。',
        points: [
          '只在帮助区域展示，不占用任务状态和下载入口。',
          '用户关闭后记住，后续不重复打扰。'
        ],
        cta: '回欢迎页看另一种展示',
        dismissButton: '关闭推荐'
      },
      badges: {
        completed: '已完成',
        failed: '失败',
        running: '进行中'
      },
      actions: {
        cancelTask: '取消任务',
        retry: '重试',
        deleteRecord: '删除记录'
      },
      layersLabel: '层数',
      empty: {
        active: '当前没有正在进行的下载任务。',
        history: '还没有历史任务。'
      }
    },
    en: {
      lang: 'en',
      pageTitle: 'Docker Image Downloader',
      versionLabel: 'Version',
      proxyServiceLabel: 'Proxy Service',
      brandTagline: 'Control center: check status before downloading',
      heroEyebrow: 'Extension Home',
      heroTitle: 'Check the status first, then download.',
      heroLead: 'This is the control page for the extension. Before starting a download, you can verify the proxy registry service, Docker Hub authentication, and task health. Retry, cleanup, and credential updates also happen here.',
      demoButton: 'Open demo tags',
      refreshButton: 'Refresh status',
      refreshingButton: 'Refreshing...',
      welcomePageButton: 'Open welcome page',
      popupButton: 'Open task popup',
      reopenGuideButton: 'Reopen guide',
      metrics: {
        flow: { label: 'Suggested Flow', value: 'Check status first, then open the tags page and download' },
        troubleshooting: { label: 'Troubleshooting', value: 'Start with 401, 429, proxy node health, and architecture match' },
        output: { label: 'Output', value: 'Completed tasks produce an import-ready tar file' }
      },
      proxy: {
        cardLabel: 'Proxy Registry Service',
        sectionTitle: 'Proxy Registry Service',
        sectionBody: 'The extension fetches available proxies from here and reports task start, completion, and failure events.',
        onlineSummary: (count) => `${count} healthy node(s) online, with routing managed by the registry service`,
        noHealthyNodes: 'No healthy nodes are available right now, so the extension will fall back to static proxy configuration',
        loadFailedPrefix: 'Unable to read proxy registry status'
      },
      auth: {
        cardLabel: 'Docker Hub Auth',
        cardSub: 'Only add credentials for private images, restricted repositories, or anonymous rate limits.',
        sectionTitle: 'Docker Hub Authentication',
        sectionBody: 'You only need this for private images, restricted repositories, or repeated anonymous rate limiting.',
        saveButton: 'Save credentials',
        configured: 'Configured',
        notConfigured: 'Not set',
        currentAccountPrefix: 'Current account:',
        publicImageHint: 'Authentication is not configured. It is usually unnecessary for public images.',
        fillCredentialsError: 'Please enter a username and password, or an access token.',
        saveFailedPrefix: 'Save failed',
        updatedPrefix: 'Authentication updated',
        usernamePlaceholder: 'Docker Hub username or access token',
        passwordPlaceholder: 'Password or access token'
      },
      rhythm: {
        label: 'Current Rhythm',
        body: 'The home page answers one question: can downloads succeed right now? Actual downloads still start from the button on the Docker Hub tags page.'
      },
      stats: ['Active Tasks', 'History', 'Failed', 'Completed'],
      activeTasks: {
        title: 'Active Tasks',
        body: 'This section shows downloads and packaging jobs that are still running. You can also cancel them here.'
      },
      history: {
        title: 'Recent History',
        body: 'The latest 8 tasks are kept here so you can retry quickly and compare failure reasons.'
      },
      config: {
        title: 'Configuration',
        body: 'Before downloading, confirm both authentication and proxy service status here.'
      },
      help: {
        title: 'Help',
        body: 'Start with these checks when something fails. They usually narrow the problem down quickly.',
        cards: [
          {
            title: 'How to start a download',
            body: 'Open a Docker Hub tags page, find the target tag and architecture, and click the download button on the right. The result is a tar file that you can load with docker load -i image.tar.'
          },
          {
            title: 'When credentials are needed',
            body: 'You only need Docker Hub credentials for private images, restricted repositories, or anonymous pulls that hit rate limits.'
          },
          {
            title: 'Why a task may fail',
            body: 'The most common causes are 401, 429, unavailable proxy nodes, or missing tag and architecture variants. The failure reason is shown directly in the task card.'
          }
        ]
      },
      sponsor: {
        kicker: 'Sponsor Slot',
        title: 'This spot is better for developer-focused sponsorships than popup ads.',
        body: 'Cloud servers, managed proxy nodes, team collaboration tools, or developer affiliate offers all fit this extension better than anything that interrupts downloads.',
        points: [
          'Keep it inside the help area so task status and download entry points stay untouched.',
          'Remember when a user dismisses it so the recommendation does not keep coming back.'
        ],
        cta: 'See the welcome placement',
        dismissButton: 'Dismiss'
      },
      badges: {
        completed: 'Completed',
        failed: 'Failed',
        running: 'In Progress'
      },
      actions: {
        cancelTask: 'Cancel task',
        retry: 'Retry',
        deleteRecord: 'Delete record'
      },
      layersLabel: 'Layers',
      empty: {
        active: 'There are no active download tasks right now.',
        history: 'There is no task history yet.'
      }
    }
  };

  return dict[locale] || dict.en;
}
