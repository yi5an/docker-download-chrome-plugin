// config.js
// 统一维护代理记录服务与静态兜底代理配置

const PROXY_REGISTRY_CONFIG = {
  serviceBase: 'http://127.0.0.1:3000',
  select: '/api/proxies/select',
  downloadsStart: '/api/downloads/start',
  downloadsComplete: '/api/downloads/complete',
  downloadsFail: '/api/downloads/fail'
};

const FALLBACK_PROXY_CONFIG = {
  domestic: {
    proxyId: 'fallback-domestic',
    name: 'Fallback Domestic',
    baseUrl: 'http://123.57.165.38:7000',
    proxyPath: '/proxy?url=',
    trackPath: '/track',
    location: {
      countryCode: 'CN',
      country: 'China'
    }
  },
  overseas: {
    proxyId: 'fallback-overseas',
    name: 'Fallback Overseas',
    baseUrl: 'https://chrome.plugin.yi5an.xyz',
    proxyPath: '/proxy?url=',
    trackPath: '/track',
    location: {
      countryCode: 'US',
      country: 'United States'
    }
  }
};

function getFallbackProxyConfig(isChina) {
  return isChina ? FALLBACK_PROXY_CONFIG.domestic : FALLBACK_PROXY_CONFIG.overseas;
}

function getProxyRegistryServiceUrl() {
  return PROXY_REGISTRY_CONFIG.serviceBase;
}

const DEFAULT_PROXY_BASE = `${FALLBACK_PROXY_CONFIG.overseas.baseUrl}${FALLBACK_PROXY_CONFIG.overseas.proxyPath}`;
const TRACKING_URL = `${PROXY_REGISTRY_CONFIG.serviceBase}${PROXY_REGISTRY_CONFIG.downloadsStart}`;

this.getFallbackProxyConfig = getFallbackProxyConfig;
this.getProxyRegistryServiceUrl = getProxyRegistryServiceUrl;
this.PROXY_REGISTRY_CONFIG = PROXY_REGISTRY_CONFIG;
