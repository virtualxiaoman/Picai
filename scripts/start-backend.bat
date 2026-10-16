@echo off
chcp 65001 >nul
cd /d "%~dp0..\backend"
echo 启动 Picai 后端 (http://127.0.0.1:8000) ...
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
