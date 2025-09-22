const fetch = require('node-fetch');

const PROXY_BASE = 'http://localhost:7000';

// 测试用例
const testCases = [
  {
    name: '健康检查',
    url: `${PROXY_BASE}/health`,
    expected: 'ok'
  },
  {
    name: '获取Docker Token',
    url: `${PROXY_BASE}/proxy?url=${encodeURIComponent('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/hello-world:pull')}`,
    expected: 'token'
  },
  {
    name: '获取Manifest',
    url: `${PROXY_BASE}/proxy?url=${encodeURIComponent('https://registry-1.docker.io/v2/library/hello-world/manifests/latest')}`,
    headers: {
      'Accept': 'application/vnd.docker.distribution.manifest.v2+json'
    },
    expected: 'manifest'
  },
  {
    name: '统计信息',
    url: `${PROXY_BASE}/stats`,
    expected: 'stats'
  }
];

async function runTests() {
  console.log('🧪 开始测试Docker代理服务器...\n');

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testCases.length; i++) {
    const test = testCases[i];
    console.log(`${i + 1}. 测试: ${test.name}`);

    try {
      const response = await fetch(test.url, {
        headers: test.headers || {}
      });

      if (response.ok) {
        const data = await response.text();
        console.log(`   ✅ 成功 (${response.status})`);

        if (test.expected === 'stats') {
          const stats = JSON.parse(data);
          console.log(`   📊 总下载: ${stats.totalDownloads}, 缓存命中: ${stats.cacheStats.hits}`);
        } else if (test.expected === 'ok') {
          const health = JSON.parse(data);
          console.log(`   🚀 状态: ${health.status}, 版本: ${health.version}`);
        } else if (test.expected === 'token') {
          const token = JSON.parse(data);
          console.log(`   🔑 Token获取成功 (${token.token ? '有效' : '无效'})`);
        } else if (test.expected === 'manifest') {
          console.log(`   📋 Manifest获取成功 (${data.length} bytes)`);
        }

        passed++;
      } else {
        console.log(`   ❌ 失败 (${response.status}): ${response.statusText}`);
        failed++;
      }
    } catch (error) {
      console.log(`   ❌ 错误: ${error.message}`);
      failed++;
    }

    console.log('');
  }

  console.log(`📊 测试结果: ${passed}个通过, ${failed}个失败`);

  if (failed === 0) {
    console.log('🎉 所有测试通过！代理服务器工作正常。');
  } else {
    console.log('⚠️  部分测试失败，请检查服务器状态。');
  }
}

// 检查服务器是否运行
async function checkServer() {
  try {
    const response = await fetch(`${PROXY_BASE}/health`);
    if (response.ok) {
      console.log('✅ 代理服务器正在运行\n');
      return true;
    }
  } catch (error) {
    console.log('❌ 代理服务器未启动，请先运行: npm start');
    console.log('   或使用启动脚本: start.bat (Windows) 或 start.sh (Linux/Mac)\n');
    return false;
  }
}

async function main() {
  console.log('🔍 检查代理服务器状态...');

  if (await checkServer()) {
    await runTests();
  }
}

main().catch(console.error);