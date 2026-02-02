@echo off
echo ========================================
echo  Starting Docker Proxy Server (Direct Mode)
echo ========================================
echo.
echo Mode: Direct Connection (No Proxy)
echo Port: 7000
echo.
cd /d "%~dp0"
node service.js
pause
