const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'downloads.json');

app.use(cors());
app.use(bodyParser.json());

// 初始化數據文件
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ total: 0, details: [] }, null, 2));
}

app.post('/api/track', (req, res) => {
    const { image, tag, arch } = req.body;

    if (!image || !tag || !arch) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        data.total += 1;
        data.details.push({
            image,
            tag,
            arch,
            timestamp: new Date().toISOString(),
            ip: req.ip
        });

        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`[Track] Downloaded: ${image}:${tag} (${arch})`);
        res.json({ success: true, count: data.total });
    } catch (err) {
        console.error('Failed to save tracking data:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`Tracking server running at http://localhost:${PORT}`);
});
