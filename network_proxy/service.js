const fetch = require('node-fetch');
const express = require('express');
const fs = require('fs-extra');
const crypto = require('crypto');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:7890'); // 你的本地代理地址

// 配置项
const CONFIG = {
  PORT: 7000,
  CACHE_DIR: path.join(__dirname, 'cache'),
  STATS_FILE: path.join(__dirname, 'download-stats.json'),
  CACHE_ENABLED: true,
  CACHE_MAX_SIZE: 10 * 1024 * 1024 * 1024, // 10GB
  CACHE_EXPIRY: 7 * 24 * 60 * 60 * 1000, // 7天
};

// 初始化目录和文件
async function initializeStorage() {
  await fs.ensureDir(CONFIG.CACHE_DIR);
  await fs.ensureDir(path.join(CONFIG.CACHE_DIR, 'manifests'));
  await fs.ensureDir(path.join(CONFIG.CACHE_DIR, 'blobs'));

  if (!await fs.pathExists(CONFIG.STATS_FILE)) {
    await fs.writeJson(CONFIG.STATS_FILE, {
      totalDownloads: 0,
      imageStats: {},
      dailyStats: {},
      cacheStats: {
        hits: 0,
        misses: 0,
        totalSize: 0
      }
    });
  }
}

// 统计功能
class StatsManager {
  constructor() {
    this.stats = null;
    this.loadStats();
  }

  async loadStats() {
    try {
      this.stats = await fs.readJson(CONFIG.STATS_FILE);
    } catch (err) {
      console.error('[Stats] 加载统计数据失败:', err);
      this.stats = {
        totalDownloads: 0,
        imageStats: {},
        dailyStats: {},
        cacheStats: { hits: 0, misses: 0, totalSize: 0 }
      };
    }
  }

  async saveStats() {
    try {
      await fs.writeJson(CONFIG.STATS_FILE, this.stats, { spaces: 2 });
    } catch (err) {
      console.error('[Stats] 保存统计数据失败:', err);
    }
  }

  recordDownload(image, tag, arch, size = 0) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const imageKey = `${image}:${tag}:${arch}`;

    // 总下载次数
    this.stats.totalDownloads++;

    // 镜像统计
    if (!this.stats.imageStats[imageKey]) {
      this.stats.imageStats[imageKey] = {
        downloads: 0,
        totalSize: 0,
        firstDownload: new Date().toISOString(),
        lastDownload: new Date().toISOString()
      };
    }
    this.stats.imageStats[imageKey].downloads++;
    this.stats.imageStats[imageKey].totalSize += size;
    this.stats.imageStats[imageKey].lastDownload = new Date().toISOString();

    // 每日统计
    if (!this.stats.dailyStats[today]) {
      this.stats.dailyStats[today] = {
        downloads: 0,
        uniqueImages: new Set(),
        totalSize: 0,
        hourlyStats: {}
      };
    }
    this.stats.dailyStats[today].downloads++;
    this.stats.dailyStats[today].uniqueImages.add(imageKey);
    this.stats.dailyStats[today].totalSize += size;

    // 小时统计
    if (!this.stats.dailyStats[today].hourlyStats[hour]) {
      this.stats.dailyStats[today].hourlyStats[hour] = {
        downloads: 0,
        totalSize: 0
      };
    }
    this.stats.dailyStats[today].hourlyStats[hour].downloads++;
    this.stats.dailyStats[today].hourlyStats[hour].totalSize += size;

    this.saveStats();
  }

  recordCacheHit() {
    this.stats.cacheStats.hits++;
    this.saveStats();
  }

  recordCacheMiss() {
    this.stats.cacheStats.misses++;
    this.saveStats();
  }

  getStats() {
    return this.stats;
  }
}

// 缓存管理器
class CacheManager {
  constructor() {
    this.cacheDir = CONFIG.CACHE_DIR;
  }

  // 生成缓存键
  generateCacheKey(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  // 获取缓存文件路径
  getCachePath(cacheKey, type = 'blobs') {
    return path.join(this.cacheDir, type, cacheKey);
  }

  // 检查缓存是否存在且有效
  async isCacheValid(cacheKey, type = 'blobs') {
    const cachePath = this.getCachePath(cacheKey, type);
    const metaPath = cachePath + '.meta';

    try {
      const [cacheExists, metaExists] = await Promise.all([
        fs.pathExists(cachePath),
        fs.pathExists(metaPath)
      ]);

      if (!cacheExists || !metaExists) return false;

      const meta = await fs.readJson(metaPath);
      const now = Date.now();

      // 检查是否过期
      if (now - meta.timestamp > CONFIG.CACHE_EXPIRY) {
        await this.removeCache(cacheKey, type);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Cache] 检查缓存失败:', err);
      return false;
    }
  }

  // 获取缓存
  async getCache(cacheKey, type = 'blobs') {
    const cachePath = this.getCachePath(cacheKey, type);
    const metaPath = cachePath + '.meta';

    try {
      const meta = await fs.readJson(metaPath);
      const data = await fs.readFile(cachePath);

      return {
        data,
        headers: meta.headers,
        status: meta.status
      };
    } catch (err) {
      console.error('[Cache] 读取缓存失败:', err);
      return null;
    }
  }

  // 设置缓存
  async setCache(cacheKey, data, headers, status, type = 'blobs') {
    const cachePath = this.getCachePath(cacheKey, type);
    const metaPath = cachePath + '.meta';

    try {
      await fs.ensureDir(path.dirname(cachePath));

      // 保存数据
      await fs.writeFile(cachePath, data);

      // 保存元数据
      const meta = {
        timestamp: Date.now(),
        headers: headers,
        status: status,
        size: data.length
      };
      await fs.writeJson(metaPath, meta);

      console.log(`[Cache] 缓存已保存: ${cacheKey.substring(0, 16)}... (${data.length} bytes)`);
    } catch (err) {
      console.error('[Cache] 保存缓存失败:', err);
    }
  }

  // 删除缓存
  async removeCache(cacheKey, type = 'blobs') {
    const cachePath = this.getCachePath(cacheKey, type);
    const metaPath = cachePath + '.meta';

    try {
      await Promise.all([
        fs.remove(cachePath),
        fs.remove(metaPath)
      ]);
    } catch (err) {
      console.error('[Cache] 删除缓存失败:', err);
    }
  }

  // 清理过期缓存
  async cleanExpiredCache() {
    console.log('[Cache] 开始清理过期缓存...');

    const types = ['blobs', 'manifests'];

    for (const type of types) {
      const typeDir = path.join(this.cacheDir, type);

      try {
        const files = await fs.readdir(typeDir);
        const metaFiles = files.filter(f => f.endsWith('.meta'));

        for (const metaFile of metaFiles) {
          const metaPath = path.join(typeDir, metaFile);
          const cacheKey = metaFile.replace('.meta', '');

          try {
            const meta = await fs.readJson(metaPath);
            const now = Date.now();

            if (now - meta.timestamp > CONFIG.CACHE_EXPIRY) {
              await this.removeCache(cacheKey, type);
              console.log(`[Cache] 清理过期缓存: ${cacheKey.substring(0, 16)}...`);
            }
          } catch (err) {
            console.error('[Cache] 处理meta文件失败:', metaPath, err);
          }
        }
      } catch (err) {
        console.error('[Cache] 清理缓存目录失败:', typeDir, err);
      }
    }

    console.log('[Cache] 缓存清理完成');
  }

  // 获取缓存统计
  async getCacheStats() {
    let totalSize = 0;
    let fileCount = 0;

    const types = ['blobs', 'manifests'];

    for (const type of types) {
      const typeDir = path.join(this.cacheDir, type);

      try {
        const files = await fs.readdir(typeDir);
        const dataFiles = files.filter(f => !f.endsWith('.meta'));

        for (const file of dataFiles) {
          const filePath = path.join(typeDir, file);
          const stat = await fs.stat(filePath);
          totalSize += stat.size;
          fileCount++;
        }
      } catch (err) {
        console.error('[Cache] 获取缓存统计失败:', err);
      }
    }

    return { totalSize, fileCount };
  }
}

// 初始化管理器
const statsManager = new StatsManager();
const cacheManager = new CacheManager();

app.use(express.json());

// 静态文件服务
app.use('/static', express.static(path.join(__dirname, 'public')));

// 允许所有跨域
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Range');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// 解析请求信息
function parseDockerRequest(url) {
  // 解析Docker Registry API URL
  const manifestMatch = url.match(/https:\/\/registry-1\.docker\.io\/v2\/([^\/]+)\/manifests\/(.+)/);
  const blobMatch = url.match(/https:\/\/registry-1\.docker\.io\/v2\/([^\/]+)\/blobs\/(.+)/);
  const tokenMatch = url.match(/https:\/\/auth\.docker\.io\/token\?.*scope=repository:([^:]+):pull/);

  if (manifestMatch) {
    return {
      type: 'manifest',
      image: manifestMatch[1],
      tag: manifestMatch[2]
    };
  } else if (blobMatch) {
    return {
      type: 'blob',
      image: blobMatch[1],
      digest: blobMatch[2]
    };
  } else if (tokenMatch) {
    return {
      type: 'token',
      image: tokenMatch[1]
    };
  }

  return { type: 'unknown' };
}

// 代理 GET 请求
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  console.log(`[Proxy] 请求目标: ${targetUrl}`);

  if (!targetUrl) {
    console.error('[Proxy] 缺少url参数');
    return res.status(400).send('Missing url param');
  }

  // 安全检查
  if (!/^https:\/\/(registry-1|auth)\.docker\.io\//.test(targetUrl)) {
    console.error('[Proxy] 非法目标:', targetUrl);
    return res.status(403).send('Forbidden');
  }

  const requestInfo = parseDockerRequest(targetUrl);
  const cacheKey = cacheManager.generateCacheKey(targetUrl);

  try {
    // 对于blobs和manifests，检查缓存
    if (CONFIG.CACHE_ENABLED && (requestInfo.type === 'blob' || requestInfo.type === 'manifest')) {
      const cacheType = requestInfo.type === 'manifest' ? 'manifests' : 'blobs';

      if (await cacheManager.isCacheValid(cacheKey, cacheType)) {
        console.log(`[Cache] 缓存命中: ${targetUrl}`);

        const cached = await cacheManager.getCache(cacheKey, cacheType);
        if (cached) {
          statsManager.recordCacheHit();

          // 设置响应头
          res.status(cached.status);
          Object.entries(cached.headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'content-encoding') { // 避免双重压缩
              res.set(key, value);
            }
          });

          return res.send(cached.data);
        }
      }

      statsManager.recordCacheMiss();
    }

    // 准备请求头
    const headers = {};
    if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];
    if (req.headers['range']) headers['range'] = req.headers['range'];

    console.log(`[Proxy] 发起请求: ${targetUrl}`);
    const resp = await fetch(targetUrl, { headers, agent: proxyAgent });

    console.log(`[Proxy] 响应状态: ${resp.status}`);

    // 获取响应数据
    const buffer = await resp.buffer();
    const responseHeaders = {};

    // 复制响应头，避免冲突的头
    resp.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      responseHeaders[key] = value;

      // 跳过可能导致冲突的头
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(lowerKey)) {
        res.set(key, value);
      }
    });

    res.status(resp.status);

    // 缓存响应（仅对成功的blobs和manifests请求）
    if (CONFIG.CACHE_ENABLED && resp.ok && (requestInfo.type === 'blob' || requestInfo.type === 'manifest')) {
      const cacheType = requestInfo.type === 'manifest' ? 'manifests' : 'blobs';
      await cacheManager.setCache(cacheKey, buffer, responseHeaders, resp.status, cacheType);
    }

    // 记录下载统计
    if (resp.ok && requestInfo.type === 'blob') {
      statsManager.recordDownload(
        requestInfo.image || 'unknown',
        'unknown', // tag信息在这里不可用
        'unknown', // arch信息在这里不可用
        buffer.length
      );
    }

    res.send(buffer);

  } catch (err) {
    console.error('[Proxy] 错误:', err.message);
    res.status(500).send(err.message);
  }
});

// 统计API
app.get('/stats', async (req, res) => {
  try {
    const stats = statsManager.getStats();
    const cacheStats = await cacheManager.getCacheStats();

    // 处理Set对象序列化问题
    const processedDailyStats = {};
    Object.entries(stats.dailyStats).forEach(([date, data]) => {
      processedDailyStats[date] = {
        ...data,
        uniqueImages: Array.from(data.uniqueImages || [])
      };
    });

    res.json({
      ...stats,
      dailyStats: processedDailyStats,
      cacheStats: {
        ...stats.cacheStats,
        ...cacheStats
      }
    });
  } catch (err) {
    console.error('[Stats] 获取统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 每日统计API
app.get('/api/daily-stats', async (req, res) => {
  try {
    const stats = statsManager.getStats();
    const days = parseInt(req.query.days) || 7;

    const dailyData = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const dayStats = stats.dailyStats[dateStr] || {
        downloads: 0,
        totalSize: 0,
        uniqueImages: [],
        hourlyStats: {}
      };

      dailyData.push({
        date: dateStr,
        downloads: dayStats.downloads,
        totalSize: dayStats.totalSize,
        uniqueImages: Array.from(dayStats.uniqueImages || []).length,
        hourlyStats: dayStats.hourlyStats || {}
      });
    }

    res.json(dailyData);
  } catch (err) {
    console.error('[API] 获取每日统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 小时统计API
app.get('/api/hourly-stats', async (req, res) => {
  try {
    const stats = statsManager.getStats();
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const dayStats = stats.dailyStats[date];
    if (!dayStats) {
      return res.json([]);
    }

    const hourlyData = [];
    for (let hour = 0; hour < 24; hour++) {
      const hourStats = dayStats.hourlyStats[hour] || {
        downloads: 0,
        totalSize: 0
      };

      hourlyData.push({
        hour,
        downloads: hourStats.downloads,
        totalSize: hourStats.totalSize
      });
    }

    res.json(hourlyData);
  } catch (err) {
    console.error('[API] 获取小时统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 缓存管理API
app.post('/cache/clear', async (req, res) => {
  try {
    await cacheManager.cleanExpiredCache();
    res.json({ success: true, message: '缓存清理完成' });
  } catch (err) {
    console.error('[Cache] 清理缓存失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/cache', async (req, res) => {
  try {
    await fs.emptyDir(CONFIG.CACHE_DIR);
    await initializeStorage(); // 重新初始化目录结构
    res.json({ success: true, message: '缓存已清空' });
  } catch (err) {
    console.error('[Cache] 清空缓存失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.1.0',
    features: {
      cache: CONFIG.CACHE_ENABLED,
      stats: true
    }
  });
});

// 前端监控页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
async function startServer() {
  try {
    await initializeStorage();

    // 定期清理缓存（每6小时）
    setInterval(() => {
      cacheManager.cleanExpiredCache();
    }, 6 * 60 * 60 * 1000);

    app.listen(CONFIG.PORT, () => {
      console.log(`🚀 Docker代理服务器已启动`);
      console.log(`📍 地址: http://localhost:${CONFIG.PORT}`);
      console.log(`💾 缓存目录: ${CONFIG.CACHE_DIR}`);
      console.log(`📊 统计文件: ${CONFIG.STATS_FILE}`);
      console.log(`🔧 功能: 缓存=${CONFIG.CACHE_ENABLED}, 统计=true`);
    });
  } catch (err) {
    console.error('启动服务器失败:', err);
    process.exit(1);
  }
}

startServer();