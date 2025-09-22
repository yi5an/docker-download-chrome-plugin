// background-wrapper.js
// 加载config.js，docker-download.js，然后加载background.js

// 首先加载config.js
importScripts('config.js');

// 加载docker-download.js
importScripts('core/docker-download.js');

// 然后加载background.js
importScripts('background.js');