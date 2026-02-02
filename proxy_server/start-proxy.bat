@echo off
echo ========================================
echo  Starting Docker Proxy Server (Proxy Mode)
echo ========================================
echo.
echo Mode: Through Proxy (127.0.0.1:7890)
echo Port: 7000
echo.
echo Please make sure your proxy (Clash/V2Ray) is running at 127.0.0.1:7890
echo.
cd /d "%~dp0"
set USE_PROXY=true
set PROXY_URL=http://127.0.0.1:7890
node service.js
pause
