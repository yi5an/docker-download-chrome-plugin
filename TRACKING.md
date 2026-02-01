# 追踪功能使用说明

## 📊 功能概述

自动追踪用户通过浏览器插件下载的 Docker 镜像，包括：
- 镜像名称和标签
- 下载架构（amd64/arm64）
- 下载时间戳
- 下载次数统计

## 🔧 架构设计

```
Chrome 插件
    ↓ POST {image, tag, arch}
代理服务器 (7000端口)
    ↓ 记录到本地文件
tracking.log (JSON格式)
```

**优势**：
- ✅ 通过代理服务器转发，**完全避免 CORS 问题**
- ✅ 追踪失败不影响下载功能
- ✅ 本地日志文件，易于分析和备份
- ✅ 可选转发到远程服务器

## 🚀 快速开始

### 1. 确认配置

**[config.js](docker-image-chrome-plugin/config.js:3)**:
```javascript
const TRACKING_URL = 'http://123.57.165.38:7000/track';
```

### 2. 启动代理服务器

```bash
cd proxy_server
node service.js
```

输出：
```
Proxy server running at http://localhost:7000
```

### 3. 重新加载插件

1. 打开 `chrome://extensions/`
2. 找到 "Docker 镜像一键下载器"
3. 点击 **刷新按钮** 🔄

### 4. 测试追踪

1. 访问 DockerHub 并下载任意镜像
2. 检查 Service Worker 日志：
   ```
   [Track] Reported: library/memcached:latest (amd64)
   ```
3. 查看追踪日志：
   ```bash
   cd proxy_server
   node view-tracking.js
   ```

## 📈 查看追踪数据

### 方法 1：使用统计工具

```bash
cd proxy_server
node view-tracking.js
```

输出示例：
```
📊 Docker 镜像下载统计

总下载次数: 15
不同镜像数: 5

  library/memcached:latest
    下载次数: 8 | 架构: amd64, arm64
    首次: 2026-02-01T10:30:15.123Z
    最近: 2026-02-01T12:45:22.456Z

  library/nginx:1.24
    下载次数: 5 | 架构: amd64
    首次: 2026-02-01T09:15:30.789Z
    最近: 2026-02-01T11:20:10.234Z
```

### 方法 2：直接查看日志

```bash
cat proxy_server/tracking.log
```

日志格式（每行一个 JSON）：
```json
{"timestamp":"2026-02-01T10:30:15.123Z","image":"library/memcached","tag":"latest","arch":"amd64"}
{"timestamp":"2026-02-01T10:35:22.456Z","image":"library/nginx","tag":"1.24","arch":"arm64"}
```

### 方法 3：实时监控

```bash
# Linux/Mac
tail -f proxy_server/tracking.log

# Windows (PowerShell)
Get-Content proxy_server\tracking.log -Wait
```

## 🔄 导出和分析数据

### 导出到 CSV

```bash
cd proxy_server
node -e "
const logs = require('fs').readFileSync('tracking.log', 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
console.log('Timestamp,Image,Tag,Arch');
logs.forEach(l => console.log(\`\${l.timestamp},\${l.image},\${l.tag},\${l.arch}\`));
" > downloads.csv
```

### 分析工具示例

**按镜像统计**:
```bash
cat tracking.log | grep -o '"image":"[^"]*"' | sort | uniq -c | sort -rn
```

**按日期统计**:
```bash
cat tracking.log | cut -d'T' -f1 | sort | uniq -c
```

## ⚙️ 高级配置

### 转发到远程服务器

编辑 **[proxy_server/service.js](proxy_server/service.js:78)**:
```javascript
const remoteTrackingUrl = 'http://your-server.com/api/track';
if (remoteTrackingUrl) {
    await fetch(remoteTrackingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, tag, arch })
    });
}
```

### 自定义日志格式

修改 **[service.js:20](proxy_server/service.js:20)** 的 `logTracking` 函数。

### 设置日志轮转

防止日志文件过大：
```bash
# 每月归档
mv proxy_server/tracking.log "proxy_server/tracking-$(date +%Y%m).log"
```

## 🛡️ 隐私和安全

### 数据脱敏

追踪数据默认包含：
- ✅ 镜像名称和标签
- ✅ 架构信息
- ✅ 时间戳
- ❌ **不包含** 用户 IP、浏览器信息、个人数据

### 禁用追踪

编辑 **[config.js](docker-image-chrome-plugin/config.js:3)**:
```javascript
const TRACKING_URL = ''; // 留空禁用
```

## 🐛 故障排除

### 问题 1：追踪日志为空

**检查**:
1. 代理服务器是否正在运行：`netstat -ano | findstr :7000`
2. TRACKING_URL 配置是否正确
3. Service Worker 日志是否有错误

### 问题 2：CORS 错误

**原因**: TRACKING_URL 未指向代理服务器

**解决**:
```javascript
// ❌ 错误（直接请求追踪服务器）
const TRACKING_URL = 'http://123.57.165.38:3000/api/track';

// ✅ 正确（通过代理转发）
const TRACKING_URL = 'http://123.57.165.38:7000/track';
```

### 问题 3：代理服务器启动失败

**检查**:
```bash
# 查看端口占用
netstat -ano | findstr :7000

# 更换端口
修改 service.js:67 中的 PORT = 7001
```

## 📞 支持

遇到问题？
1. 查看 Service Worker 控制台日志
2. 查看代理服务器日志：`proxy_server/debug.log`
3. 确认追踪日志：`proxy_server/tracking.log`
