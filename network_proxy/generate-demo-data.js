// 演示数据生成器
const fs = require('fs-extra');
const path = require('path');

async function generateDemoData() {
    const statsFile = path.join(__dirname, 'download-stats.json');

    // 生成模拟的统计数据
    const demoStats = {
        totalDownloads: 0,
        imageStats: {},
        dailyStats: {},
        cacheStats: {
            hits: 0,
            misses: 0,
            totalSize: 0
        }
    };

    const images = [
        'library/nginx:latest:amd64',
        'library/ubuntu:20.04:amd64',
        'library/redis:7.0:amd64',
        'library/postgres:15:amd64',
        'library/node:18:amd64',
        'library/python:3.11:amd64',
        'library/mysql:8.0:amd64',
        'library/alpine:latest:amd64'
    ];

    // 生成最近30天的数据
    for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        const dailyDownloads = Math.floor(Math.random() * 50) + 10; // 10-60次下载
        const dailySize = Math.floor(Math.random() * 5000000000) + 1000000000; // 1-6GB

        demoStats.dailyStats[dateStr] = {
            downloads: dailyDownloads,
            uniqueImages: new Set(),
            totalSize: dailySize,
            hourlyStats: {}
        };

        // 生成24小时数据
        for (let hour = 0; hour < 24; hour++) {
            const hourlyDownloads = Math.floor(Math.random() * 5);
            const hourlySize = Math.floor(Math.random() * 200000000); // 0-200MB

            if (hourlyDownloads > 0) {
                demoStats.dailyStats[dateStr].hourlyStats[hour] = {
                    downloads: hourlyDownloads,
                    totalSize: hourlySize
                };
            }
        }

        demoStats.totalDownloads += dailyDownloads;

        // 随机选择镜像
        const usedImages = Math.floor(Math.random() * 5) + 2; // 2-6个不同镜像
        for (let j = 0; j < usedImages; j++) {
            const image = images[Math.floor(Math.random() * images.length)];
            demoStats.dailyStats[dateStr].uniqueImages.add(image);

            // 更新镜像统计
            if (!demoStats.imageStats[image]) {
                demoStats.imageStats[image] = {
                    downloads: 0,
                    totalSize: 0,
                    firstDownload: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
                    lastDownload: new Date().toISOString()
                };
            }

            const imageDownloads = Math.floor(dailyDownloads / usedImages);
            const imageSize = Math.floor(dailySize / usedImages);

            demoStats.imageStats[image].downloads += imageDownloads;
            demoStats.imageStats[image].totalSize += imageSize;
            demoStats.imageStats[image].lastDownload = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();
        }

        // 转换Set为Array
        demoStats.dailyStats[dateStr].uniqueImages = Array.from(demoStats.dailyStats[dateStr].uniqueImages);
    }

    // 生成缓存统计
    demoStats.cacheStats.hits = Math.floor(demoStats.totalDownloads * 0.75);
    demoStats.cacheStats.misses = demoStats.totalDownloads - demoStats.cacheStats.hits;
    demoStats.cacheStats.totalSize = Math.floor(Math.random() * 10000000000) + 5000000000; // 5-15GB

    // 保存数据
    await fs.writeJson(statsFile, demoStats, { spaces: 2 });

    console.log('🎭 演示数据生成完成！');
    console.log(`📊 总下载次数: ${demoStats.totalDownloads}`);
    console.log(`📦 不同镜像: ${Object.keys(demoStats.imageStats).length}`);
    console.log(`📅 数据天数: ${Object.keys(demoStats.dailyStats).length}`);
    console.log(`💾 缓存命中率: ${Math.round((demoStats.cacheStats.hits / demoStats.totalDownloads) * 100)}%`);
    console.log('');
    console.log('🌐 现在可以访问 http://localhost:7000 查看监控面板！');
}

// 运行生成器
if (require.main === module) {
    generateDemoData().catch(console.error);
}

module.exports = generateDemoData;