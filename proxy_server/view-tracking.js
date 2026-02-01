#!/usr/bin/env node
// 查看追踪统计日志

const fs = require('fs');
const path = require('path');

const TRACKING_LOG_PATH = path.join(__dirname, 'tracking.log');

if (!fs.existsSync(TRACKING_LOG_PATH)) {
    console.log('暂无追踪记录');
    process.exit(0);
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

if (logs.length === 0) {
    console.log('暂无追踪记录');
    process.exit(0);
}

// 统计
const stats = {};
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
});

console.log('\n📊 Docker 镜像下载统计\n');
console.log(`总下载次数: ${logs.length}`);
console.log(`不同镜像数: ${Object.keys(stats).length}\n`);

Object.entries(stats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .forEach(([key, data]) => {
        const archs = Array.from(data.archs).join(', ');
        console.log(`  ${key}`);
        console.log(`    下载次数: ${data.count} | 架构: ${archs}`);
        console.log(`    首次: ${data.firstSeen}`);
        console.log(`    最近: ${data.lastSeen}\n`);
    });

console.log(`\n📝 详细日志文件: ${TRACKING_LOG_PATH}`);
