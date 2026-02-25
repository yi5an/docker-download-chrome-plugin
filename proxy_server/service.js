const fetch = require('node-fetch');
const express = require('express');
const app = express();
const { HttpsProxyAgent } = require('https-proxy-agent');

// 代理配置（可通过环境变量控制）
const USE_PROXY = process.env.USE_PROXY === 'true';
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';

// 缓存配置（可通过环境变量控制）
const CACHE_BLOB = process.env.CACHE_BLOB !== 'false'; // 默认启用缓存blob，只有明确设置为false时才禁用
const CACHE_BLOB_MAX_SIZE = parseInt(process.env.CACHE_BLOB_MAX_SIZE || '200') * 1024 * 1024; // blob缓存大小限制（MB），默认200MB

console.log(`[Config] Blob caching: ${CACHE_BLOB ? 'ENABLED' : 'DISABLED'}, Max size: ${(CACHE_BLOB_MAX_SIZE / 1024 / 1024).toFixed(2)} MB`);

// 根据环境变量决定是否使用代理
const proxyAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : null;

const fs = require('fs');
const path = require('path');

// ==================== 流量统计 ====================
const TRAFFIC_LOG_PATH = path.join(__dirname, 'traffic.log');

const trafficStats = {
    totalRequests: 0,
    totalBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    byDomain: {},
    byDate: {},
    startTime: new Date().toISOString()
};

function recordTraffic(url, bytes, fromCache) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const domain = new URL(url).hostname;

    // 总体统计
    trafficStats.totalRequests++;
    trafficStats.totalBytes += bytes;

    // 缓存统计
    if (fromCache) {
        trafficStats.cacheHits++;
    } else {
        trafficStats.cacheMisses++;
    }

    // 域名统计
    if (!trafficStats.byDomain[domain]) {
        trafficStats.byDomain[domain] = { requests: 0, bytes: 0 };
    }
    trafficStats.byDomain[domain].requests++;
    trafficStats.byDomain[domain].bytes += bytes;

    // 日期统计
    if (!trafficStats.byDate[date]) {
        trafficStats.byDate[date] = { requests: 0, bytes: 0 };
    }
    trafficStats.byDate[date].requests++;
    trafficStats.byDate[date].bytes += bytes;

    // 记录到日志文件
    const logEntry = {
        timestamp: now.toISOString(),
        url,
        domain,
        bytes,
        fromCache
    };

    try {
        fs.appendFileSync(TRAFFIC_LOG_PATH, JSON.stringify(logEntry) + '\n');
    } catch (err) {
        console.error('[Traffic] Failed to write log:', err);
    }
}

// ==================== LRU 缓存实现（支持持久化）====================
class LRUCache {
    constructor(maxSize = 100, maxBytes = 500 * 1024 * 1024, persistPath = null) { // 默认100项或500MB
        this.maxSize = maxSize;
        this.maxBytes = maxBytes;
        this.persistPath = persistPath;
        this.cache = new Map();
        this.currentBytes = 0;
        this.hits = 0;
        this.misses = 0;
        this.pendingSave = false; // 防抖，避免频繁写入

        // 如果指定了持久化路径，从文件加载缓存
        if (this.persistPath) {
            this.loadFromDisk();
        }
    }

    // 从磁盘加载缓存
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.persistPath)) {
                console.log(`[Cache] No cache file found, starting fresh`);
                return;
            }

            const data = fs.readFileSync(this.persistPath, 'utf-8');
            const entries = JSON.parse(data);

            let totalBytes = 0;
            let validCount = 0;
            let expiredCount = 0;

            for (const [key, value] of Object.entries(entries)) {
                // 检查是否过期
                if (this.isExpired(key, value)) {
                    expiredCount++;
                    continue;
                }

                // 确保从磁盘加载的值有正确的结构
                const cachedValue = { ...value, accessCount: value.accessCount || 0 };
                this.cache.set(key, cachedValue);
                totalBytes += value.size || 0;
                validCount++;
            }

            this.currentBytes = totalBytes;
            console.log(`[Cache] Loaded ${validCount} entries from disk (${expiredCount} expired), total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
        } catch (err) {
            console.error(`[Cache] Failed to load from disk:`, err);
        }
    }

    // 保存缓存到磁盘
    saveToDisk() {
        if (!this.persistPath) return;

        try {
            const entries = {};
            for (const [key, value] of this.cache.entries()) {
                // 只保存必要数据，减少文件大小
                entries[key] = {
                    data: value.data,
                    contentType: value.contentType,
                    size: value.size,
                    timestamp: value.timestamp,
                    accessCount: value.accessCount || 0
                };
            }

            const json = JSON.stringify(entries, null, 2);
            fs.writeFileSync(this.persistPath, json, 'utf-8');
            console.log(`[Cache] Saved ${this.cache.size} entries to disk, total: ${(this.currentBytes / 1024 / 1024).toFixed(2)} MB`);
        } catch (err) {
            console.error(`[Cache] Failed to save to disk:`, err);
        }
    }

    // 检查缓存项是否过期
    isExpired(key, value) {
        // Token 缓存项不使用过期时间，但应该更频繁地检查
        if (key.includes('auth.docker.io/token')) {
            const age = Date.now() - (value.timestamp || Date.now());
            const maxAge = 5 * 60 * 1000; // 5 分钟
            return age > maxAge;
        }
        // 对于非 token 缓存项，检查是否超过 30 分钟
        const age = Date.now() - (value.timestamp || Date.now());
        const maxAge = 30 * 60 * 1000; // 30 分钟
        return age > maxAge;
    }

    get(key) {
        if (this.cache.has(key)) {
            const value = this.cache.get(key);

            // 检查缓存项是否过期
            if (this.isExpired(key, value)) {
                console.log(`[Cache] EXPIRED for key: ${key}, removing...`);
                this.cache.delete(key);
                this.currentBytes -= value.size || 0;
                this.misses++;
                this.scheduleSave();
                return null;
            }

            this.hits++;
            // 增加访问次数
            value.accessCount = (value.accessCount || 0) + 1;
            // LRU: 移到最后（保持Map顺序，访问多的在后面）
            this.cache.delete(key);
            this.cache.set(key, value);

            return value;
        }
        this.misses++;
        return null;
    }

    set(key, value, size = 0) {
        // 如果已存在，删除旧值
        if (this.cache.has(key)) {
            const oldValue = this.cache.get(key);
            this.currentBytes -= oldValue.size || 0;
            this.cache.delete(key);
        }

        // 添加新值（继承原有的访问次数）
        const existingAccessCount = value.accessCount || 0;
        this.cache.set(key, { ...value, size, timestamp: Date.now(), accessCount: existingAccessCount });
        this.currentBytes += size;

        // 检查是否需要淘汰
        this.evict();

        // 异步保存到磁盘
        this.scheduleSave();
    }

    // 调度保存，避免频繁写入
    scheduleSave() {
        if (!this.persistPath) return;

        if (!this.pendingSave) {
            this.pendingSave = true;
            setTimeout(() => {
                this.saveToDisk();
                this.pendingSave = false;
            }, 5000); // 5秒后保存
        }
    }

    evict() {
        // 按数量淘汰（淘汰访问次数最少的）
        while (this.cache.size > this.maxSize) {
            const entries = Array.from(this.cache.entries());
            // 按访问次数排序，淘汰最少的
            entries.sort((a, b) => (a[1].accessCount || 0) - (b[1].accessCount || 0));

            const firstKey = entries[0][0];
            const value = entries[0][1];
            this.currentBytes -= value.size || 0;
            this.cache.delete(firstKey);

            console.log(`[Cache] Evicted ${firstKey} (accessCount: ${value.accessCount || 0})`);
        }

        // 按大小淘汰（优先淘汰访问次数少的）
        while (this.currentBytes > this.maxBytes && this.cache.size > 0) {
            const entries = Array.from(this.cache.entries());
            // 按访问次数排序
            entries.sort((a, b) => (a[1].accessCount || 0) - (b[1].accessCount || 0));

            const firstKey = entries[0][0];
            const value = entries[0][1];
            this.currentBytes -= value.size || 0;
            this.cache.delete(firstKey);

            console.log(`[Cache] Evicted by size: ${firstKey} (accessCount: ${value.accessCount || 0}, size: ${(value.size / 1024 / 1024).toFixed(2)} MB)`);
        }
    }

    clear() {
        this.cache.clear();
        this.currentBytes = 0;
        this.hits = 0;
        this.misses = 0;

        // 清空持久化文件
        if (this.persistPath) {
            this.saveToDisk();
        }
    }

    // 清理过期缓存
    cleanupExpired() {
        const expiredKeys = [];

        for (const [key, value] of this.cache.entries()) {
            if (this.isExpired(key, value)) {
                expiredKeys.push(key);
                this.currentBytes -= value.size || 0;
            }
        }

        for (const key of expiredKeys) {
            this.cache.delete(key);
        }

        if (expiredKeys.length > 0) {
            console.log(`[Cache] Cleaned up ${expiredKeys.length} expired entries`);
            this.saveToDisk();
        }
    }

    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            currentBytes: this.currentBytes,
            maxBytes: this.maxBytes,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0
                ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    getEntries() {
        return Array.from(this.cache.entries()).map(([key, value]) => ({
            key,
            size: value.size,
            timestamp: new Date(value.timestamp).toISOString(),
            age: Math.floor((Date.now() - value.timestamp) / 1000), // 秒
            accessCount: value.accessCount || 0
        }));
    }
}

// 缓存持久化文件路径
const CACHE_PERSIST_PATH = path.join(__dirname, 'cache-persist.json');

console.log(`[Cache] Cache persist path: ${CACHE_PERSIST_PATH}`);
console.log(`[Cache] Cache file exists: ${fs.existsSync(CACHE_PERSIST_PATH)}`);

// 创建缓存实例（支持持久化）
const responseCache = new LRUCache(
    200, // 最多200个缓存项
    1024 * 1024 * 1024, // 最多1GB
    CACHE_PERSIST_PATH // 持久化路径
);

// 定期清理过期缓存（每30分钟执行一次）
setInterval(() => {
    console.log('[Cache] Running periodic cleanup...');
    responseCache.cleanupExpired();
}, 30 * 60 * 1000);

// 进程退出时保存缓存
process.on('SIGINT', () => {
    console.log('[Cache] Saving cache before exit...');
    responseCache.saveToDisk();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Cache] Saving cache before exit...');
    responseCache.saveToDisk();
    process.exit(0);
});

// ==================== 辅助函数 ====================
function logToFile(msg) {
    fs.appendFileSync('debug.log', new Date().toISOString() + ' ' + msg + '\n');
}

// 追踪日志文件
const TRACKING_LOG_PATH = path.join(__dirname, 'tracking.log');

function logTracking(data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        ...data
    };
    try {
        fs.appendFileSync(TRACKING_LOG_PATH, JSON.stringify(logEntry) + '\n');
        console.log('[Tracking] Logged:', logEntry);
    } catch (err) {
        console.error('[Tracking] Failed to write log:', err);
    }
}

// ==================== Express 中间件 ====================
app.use(express.json());

// 允许所有跨域
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

// ==================== 代理 GET 请求（带缓存） ====================
const crypto = require('crypto');

// 生成 Authorization header 的短哈希，用于缓存键
function getAuthHash(authHeader) {
    if (!authHeader) return 'no-auth';
    // 只取 token 的前 16 个字符作为标识，避免完整的 token 作为缓存键
    const token = authHeader.replace('Bearer ', '');
    return crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const skipCache = req.query._nocache || req.headers['x-skip-cache'] === 'true';
    const startTime = Date.now();

    // 检查是否是 blob 下载请求（layer 文件）
    const isBlobRequest = targetUrl && targetUrl.includes('/blobs/');
    // 检查是否是 manifest 请求
    const isManifestRequest = targetUrl && targetUrl.includes('/manifests/');

    // 检查是否应该跳过blob缓存（根据配置）
    const shouldSkipBlobCache = isBlobRequest && (!CACHE_BLOB || false);

    console.log('[proxy] 原始请求:', req.originalUrl);
    console.log('[proxy] 解析目标:', targetUrl);
    const skipCacheByHeader = req.headers['x-skip-cache'] === 'true';
    const skipCacheByUrl = !!req.query._nocache;
    console.log('[proxy] 跳过缓存:', skipCache ? '是' : '否', `(header: ${skipCacheByHeader}, url: ${skipCacheByUrl})`);
    console.log('[proxy] 请求类型:', isBlobRequest ? 'blob' : (isManifestRequest ? 'manifest' : 'other'));
    logToFile(`[Request] Original: ${req.originalUrl}`);
    logToFile(`[Request] Target: ${targetUrl}`);

    if (!targetUrl) {
        console.error('[proxy] 缺少url参数');
        return res.status(400).send('Missing url param');
    }

    try {
        // 清理 URL：移除 _nocache 参数（用于白名单检查和缓存键）
        const cleanUrl = targetUrl.replace(/[?&]_nocache=\d+/, '');

        // 白名单检查
        if (!/^https:\/\/((registry-1|auth)\.docker\.io|docker-images-prod\..*\.r2\.cloudflarestorage\.com|production\.cloudflare\.docker\.com)\//.test(cleanUrl)) {
            console.error('[proxy] 非法目标:', targetUrl);
            return res.status(403).send('Forbidden');
        }

        // 构建缓存键（使用干净的 URL，不包含 _nocache 参数，同时包含 Authorization header 的哈希）
        // 这样不同 token 的请求会有不同的缓存，避免 token 过期导致的 401 缓存问题
        const authHash = getAuthHash(req.headers['authorization']);
        const cacheKey = `${cleanUrl}#${authHash}`;

        console.log('[proxy] 缓存键 (auth hash):', authHash);
        console.log('[proxy] 清理后的 URL (用于缓存):', cleanUrl);

        // 检查缓存（如果需要跳过缓存则不检查）
        // 注意：blob 请求根据配置决定是否使用缓存
        if (!skipCache && !shouldSkipBlobCache) {
            const cached = responseCache.get(cacheKey);
            if (cached) {
                console.log('[Cache] HIT for:', cleanUrl, 'auth:', authHash);
                logToFile(`[Cache] HIT: ${cleanUrl}`);

                // 记录流量（来自缓存）
                recordTraffic(cleanUrl, cached.size, true);

                console.log('[proxy] 从缓存发送响应:', {
                    contentType: cached.contentType,
                    bufferSize: cached.data.length,
                    bufferType: cached.data.constructor.name
                });

                // 打印实际发送的响应头
                console.log('[proxy] 缓存响应头:', JSON.stringify(res.getHeaders()));

                // 使用 res.send() 发送响应（Express 会自动处理 CORS 和 Content-Type）
                res.set('Access-Control-Allow-Origin', '*');
                res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
                res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.set('X-Cache', 'HIT');
                if (cached.contentType) res.set('Content-Type', cached.contentType);

                // 直接发送 buffer
                return res.send(cached.data);
            }
        } else if (shouldSkipBlobCache) {
            if (isBlobRequest) {
                console.log('[Cache] SKIPPED (blob request, disabled by config)');
            } else {
                console.log('[Cache] SKIPPED for:', cleanUrl, '(cache disabled)');
            }
        } else {
            console.log('[Cache] SKIPPED for:', cleanUrl);
        }

        console.log('[Cache] MISS for:', cleanUrl);
        logToFile(`[Cache] MISS: ${cleanUrl}`);

        // 调试：打印收到的所有请求头
        console.log('[proxy] 收到的请求头:', JSON.stringify(req.headers, null, 2));

        // 检查 Authorization header 的内容
        const authHeader = req.headers['authorization'];
        console.log('[proxy] Authorization header:', authHeader ? 'Present' : 'Missing');
        if (authHeader) {
          console.log('[proxy] Authorization type:', authHeader.split(' ')[0]);
          console.log('[proxy] Token length:', authHeader.length);
        }

        // 缓存未命中，发起实际请求
        const headers = {};
        // 注意：Express 会将 header 名称转为小写
        if (req.headers['authorization']) {
            headers['Authorization'] = req.headers['authorization'];
        }
        if (req.headers['accept']) {
            headers['Accept'] = req.headers['accept'];
        }

        const logHeaders = { ...headers };
        if (logHeaders['Authorization']) logHeaders['Authorization'] = 'Bearer ******';
        console.log('[proxy] 发起fetch:', cleanUrl, logHeaders);
        console.log('[proxy] 使用代理:', USE_PROXY ? PROXY_URL : '直连');

        const fetchOptions = {
            headers: {
                'User-Agent': 'docker-download-extension/1.0',
                ...headers
            },
            timeout: 120000, // 120秒超时
            redirect: 'follow' // 跟随重定向
        };
        if (proxyAgent) {
            fetchOptions.agent = proxyAgent;
        }

        const resp = await fetch(cleanUrl, fetchOptions);
        const contentType = resp.headers.get('content-type');
        const contentLength = parseInt(resp.headers.get('content-length') || '0');

        console.log('[proxy] 响应状态:', resp.status, 'content-type:', contentType, 'size:', contentLength);

        // 读取响应数据
        const buffer = await resp.buffer();

        // 缓存策略：
        // 1. 只缓存成功的响应（status === 200）
        // 2. 根据配置决定是否缓存 blob 请求
        // 3. 不缓存过大的响应（限制由CACHE_BLOB_MAX_SIZE控制）
        // 4. 缓存键包含 auth hash，避免 token 问题
        const shouldCache = resp.status === 200 && buffer.length < CACHE_BLOB_MAX_SIZE;

        if (shouldCache) {
            responseCache.set(cacheKey, {
                data: buffer,
                contentType: contentType,
                status: resp.status
            }, buffer.length);

            console.log('[Cache] Cached:', cleanUrl, 'auth:', authHash, 'size:', buffer.length);
        } else if (resp.status !== 200) {
            console.log('[Cache] NOT cached (non-200 response):', resp.status);
        } else if (isBlobRequest) {
            if (!CACHE_BLOB) {
                console.log('[Cache] NOT cached (blob request, disabled by config)');
            } else {
                console.log('[Cache] NOT cached (blob request, too large):', 'size:', buffer.length, 'limit:', CACHE_BLOB_MAX_SIZE);
            }
        }

        // 记录流量（来自网络）
        recordTraffic(cleanUrl, buffer.length, false);

        // 发送响应
        console.log('[proxy] 准备发送响应:', {
            status: resp.status,
            contentType: contentType,
            bufferSize: buffer.length,
            bufferType: buffer.constructor.name
        });

        // 打印实际发送的响应头
        console.log('[proxy] 响应头:', JSON.stringify(res.getHeaders()));

        const duration = Date.now() - startTime;
        console.log('[proxy] 请求完成，耗时:', duration, 'ms');

        // 使用 res.send() 发送响应（Express 会自动处理 CORS 和 Content-Type）
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('X-Cache', 'MISS');
        if (contentType) res.set('Content-Type', contentType);

        // 直接发送 buffer
        res.send(buffer);

    } catch (err) {
        console.error('[proxy] 错误:', err && err.stack ? err.stack : err);
        res.status(500).send(err.message);
    }
});

// ==================== 追踪 API ====================
app.post('/track', async (req, res) => {
    const { image, tag, arch } = req.body;

    console.log('[Tracking] Received:', { image, tag, arch });
    logToFile(`[Tracking] Received: ${image}:${tag} (${arch})`);

    if (!image || !tag) {
        console.error('[Tracking] Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: image, tag' });
    }

    try {
        logTracking({ image, tag, arch });
        console.log('[Tracking] Logged successfully');
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Tracking] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 流量统计 API ====================
app.get('/api/traffic-stats', (req, res) => {
    try {
        res.json({
            ...trafficStats,
            uptime: Math.floor((Date.now() - new Date(trafficStats.startTime).getTime()) / 1000),
            cacheHitRate: trafficStats.cacheHits + trafficStats.cacheMisses > 0
                ? ((trafficStats.cacheHits / (trafficStats.cacheHits + trafficStats.cacheMisses)) * 100).toFixed(2) + '%'
                : '0%'
        });
    } catch (err) {
        console.error('[Traffic Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 缓存管理 API ====================
app.get('/api/cache-stats', (req, res) => {
    try {
        const stats = responseCache.getStats();
        res.json(stats);
    } catch (err) {
        console.error('[Cache Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/cache-entries', (req, res) => {
    try {
        const entries = responseCache.getEntries();
        res.json(entries);
    } catch (err) {
        console.error('[Cache Entries API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/cache-clear', (req, res) => {
    try {
        responseCache.clear();
        console.log('[Cache] Cleared');
        res.json({ success: true, message: 'Cache cleared' });
    } catch (err) {
        console.error('[Cache Clear API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 追踪统计 API ====================
app.get('/api/tracking-stats', (req, res) => {
    try {
        if (!fs.existsSync(TRACKING_LOG_PATH)) {
            return res.json({ total: 0, unique: 0, data: [] });
        }

        const logs = fs.readFileSync(TRACKING_LOG_PATH, 'utf-8')
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        const stats = {};
        const archStats = {};
        const dailyStats = {};

        logs.forEach(log => {
            const key = `${log.image}:${log.tag}`;
            if (!stats[key]) {
                stats[key] = { count: 0, archs: new Set(), firstSeen: log.timestamp, lastSeen: log.timestamp };
            }
            stats[key].count++;
            stats[key].archs.add(log.arch || 'unknown');
            if (log.timestamp > stats[key].lastSeen) {
                stats[key].lastSeen = log.timestamp;
            }

            const arch = log.arch || 'unknown';
            archStats[arch] = (archStats[arch] || 0) + 1;

            const date = log.timestamp.split('T')[0];
            dailyStats[date] = (dailyStats[date] || 0) + 1;
        });

        const data = Object.entries(stats)
            .map(([key, value]) => ({
                image: key,
                count: value.count,
                archs: Array.from(value.archs),
                firstSeen: value.firstSeen,
                lastSeen: value.lastSeen
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);

        res.json({
            total: logs.length,
            unique: Object.keys(stats).length,
            data,
            archStats,
            dailyStats
        });
    } catch (err) {
        console.error('[Stats API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 静态文件服务 ====================
app.get('/dashboard', (req, res) => {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
    } else {
        res.status(404).send('Dashboard not found');
    }
});

app.get('/traffic-dashboard', (req, res) => {
    const dashboardPath = path.join(__dirname, 'traffic-dashboard.html');
    if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
    } else {
        res.status(404).send('Traffic dashboard not found');
    }
});

// ==================== 启动服务器 ====================
const PORT = 7000;
app.listen(PORT, () => {
    console.log(`Proxy server running at http://localhost:${PORT}`);
    console.log(`\n网络配置:`);
    console.log(`  - 代理模式: ${USE_PROXY ? '已启用' : '已禁用（直连）'}`);
    if (USE_PROXY) {
        console.log(`  - 代理地址: ${PROXY_URL}`);
    }
    console.log(`\n功能列表:`);
    console.log(`  - Traffic statistics: /api/traffic-stats`);
    console.log(`  - Cache management: /api/cache-stats, /api/cache-entries, /api/cache-clear`);
    console.log(`  - Tracking: /api/tracking-stats`);
    console.log(`  - Dashboard: /dashboard`);
    console.log(`  - Traffic Dashboard: /traffic-dashboard`);
    console.log(`\n缓存配置:`);
    console.log(`  - Max items: ${responseCache.maxSize}`);
    console.log(`  - Max size: ${(responseCache.maxBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`\n提示: 通过环境变量控制代理`);
    console.log(`  启用代理: USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 node service.js`);
    console.log(`  禁用代理: node service.js`);
});
