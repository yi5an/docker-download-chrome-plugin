# 代理服务器启动指南

## 问题说明

如果您遇到以下错误：
```
Client network socket disconnected before secure TLS connection was established
```

这是因为代理服务器默认配置了通过本地代理（127.0.0.1:7890）转发请求，但该代理不可用。

---

## 🚀 快速解决方案

### 方案 1：直连模式（推荐）

**适用场景**：您的服务器部署在国外（阿里云/腾讯云/AWS等）

**Windows**：
```bash
cd proxy_server
start-direct.bat
```

**Linux/Mac**：
```bash
cd proxy_server
node service.js
```

**使用 PM2 启动**：
```bash
cd proxy_server
pm2 start service.js --name docker-proxy
```

---

### 方案 2：代理模式

**适用场景**：您的服务器在国内，需要通过本地代理访问 Docker Registry

**前提条件**：
- ✅ 确保本地代理（Clash/V2Ray）正在运行
- ✅ 代理地址为 `127.0.0.1:7890`（或其他端口）

**Windows**：
```bash
cd proxy_server
start-proxy.bat
```

**Linux/Mac**：
```bash
cd proxy_server
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 node service.js
```

**使用 PM2 启动（代理模式）**：
```bash
cd proxy_server
pm2 start service.js --name docker-proxy --env USE_PROXY=true --env PROXY_URL=http://127.0.0.1:7890
```

---

## 📝 启动脚本说明

### start-direct.bat（直连模式）
```
- 不使用本地代理
- 直接访问 Docker Registry
- 适合服务器在国外
```

### start-proxy.bat（代理模式）
```
- 通过本地代理（127.0.0.1:7890）访问
- 适合服务器在国内
- 需要代理软件（Clash/V2Ray）运行
```

---

## 🔧 环境变量配置

### USE_PROXY
- `true` - 使用代理
- `false` 或未设置 - 直连模式

### PROXY_URL
- 默认：`http://127.0.0.1:7890`
- 可修改为其他代理地址

**示例**：
```bash
# 使用自定义代理
USE_PROXY=true PROXY_URL=http://192.168.1.100:1080 node service.js

# 禁用代理
USE_PROXY=false node service.js
```

---

## 🎯 PM2 配置（推荐生产环境）

### 创建 ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'docker-proxy',
    script: './service.js',
    cwd: '/root/project/docker-download-chrome-plugin/proxy_server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    env_production: {
      // 生产环境：直连模式（服务器在国外）
      USE_PROXY: 'false'
      // 或者：代理模式（服务器在国内）
      // USE_PROXY: 'true',
      // PROXY_URL: 'http://127.0.0.1:7890'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
```

### 启动命令

```bash
# 使用配置文件启动
pm2 start ecosystem.config.js --env production

# 或者命令行启动
pm2 start service.js --name docker-proxy

# 保存进程列表
pm2 save

# 设置开机自启
pm2 startup
```

---

## 📊 验证运行状态

### 1. 检查服务是否启动
```bash
# Windows
netstat -ano | findstr :7000

# Linux/Mac
netstat -tuln | grep 7000
# 或
lsof -i :7000
```

### 2. 测试 API
```bash
# 测试流量统计
curl http://localhost:7000/api/traffic-stats

# 测试缓存统计
curl http://localhost:7000/api/cache-stats
```

### 3. 访问 Dashboard
```
http://localhost:7000/traffic-dashboard
http://192.168.0.102:7000/traffic-dashboard
```

---

## 🐛 故障排除

### 问题 1：仍然报连接错误

**原因**：使用了代理模式但代理未运行

**解决**：
1. 检查代理软件是否运行：`netstat -ano | findstr :7890`
2. 使用直连模式：`start-direct.bat`
3. 或设置环境变量：`set USE_PROXY=false`

### 问题 2：PM2 启动失败

**原因**：可能路径或权限问题

**解决**：
```bash
# 查看日志
pm2 logs docker-proxy

# 查看详细信息
pm2 show docker-proxy

# 重新启动
pm2 restart docker-proxy
```

### 问题 3：端口被占用

**解决**：
```bash
# Windows
netstat -ano | findstr :7000
taskkill //F //PID <进程ID>

# Linux/Mac
kill -9 $(lsof -t -i:7000)
```

---

## 🎉 推荐配置

### 场景 1：国内服务器（需要代理）

```bash
# 确保 Clash/V2Ray 运行在 7890 端口
pm2 start service.js --name docker-proxy --env USE_PROXY=true --env PROXY_URL=http://127.0.0.1:7890
pm2 save
```

### 场景 2：国外服务器（直连）

```bash
pm2 start service.js --name docker-proxy
pm2 save
```

### 场景 3：开发调试

```bash
# Windows
start-direct.bat

# Linux/Mac
node service.js
```

---

**现在您可以根据服务器位置选择合适的启动模式了！** 🚀

如有问题，请查看日志文件：
- `logs/error.log` - 错误日志
- `logs/out.log` - 输出日志
- `debug.log` - 调试日志
