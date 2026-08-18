@echo off
chcp 65001 >nul
title DeepSeek 文章修改助手
echo ==========================================
echo   DeepSeek 文章修改助手 - 本地服务模式
echo   即将在 127.0.0.1:7070 启动，并打开浏览器
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/ 下载 LTS 版
    pause
    exit /b 1
)
start "" "http://127.0.0.1:7070"
node server.js
pause
