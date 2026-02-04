// config.js
// 统一维护中转服务器地址
const DEFAULT_PROXY_BASE = 'http://123.57.165.38:7000/proxy?url=';
const TRACKING_URL = 'http://123.57.165.38:7000/track'; // 通过代理服务器转发，避免 CORS 问题
// const DEFAULT_PROXY_BASE = 'http://192.168.0.102:7000/proxy?url=';
// const TRACKING_URL = 'http://192.168.0.102:7000/track'; // 本地调试地址