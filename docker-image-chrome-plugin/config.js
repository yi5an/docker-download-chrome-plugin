// config.js
// 统一维护中转服务器地址

// 代理服务器配置
const PROXY_CONFIG = {
  domestic: {
    base: 'http://123.57.165.38:7000',
    proxy: '/proxy?url=',
    track: '/track'
  },
  overseas: {
    base: 'https://chrome.plugin.yi5an.xyz',
    proxy: '/proxy?url=',
    track: '/track'
  }
};

/**
 * 根据地域获取代理配置
 * @param {boolean} isChina 是否为中国IP
 * @returns {{proxy: string, track: string}} 代理配置对象
 */
function getProxyConfig(isChina) {
  return isChina ? PROXY_CONFIG.domestic : PROXY_CONFIG.overseas;
}

// 默认配置：国外代理（向后兼容）
const DEFAULT_PROXY_BASE = `${PROXY_CONFIG.overseas.base}${PROXY_CONFIG.overseas.proxy}`;
const TRACKING_URL = `${PROXY_CONFIG.overseas.base}${PROXY_CONFIG.overseas.track}`;
