@echo off
chcp 65001 >nul
cd /d "%~dp0..\frontend"
echo 启动 Picai 前端 (http://localhost:5173) ...
npm run dev
pause
