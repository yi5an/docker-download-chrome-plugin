const fetch = require('node-fetch');
const express = require('express');
const app = express();
const { HttpsProxyAgent } = require('https-proxy-agent');
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:7890'); // 你的本地代理地址


const fs = require('fs');
const path = require('path');

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

app.use(express.json());

// 允许所有跨域
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// 代理 GET 请求
app.get('/proxy', async (req, res) => {
    // 强制把 query 参数取出来，防止 express 解析 query 时被 & 截断 (虽然 url 应该是 encodeURIComponent 过的)
    // 最好直接从 query 中取，如果有问题再手动解析
    const targetUrl = req.query.url;

    console.log('[proxy] 原始请求:', req.originalUrl);
    console.log('[proxy] 解析目标:', targetUrl);
    logToFile(`[Request] Original: ${req.originalUrl}`);
    logToFile(`[Request] Target: ${targetUrl}`);

    if (!targetUrl) {
        console.error('[proxy] 缺少url参数');
        return res.status(400).send('Missing url param');
    }
    try {
        // 白名单：允许 Docker Registry 及其 CDN（包括 Cloudflare R2）
        if (!/^https:\/\/((registry-1|auth)\.docker\.io|docker-images-prod\..*\.r2\.cloudflarestorage\.com|production\.cloudflare\.docker\.com)\//.test(targetUrl)) {
            console.error('[proxy] 非法目标:', targetUrl);
            return res.status(403).send('Forbidden');
        }
        const headers = {};
        if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
        if (req.headers['accept']) headers['accept'] = req.headers['accept'];

        const logHeaders = { ...headers };
        if (logHeaders['authorization']) logHeaders['authorization'] = 'Bearer ******';
        console.log('[proxy] 发起fetch:', targetUrl, logHeaders);
        const resp = await fetch(targetUrl, { headers, agent: proxyAgent });
        const contentType = resp.headers.get('content-type');
        console.log('[proxy] 响应状态:', resp.status, 'content-type:', contentType);
        res.status(resp.status);
        if (contentType) res.set('content-type', contentType);
        resp.body.pipe(res);
    } catch (err) {
        console.error('[proxy] 错误:', err && err.stack ? err.stack : err);
        res.status(500).send(err.message);
    }
});

// 追踪 API 接口（接收下载统计）
app.post('/track', async (req, res) => {
    const { image, tag, arch } = req.body;

    console.log('[Tracking] Received:', { image, tag, arch });
    logToFile(`[Tracking] Received: ${image}:${tag} (${arch})`);

    if (!image || !tag) {
        console.error('[Tracking] Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: image, tag' });
    }

    try {
        // 记录到本地日志文件
        logTracking({ image, tag, arch });

        // 如果配置了远程追踪服务器，则转发
        // 注意：这里需要配置您实际的追踪服务器地址
        // const remoteTrackingUrl = 'http://123.57.165.38:3000/api/track';
        // if (remoteTrackingUrl) {
        //     await fetch(remoteTrackingUrl, {
        //         method: 'POST',
        //         headers: { 'Content-Type': 'application/json' },
        //         body: JSON.stringify({ image, tag, arch })
        //     });
        // }

        console.log('[Tracking] Logged successfully');
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Tracking] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 追踪统计 API 接口
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

        // 统计
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

            // 架构统计
            const arch = log.arch || 'unknown';
            archStats[arch] = (archStats[arch] || 0) + 1;

            // 日期统计
            const date = log.timestamp.split('T')[0];
            dailyStats[date] = (dailyStats[date] || 0) + 1;
        });

        // 转换为数组并排序
        const data = Object.entries(stats)
            .map(([key, value]) => ({
                image: key,
                count: value.count,
                archs: Array.from(value.archs),
                firstSeen: value.firstSeen,
                lastSeen: value.lastSeen
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50); // 只返回前50个

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

// 静态文件服务
app.get('/dashboard', (req, res) => {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
    } else {
        res.status(404).send('Dashboard not found. Please create dashboard.html');
    }
});

// 代理 POST/PUT/DELETE 可按需扩展

const PORT = 7000;
app.listen(PORT, () => {
    console.log(`Proxy server running at http://localhost:${PORT}`);
});