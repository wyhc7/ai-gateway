# 在 Windows 上以系统服务方式安装 AI 中转站（生产模式，单进程托管界面 + API）
# 用法（管理员 PowerShell）:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1 -AppDir C:\ai-gateway
# 卸载:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1 -AppDir C:\ai-gateway -Uninstall
# 前置: 已安装 Node.js >= 18，NSSM 可执行文件已放到脚本同目录 nssm.exe（https://nssm.cc/download）

param(
  [string]$AppDir = "C:\ai-gateway",
  [int]$Port = 3001,
  [string]$ServiceName = "ai-gateway",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Nssm = Join-Path $PSScriptRoot "nssm.exe"

if (-not (Test-Path $Nssm)) {
  Write-Host "[x] 未找到 nssm.exe，请从 https://nssm.cc/download 下载并放到本脚本同目录。" -ForegroundColor Red
  exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source
$root = $PSScriptRoot
$serverIndex = Join-Path $AppDir "server\index.js"
$dataDir = Join-Path $AppDir "data"

if ($Uninstall) {
  Write-Host "==> 卸载服务 $ServiceName"
  & $Nssm stop $ServiceName 2>$null
  & $Nssm remove $ServiceName confirm 2>$null
  Write-Host "已卸载。如需删除程序目录请手动删除: $AppDir"
  exit 0
}

Write-Host "==> 复制代码到 $AppDir"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Recurse -Force "$root\..\server" $AppDir
Copy-Item -Recurse -Force "$root\..\web" $AppDir
Copy-Item -Force "$root\..\package.json" $AppDir
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "==> 安装依赖并构建前端"
Push-Location $AppDir
npm install --prefix server --omit=dev
npm install --prefix web
npm run build --prefix web
npm install --prefix web --omit=dev
Pop-Location

Write-Host "==> 注册服务 $ServiceName (端口 $Port)"
& $Nssm install $ServiceName $node $serverIndex
& $Nssm set $ServiceName AppDirectory $AppDir
& $Nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production`nPORT=$Port`nDATA_DIR=$dataDir"
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 3000
& $Nssm set $ServiceName DisplayName "AI Gateway - 自托管多平台 AI 中转站"
& $Nssm set $ServiceName Description "对外暴露 OpenAI 兼容端点，多平台多 Key 管理 + 自动故障切换"
& $Nssm set $ServiceName ObjectName LocalSystem

Write-Host "==> 启动服务"
& $Nssm start $ServiceName

Write-Host "安装完成。管理界面: http://localhost:$Port"
Write-Host "管理命令: nssm status $ServiceName / nssm restart $ServiceName"
