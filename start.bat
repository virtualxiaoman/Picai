@echo off
rem ========================================================
rem  Picai 启动脚本（Windows）
rem  注意：本文件与 scripts 目录下的 .bat 均为 GBK 编码
rem  （中文 Windows 命令行默认代码页 936），请勿另存为
rem  UTF-8，否则中文会被拆断导致脚本解析错误。
rem ========================================================
setlocal
cd /d "%~dp0"

echo ============================================
echo   Picai 本地 AI 图片编辑 - 启动脚本
echo ============================================
echo.

rem ---------- 依赖检查 ----------
if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到 Python 虚拟环境 .venv
    echo        请先按 README 创建环境并安装依赖。
    pause
    exit /b 1
)
if not exist "frontend\node_modules" (
    echo [错误] 未找到前端依赖 frontend\node_modules
    echo        请先执行: cd frontend 然后 npm install
    pause
    exit /b 1
)

rem ---------- 后端 ----------
curl -s -m 2 -o nul http://127.0.0.1:8000/api/health 2>nul
if %errorlevel%==0 (
    echo [提示] 后端已在运行 http://127.0.0.1:8000
) else (
    echo 正在启动后端，新窗口...
    start "Picai 后端 - 关闭此窗口可停止服务" cmd /k ""%~dp0scripts\start-backend.bat""
)

rem ---------- 前端 ----------
curl -s -m 2 -o nul http://localhost:5173 2>nul
if %errorlevel%==0 (
    echo [提示] 前端已在运行 http://localhost:5173
) else (
    echo 正在启动前端，新窗口...
    start "Picai 前端 - 关闭此窗口可停止服务" cmd /k ""%~dp0scripts\start-frontend.bat""
)

rem ---------- 等待前端就绪，最多约 60 秒 ----------
echo.
echo 等待前端就绪...
set /a tries=0
:waitloop
curl -s -m 1 -o nul http://localhost:5173 2>nul
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% GEQ 30 goto timeout
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
echo.
echo ============================================
echo   启动完成！请在浏览器中打开:
echo.
echo       前端应用:  http://localhost:5173
echo       后端 API:  http://127.0.0.1:8000/api/health
echo ============================================
echo.
echo 提示: 后端与前端各运行在一个独立窗口中，
echo       关闭对应窗口即可停止对应服务。
echo.
pause
exit /b 0

:timeout
echo.
echo [警告] 等待前端超时，约 60 秒。
echo        请查看标题为 Picai 前端的窗口中的错误信息。
echo        若其实已启动成功，可直接访问: http://localhost:5173
echo.
pause
exit /b 1
