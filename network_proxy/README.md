# Docker镜像下载代理服务器

优化的网络代理服务器，支持缓存和统计功能，大幅提升Docker镜像下载体验。

## ✨ 主要功能

### 🚀 核心功能
- **CORS代理**: 解决Chrome插件跨域问题，代理Docker Registry API请求
- **智能缓存**: 自动缓存镜像层和manifest文件，避免重复下载
- **下载统计**: 记录下载次数、镜像版本、使用情况等详细统计
- **性能优化**: 显著减少网络请求，提升下载速度

### 📊 统计功能
- 总下载次数统计
- 按镜像和版本的下载统计
- 每日下载统计和趋势分析
- 缓存命中率统计
- 存储使用情况监控

### 💾 缓存功能
- **镜像层缓存**: 自动缓存下载的Docker镜像层
- **Manifest缓存**: 缓存镜像manifest文件，加速镜像信息获取
- **智能过期**: 7天自动过期机制，保持缓存新鲜度
- **空间管理**: 支持缓存清理和空间统计

## 🛠️ 安装和使用

### 1. 安装依赖
```bash
cd network_proxy
npm install
```

### 2. 启动服务器
```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

服务器将在 `http://localhost:7000` 启动

### 3. 配置代理
确保 `service.js` 中的代理设置符合你的网络环境：
```javascript
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:7890'); // 修改为你的代理地址
```

## 📁 目录结构

```
network_proxy/
├── service.js              # 主服务文件
├── package.json            # 项目配置
├── README.md               # 说明文档
├── cache/                  # 缓存目录（自动创建）
│   ├── blobs/             # 镜像层缓存
│   └── manifests/         # Manifest缓存
└── download-stats.json    # 统计数据文件（自动创建）
```

## 🔧 配置选项

在 `service.js` 中可以调整以下配置：

```javascript
const CONFIG = {
  PORT: 7000,                                    // 服务器端口
  CACHE_DIR: path.join(__dirname, 'cache'),     // 缓存目录
  STATS_FILE: path.join(__dirname, 'download-stats.json'), // 统计文件
  CACHE_ENABLED: true,                           // 是否启用缓存
  CACHE_MAX_SIZE: 10 * 1024 * 1024 * 1024,     // 最大缓存大小（10GB）
  CACHE_EXPIRY: 7 * 24 * 60 * 60 * 1000,       // 缓存过期时间（7天）
};
```

## 📚 API接口

### 代理接口
- `GET /proxy?url=<target_url>` - 代理Docker Registry请求

### 统计接口
- `GET /stats` - 获取下载统计信息
- `GET /health` - 健康检查

### 缓存管理
- `POST /cache/clear` - 清理过期缓存
- `DELETE /cache` - 清空所有缓存

## 📊 统计数据示例

访问 `http://localhost:7000/stats` 可以获取详细统计：

```json
{
  "totalDownloads": 156,
  "imageStats": {
    "library/nginx:latest:amd64": {
      "downloads": 23,
      "totalSize": 142857600,
      "firstDownload": "2025-09-22T10:30:00.000Z",
      "lastDownload": "2025-09-22T15:45:00.000Z"
    }
  },
  "dailyStats": {
    "2025-09-22": {
      "downloads": 45,
      "uniqueImages": ["library/nginx:latest:amd64", "library/ubuntu:20.04:amd64"]
    }
  },
  "cacheStats": {
    "hits": 89,
    "misses": 67,
    "totalSize": 2847362048,
    "fileCount": 234
  }
}
```

## 🚀 性能优化效果

### 缓存命中时
- ⚡ **响应时间**: 从网络请求的2-10秒降至本地缓存的50-200ms
- 💾 **带宽节省**: 避免重复下载相同的镜像层，节省带宽
- 🔄 **重复下载**: 相同镜像的后续下载几乎瞬间完成

### 智能缓存策略
- 📦 **镜像层缓存**: 相同的layer在不同镜像间共享
- 📋 **Manifest缓存**: 加速镜像信息获取
- ⏰ **自动清理**: 定期清理过期缓存，保持性能

## 🔒 安全特性

- **URL白名单**: 仅允许代理Docker官方Registry的请求
- **请求验证**: 严格验证请求格式和来源
- **本地缓存**: 所有缓存数据存储在本地，确保安全性

## 🐛 故障排除

### 常见问题

1. **服务器启动失败**
   - 检查端口7000是否被占用
   - 确认所有依赖已正确安装

2. **代理请求失败**
   - 检查本地代理设置（如使用了代理软件）
   - 确认网络连接正常

3. **缓存不工作**
   - 检查缓存目录权限
   - 查看服务器日志获取详细错误信息

### 日志说明
- `[Proxy]` - 代理请求相关日志
- `[Cache]` - 缓存操作相关日志
- `[Stats]` - 统计功能相关日志

## 📈 监控和维护

### 定期维护
- 服务器每6小时自动清理过期缓存
- 建议定期检查缓存目录大小
- 可通过 `/stats` 接口监控使用情况

### 手动清理
```bash
# 清理过期缓存
curl -X POST http://localhost:7000/cache/clear

# 清空所有缓存
curl -X DELETE http://localhost:7000/cache
```

## 🔄 版本更新

当前版本: v1.1.0

### 更新内容
- ✨ 新增智能缓存功能
- 📊 新增详细统计功能
- 🚀 优化响应性能
- 🔧 增强错误处理
- 📝 完善日志记录

---

> 此代理服务器专为Docker镜像下载Chrome插件优化，在不改变插件功能的前提下，显著提升用户下载体验。