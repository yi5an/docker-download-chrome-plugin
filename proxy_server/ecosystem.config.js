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
        CACHE_BLOB_MAX_SIZE: '500',      // blob缓存大小限制（MB），提高至500MB
        // 性能优化配置
        REQUEST_TIMEOUT: '300',          // 请求超时：300秒
        MAX_CONCURRENT_REQUESTS: '20',    // 最大并发请求数
        MAX_RESPONSE_SIZE: '10000',       // 最大响应大小：10GB
        STREAM_THRESHOLD: '50'           // 流式处理阈值：50MB
      },
      // 国外服务器配置（不需要上游代理，直连Docker Hub）
      env_foreign: {
        USE_PROXY: 'false',
        // 缓存配置
        CACHE_BLOB: 'true',              // 是否缓存blob请求（true=启用，false=禁用）
        CACHE_BLOB_MAX_SIZE: '1000',      // 国外网络更好，缓存1GB
        // 性能优化配置
        REQUEST_TIMEOUT: '300',          // 请求超时：300秒
        MAX_CONCURRENT_REQUESTS: '50',   // 国外并发可以更高
        MAX_RESPONSE_SIZE: '20000',       // 最大响应大小：20GB
        STREAM_THRESHOLD: '50'           // 流式处理阈值：50MB
      },
      // PM2配置
      instances: 2,                      // 运行2个实例提高可用性
      exec_mode: 'cluster',              // 使用cluster模式
      max_memory_restart: '1G',          // 内存超过1GB时重启
      min_uptime: '10s',                // 最小运行时间
      max_restarts: 5,                  // 最大重启次数
      merge_logs: true,
      time: true,
      watch: false,                     // 不自动重启（部署后重启）
      env_production: {
        NODE_ENV: 'production'
      }
    }]
  }
