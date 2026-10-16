@echo off
rem 注意：本文件为 GBK 编码，请勿另存为 UTF-8
cd /d "%~dp0..\frontend"
echo 启动 Picai 前端 http://localhost:5173 ...
npm run dev
pause
