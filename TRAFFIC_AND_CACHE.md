# 代理服务器增强功能说明

## 📊 新增功能概述

代理服务器现在支持以下增强功能：

1. **流量统计** - 实时监控请求次数、数据传输量、域名分布
2. **智能缓存** - LRU 缓存机制，自动缓存 Docker Registry 响应
3. **可视化 Dashboard** - 美观的流量和缓存统计页面
4. **缓存管理** - 查看缓存状态、清理缓存、查看缓存条目

---

## 🚀 快速开始

### 1. 使用增强版代理服务器

**替换原有的 `service.js`**：

```bash
cd proxy_server
cp service.js service.js.backup
cp service-enhanced.js service.js
node service.js
```

或者直接运行增强版：

```bash
cd proxy_server
node service-enhanced.js
```

### 2. 访问流量统计 Dashboard

在浏览器中打开：

```
http://localhost:7000/traffic-dashboard
```

### 3. 访问原有的下载统计 Dashboard

```
http://localhost:7000/dashboard
```

---

## 📈 流量统计功能

### 统计指标

**实时指标**：
- **总请求数** - 代理服务器处理的请求总数
- **总流量** - 数据传输总量（自动转换为 KB/MB/GB）
- **缓存命中数** - 从缓存返回的请求数
- **缓存未命中数** - 需要访问网络的请求数
- **缓存命中率** - 缓存命中百分比
- **运行时间** - 服务器启动后的运行时长

**域名流量分布**：
- 每个域名的请求次数
- 每个域名的数据传输量
- 可视化进度条展示

### 查看流量统计

**API 接口**：
```bash
curl http://localhost:7000/api/traffic-stats
```

**响应示例**：
```json
{
    "totalRequests": 1523,
    "totalBytes": 524288000,
    "cacheHits": 856,
    "cacheMisses": 667,
    "cacheHitRate": "56.20%",
    "byDomain": {
        "registry-1.docker.io": {
            "requests": 1200,
            "bytes": 500000000
        },
        "auth.docker.io": {
            "requests": 323,
            "bytes": 24288000
        }
    },
    "byDate": {
        "2026-02-01": {
            "requests": 1523,
            "bytes": 524288000
        }
    },
    "startTime": "2026-02-01T10:00:00.000Z",
    "uptime": 3600
}
```

### 流量日志

日志文件位置：`proxy_server/traffic.log`

格式（每行一个 JSON）：
```json
{"timestamp":"2026-02-01T12:00:00.000Z","url":"https://registry-1.docker.io/v2/...","domain":"registry-1.docker.io","bytes":1024000,"fromCache":false}
```

**查看日志**：
```bash
# 查看最新日志
tail -f proxy_server/traffic.log

# 统计今日流量
cat proxy_server/traffic.log | grep "2026-02-01" | wc -l

# 分析流量分布
cat proxy_server/traffic.log | jq -r '.domain' | sort | uniq -c
```

---

## 💾 智能缓存功能

### 缓存配置

**默认配置**：
- **最大缓存项数**: 200 个
- **最大缓存大小**: 1 GB
- **单文件大小限制**: 50 MB（超过不缓存）
- **淘汰策略**: LRU（最近最少使用）

### 缓存工作原理

```
用户请求 → 检查缓存
    ↓
   命中？
    ↓
  是 → 返回缓存数据（快速）→ 记录流量
    ↓
  否 → 访问 Docker Registry → 缓存响应 → 返回数据
```

### 缓存策略

**哪些请求会被缓存**：
- ✅ Docker Registry 的 manifest 请求
- ✅ Docker Registry 的 blob 请求（小于 50MB）
- ✅ HTTP 200 响应
- ✅ Auth Docker IO 的 token 请求

**哪些请求不会被缓存**：
- ❌ 非 Docker Registry 域名
- ❌ 错误响应（4xx, 5xx）
- ❌ 大于 50MB 的文件
- ❌ POST/PUT/DELETE 请求

### 查看缓存统计

**API 接口**：
```bash
# 获取缓存统计
curl http://localhost:7000/api/cache-stats

# 获取缓存条目列表
curl http://localhost:7000/api/cache-entries
```

**缓存统计响应**：
```json
{
    "size": 45,
    "maxSize": 200,
    "currentBytes": 234567890,
    "maxBytes": 1073741824,
    "hits": 856,
    "misses": 667,
    "hitRate": "56.20%"
}
```

**缓存条目响应**：
```json
[
    {
        "key": "https://registry-1.docker.io/v2/library/nginx/manifests/latest",
        "size": 2345,
        "timestamp": "2026-02-01T12:00:00.000Z",
        "age": 3600
    }
]
```

### 清空缓存

**方法 1：通过 API**
```bash
curl -X POST http://localhost:7000/api/cache-clear
```

**方法 2：通过 Dashboard**
点击 "🗑️ 清空缓存" 按钮

**方法 3：重启服务器**
```bash
# 停止服务器
# 重新启动
node service-enhanced.js
```

---

## 🎛️ API 接口汇总

### 流量统计

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/traffic-stats` | GET | 获取流量统计 |
| `/traffic-dashboard` | GET | 流量统计 Dashboard 页面 |

### 缓存管理

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/cache-stats` | GET | 获取缓存统计 |
| `/api/cache-entries` | GET | 获取缓存条目列表 |
| `/api/cache-clear` | POST | 清空所有缓存 |

### 下载追踪

| 接口 | 方法 | 说明 |
|------|------|------|
| `/track` | POST | 上报下载记录 |
| `/api/tracking-stats` | GET | 获取下载统计 |
| `/dashboard` | GET | 下载统计 Dashboard |

---

## 📊 Dashboard 对比

### 流量统计 Dashboard (`/traffic-dashboard`)

**功能**：
- 实时流量监控
- 域名流量分布
- 缓存性能分析
- 缓存条目查看

**适用场景**：
- 监控代理服务器负载
- 分析流量瓶颈
- 优化缓存配置

### 下载统计 Dashboard (`/dashboard`)

**功能**：
- 用户下载记录
- 热门镜像统计
- 架构分布分析

**适用场景**：
- 了解用户使用情况
- 发现热门镜像
- 统计下载趋势

---

## ⚙️ 高级配置

### 调整缓存配置

编辑 `service-enhanced.js`，找到缓存实例化部分：

```javascript
const responseCache = new LRUCache(
    200, // 最大缓存项数
    1024 * 1024 * 1024 // 最大缓存大小（1GB）
);
```

**调整建议**：

| 内存大小 | 最大项数 | 最大大小 | 适用场景 |
|---------|---------|---------|---------|
| 小型 | 50 | 256 MB | 个人开发 |
| 中型 | 200 | 1 GB | 小团队使用 |
| 大型 | 500 | 5 GB | 生产环境 |

### 调整单文件缓存限制

在代理请求处理代码中：

```javascript
// 只缓存成功的响应
if (resp.status === 200 && buffer.length < 50 * 1024 * 1024) { // 50MB
    // ... 缓存逻辑
}
```

**建议**：
- **开发环境**: 10-50 MB
- **生产环境**: 50-100 MB

---

## 🔍 故障排除

### 问题 1：缓存命中率过低

**原因**：
- 缓存大小太小
- 缓存项数太少
- 大量首次请求

**解决**：
1. 增加缓存配置
2. 预热缓存（提前访问常用镜像）
3. 检查是否正确缓存

### 问题 2：内存占用过高

**原因**：
- 缓存大小设置过大
- 缓存了大量大文件

**解决**：
1. 减少 `maxBytes` 配置
2. 降低单文件缓存限制
3. 定期清空缓存

### 问题 3：流量统计不准确

**原因**：
- 服务重启导致统计重置
- 日志文件过大

**解决**：
1. 使用 `traffic.log` 持久化数据
2. 定期归档日志文件
3. 使用外部数据库存储统计

---

## 📈 性能优化建议

### 1. 缓存预热

在低峰期预先访问常用镜像：

```bash
# 预热 nginx:latest
curl "http://localhost:7000/proxy?url=https://registry-1.docker.io/v2/library/nginx/manifests/latest"
```

### 2. 定期清理

设置定时任务清空缓存：

```bash
# Linux crontab
0 3 * * * curl -X POST http://localhost:7000/api/cache-clear
```

### 3. 监控告警

基于流量统计设置告警：

- 总流量超过阈值
- 缓存命中率过低
- 某个域名异常流量

---

## 🎯 使用场景

### 场景 1：团队共享代理

**配置**：
```javascript
const responseCache = new LRUCache(500, 5 * 1024 * 1024 * 1024); // 5GB
```

**效果**：
- 团队成员共享缓存
- 大幅减少网络请求
- 加速镜像下载

### 场景 2：CI/CD 环境

**配置**：
```javascript
const responseCache = new LRUCache(1000, 10 * 1024 * 1024 * 1024); // 10GB
```

**效果**：
- 构建任务共享缓存
- 减少重复下载
- 缩短构建时间

### 场景 3：个人开发

**配置**：
```javascript
const responseCache = new LRUCache(100, 500 * 1024 * 1024); // 500MB
```

**效果**：
- 快速响应
- 节省带宽
- 离线可用（已缓存内容）

---

## 📝 技术细节

### LRU 缓存实现

**核心逻辑**：
1. 新访问的项目移到最后
2. 淘汰时从开头删除
3. 双重限制：数量 + 大小

**时间复杂度**：
- 获取: O(1)
- 设置: O(1)
- 淘汰: O(n)

### 流量记录

**记录时机**：
- 缓存命中：立即记录
- 缓存未命中：网络请求完成后记录

**记录内容**：
- URL
- 域名
- 数据大小
- 是否来自缓存
- 时间戳

---

## 🔗 相关文档

- [TRACKING.md](TRACKING.md) - 下载追踪功能
- [DASHBOARD.md](DASHBOARD.md) - Dashboard 使用指南

---

**现在您的代理服务器具备了企业级的流量监控和缓存能力！** 🚀
