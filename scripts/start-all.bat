@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 同时启动 Picai 前后端...
start "Picai 后端" cmd /k "%~dp0start-backend.bat"
timeout /t 3 /nobreak >nul
start "Picai 前端" cmd /k "%~dp0start-frontend.bat"
echo 已启动。浏览器访问 http://localhost:5173
