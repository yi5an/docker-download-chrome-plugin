// ============================================================
// 部署说明：
//
// 1. 同一台机器部署两个服务：
//    pm2 start ecosystem.config.js                 # 国内服务器
//    pm2 start ecosystem.config.js --env foreign    # 国外服务器
//
// 2. 只部署代理转发服务（注册服务在另一台机器）：
//    pm2 start ecosystem.config.js --only docker-download-proxy                 # 国内
//    pm2 start ecosystem.config.js --only docker-download-proxy --env foreign    # 国外
//
// 3. 只部署注册服务：
//    pm2 start ecosystem.config.js --only docker-download-server
//
// 4. 保存 & 开机自启：
//    pm2 save && pm2 startup
//
// 注意：部署前将下面的 YOUR_SERVER_IP 替换为实际公网 IP
// ============================================================

const PUBLIC_IP = 'YOUR_SERVER_IP';  // ← 替换为实际公网 IP

module.exports = {
    apps: [
      // ==================== 代理注册服务 ====================
      {
        name: 'docker-download-server',
        script: '../server/server.js',
        cwd: __dirname,
        env: {
          PORT: '3000'
        },
        instances: 1,
        exec_mode: 'fork',
        node_args: '--max-old-space-size=256',
        max_memory_restart: '256M',
        min_uptime: '10s',
        max_restarts: 5,
        merge_logs: true,
        time: true,
        watch: false,
        env_production: {
          NODE_ENV: 'production'
        }
      },
      // ==================== 代理转发服务 ====================
      {
        name: 'docker-download-proxy',
        script: 'service.js',
        // 国内服务器配置（需要上游代理）
        env: {
          PORT: '7001',
          PROXY_NODE_ID: `proxy-cn-${PUBLIC_IP}`,
          PROXY_PUBLIC_BASE_URL: `http://${PUBLIC_IP}:7001`,
          REGISTRY_SERVICE_URL: 'http://127.0.0.1:3000',
          USE_PROXY: 'true',
          PROXY_URL: 'http://127.0.0.1:7890',
          // 缓存配置
          CACHE_BLOB: 'true',
          CACHE_BLOB_MAX_SIZE: '500',
          // 性能优化配置
          REQUEST_TIMEOUT: '1800',
          MAX_CONCURRENT_REQUESTS: '20',
          MAX_RESPONSE_SIZE: '10000',
          STREAM_THRESHOLD: '50'
        },
        // 国外服务器配置（不需要上游代理，直连 Docker Hub）
        env_foreign: {
          PORT: '7001',
          PROXY_NODE_ID: `proxy-foreign-${PUBLIC_IP}`,
          PROXY_PUBLIC_BASE_URL: `http://${PUBLIC_IP}:7001`,
          REGISTRY_SERVICE_URL: 'http://127.0.0.1:3000',
          USE_PROXY: 'false',
          // 缓存配置
          CACHE_BLOB: 'true',
          CACHE_BLOB_MAX_SIZE: '1000',
          // 性能优化配置
          REQUEST_TIMEOUT: '1800',
          MAX_CONCURRENT_REQUESTS: '50',
          MAX_RESPONSE_SIZE: '20000',
          STREAM_THRESHOLD: '50'
        },
        instances: 1,
        exec_mode: 'fork',
        node_args: '--max-old-space-size=512',
        max_memory_restart: '512M',
        min_uptime: '10s',
        max_restarts: 5,
        merge_logs: true,
        time: true,
        watch: false,
        env_production: {
          NODE_ENV: 'production'
        }
      }
    ]
  }
