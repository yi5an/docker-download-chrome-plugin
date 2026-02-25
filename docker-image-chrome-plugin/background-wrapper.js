// background-wrapper.js
// 加载config.js，docker-download.js，然后加载background.js

console.log('[Wrapper] Loading scripts...');

try {
  // 首先加载config.js
  importScripts('config.js');
  console.log('[Wrapper] config.js loaded, getProxyConfig available:', typeof getProxyConfig);

  // 加载docker-download.js
  importScripts('./core/docker-download.js');
  console.log('[Wrapper] docker-download.js loaded');

  // 然后加载background.js
  importScripts('background.js');
  console.log('[Wrapper] background.js loaded, onMessage registered:', typeof chrome.runtime.onMessage?.hasListener);
} catch (error) {
  console.error('[Wrapper] Failed to load scripts:', error);
}