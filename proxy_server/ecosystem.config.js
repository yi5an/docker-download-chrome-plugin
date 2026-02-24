module.exports = {
    apps: [{
      name: 'docker-download-proxy',
      script: 'service.js',
      // 国内服务器配置（需要上游代理）
      env: {
        USE_PROXY: 'true',
        PROXY_URL: 'http://127.0.0.1:7890',
        // 缓存配置
        CACHE_BLOB: 'true',              // 是否缓存blob请求（true=启用，false=禁用）
        CACHE_BLOB_MAX_SIZE: '200'    // blob缓存大小限制（MB），默认200MB
      },
      // 国外服务器配置（不需要上游代理，直连Docker Hub）
      env_foreign: {
        USE_PROXY: 'false',
        // 缓存配置
        CACHE_BLOB: 'true',              // 是否缓存blob请求（true=启用，false=禁用）
        CACHE_BLOB_MAX_SIZE: '200'    // blob缓存大小限制（MB），默认200MB
      }
    }]
  }
