# 📊 Docker 镜像下载统计报表

## 快速开始

### 1. 确保代理服务器正在运行

```bash
cd proxy_server
node service.js
```

输出：
```
Proxy server running at http://localhost:7000
```

### 2. 访问报表页面

在浏览器中打开：

**本地访问**：
```
http://localhost:7000/dashboard
```

**局域网访问**（替换为您的 IP）：
```
http://192.168.0.102:7000/dashboard
```

## 功能特性

### 📈 实时统计卡片
- **总下载次数**：所有镜像的下载总次数
- **不同镜像数**：唯一镜像数量
- **最受欢迎镜像**：下载次数最多的镜像
- **今日下载**：当天的下载次数

### 🔥 热门镜像 Top 10
显示下载次数最多的前 10 个镜像，包括：
- 镜像名称和标签
- 下载次数
- 支持的架构（amd64/arm64）
- 最近下载时间

### 💻 架构分布
可视化展示不同架构的下载分布：
- AMD64 vs ARM64
- 下载次数和占比
- 进度条可视化

### 📋 所有下载记录
完整的下载历史记录，按下载次数排序：
- 镜像名称
- 下载次数
- 支持架构
- 首次下载时间
- 最近下载时间

### 🔄 自动刷新
- 页面每 30 秒自动刷新数据
- 点击"刷新数据"按钮手动刷新
- 显示最后更新时间

## API 接口

### 获取统计数据

```bash
GET http://localhost:7000/api/tracking-stats
```

**响应示例**：
```json
{
    "total": 5,
    "unique": 2,
    "data": [
        {
            "image": "library/memcached:1.6",
            "count": 3,
            "archs": ["amd64", "arm64"],
            "firstSeen": "2026-02-01T12:10:00.000Z",
            "lastSeen": "2026-02-01T12:20:00.000Z"
        }
    ],
    "archStats": {
        "amd64": 3,
        "arm64": 2
    },
    "dailyStats": {
        "2026-02-01": 5
    }
}
```

## 数据来源

### 追踪日志文件
位置：`proxy_server/tracking.log`

格式（每行一个 JSON）：
```json
{"timestamp":"2026-02-01T12:00:00.000Z","image":"library/nginx","tag":"latest","arch":"amd64"}
{"timestamp":"2026-02-01T12:05:00.000Z","image":"library/nginx","tag":"latest","arch":"arm64"}
```

### 查看原始日志
```bash
cat proxy_server/tracking.log
```

### 实时监控日志
```bash
# Linux/Mac
tail -f proxy_server/tracking.log

# Windows PowerShell
Get-Content proxy_server\tracking.log -Wait
```

## 测试数据

### 创建测试数据
```bash
cd proxy_server
echo '{"timestamp":"2026-02-01T12:00:00.000Z","image":"library/nginx","tag":"latest","arch":"amd64"}
{"timestamp":"2026-02-01T12:05:00.000Z","image":"library/nginx","tag":"latest","arch":"arm64"}
{"timestamp":"2026-02-01T12:10:00.000Z","image":"library/memcached","tag":"1.6","arch":"amd64"}' > tracking.log
```

### 清空数据
```bash
> proxy_server/tracking.log
```

## 故障排除

### 问题 1：无法访问 Dashboard

**检查**：
1. 代理服务器是否正在运行
   ```bash
   netstat -ano | findstr :7000
   ```
2. 防火墙是否允许 7000 端口
3. 浏览器是否使用了正确的地址

### 问题 2：数据为空

**原因**：还没有下载记录

**解决**：
1. 使用 Chrome 插件下载一些镜像
2. 或创建测试数据（见上方）

### 问题 3：页面不刷新

**解决**：
1. 检查浏览器控制台是否有错误
2. 手动点击"刷新数据"按钮
3. 刷新浏览器页面（F5）

## 技术栈

- **后端**：Node.js + Express
- **前端**：纯 HTML/CSS/JavaScript（无框架）
- **数据存储**：本地文件（JSON Lines 格式）
- **图表**：纯 CSS 实现（无外部库）

## 部署建议

### 生产环境

1. **使用 PM2 保持服务运行**
   ```bash
   npm install -g pm2
   pm2 start proxy_server/service.js --name docker-proxy
   pm2 save
   pm2 startup
   ```

2. **配置反向代理**（Nginx）
   ```nginx
   location /docker-proxy/ {
       proxy_pass http://localhost:7000/;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_cache_bypass $http_upgrade;
   }
   ```

3. **添加认证**（可选）
   ```javascript
   app.use((req, res, next) => {
       const auth = req.headers.authorization;
       if (auth && auth === 'Bearer YOUR_TOKEN') {
           next();
       } else {
           res.status(401).send('Unauthorized');
       }
   });
   ```

### 日志轮转

防止日志文件过大：
```bash
# 每月归档
mv proxy_server/tracking.log "proxy_server/tracking-$(date +%Y%m).log"

# 或使用 logrotate
```

## 后续优化建议

- [ ] 添加用户认证
- [ ] 支持数据导出（CSV/Excel）
- [ ] 添加日期范围筛选
- [ ] 图表可视化（Chart.js/ECharts）
- [ ] 支持按镜像名称搜索
- [ ] 添加数据备份功能
- [ ] 支持多用户隔离
- [ ] 添加邮件告警

## 联系方式

如有问题，请查看：
- Service Worker 控制台日志
- 代理服务器日志：`proxy_server/debug.log`
- 追踪日志：`proxy_server/tracking.log`
