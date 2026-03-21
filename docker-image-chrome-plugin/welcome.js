document.addEventListener('DOMContentLoaded', async () => {
  const SPONSOR_DISMISS_KEY = 'sponsorPlacementState';
  const locale = await getPreferredLocale();
  const urlParams = new URLSearchParams(window.location.search);
  const source = urlParams.get('source') || 'default';
  const bannerMode = source === 'install' ? 'install' : (source === 'update' ? 'update' : 'manual');
  const messages = getMessages(locale, {
    bannerMode,
    version: urlParams.get('version') || '',
    fromVersion: urlParams.get('from') || ''
  });

  applyStaticTranslations(messages);

  const registryBase = typeof getProxyRegistryServiceUrl === 'function'
    ? getProxyRegistryServiceUrl()
    : 'http://123.57.165.38:3000';
  const installScriptUrl = `${registryBase}/install-proxy.sh`;
  const installCommand = `curl -fsSL ${installScriptUrl} | REGISTRY_SERVICE_URL=${registryBase} bash -s -- <YOUR_PUBLIC_IP> 7001`;

  const commandEl = document.getElementById('install-command');
  const statusEl = document.getElementById('copy-status');
  const copyCommandBtn = document.getElementById('copy-command');
  const copyScriptBtn = document.getElementById('copy-script-url');
  const versionEl = document.getElementById('extension-version');
  const proxyHostChipEl = document.getElementById('proxy-host-chip');
  const openHomeBtn = document.getElementById('open-home');
  const languageToggleBtn = document.getElementById('language-toggle');
  const installBanner = document.getElementById('install-banner');
  const completeOnboardingBtn = document.getElementById('complete-onboarding');
  const sponsorPanel = document.getElementById('welcome-sponsor-panel');
  const dismissSponsorBtn = document.getElementById('dismiss-welcome-sponsor');

  commandEl.textContent = installCommand;
  proxyHostChipEl.textContent = registryBase.replace(/^https?:\/\//, '');

  try {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = manifest.version || '-';
  } catch (error) {
    versionEl.textContent = '-';
  }

  languageToggleBtn.textContent = locale === 'zh-CN' ? 'EN' : '中文';
  languageToggleBtn.addEventListener('click', async () => {
    const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    await savePreferredLocale(nextLocale);
    window.location.reload();
  });

  if (source === 'install' || source === 'update') {
    installBanner.classList.add('visible');
  }

  if (await isSponsorDismissed(SPONSOR_DISMISS_KEY)) {
    sponsorPanel.classList.add('is-hidden');
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = successMessage;
      statusEl.style.color = '#15803d';
    } catch (error) {
      statusEl.textContent = `${messages.copyFailedPrefix}: ${error.message}`;
      statusEl.style.color = '#b42318';
    }
  }

  copyCommandBtn.addEventListener('click', () => {
    copyText(installCommand, messages.copyCommandSuccess);
  });

  copyScriptBtn.addEventListener('click', () => {
    copyText(installScriptUrl, messages.copyScriptSuccess);
  });

  openHomeBtn.addEventListener('click', async () => {
    await markOnboardingCompleted();
    window.location.href = 'home.html';
  });

  completeOnboardingBtn.addEventListener('click', async () => {
    await markOnboardingCompleted();
    window.location.href = 'home.html';
  });

  dismissSponsorBtn.addEventListener('click', async () => {
    await setSponsorDismissed(SPONSOR_DISMISS_KEY);
    sponsorPanel.classList.add('is-hidden');
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

function markOnboardingCompleted() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.get(['onboardingState'], (result) => {
      const current = result.onboardingState || {};
      chrome.storage.local.set({
        onboardingState: {
          ...current,
          completed: true,
          completedAt: Date.now()
        }
      }, () => resolve());
    });
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

function applyStaticTranslations(messages) {
  document.documentElement.lang = messages.lang;
  document.title = messages.pageTitle;

  setHtml('.top-pills .pill:first-child', `${messages.versionLabel} <strong id="extension-version">-</strong>`);
  setHtml('.top-pills .pill:last-child', `${messages.proxyServiceLabel} <strong id="proxy-host-chip">Loading</strong>`);

  setText('.brand-copy span', messages.brandTagline);
  setText('#install-banner-kicker', messages.installBanner.kicker);
  setText('#install-banner-title', messages.installBanner.title);
  setText('#install-banner-body', messages.installBanner.body);
  setText('#install-banner-demo', messages.installBanner.demoButton);
  setText('#complete-onboarding', messages.installBanner.completeButton);
  setText('.eyebrow', messages.heroEyebrow);
  setText('.headline', messages.heroTitle);
  setText('.lead', messages.heroLead);
  setText('.hero-actions .btn', messages.openDemoButton);
  setText('#open-home', messages.openHomeButton);
  setText('.quick-row a:first-child', messages.openPopupButton);
  setText('.quick-row a:last-child', messages.openProxySectionButton);

  setText('.hero-grid .metric:nth-child(1) .label', messages.metrics.entry.label);
  setText('.hero-grid .metric:nth-child(1) .value', messages.metrics.entry.value);
  setText('.hero-grid .metric:nth-child(2) .label', messages.metrics.output.label);
  setText('.hero-grid .metric:nth-child(2) .value', messages.metrics.output.value);
  setText('.hero-grid .metric:nth-child(3) .label', messages.metrics.scenarios.label);
  setText('.hero-grid .metric:nth-child(3) .value', messages.metrics.scenarios.value);

  setText('.floating-card .card-kicker', messages.flowKicker);
  setText('.terminal code', messages.flowCode);
  setText('.side-card .card-kicker', messages.sideCard.kicker);
  setText('.side-card strong', messages.sideCard.title);
  setText('.side-card p', messages.sideCard.body);

  setText('.layout .panel:first-child .section-heading h2', messages.quickStart.title);
  setText('.layout .panel:first-child .section-heading p', messages.quickStart.body);

  messages.steps.forEach((step, index) => {
    setText(`.steps-grid .step:nth-child(${index + 1}) strong`, step.title);
    setText(`.steps-grid .step:nth-child(${index + 1}) p`, step.body);
  });

  messages.highlights.forEach((item, index) => {
    setText(`.highlight-strip .highlight:nth-child(${index + 1}) .tag`, item.label);
    setText(`.highlight-strip .highlight:nth-child(${index + 1}) strong`, item.value);
  });

  setText('#proxy-setup .section-heading h2', messages.proxySetup.title);
  setText('#proxy-setup .section-heading p', messages.proxySetup.body);
  setText('#proxy-setup .callout', messages.proxySetup.callout);
  setText('#copy-command', messages.proxySetup.copyCommandButton);
  setText('#copy-script-url', messages.proxySetup.copyScriptButton);

  messages.proxySetup.notes.forEach((note, index) => {
    setText(`.note-list .note-item:nth-child(${index + 1}) strong`, note.title);
    setText(`.note-list .note-item:nth-child(${index + 1}) p`, note.body);
  });

  setText('.fine', messages.proxySetup.finePrint);
  setText('#welcome-sponsor-kicker', messages.sponsor.kicker);
  setText('#welcome-sponsor-title', messages.sponsor.title);
  setText('#welcome-sponsor-body', messages.sponsor.body);
  setText('#welcome-sponsor-point-1', messages.sponsor.points[0]);
  setText('#welcome-sponsor-point-2', messages.sponsor.points[1]);
  setText('#welcome-sponsor-cta', messages.sponsor.cta);
  setText('#dismiss-welcome-sponsor', messages.sponsor.dismissButton);
}

function getMessages(locale, context = {}) {
  const bannerMode = context.bannerMode || 'install';
  const version = context.version || '';
  const fromVersion = context.fromVersion || '';

  const dict = {
    'zh-CN': {
      lang: 'zh-CN',
      pageTitle: 'Docker 镜像一键下载器 - 安装引导',
      versionLabel: '版本',
      proxyServiceLabel: '代理服务',
      brandTagline: '少走流程，尽快把镜像拿到手',
      installBanner: bannerMode === 'update'
        ? {
          kicker: '版本更新',
          title: `插件已更新到 ${version || '新版本'}，可以快速看一眼变化。`,
          body: fromVersion
            ? `你刚刚从 ${fromVersion} 升级到了 ${version || '新版本'}。这次版本已经补上了双语界面、语言切换和更完整的欢迎页体验。`
            : '这次版本已经补上了双语界面、语言切换和更完整的欢迎页体验。',
          demoButton: '打开示例 tags 页',
          completeButton: '知道了，去主页'
        }
        : {
          kicker: bannerMode === 'manual' ? '使用引导' : '首次安装',
          title: bannerMode === 'manual' ? '这里是使用引导页，随时都可以回来查看。' : '插件已经安装完成，接下来就差真正用起来。',
          body: bannerMode === 'manual'
            ? '如果你一时忘了按钮出现在哪、下载结果是什么，或者代理节点怎么部署，可以把这一页当作快速说明书。'
            : '建议先打开一个 Docker Hub tags 页面确认按钮位置，再回到主页查看任务、认证和代理状态。整个过程不需要额外复杂配置。',
          demoButton: bannerMode === 'manual' ? '打开示例 tags 页' : '立即打开示例 tags 页',
          completeButton: bannerMode === 'manual' ? '返回主页' : '知道了，去主页'
        },
      heroEyebrow: 'Welcome Aboard',
      heroTitle: '从 Docker Hub tags 页，直接下载镜像。',
      heroLead: '插件会在 Docker Hub 的 tags 页面里直接加上下载入口。选好 tag 和架构后点一下，就能把镜像打包成可导入的 tar 文件，不用手抄命令，也不用自己拼 layers。',
      openDemoButton: '打开示例 tags 页',
      openHomeButton: '打开插件主页',
      openPopupButton: '查看任务弹出层',
      openProxySectionButton: '部署代理节点',
      metrics: {
        entry: { label: '下载入口', value: '按钮直接出现在 tags 列表右侧' },
        output: { label: '交付结果', value: '下载完成后得到可直接导入的 tar 包' },
        scenarios: { label: '适用场景', value: '离线导入、架构挑选、临时救急' }
      },
      flowKicker: '一眼看懂流程',
      flowCode: '1. 打开 Docker Hub 镜像 tags 页面\n2. 找到正确 tag 和架构\n3. 点击下载按钮\n4. 等待打包完成\n5. docker load -i image.tar',
      sideCard: {
        kicker: '公益项目',
        title: '默认先能用，再考虑更复杂的配置。',
        body: '大多数情况下，安装插件后就可以直接开始下载。只有在网络不稳定、匿名拉取受限，或者你想提供共享节点时，才需要代理服务。'
      },
      quickStart: {
        title: '3 分钟上手',
        body: '第一次打开时先看这一页，知道按钮出现在哪、结果是什么、出问题时该去哪里看。'
      },
      steps: [
        {
          title: '打开目标镜像的 tags 页面',
          body: '不管是官方镜像还是私有仓库，都建议从 tags 页进入，因为这里能直接看到每个 tag 对应的架构列表。'
        },
        {
          title: '确认 tag 和架构，再点下载',
          body: '同一个 tag 往往同时有 `amd64`、`arm64`、`arm/v7` 等变体。确认目标环境需要哪个架构，再点对应按钮。'
        },
        {
          title: '用弹出层查看进度和错误',
          body: '浏览器右上角的插件弹出层会显示活动任务、历史记录和失败原因。多数时候，不用开控制台也能定位问题。'
        },
        {
          title: '下载完成后直接导入运行环境',
          body: '下载结果是标准 tar 包。拿到文件后可以执行 `docker load -i image.tar`，也可以继续用 `ctr`、`nerdctl` 等工具处理。'
        }
      ],
      highlights: [
        { label: '认证', value: '下载公开镜像时，通常不需要填写 Docker Hub 账号。' },
        { label: '代理', value: '代理节点是增强能力，不是安装插件后的必选项。' },
        { label: '结果', value: '最终拿到的是文件，不是本地镜像 ID。' }
      ],
      proxySetup: {
        title: '可选：部署代理节点',
        body: '如果你有公网 IP 云服务器，想给自己或团队提供更稳定的下载入口，可以直接复制下面的安装命令。',
        callout: '插件本身可以直接使用，不要求先部署代理。只有在你需要更稳定的网络链路、更多可用节点，或者打算共享下载能力时，再考虑这一部分。',
        copyCommandButton: '复制安装命令',
        copyScriptButton: '复制脚本地址',
        notes: [
          {
            title: '替换公网 IP',
            body: '把命令里的 <YOUR_PUBLIC_IP> 换成你的云服务器公网 IP。安装脚本会先检查环境，然后通过 pm2 托管服务进程。'
          },
          {
            title: '提前放行 7001 端口',
            body: '记录服务会反向探测 http://<YOUR_PUBLIC_IP>:7001/health。如果安全组或防火墙没放行，注册会直接超时。'
          },
          {
            title: '需要上游代理时再追加环境变量',
            body: '如果你的云服务器访问 Docker Hub 也需要代理，可以在执行前追加 USE_PROXY=true PROXY_URL=http://127.0.0.1:7890。'
          }
        ],
        finePrint: '节点本身资源占用不高，主要成本来自出口带宽和少量磁盘缓存。如果后续有赞助或收益，再考虑按流量给节点提供者补贴也不迟。'
      },
      sponsor: {
        kicker: '赞助推荐位',
        title: '这个位置以后可以放克制型赞助推荐。',
        body: '建议优先放和开发者工作流强相关的内容，比如云服务器、代理节点赞助、镜像托管工具或团队协作服务，而不是打断式广告。',
        points: [
          '只放在欢迎页和主页，不插到 Docker Hub 下载界面里。',
          '让用户可以关闭，而且关闭后记住，不要反复打扰。'
        ],
        cta: '先看主页里的展示位',
        dismissButton: '关闭推荐'
      },
      copyCommandSuccess: '安装命令已复制',
      copyScriptSuccess: '脚本地址已复制',
      copyFailedPrefix: '复制失败'
    },
    en: {
      lang: 'en',
      pageTitle: 'Docker Image Downloader - Getting Started',
      versionLabel: 'Version',
      proxyServiceLabel: 'Proxy Service',
      brandTagline: 'Fewer steps, faster image downloads',
      installBanner: bannerMode === 'update'
        ? {
          kicker: 'Updated',
          title: `The extension is now on ${version || 'the latest version'}.`,
          body: fromVersion
            ? `You just upgraded from ${fromVersion} to ${version || 'the latest version'}. This release adds bilingual UI support, language switching, and a more complete welcome experience.`
            : 'This release adds bilingual UI support, language switching, and a more complete welcome experience.',
          demoButton: 'Open demo tags page',
          completeButton: 'Got it, open home'
        }
        : {
          kicker: bannerMode === 'manual' ? 'Guide' : 'First Install',
          title: bannerMode === 'manual' ? 'This guide stays here whenever you need to come back.' : 'The extension is installed. Now let’s make it useful right away.',
          body: bannerMode === 'manual'
            ? 'Use this page as a quick reference whenever you want to remember where the button appears, what the output looks like, or how proxy nodes are set up.'
            : 'Start by opening a Docker Hub tags page so you can see where the download button appears, then return to the home page to check tasks, auth, and proxy status.',
          demoButton: 'Open a demo tags page',
          completeButton: bannerMode === 'manual' ? 'Back to home' : 'Got it, open home'
        },
      heroEyebrow: 'Welcome Aboard',
      heroTitle: 'Download images straight from Docker Hub tags pages.',
      heroLead: 'This extension adds download actions directly to Docker Hub tags pages. Pick the right tag and architecture, click once, and get an importable tar file without piecing layers together by hand.',
      openDemoButton: 'Open demo tags page',
      openHomeButton: 'Open extension home',
      openPopupButton: 'Open task popup',
      openProxySectionButton: 'Deploy a proxy node',
      metrics: {
        entry: { label: 'Entry Point', value: 'Buttons appear right beside each tags row' },
        output: { label: 'Output', value: 'You get an import-ready tar file when the task finishes' },
        scenarios: { label: 'Best For', value: 'Offline import, architecture selection, fast recovery' }
      },
      flowKicker: 'Quick flow',
      flowCode: '1. Open a Docker Hub tags page\n2. Find the right tag and architecture\n3. Click the download button\n4. Wait for packaging to finish\n5. docker load -i image.tar',
      sideCard: {
        kicker: 'Community project',
        title: 'Start simple first, add more setup only when needed.',
        body: 'In most cases, you can install the extension and start downloading right away. Only add proxy services when the network is unstable, anonymous pulls are limited, or you want to share download capacity.'
      },
      quickStart: {
        title: 'Get started in 3 minutes',
        body: 'Use this page once to learn where the button appears, what the output looks like, and where to check when something goes wrong.'
      },
      steps: [
        {
          title: 'Open the target image tags page',
          body: 'For both official images and private repositories, the tags page is the best starting point because it shows the available architectures for each tag.'
        },
        {
          title: 'Confirm the tag and architecture, then download',
          body: 'A single tag may provide amd64, arm64, arm/v7, and other variants. Choose the one that matches your target environment before downloading.'
        },
        {
          title: 'Use the popup to check progress and errors',
          body: 'The extension popup shows active tasks, history, and failure reasons. In most cases, you can diagnose the issue without opening DevTools.'
        },
        {
          title: 'Import the result into your runtime',
          body: 'The output is a standard tar file. You can load it with docker load -i image.tar, or continue with ctr, nerdctl, and related tools.'
        }
      ],
      highlights: [
        { label: 'Auth', value: 'Public images usually do not require Docker Hub credentials.' },
        { label: 'Proxy', value: 'Proxy nodes are optional enhancements, not a setup prerequisite.' },
        { label: 'Result', value: 'The final output is a file, not a local image ID.' }
      ],
      proxySetup: {
        title: 'Optional: deploy a proxy node',
        body: 'If you have a public cloud server and want a steadier download entry point for yourself or your team, copy the install command below.',
        callout: 'The extension works without deploying a proxy first. Only consider this part when you need a steadier network path, more available nodes, or shared download capacity.',
        copyCommandButton: 'Copy install command',
        copyScriptButton: 'Copy script URL',
        notes: [
          {
            title: 'Replace the public IP',
            body: 'Replace <YOUR_PUBLIC_IP> in the command with your server public IP. The install script checks the environment first, then manages the service with pm2.'
          },
          {
            title: 'Open port 7001 first',
            body: 'The registry service probes http://<YOUR_PUBLIC_IP>:7001/health. If your security group or firewall blocks it, registration will time out.'
          },
          {
            title: 'Append upstream proxy variables only when needed',
            body: 'If your cloud server also needs a proxy to reach Docker Hub, append USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 before running the command.'
          }
        ],
        finePrint: 'The node itself is lightweight. The main cost is outbound bandwidth plus a small amount of disk cache. If the project later gets sponsorship or revenue, traffic-based compensation can be considered.'
      },
      sponsor: {
        kicker: 'Sponsor Slot',
        title: 'This area can host restrained sponsor recommendations later.',
        body: 'The best fit is developer-adjacent offers such as cloud servers, proxy node sponsors, image hosting tools, or team collaboration services instead of disruptive ads.',
        points: [
          'Keep it on the welcome and home pages only, never inside the Docker Hub download workflow.',
          'Let people dismiss it once and remember that choice so it does not keep interrupting them.'
        ],
        cta: 'Preview the home placement',
        dismissButton: 'Dismiss'
      },
      copyCommandSuccess: 'Install command copied',
      copyScriptSuccess: 'Script URL copied',
      copyFailedPrefix: 'Copy failed'
    }
  };

  return dict[locale] || dict.en;
}
