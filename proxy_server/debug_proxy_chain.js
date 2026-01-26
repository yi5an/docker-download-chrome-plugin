const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = 'http://127.0.0.1:7890';
console.log('Using proxy:', proxyUrl);
const agent = new HttpsProxyAgent(proxyUrl);

// 1. Test Auth URL (Token fetch)
const authUrl = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:tensorflow/tensorflow:pull';

async function test() {
    console.log('--- Testing Auth URL ---');
    try {
        const resp = await fetch(authUrl, { agent });
        console.log('Status:', resp.status);
        if (resp.status !== 200) {
            console.log('Body:', await resp.text());
        } else {
            const data = await resp.json();
            console.log('Token received (length):', data.token.length);

            // 2. Test Manifest URL
            console.log('\n--- Testing Manifest URL for nightly-jupyter ---');
            const manifestUrl = 'https://registry-1.docker.io/v2/tensorflow/tensorflow/manifests/nightly-jupyter';
            const resp2 = await fetch(manifestUrl, {
                headers: {
                    'Authorization': `Bearer ${data.token}`,
                    'Accept': 'application/vnd.docker.distribution.manifest.v2+json'
                },
                agent
            });
            console.log('Status:', resp2.status);
            if (resp2.status !== 200) {
                console.log('Body:', await resp2.text());
            } else {
                console.log('Manifest received!');
            }
        }
    } catch (err) {
        console.error('Error:', err);
    }
}

test();
