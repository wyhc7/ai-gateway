@echo off
chcp 65001 >nul
title ChatGPT2API 本机一键部署（需 Docker Desktop）
setlocal EnableDelayedExpansion

REM ========= 配置区（按需修改）=========
set "REPO=https://github.com/basketikun/chatgpt2api.git"
set "DIR=%~dp0chatgpt2api"
REM chatgpt2api 的管理密钥（AI 网关/api_key 用，自己设一个强一点的）
set "AUTH_KEY=change-me-to-a-strong-auth-key"
REM 本机代理（chatgpt2api 访问 chatgpt.com 需走 Clash 等海外节点；Docker 内用 host.docker.internal 指向宿主机）
set "PROXY=http://host.docker.internal:7897"
REM =====================================

echo.
echo [0/5] 环境检查
where docker >nul 2>nul
if errorlevel 1 (
  echo [X] 没检测到 Docker。请先装 Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo     装好后重开终端再运行本脚本。
  pause & exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo [X] Docker 已安装但未启动，请先启动 Docker Desktop。
  pause & exit /b 1
)
echo [OK] Docker 可用

echo.
echo [1/5] 克隆仓库
if exist "%DIR%\.git" (
  echo [~] 已克隆，跳过（如需更新：cd chatgpt2api ^&^& git pull）
) else (
  git clone "%REPO%" "%DIR%"
  if errorlevel 1 (echo [X] 克隆失败，检查网络/代理; pause & exit /b 1)
)

echo.
echo [2/5] 注入 auth-key 与代理
REM 优先改 docker-compose.yml 的 CHATGPT2API_AUTH_KEY / 代理环境变量（容错：失败仅提示手动改）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$f='%DIR%\docker-compose.yml'; ^
   if (Test-Path $f) { ^
     $t=Get-Content $f -Raw; ^
     $t=$t -replace 'CHATGPT2API_AUTH_KEY:\s*\S+','CHATGPT2API_AUTH_KEY: %AUTH_KEY%'; ^
     $t=$t -replace 'HTTPS_PROXY:\s*\S+','HTTPS_PROXY: %PROXY%'; ^
     $t=$t -replace 'HTTP_PROXY:\s*\S+','HTTP_PROXY: %PROXY%'; ^
     Set-Content $f $t -NoNewline; ^
     echo '[OK] 已写 auth-key/代理到 docker-compose.yml'; ^
   } else { echo '[~] 未找到 docker-compose.yml，请手动在配置里设 CHATGPT2API_AUTH_KEY=%AUTH_KEY% 与代理 %PROXY%' }"

echo.
echo [3/5] 启动容器
cd /d "%DIR%"
docker compose up -d
if errorlevel 1 (echo [X] 启动失败; pause & exit /b 1)

echo.
echo [4/5] 等待启动并健康检查
timeout /t 10 >nul
curl -s -m 8 http://localhost:3000/v1/models
if errorlevel 1 (echo [~] 健康检查未通过，稍等几秒再 curl http://localhost:3000/v1/models) else (echo. & echo [OK] API 已就绪)

echo.
echo [5/5] 下一步
echo   - 打开 chatgpt2api 后台（http://localhost:3000）导入 ChatGPT access_token（手机已登录号可绕手机号）
echo   - ai-gateway 建平台选模板 [ChatGPT 网页/手机版（chatgpt2api）]
echo     base_url = http://127.0.0.1:3000/v1   api_key = %AUTH_KEY%
echo   - 详细见 docs/CHATGPT2API-ONBOARDING.md
echo.
pause
