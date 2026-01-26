// Native fetch is available in Node 20+
// I generally assume modern node in this environment, but if not I'll handle it.
// Actually, `run_command` environment usually has some node.
// safe to assume fetch is available in node 18+.

const DEFAULT_PROXY_BASE = 'http://123.57.165.38:7000/proxy?url=';
const TEST_URL = 'https://www.google.com';

async function testProxy() {
    const finalUrl = DEFAULT_PROXY_BASE + encodeURIComponent(TEST_URL);
    console.log(`Testing proxy url: ${finalUrl}`);
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, 5000); // 5 sec timeout

        const resp = await fetch(finalUrl, { signal: controller.signal });
        clearTimeout(timeout);

        console.log(`Status: ${resp.status}`);
        if (resp.ok) {
            console.log('Proxy is working!');
            // console.log(await resp.text());
        } else {
            console.error('Proxy request failed with status:', resp.status);
            console.error(await resp.text());
        }
    } catch (err) {
        console.error('Proxy request failed:', err.message);
    }
}

testProxy();
