// docker-download.js
// Docker 镜像下载核心逻辑（支持多架构manifest list）
// 依赖：fetch、pako、tar-js（后续完善）

/**
 * 获取 DockerHub 镜像的 manifest/config/layers，支持多架构
 * @param {string} image 镜像名（如 library/ubuntu）
 * @param {string} tag 镜像tag（如 latest）
 * @param {string} arch 架构（如 amd64、arm64）
 * @returns {Promise<object>} manifest对象
 */
async function fetchManifest(image, tag, arch = 'amd64') {
  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });

  // 先尝试使用认证（如果是私有镜像）
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);
  const token = await getDockerToken(image, useAuth);

  // 获取manifest（可能是manifest list）
  const manifestUrl = `https://registry-1.docker.io/v2/${image}/manifests/${tag}`;

  // 如果获取manifest失败且配置了认证，尝试不使用认证（可能是公开镜像）
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
  };

  let resp = await fetch(manifestUrl, { headers });

  // 如果401且配置了认证，可能镜像实际上是公开的，尝试不使用认证
  if (!resp.ok && resp.status === 401 && useAuth) {
    console.log('[Manifest] 认证失败，尝试不使用认证...');
    const publicToken = await getDockerToken(image, false);
    resp = await fetch(manifestUrl, {
      headers: {
        'Authorization': `Bearer ${publicToken}`,
        'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
      }
    });
  }
  if (!resp.ok) throw new Error('获取manifest失败');
  const contentType = resp.headers.get('Content-Type');
  const manifest = await resp.json();
  // 判断是否为manifest list（多架构）
  if (contentType && contentType.includes('manifest.list.v2+json')) {
    // 查找与arch匹配的manifest
    const found = manifest.manifests.find(m => m.platform && m.platform.architecture === arch);
    if (!found) throw new Error('未找到匹配架构的manifest: ' + arch);
    // 再次获取该架构的manifest
    const archManifestUrl = `https://registry-1.docker.io/v2/${image}/manifests/${found.digest}`;
    resp = await fetch(archManifestUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.docker.distribution.manifest.v2+json'
      }
    });
    if (!resp.ok) throw new Error('获取架构manifest失败');
    return await resp.json();
  }
  // 否则直接返回
  return manifest;
}

/**
 * 获取 DockerHub 镜像下载token
 * @param {string} image 镜像名
 * @param {boolean} useAuth - 是否使用Docker Hub认证
 * @returns {Promise<string>} token
 */
async function getDockerToken(image, useAuth = false) {
  // 对于私有镜像，尝试更广的scope
  const scopes = [
    `repository:${image}:pull`,
    `repository:${image}:pull,push`,
    `repository:${image}:*,pull`
  ];

  // 如果配置了认证信息，使用Docker Hub认证
  let authHeaders = {};
  if (useAuth) {
    // 从storage获取认证信息（需要在调用前确保已配置）
    const auth = await new Promise((resolve) => {
      chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
    });

    if (auth.dockerUsername && auth.dockerPassword) {
      console.log(`[Token] 使用Docker Hub认证用户: ${auth.dockerUsername}`);

      // 使用Basic Auth进行Docker Hub认证
      const credentials = btoa(`${auth.dockerUsername}:${auth.dockerPassword}`);
      authHeaders.Authorization = `Basic ${credentials}`;

      // 也可以尝试使用Docker Hub的OAuth
      // authHeaders.Authorization = `Bearer ${auth.dockerPassword}`;
    }
  }

  let lastError;

  // 尝试不同的scope，直到成功
  for (const scope of scopes) {
    const url = `https://auth.docker.io/token?service=registry.docker.io&scope=${scope}`;
    console.log(`[Token] 尝试获取token，scope: ${scope}`);

    try {
      const resp = await fetch(url, {
        headers: authHeaders
      });

      if (!resp.ok) {
        console.log(`[Token] 失败: ${resp.status} ${resp.statusText}`);
        // 如果401且配置了认证，尝试不使用认证（可能镜像是公开的）
        if (resp.status === 401 && useAuth) {
          console.log(`[Token] 认证失败，尝试不使用认证...`);
          return getDockerToken(image, false);
        }
        continue;
      }

      const data = await resp.json();
      console.log(`[Token] 成功获取token，有效期: ${data.expires_in || 'unknown'}秒`);
      console.log(`[Token] Token前缀: ${data.token.substring(0, 20)}...`);
      return data.token;
    } catch (err) {
      console.log(`[Token] 请求失败: ${err.message}`);
      lastError = err;
    }
  }

  // 所有scope都尝试失败
  throw new Error(`获取token失败，已尝试所有scope。最后错误: ${lastError?.message || '未知错误'}`);
}

/**
 * 下载镜像所有layer（支持分片下载、进度回调、gzip解压）
 * @param {string} image 镜像名
 * @param {Array} layers 镜像layer数组
 * @param {string} token 认证token
 * @param {Function} progressCallback 进度回调函数 (layerDigest, percent, status) => void
 * @returns {Promise<{layerData: ArrayBuffer, layerId: string, digest: string}[]>} 所有layer的解压后数据及ID
 */
async function downloadLayers(image, layers, token, progressCallback = () => {}) {
  const results = [];
  let parentId = ''; // 用于生成layer ID

  // 检查是否配置了Docker Hub认证
  const auth = await new Promise((resolve) => {
    chrome.storage.local.get(['dockerUsername', 'dockerPassword'], resolve);
  });
  const useAuth = !!(auth.dockerUsername && auth.dockerPassword);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const digest = layer.digest;
    const shortDigest = digest.substring(7, 19); // 截取digest的一部分用于显示

    // 生成layer ID（与Python版本相同的算法）
    const layerId = await sha256Hash(`${parentId}\n${digest}\n`);
    parentId = layerId; // 更新parentId用于下一层

    try {
      // 更新状态为开始下载
      progressCallback(digest, 0, 'downloading');

      // 获取文件大小
      const url = `https://registry-1.docker.io/v2/${image}/blobs/${digest}`;

      // 带重试机制的下载函数
      let currentToken = token;
      let retryCount = 0;
      const maxRetries = 2;

      const downloadWithRetry = async (fetchUrl, fetchOptions) => {
        try {
          const resp = await fetch(fetchUrl, fetchOptions);

          // 如果是401错误，尝试重新获取token并重试
          if (resp.status === 401 && retryCount < maxRetries) {
            console.log(`[Layer] 401错误，尝试重新获取token... (尝试 ${retryCount + 1}/${maxRetries})`);
            retryCount++;

            // 如果配置了认证，先尝试用认证的token
            if (useAuth) {
              currentToken = await getDockerToken(image, true);
            } else {
              currentToken = await getDockerToken(image, false);
            }

            // 使用新token重试
            const newFetchOptions = { ...fetchOptions, headers: { ...fetchOptions.headers, 'Authorization': `Bearer ${currentToken}` } };
            return fetch(fetchUrl, newFetchOptions);
          }

          return resp;
        } catch (err) {
          // 如果是网络错误，也尝试重试
          if (retryCount < maxRetries && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
            console.log(`[Layer] 网络错误，重试... (尝试 ${retryCount + 1}/${maxRetries})`);
            retryCount++;
            return downloadWithRetry(fetchUrl, fetchOptions);
          }
          throw err;
        }
      };

      const headResp = await downloadWithRetry(url, {
        method: 'HEAD',
        headers: { 'Authorization': `Bearer ${currentToken}` }
      });

      if (!headResp.ok) {
        throw new Error(`获取layer信息失败: ${digest} (${headResp.status})`);
      }
      
      const contentLength = parseInt(headResp.headers.get('Content-Length') || '0');
      const chunkSize = 2 * 1024 * 1024; // 2MB分片
      const chunks = [];
      let downloaded = 0;
      
      // 分片下载
      for (let start = 0; start < contentLength; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, contentLength - 1);

        // 使用重试机制下载分片
        const rangeResp = await downloadWithRetry(url, {
          headers: {
            'Authorization': `Bearer ${currentToken}`,
            'Range': `bytes=${start}-${end}`
          }
        });
        
        if (!rangeResp.ok && rangeResp.status !== 206) {
          throw new Error(`下载layer分片失败: ${digest}, 范围: ${start}-${end}`);
        }
        
        const chunk = await rangeResp.arrayBuffer();
        chunks.push(new Uint8Array(chunk));
        
        downloaded += chunk.byteLength;
        const percent = Math.floor((downloaded / contentLength) * 100);
        progressCallback(digest, percent, 'downloading');
      }
      
      // 合并所有分片
      const combinedLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
      const combinedArray = new Uint8Array(combinedLength);
      let position = 0;
      
      for (const chunk of chunks) {
        combinedArray.set(chunk, position);
        position += chunk.byteLength;
      }
      
      // 更新状态为解压中
      progressCallback(digest, 100, 'extracting');
      
      // 解压gzip数据（使用pako库）
      const uncompressed = await ungzip(combinedArray.buffer);
      
      progressCallback(digest, 100, 'done');
      
      // 保存解压后的数据和layer ID
      results.push({
        layerData: uncompressed,
        layerId: layerId,
        digest: digest
      });
      
    } catch (error) {
      progressCallback(digest, 0, 'failed');
      throw error;
    }
  }
  
  return results;
}

/**
 * 使用pako库解压gzip数据
 * @param {ArrayBuffer} compressedData gzip压缩的数据
 * @returns {Promise<ArrayBuffer>} 解压后的数据
 */
async function ungzip(compressedData) {
  // 注意：这里假设已经引入了pako库
  // 实际使用时需要确保pako库已正确引入
  try {
    // 使用Web Worker进行解压以避免阻塞主线程
    return new Promise((resolve, reject) => {
      const worker = new Worker(URL.createObjectURL(new Blob([`
        importScripts('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
        onmessage = function(e) {
          try {
            const result = pako.ungzip(new Uint8Array(e.data));
            postMessage({success: true, data: result.buffer}, [result.buffer]);
          } catch (error) {
            postMessage({success: false, error: error.message});
          }
        };
      `], {type: 'application/javascript'})));
      
      worker.onmessage = function(e) {
        worker.terminate();
        if (e.data.success) {
          resolve(e.data.data);
        } else {
          reject(new Error(e.data.error));
        }
      };
      
      worker.onerror = function(e) {
        worker.terminate();
        reject(new Error('Worker error: ' + e.message));
      };
      
      worker.postMessage(compressedData, [compressedData]);
    });
  } catch (error) {
    console.error('解压失败:', error);
    throw error;
  }
}

/**
 * 计算SHA256哈希
 * @param {string} data 要计算哈希的字符串
 * @returns {Promise<string>} 哈希结果
 */
async function sha256Hash(data) {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 打包为tar文件（使用tar-js库实现Docker镜像标准格式）
 * @param {Array<{layerData: ArrayBuffer, layerId: string, digest: string}>} layers 所有layer的解压后数据及ID
 * @param {Object} manifest 镜像manifest
 * @param {string} imageName 镜像名
 * @param {string} tag 镜像标签
 * @returns {Promise<Blob>} tar文件的blob对象
 */
async function packToTar(layers, manifest, imageName, tag) {
  // 使用tar-js库创建tar文件
  const tar = new tarball.TarWriter();

  // 验证参数
  if (!manifest) {
    throw new Error('Manifest is required for packing tar file');
  }
  if (!manifest.config || !manifest.config.digest) {
    throw new Error('Manifest config is missing or invalid');
  }

  // 获取镜像配置信息
  const configDigest = manifest.config.digest;
  const configBlob = layers.find(layer => layer.digest === configDigest);
  let config;
  
  if (configBlob) {
    // 解析配置JSON
    const decoder = new TextDecoder('utf-8');
    const configText = decoder.decode(configBlob.layerData);
    config = JSON.parse(configText);
  } else {
    throw new Error('找不到镜像配置信息');
  }
  
  // 移除配置层，只保留实际数据层
  const dataLayers = layers.filter(layer => layer.digest !== configDigest);
  
  // 1. 为每一层创建目录和文件
  for (let i = 0; i < dataLayers.length; i++) {
    const layer = dataLayers[i];
    const layerId = layer.layerId;
    
    // 创建VERSION文件
    tar.addTextFile(`${layerId}/VERSION`, '1.0');
    
    // 添加layer.tar文件（已解压的layer数据）
    tar.addFile(`${layerId}/layer.tar`, new Uint8Array(layer.layerData));
    
    // 创建json文件
    const layerJson = {
      id: layerId,
      created: config.created,
      container_config: config.container_config || { Hostname: '', Cmd: null, Image: '' }
    };
    
    // 最后一层包含完整配置信息
    if (i === dataLayers.length - 1) {
      layerJson.config = config.config || {};
      layerJson.architecture = config.architecture || 'amd64';
      layerJson.os = config.os || 'linux';
      layerJson.history = config.history || [];
    }
    
    tar.addTextFile(`${layerId}/json`, JSON.stringify(layerJson));
  }
  
  // 2. 创建manifest.json文件
  const manifestJson = [
    {
      Config: `${dataLayers[dataLayers.length - 1].layerId}.json`,
      RepoTags: [`${imageName}:${tag}`],
      Layers: dataLayers.map(layer => `${layer.layerId}/layer.tar`)
    }
  ];
  tar.addTextFile('manifest.json', JSON.stringify(manifestJson));
  
  // 3. 创建repositories文件
  const repositories = {};
  const repoName = imageName.includes('/') ? imageName : `library/${imageName}`;
  repositories[repoName] = {};
  repositories[repoName][tag] = dataLayers[dataLayers.length - 1].layerId;
  tar.addTextFile('repositories', JSON.stringify(repositories));
  
  // 4. 添加最后一层的完整JSON配置
  const lastLayerId = dataLayers[dataLayers.length - 1].layerId;
  tar.addTextFile(`${lastLayerId}.json`, JSON.stringify(config));
  
  // 生成最终的tar文件
  const tarData = await tar.write();
  return new Blob([tarData], { type: 'application/x-tar' });
}

/**
 * 简化版的tar-js库实现
 * 实际项目中应该使用完整的tar-js库
 */
const tarball = {
  TarWriter: class {
    constructor() {
      this.files = [];
    }
    
    addTextFile(filename, content) {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      this.addFile(filename, data);
    }
    
    addFile(filename, data) {
      this.files.push({
        filename,
        data,
        mode: 0o644,
        mtime: Math.floor(Date.now() / 1000),
        uid: 0,
        gid: 0
      });
    }
    
    async write() {
      // 计算所有文件的总大小
      let totalSize = 0;
      for (const file of this.files) {
        // 每个文件头512字节 + 文件内容（向上取整到512的倍数）
        totalSize += 512 + (Math.ceil(file.data.length / 512) * 512);
      }
      // 添加结束标记（两个全零的512字节块）
      totalSize += 1024;
      
      const buffer = new Uint8Array(totalSize);
      let offset = 0;
      
      for (const file of this.files) {
        // 写入文件头
        offset = this._writeHeader(buffer, offset, file);
        
        // 写入文件内容
        buffer.set(file.data, offset);
        offset += file.data.length;
        
        // 填充到512字节的倍数
        const paddingLength = 512 - (file.data.length % 512);
        if (paddingLength < 512) {
          offset += paddingLength; // 跳过填充的零字节
        }
      }
      
      // 写入结束标记（两个全零的512字节块）
      // 由于buffer初始化为0，不需要额外操作
      
      return buffer;
    }
    
    _writeHeader(buffer, offset, file) {
      const encoder = new TextEncoder();
      const header = new Uint8Array(512); // tar头部固定512字节
      
      // 文件名，最多100字节
      const filenameBytes = encoder.encode(file.filename);
      header.set(filenameBytes.slice(0, 100), 0);
      
      // 文件模式，8进制字符串，8字节
      const modeStr = file.mode.toString(8).padStart(7, '0') + ' ';
      header.set(encoder.encode(modeStr), 100);
      
      // UID，8进制字符串，8字节
      const uidStr = file.uid.toString(8).padStart(7, '0') + ' ';
      header.set(encoder.encode(uidStr), 108);
      
      // GID，8进制字符串，8字节
      const gidStr = file.gid.toString(8).padStart(7, '0') + ' ';
      header.set(encoder.encode(gidStr), 116);
      
      // 文件大小，8进制字符串，12字节
      const sizeStr = file.data.length.toString(8).padStart(11, '0') + ' ';
      header.set(encoder.encode(sizeStr), 124);
      
      // 修改时间，8进制字符串，12字节
      const mtimeStr = file.mtime.toString(8).padStart(11, '0') + ' ';
      header.set(encoder.encode(mtimeStr), 136);
      
      // 校验和占位，8字节
      header.set(encoder.encode('        '), 148);
      
      // 文件类型，1字节，'0'表示普通文件
      header.set(encoder.encode('0'), 156);
      
      // 计算校验和
      let checksum = 0;
      for (let i = 0; i < 512; i++) {
        checksum += header[i];
      }
      
      // 写入校验和，8进制字符串，6字节+空格+\0
      const checksumStr = checksum.toString(8).padStart(6, '0') + '\u0000 ';
      header.set(encoder.encode(checksumStr), 148);
      
      // 将头部复制到主缓冲区
      buffer.set(header, offset);
      return offset + 512;
    }
  }
};

// 后续：支持config文件下载、进度回调、错误处理等