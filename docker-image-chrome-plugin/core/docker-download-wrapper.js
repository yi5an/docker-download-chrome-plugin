// docker-download-wrapper.js
// 将docker-download.js中的函数导出为全局函数

// 全局函数声明
window.fetchManifest = null;
window.getDockerToken = null;
window.downloadLayers = null;
window.packToTar = null;
window.ungzip = null;
window.sha256Hash = null;

// 加载docker-download.js
importScripts('docker-download.js');

// 将模块中的函数赋值给全局变量
// 注意：这里假设docker-download.js中使用了export语法导出这些函数
// 实际使用时需要根据docker-download.js的实际导出方式进行调整