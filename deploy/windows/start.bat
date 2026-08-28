@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem AI 中转站 Windows 一键部署脚本
rem 用法: start.bat（双击运行或命令行执行）
rem 前置: 已安装 Node.js >= 18 (https://nodejs.org)

set "ROOT=%~dp0.."

rem 检查项目是否存在，不存在则克隆
if exist "%ROOT%\server\package.json" goto :project_ready
echo [start] 未检测到项目文件，正在从 GitHub 克隆...
if not exist "%ROOT%" mkdir "%ROOT%"
if not exist "%ROOT%\.git" (
  git clone --depth 1 https://github.com/wyhc7/ai-gateway.git "%ROOT%"
  if errorlevel 1 (
    echo [ERROR] 克隆失败，请检查网络或手动下载: https://github.com/wyhc7/ai
    exit /b 1
  )
  echo [start] 项目已克隆到 %ROOT%
)

:found_ready
cd /d "%ROOT%"

if not exist "server\node_modules" (
  echo [start] 安装后端依赖...
  call npm install --prefix server --omit=dev
  if errorlevel 1 goto :error
)

if not exist "web\node_modules" (
  echo [start] 安装前端依赖...
  call npm install --prefix web
  if errorlevel 1 goto :error
)

echo [start] 构建前端...
call npm run build --prefix web
if errorlevel 1 goto :error

echo [start] 启动服务 (端口 3001)...
echo   管理界面: http://localhost:3001
echo   API 端点: http://localhost:3001/api/v1
echo   按 Ctrl+C 停止
echo.
call node server\index.js

goto :eof

:error
echo [ERROR] 步骤失败，请检查后重试。
pause
exit /b 1