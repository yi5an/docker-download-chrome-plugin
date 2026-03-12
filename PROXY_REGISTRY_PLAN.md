# Proxy Registry Plan

## 功能清单
- 代理记录服务维护代理节点、心跳、测速、位置、流量、下载记录。
- 插件下载前请求最佳代理节点，下载生命周期按 `downloadId` 上报。
- 代理服务启动注册、周期心跳，并把代理侧下载事件和流量上报到记录服务。

## 当前实现

### 代理记录服务
- 文件：`server/server.js`
- 核心接口：
  - `POST /api/proxies/register`
  - `POST /api/proxies/heartbeat`
  - `GET /api/proxies/select`
  - `POST /api/downloads/start`
  - `POST /api/downloads/complete`
  - `POST /api/downloads/fail`
  - `POST /api/proxies/download-events`
  - `GET /api/stats`
- 数据文件：`server/data/registry-data.json`

### 代理服务
- 文件：`proxy_server/service.js`
- 新增能力：
  - 启动注册代理节点
  - 定时测速和心跳
  - 代理请求支持 `X-Download-Id` / `X-Image` / `X-Tag` / `X-Arch`
  - 代理侧下载事件上报到记录服务

### 插件
- 文件：
  - `docker-image-chrome-plugin/config.js`
  - `docker-image-chrome-plugin/background.js`
  - `docker-image-chrome-plugin/manifest.json`
- 新增能力：
  - 下载前从代理记录服务获取最佳代理
  - 为每次下载生成 `downloadId`
  - 下载开始、成功、失败上报
  - Docker Hub 请求携带下载元数据给代理服务

## 环境变量

### 代理记录服务
- `PORT`
- `HEARTBEAT_STALE_MS`

### 代理服务
- `REGISTRY_SERVICE_URL`
- `PROXY_NODE_ID`
- `PROXY_PUBLIC_BASE_URL`
- `HEARTBEAT_INTERVAL_MS`
- `SPEED_TEST_TARGET`
- 原有 `USE_PROXY` / `PROXY_URL` / 缓存与超时变量继续有效

## 安装脚本
- 文件：`proxy_server/install_proxy_service.sh`
- 用法：
  - 自动探测公网 IP：`./install_proxy_service.sh`
  - 显式指定公网 IP：`./install_proxy_service.sh 1.2.3.4`
  - 显式指定公网 IP 和端口：`./install_proxy_service.sh 1.2.3.4 7001`
- 行为：
  - 写入 `.env.proxy-service`
  - 启动 `proxy_server/service.js`
  - 代理记录服务会校验 `PROXY_PUBLIC_BASE_URL` 的 `/health` 或 `/api/traffic-stats`
  - 校验失败时，代理服务启动失败，安装脚本直接退出

## 后续建议
- 把 `server` 的 JSON 文件存储替换成 SQLite/PostgreSQL。
- 为代理选路加入区域权重、历史成功率和负载因子。
- 给 `server` 和 `proxy_server` 增加自动化接口测试。
