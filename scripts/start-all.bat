@echo off
rem 注意：本文件为 GBK 编码，请勿另存为 UTF-8
cd /d "%~dp0"
echo 同时启动 Picai 前后端...
start "Picai 后端 - 关闭此窗口可停止服务" cmd /k ""%~dp0start-backend.bat""
ping -n 3 127.0.0.1 >nul
start "Picai 前端 - 关闭此窗口可停止服务" cmd /k ""%~dp0start-frontend.bat""
echo 已启动。浏览器访问 http://localhost:5173
pause
