# Chrome 插件：Docker 镜像一键下载器 设计文档

## 一、项目目标

- 在用户访问 DockerHub 镜像页面时，自动识别并在 tag 列表每个架构旁添加“下载”按钮。
- 支持多架构镜像的选择与下载。
- 点击按钮后，直接通过浏览器下载镜像（tar 格式），无需本地 Docker 环境。
- 前端全部用 JavaScript/TypeScript 实现，核心下载逻辑移植自现有 Python 代码。

---

## 二、功能模块

1. **页面识别与按钮注入**
   - 自动检测用户是否在 DockerHub 镜像 tag 列表页面。
   - 在每个 tag 的每个架构旁边插入"下载"按钮。
   - 按钮携带镜像名、tag、架构等信息。

2. **镜像信息解析**
   - 解析页面上的镜像名、tag、可用架构等信息。

3. **镜像下载核心逻辑**
   - 用 JS 实现 Docker Registry API 交互，获取 manifest、layer、config 等。
   - 支持多架构镜像的 manifest list 解析与选择。
   - 支持分片下载、进度显示、合并打包为 tar 文件。

4. **文件保存**
   - 使用浏览器 API（如 FileSystem API 或 a 标签 download 属性）保存 tar 文件到本地。

5. **下载进度显示**
   - 通过插件弹窗实时显示下载任务的进度、层信息和状态。
   - 支持查看活动任务和历史任务列表。
   - 提供重试下载和删除历史记录功能。

6. **用户交互与提示**
   - 下载开始、进行中、完成和失败的状态通知。
   - 在页面中显示下载状态提示。
   - 在插件弹窗中显示详细的下载进度和任务状态。

---

## 三、技术选型

- **前端**：TypeScript + 原生 JS（或可选 React/Vue，视复杂度而定）
- **Chrome 插件开发**：Manifest V3
- **网络请求**：fetch/axios
- **打包工具**：webpack/vite
- **辅助库**：pako（gzip 解压）、jsSHA（sha256）、tar-js（打包 tar 文件）

---

## 四、核心流程（已根据用户反馈调整）

```mermaid
flowchart TD
    A[用户访问 DockerHub 镜像页面] --> B[插件识别页面并注入按钮]
    B --> C[每个 tag 的每个架构旁边都插入"下载"按钮]
    C --> D[用户点击某一架构的下载按钮]
    D --> E[插件用 JS 调用 Docker Registry API 获取 manifest/config/layers（指定架构）]
    E --> F[分片下载所有 layer 并解压]
    F --> G[打包为 tar 文件]
    G --> H[浏览器保存到本地]
    H --> I[提示用户下载完成]
    D --> J[点击插件图标查看下载进度]
    J --> K[显示实时下载进度、层信息和任务状态]
    K --> L[下载完成后保存到历史记录]
    L --> M[用户可查看、重试或删除历史任务]
```

### 具体说明

1. 用户访问 DockerHub 镜像 tag 列表页面。
2. 插件检测到页面类型，注入下载按钮。
3. 用户点击某个架构的下载按钮。
4. 插件获取镜像的 manifest 信息。
5. 解析 manifest，获取所有 layer 的下载地址。
6. 并行下载所有 layer 和 config 文件。
7. 用户可点击插件图标查看实时下载进度。
8. 插件弹窗显示当前下载任务的进度、层信息和状态。
9. 将下载的文件按 Docker 镜像格式组装成 tar 包。
10. 提示用户下载完成，保存 tar 文件到本地。
11. 下载任务完成后，记录保存到历史记录中，用户可查看、重试或删除。

### 具体说明

- 插件需监听并解析 DockerHub tag 列表页面的 DOM，找到每个 tag 下的所有架构（如 amd64、arm64 等）。
- 在每个架构旁边插入"下载"按钮，按钮携带镜像名、tag、架构等信息。
- 用户点击后，直接下载对应架构的镜像，无需再弹窗选择。
- 点击浏览器工具栏中的插件图标，可以查看当前下载任务的实时进度、层信息和状态。
- 下载完成后，会在页面上显示通知，并在插件弹窗中更新任务状态为"已完成"。
- 历史下载记录会保存在插件中，用户可以查看、重试或删除历史任务。

---
## 私有镜像下载
- **Docker Hub认证支持**：在插件popup界面可以配置Docker Hub用户名和密码
  - 支持用户名/密码或访问令牌（Access Token）
  - 对于私有镜像（如`mcp/playwright`），会自动使用认证信息
  - 认证失败时会自动降级尝试公开镜像访问
- **多种Token Scope**：支持尝试不同的权限范围
  - `repository:image:pull` - 基本拉取权限
  - `repository:image:pull,push` - 扩展权限
  - `repository:image:*,pull` - 最广权限
- **自动Token刷新**：遇到401错误时自动刷新token并重试
- **Accept请求头修复**：添加了Docker Registry blob下载的标准Accept头
- **Service Worker超时优化**：防止长时间下载被终止

---

## 五、目录结构

```
docker-image-chrome-plugin/
├── background-wrapper.js
├── background.js        # 后台脚本，处理下载任务
├── config.js            # 配置文件
├── content-script.js    # 内容脚本，注入下载按钮
├── core/
│   ├── docker-download-wrapper.js
│   └── docker-download.js  # 镜像下载核心逻辑
├── icon16.png
├── icon48.png
├── icon128.png
├── manifest.json        # 插件配置文件
├── popup/
│   ├── popup.html       # 弹窗HTML，显示下载进度
│   └── popup.js         # 弹窗脚本，处理下载进度显示
└── ...
```

---

## 六、关键技术点与难点

1. **Docker Registry API 兼容性**
   - 需兼容 DockerHub 及其他公开 registry，处理 token 获取、manifest v2、manifest list 等。
   - 需处理多架构镜像的 manifest list 选择。

2. **大文件分片下载与打包**
   - 浏览器端下载大文件需考虑内存与性能，建议分片处理。
   - 需用 JS 实现 gzip 解压与 tar 打包（可用 pako、tar-js 等库）。

2. **中转服务器与缓存**
   - 通过`proxy_server/service.js`代理Docker Registry请求
   - **缓存持久化**：缓存数据保存到`cache-persist.json`
   - **LRU淘汰策略**：基于访问次数淘汰，访问少的优先淘汰
   - **可配置Blob缓存**：`CACHE_BLOB`环境变量控制是否缓存blob请求
   - **缓存大小限制**：`CACHE_BLOB_MAX_SIZE`控制blob缓存上限（默认200MB）
   - **过期时间**：Token 5分钟，其他30分钟

3. **页面注入与交互**
   - 需适配 DockerHub 页面结构，防止页面更新导致按钮失效。
   - 需处理 SPA 页面跳转（监听 URL 变化）。

4. **下载进度实时显示**
   - 使用 Chrome 扩展的 background 和 popup 页面通信机制。
   - 通过 chrome.storage.local 存储和同步下载任务状态。
   - 实现任务列表的实时更新和状态管理。
   - 处理多任务并行下载的进度显示。

5. **安全与权限**
   - manifest.json 需声明合适的 host 权限。
   - 需处理 CORS 问题（如必要可用 background script 代理）。

---

## 七、使用说明

### 安装方法
1. 下载本项目代码
2. 打开Chrome浏览器，进入扩展程序页面（chrome://extensions/）
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"，选择项目中的`docker-image-chrome-plugin`文件夹
5. 安装完成后，浏览器工具栏会显示插件图标

### 使用方法
1. 访问DockerHub镜像页面（如https://hub.docker.com/r/library/nginx/tags）
2. 在每个镜像标签的架构旁边会出现"下载"按钮
3. 点击对应架构的"下载"按钮，开始下载镜像
4. 点击浏览器工具栏中的插件图标，可以查看下载进度
5. 下载完成后，镜像文件（tar格式）会自动保存到本地
6. 在插件弹窗中可以查看历史下载记录，支持重试下载或删除记录

## 八、备注与代码规范

- **每个核心函数/模块需有详细注释**，说明用途、参数、返回值、异常处理。
- **关键流程需有中文备注**，便于后续维护。
- **README.md** 需包含：
  - 插件功能简介
  - 安装方法（开发者模式加载）
  - 使用说明（如何在 DockerHub 页面下载镜像）
  - 技术实现说明
  - 贡献指南
  - 常见问题与解决方法

---

## 八、README 维护建议

- 每次功能更新需同步更新 README。
- 记录已支持的 registry、已适配的页面结构。
- 说明已知限制（如最大支持镜像大小、浏览器兼容性等）。
- 提供联系方式或 issue 提交方式。

---

## 九、后续可扩展方向

- 支持私有 registry 登录与下载
- 支持批量下载
- 支持镜像信息预览
- 支持导入到本地 Docker
- 下载进度显示优化：
  - 添加下载速度显示
  - 支持暂停/继续下载功能
  - 添加下载完成通知和声音提醒
  - 优化多任务并行下载时的资源管理
- 数据统计与分析：统计下载次数、耗时、成功率等

---

> 本文档为项目开发与维护的基础文档，后续如有需求变更请及时同步更新。