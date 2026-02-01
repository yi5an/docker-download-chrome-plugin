const fetch = require('node-fetch');
const express = require('express');
const app = express();
const { HttpsProxyAgent } = require('https-proxy-agent');
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:7890'); // 你的本地代理地址


const fs = require('fs');

function logToFile(msg) {
    fs.appendFileSync('debug.log', new Date().toISOString() + ' ' + msg + '\n');
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

// 代理 POST/PUT/DELETE 可按需扩展

const PORT = 7000;
app.listen(PORT, () => {
    console.log(`Proxy server running at http://localhost:${PORT}`);
});