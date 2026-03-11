document.addEventListener('DOMContentLoaded', () => {
  const registryBase = typeof getProxyRegistryServiceUrl === 'function'
    ? getProxyRegistryServiceUrl()
    : 'http://127.0.0.1:3000';
  const installScriptUrl = `${registryBase}/install-proxy.sh`;
  const installCommand = `curl -fsSL ${installScriptUrl} | REGISTRY_SERVICE_URL=${registryBase} bash -s -- <YOUR_PUBLIC_IP> 7001`;

  const commandEl = document.getElementById('install-command');
  const statusEl = document.getElementById('copy-status');
  const copyCommandBtn = document.getElementById('copy-command');
  const copyScriptBtn = document.getElementById('copy-script-url');

  commandEl.textContent = installCommand;

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = successMessage;
      statusEl.style.color = '#15803d';
    } catch (error) {
      statusEl.textContent = `复制失败: ${error.message}`;
      statusEl.style.color = '#b42318';
    }
  }

  copyCommandBtn.addEventListener('click', () => {
    copyText(installCommand, '一键安装命令已复制');
  });

  copyScriptBtn.addEventListener('click', () => {
    copyText(installScriptUrl, '脚本地址已复制');
  });
});
