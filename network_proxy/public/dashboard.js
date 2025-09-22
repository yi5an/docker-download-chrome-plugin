// Dashboard JavaScript for Docker Proxy Monitor
class ProxyDashboard {
    constructor() {
        this.baseUrl = window.location.origin;
        this.dailyChart = null;
        this.hourlyChart = null;
        this.init();
    }

    async init() {
        // 设置今天的日期
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('date-picker').value = today;

        // 加载初始数据
        await this.loadAllData();

        // 设置定时刷新
        setInterval(() => this.loadAllData(), 30000); // 30秒刷新一次
    }

    async loadAllData() {
        try {
            await Promise.all([
                this.loadServerStatus(),
                this.loadOverallStats(),
                this.loadDailyChart(),
                this.loadHourlyChart()
            ]);
        } catch (error) {
            console.error('加载数据失败:', error);
        }
    }

    async loadServerStatus() {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            const data = await response.json();

            const statusHtml = `
                <div class="stat-item">
                    <span class="stat-label">
                        <span class="status-indicator ${data.status === 'ok' ? 'status-online' : 'status-offline'}"></span>
                        服务状态
                    </span>
                    <span class="stat-value ${data.status === 'ok' ? 'success' : 'error'}">
                        ${data.status === 'ok' ? '运行中' : '离线'}
                    </span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">版本</span>
                    <span class="stat-value">${data.version}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">缓存功能</span>
                    <span class="stat-value ${data.features.cache ? 'success' : 'warning'}">
                        ${data.features.cache ? '已启用' : '已禁用'}
                    </span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">统计功能</span>
                    <span class="stat-value ${data.features.stats ? 'success' : 'warning'}">
                        ${data.features.stats ? '已启用' : '已禁用'}
                    </span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">更新时间</span>
                    <span class="stat-value">${new Date(data.timestamp).toLocaleString()}</span>
                </div>
            `;

            document.getElementById('server-status').innerHTML = statusHtml;
        } catch (error) {
            document.getElementById('server-status').innerHTML =
                '<div class="error">无法连接到服务器</div>';
        }
    }

    async loadOverallStats() {
        try {
            const response = await fetch(`${this.baseUrl}/stats`);
            const data = await response.json();

            const totalImages = Object.keys(data.imageStats || {}).length;
            const totalDays = Object.keys(data.dailyStats || {}).length;

            const overallHtml = `
                <div class="stat-item">
                    <span class="stat-label">总下载次数</span>
                    <span class="stat-value info">${data.totalDownloads || 0}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">不同镜像数量</span>
                    <span class="stat-value">${totalImages}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">活跃天数</span>
                    <span class="stat-value">${totalDays}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">缓存命中率</span>
                    <span class="stat-value success">
                        ${this.calculateHitRate(data.cacheStats)}%
                    </span>
                </div>
            `;

            document.getElementById('overall-stats').innerHTML = overallHtml;

            // 更新缓存统计
            const cacheHtml = `
                <div class="stat-item">
                    <span class="stat-label">缓存命中</span>
                    <span class="stat-value success">${data.cacheStats.hits || 0}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">缓存未命中</span>
                    <span class="stat-value warning">${data.cacheStats.misses || 0}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">缓存大小</span>
                    <span class="stat-value">${this.formatBytes(data.cacheStats.totalSize || 0)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">缓存文件数</span>
                    <span class="stat-value">${data.cacheStats.fileCount || 0}</span>
                </div>
            `;

            document.getElementById('cache-stats').innerHTML = cacheHtml;

            // 更新今日统计
            const today = new Date().toISOString().split('T')[0];
            const todayData = data.dailyStats[today] || {
                downloads: 0,
                totalSize: 0,
                uniqueImages: []
            };

            const todayHtml = `
                <div class="stat-item">
                    <span class="stat-label">今日下载</span>
                    <span class="stat-value info">${todayData.downloads}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">今日流量</span>
                    <span class="stat-value">${this.formatBytes(todayData.totalSize || 0)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">不同镜像</span>
                    <span class="stat-value">${todayData.uniqueImages.length || 0}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">平均单次大小</span>
                    <span class="stat-value">
                        ${todayData.downloads > 0 ?
                            this.formatBytes((todayData.totalSize || 0) / todayData.downloads) :
                            '0 B'}
                    </span>
                </div>
            `;

            document.getElementById('today-stats').innerHTML = todayHtml;

        } catch (error) {
            document.getElementById('overall-stats').innerHTML =
                '<div class="error">加载统计数据失败</div>';
        }
    }

    async loadDailyChart() {
        try {
            const days = document.getElementById('days-range').value;
            const response = await fetch(`${this.baseUrl}/api/daily-stats?days=${days}`);
            const data = await response.json();

            if (this.dailyChart) {
                this.dailyChart.destroy();
            }

            const ctx = document.getElementById('daily-chart').getContext('2d');
            this.dailyChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.map(d => this.formatDate(d.date)),
                    datasets: [{
                        label: '下载次数',
                        data: data.map(d => d.downloads),
                        borderColor: 'rgb(102, 126, 234)',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        yAxisID: 'y'
                    }, {
                        label: '流量大小 (MB)',
                        data: data.map(d => (d.totalSize / 1024 / 1024).toFixed(2)),
                        borderColor: 'rgb(118, 75, 162)',
                        backgroundColor: 'rgba(118, 75, 162, 0.1)',
                        yAxisID: 'y1'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    scales: {
                        x: {
                            display: true,
                            title: {
                                display: true,
                                text: '日期'
                            }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: {
                                display: true,
                                text: '下载次数'
                            }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: {
                                display: true,
                                text: '流量 (MB)'
                            },
                            grid: {
                                drawOnChartArea: false,
                            },
                        }
                    }
                }
            });
        } catch (error) {
            console.error('加载每日图表失败:', error);
        }
    }

    async loadHourlyChart() {
        try {
            const date = document.getElementById('date-picker').value;
            const response = await fetch(`${this.baseUrl}/api/hourly-stats?date=${date}`);
            const data = await response.json();

            if (this.hourlyChart) {
                this.hourlyChart.destroy();
            }

            const ctx = document.getElementById('hourly-chart').getContext('2d');
            this.hourlyChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data.map(d => `${d.hour}:00`),
                    datasets: [{
                        label: '下载次数',
                        data: data.map(d => d.downloads),
                        backgroundColor: 'rgba(102, 126, 234, 0.8)',
                        yAxisID: 'y'
                    }, {
                        label: '流量大小 (MB)',
                        data: data.map(d => (d.totalSize / 1024 / 1024).toFixed(2)),
                        backgroundColor: 'rgba(118, 75, 162, 0.8)',
                        yAxisID: 'y1'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            title: {
                                display: true,
                                text: '小时'
                            }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: {
                                display: true,
                                text: '下载次数'
                            }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: {
                                display: true,
                                text: '流量 (MB)'
                            },
                            grid: {
                                drawOnChartArea: false,
                            },
                        }
                    }
                }
            });
        } catch (error) {
            console.error('加载小时图表失败:', error);
        }
    }

    calculateHitRate(cacheStats) {
        const total = (cacheStats.hits || 0) + (cacheStats.misses || 0);
        if (total === 0) return 0;
        return Math.round((cacheStats.hits / total) * 100);
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatDate(dateStr) {
        const date = new Date(dateStr);
        return `${date.getMonth() + 1}/${date.getDate()}`;
    }

    async calculateCost() {
        try {
            const pricePerGB = parseFloat(document.getElementById('price-per-gb').value) || 0;
            const baseCost = parseFloat(document.getElementById('base-cost').value) || 0;
            const period = document.getElementById('cost-period').value;

            const response = await fetch(`${this.baseUrl}/stats`);
            const data = await response.json();

            let totalSize = 0;
            let downloads = 0;
            let periodText = '';

            const now = new Date();

            switch (period) {
                case 'today':
                    const today = now.toISOString().split('T')[0];
                    const todayData = data.dailyStats[today] || {};
                    totalSize = todayData.totalSize || 0;
                    downloads = todayData.downloads || 0;
                    periodText = '今日';
                    break;

                case 'week':
                    for (let i = 0; i < 7; i++) {
                        const date = new Date(now);
                        date.setDate(date.getDate() - i);
                        const dateStr = date.toISOString().split('T')[0];
                        const dayData = data.dailyStats[dateStr] || {};
                        totalSize += dayData.totalSize || 0;
                        downloads += dayData.downloads || 0;
                    }
                    periodText = '本周';
                    break;

                case 'month':
                    for (let i = 0; i < 30; i++) {
                        const date = new Date(now);
                        date.setDate(date.getDate() - i);
                        const dateStr = date.toISOString().split('T')[0];
                        const dayData = data.dailyStats[dateStr] || {};
                        totalSize += dayData.totalSize || 0;
                        downloads += dayData.downloads || 0;
                    }
                    periodText = '本月';
                    break;
            }

            const totalGB = totalSize / (1024 * 1024 * 1024);
            const trafficCost = totalGB * pricePerGB;
            let periodBaseCost = baseCost;

            if (period === 'today') {
                periodBaseCost = baseCost / 30; // 每日基础成本
            } else if (period === 'week') {
                periodBaseCost = baseCost / 4.33; // 每周基础成本
            }

            const totalCost = trafficCost + periodBaseCost;

            const resultHtml = `
                <h4>💰 ${periodText}成本分析</h4>
                <div class="stat-item">
                    <span class="stat-label">总流量</span>
                    <span class="stat-value">${this.formatBytes(totalSize)} (${totalGB.toFixed(3)} GB)</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">下载次数</span>
                    <span class="stat-value">${downloads}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">流量费用</span>
                    <span class="stat-value">¥${trafficCost.toFixed(2)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">${periodText}基础费用</span>
                    <span class="stat-value">¥${periodBaseCost.toFixed(2)}</span>
                </div>
                <div class="stat-item" style="border-top: 2px solid #667eea; margin-top: 10px; padding-top: 15px;">
                    <span class="stat-label"><strong>总成本</strong></span>
                    <span class="stat-value" style="font-size: 1.3em; color: #667eea;"><strong>¥${totalCost.toFixed(2)}</strong></span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">平均每次下载成本</span>
                    <span class="stat-value">¥${downloads > 0 ? (totalCost / downloads).toFixed(4) : '0.00'}</span>
                </div>
            `;

            const resultDiv = document.getElementById('cost-result');
            resultDiv.innerHTML = resultHtml;
            resultDiv.style.display = 'block';

        } catch (error) {
            console.error('计算成本失败:', error);
            document.getElementById('cost-result').innerHTML =
                '<div class="error">计算成本失败，请检查网络连接</div>';
            document.getElementById('cost-result').style.display = 'block';
        }
    }

    async clearCache() {
        if (!confirm('确定要清理过期缓存吗？')) {
            return;
        }

        try {
            const response = await fetch(`${this.baseUrl}/cache/clear`, {
                method: 'POST'
            });

            if (response.ok) {
                alert('缓存清理成功！');
                await this.loadAllData();
            } else {
                alert('缓存清理失败！');
            }
        } catch (error) {
            console.error('清理缓存失败:', error);
            alert('清理缓存失败！');
        }
    }
}

// 全局函数
async function refreshData() {
    if (window.dashboard) {
        await window.dashboard.loadAllData();
    }
}

async function clearCache() {
    if (window.dashboard) {
        await window.dashboard.clearCache();
    }
}

async function calculateCost() {
    if (window.dashboard) {
        await window.dashboard.calculateCost();
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new ProxyDashboard();

    // 绑定事件
    document.getElementById('date-picker').addEventListener('change', () => {
        window.dashboard.loadHourlyChart();
    });

    document.getElementById('days-range').addEventListener('change', () => {
        window.dashboard.loadDailyChart();
    });
});