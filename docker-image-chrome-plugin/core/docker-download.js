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
export async function fetchManifest(image, tag, arch = 'amd64') {
  // 获取token
  const token = await getDockerToken(image);
  // 获取manifest（可能是manifest list）
  const manifestUrl = `https://registry-1.docker.io/v2/${image}/manifests/${tag}`;
  let resp = await fetch(manifestUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    }
  });
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
 * @returns {Promise<string>} token
 */
export async function getDockerToken(image) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('获取token失败');
  const data = await resp.json();
  return data.token;
}

/**
 * 下载镜像所有layer（伪实现，后续完善分片、进度、解压等）
 * @param {string} image 镜像名
 * @param {Array} layers 镜像layer数组
 * @param {string} token 认证token
 * @returns {Promise<ArrayBuffer[]>} 所有layer的二进制数据
 */
export async function downloadLayers(image, layers, token) {
  // 这里只做伪实现，后续需分片、进度、gzip解压
  const results = [];
  for (const layer of layers) {
    const url = `https://registry-1.docker.io/v2/${image}/blobs/${layer.digest}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) throw new Error('下载layer失败:' + layer.digest);
    const buf = await resp.arrayBuffer();
    results.push(buf);
  }
  return results;
}

/**
 * 打包为tar文件（伪实现，后续用tar-js等库实现）
 * @param {ArrayBuffer[]} layersData 所有layer的二进制数据
 * @returns {Blob} tar文件Blob
 */
export function packToTar(layersData) {
  // 这里只做伪实现，后续用tar-js等库实现真正打包
  // return new Blob([...layersData], {type: 'application/x-tar'});
  // 占位：实际应将各layer和config等文件打包为标准docker镜像tar结构
  return new Blob([new Uint8Array([0x54,0x41,0x52])], {type: 'application/x-tar'}); // 仅占位
}

// 后续：支持config文件下载、进度回调、错误处理等 