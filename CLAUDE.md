# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

这是一个Chrome插件项目，用于在DockerHub页面直接下载Docker镜像文件。插件可以自动识别DockerHub镜像页面，为每个架构的镜像添加下载按钮，支持多架构镜像下载。

## 项目结构

```
docker-image-chrome-plugin/     # Chrome插件主目录
├── manifest.json              # 插件配置文件（Manifest V3）
├── config.js                  # 全局配置（中转服务器地址等）
├── background.js              # 后台服务脚本
├── background-wrapper.js      # 后台脚本包装器
├── content-script.js          # 内容脚本（注入下载按钮）
├── core/
│   ├── docker-download.js     # Docker镜像下载核心逻辑
│   └── docker-download-wrapper.js
├── popup/
│   ├── popup.html             # 插件弹窗界面
│   └── popup.js               # 弹窗逻辑（显示下载进度）
└── icon*.png                  # 插件图标
```

## 核心架构

### 1. Chrome扩展架构
- **Manifest V3**: 使用最新的Chrome扩展规范
- **Service Worker**: background.js 作为服务工作进程处理下载任务
- **Content Script**: content-script.js 注入到DockerHub页面，添加下载按钮
- **Popup**: 显示下载进度和任务管理界面

### 2. 核心功能模块
- **页面检测与按钮注入**: 自动识别DockerHub镜像tag页面，为每个架构添加下载按钮
- **Docker Registry API**: 实现完整的Docker镜像下载流程（manifest、layers、config）
- **多架构支持**: 支持manifest list解析，可下载指定架构的镜像
- **代理机制**: 通过中转服务器解决CORS问题
- **任务管理**: 支持并行下载、进度显示、历史记录

### 3. 网络架构
- **中转服务器**: 配置在config.js中的`PROXY_BASE`，用于代理Docker Registry请求
- **权限配置**: manifest.json中配置了必要的host权限
  - DockerHub: `https://hub.docker.com/*`
  - Docker Registry: `https://registry-1.docker.io/*`
  - 中转服务器: `http://123.57.165.38:7000/*`

## 开发指南

### 安装与调试
1. 在Chrome中打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `docker-image-chrome-plugin` 目录

### 核心API流程
1. **获取Token**: 通过Docker Hub认证服务获取访问令牌
2. **获取Manifest**: 支持单架构manifest和多架构manifest list
3. **解析Layers**: 从manifest中提取所有layer的下载信息
4. **并行下载**: 分块下载所有layers和config文件
5. **组装镜像**: 按Docker镜像格式组装成tar文件

### 关键配置
- **中转服务器**: 在config.js中的`PROXY_BASE`变量配置
- **目标页面**: content_scripts在manifest.json中配置匹配规则
- **权限管理**: host_permissions控制可访问的域名

### 代码规范
- 所有核心函数都有详细的JSDoc注释
- 错误处理使用try-catch包装
- 异步操作使用async/await模式
- 任务状态通过Chrome storage API持久化

## 常用调试方法

### 查看插件状态
- 在Chrome扩展页面查看插件是否正常加载
- 通过popup界面查看当前下载任务状态
- 在开发者工具中查看content script和background script日志

### 网络请求调试
- 检查中转服务器是否可访问
- 确认Docker Registry API响应格式
- 验证token获取和权限配置

### 页面注入调试
- 确认content script是否正确注入到DockerHub页面
- 检查DOM选择器是否匹配当前页面结构
- 验证下载按钮是否正确添加到所有架构

## 注意事项

- 项目依赖中转服务器解决CORS问题，需确保服务器可用性
- DockerHub页面结构可能发生变化，需要相应更新DOM选择器
- 大镜像下载时需注意浏览器内存限制
- 多任务并行下载需控制并发数避免过载