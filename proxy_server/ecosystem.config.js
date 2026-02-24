module.exports = {
    apps: [{
      name: 'docker-download-proxy',
      script: 'service.js',
      env: {
        USE_PROXY: 'true',
        PROXY_URL: 'http://127.0.0.1:7890'
      }
    }]
  }
