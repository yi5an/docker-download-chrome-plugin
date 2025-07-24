// background.js
// 代理 fetch，解决 CORS 问题，并输出详细日志

import { PROXY_BASE } from './config.js';

let tasks = [];
let history = [];

// 代理fetch通过中转服务器
async function proxyFetch(url, options = {}, responseType = 'json') {
  const proxyUrl = PROXY_BASE + encodeURIComponent(url);
  const resp = await fetch(proxyUrl, options);
  if (!resp.ok) throw new Error('proxy fetch failed: ' + url);
  if (responseType === 'json') return await resp.json();
  if (responseType === 'arrayBuffer') return await resp.arrayBuffer();
  return await resp.text();
}

// 加载历史
chrome.storage.local.get(['dockerDownloadTasks', 'dockerDownloadHistory'], data => {
  tasks = data.dockerDownloadTasks || [];
  history = data.dockerDownloadHistory || [];
});

function syncTasks() {
  chrome.storage.local.set({dockerDownloadTasks: tasks, dockerDownloadHistory: history});
}

function taskKey(image, tag, arch) {
  return `${image}:${tag}:${arch}`;
}
function findTask(image, tag, arch) {
  return tasks.find(t => taskKey(t.image, t.tag, t.arch) === taskKey(image, tag, arch));
}

async function getDockerToken(image) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`;
  const data = await proxyFetch(url, {}, 'json');
  return data.token;
}

async function fetchManifest(image, tagOrDigest, arch = 'amd64') {
  const token = await getDockerToken(image);
  let url = `https://registry-1.docker.io/v2/${image}/manifests/${tagOrDigest}`;
  let manifest = await proxyFetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    }
  }, 'json');
  let tryCount = 0;
  while (!manifest.layers && manifest.manifests && tryCount < 5) {
    const found = manifest.manifests.find(m => m.platform && m.platform.architecture === arch);
    if (!found) throw new Error('未找到匹配架构的manifest: ' + arch);
    url = `https://registry-1.docker.io/v2/${image}/manifests/${found.digest}`;
    manifest = await proxyFetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': found.mediaType || 'application/vnd.docker.distribution.manifest.v2+json'
      }
    }, 'json');
    tryCount++;
  }
  if (!manifest.layers) throw new Error('manifest.layers is not iterable，实际值：' + JSON.stringify(manifest));
  return manifest;
}

async function downloadSingleLayer(image, layer, token) {
  const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
  return await proxyFetch(url, { headers: { 'Authorization': `Bearer ${token}` } }, 'arrayBuffer');
}

async function runDownloadTask(task) {
  task.status = 'downloading';
  task.finished = 0;
  task.running = 0;
  task.pending = task.total;
  task.layers.forEach(l => l.status = 'pending');
  syncTasks();
  try {
    const token = await getDockerToken(task.image);
    const layersData = [];
    for (let i = 0; i < task.layers.length; i++) {
      task.layers[i].status = 'downloading';
      task.running = 1;
      syncTasks();
      try {
        const buf = await downloadSingleLayer(task.image, task.layers[i], token);
        layersData.push(buf);
        task.layers[i].status = 'done';
      } catch (err) {
        task.layers[i].status = 'failed';
        task.status = 'failed';
        syncTasks();
        throw err;
      }
      task.finished = task.layers.filter(l => l.status === 'done').length;
      task.running = 0;
      task.pending = task.layers.filter(l => l.status === 'pending').length;
      syncTasks();
    }
    task.status = 'done';
    task.finished = task.total;
    task.running = 0;
    task.pending = 0;
    syncTasks();
  } catch (err) {
    task.status = 'failed';
    syncTasks();
  }
  task.history = true;
  task.updatedAt = Date.now();
  history.unshift({...task});
  if (history.length > 100) history.length = 100;
  tasks = tasks.filter(t => t.id !== task.id);
  syncTasks();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start-download') {
    if (findTask(msg.image, msg.tag, msg.arch)) {
      sendResponse({ok: false, reason: '任务已存在'});
      return;
    }
    fetchManifest(msg.image, msg.tag, msg.arch).then(manifest => {
      const task = {
        id: Date.now() + Math.random(),
        image: msg.image, tag: msg.tag, arch: msg.arch,
        total: manifest.layers.length,
        finished: 0, running: 0, pending: manifest.layers.length,
        status: 'downloading',
        layers: manifest.layers.map(l => ({digest: l.digest, status: 'pending'})),
        createdAt: Date.now(), updatedAt: Date.now(),
        history: false
      };
      tasks.push(task);
      syncTasks();
      runDownloadTask(task);
      sendResponse({ok: true});
    }).catch(err => {
      sendResponse({ok: false, reason: err.message});
    });
    return true;
  }
  if (msg.type === 'retry-download') {
    const h = history.find(h => taskKey(h.image, h.tag, h.arch) === taskKey(msg.image, msg.tag, msg.arch));
    if (h) {
      h.history = false;
      h.status = 'downloading';
      h.finished = 0;
      h.running = 0;
      h.pending = h.total;
      h.layers.forEach(l => l.status = 'pending');
      h.id = Date.now() + Math.random();
      tasks.push(h);
      history = history.filter(x => x !== h);
      syncTasks();
      runDownloadTask(h);
      sendResponse({ok: true});
    } else {
      sendResponse({ok: false, reason: '历史任务不存在'});
    }
    return true;
  }
  if (msg.type === 'delete-history') {
    history = history.filter(h => !(h.image === msg.image && h.tag === msg.tag && h.arch === msg.arch));
    syncTasks();
    sendResponse({ok: true});
    return true;
  }
  if (msg.type === 'get-tasks') {
    sendResponse({tasks, history});
    return true;
  }
}); 