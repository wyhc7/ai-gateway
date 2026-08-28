#!/bin/bash
# AI 中转站一键安装脚本（Ubuntu/Debian）
# 用法: sudo bash deploy/linux/install-ubuntu.sh

set -euo pipefail

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查是否以 root 运行
if [[ $EUID -ne 0 ]]; then
   log_error "请使用 sudo 运行此脚本"
   exit 1
fi

log_info "开始安装 AI 中转站..."

# 第 1 步：安装系统依赖
log_info "第 1 步：安装 Node.js 和 git..."

# 添加 NodeSource 仓库（安装 Node 20 LTS）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# 安装 Node.js（>= 20）和 git
apt install -y nodejs git curl

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
   log_error "Node.js 版本过低（当前: $NODE_VERSION，要求: >= 18）"
   exit 1
fi

# 第 2 步：检测项目目录
log_info "第 2 步：检测项目目录..."
if [[ -f "server/package.json" ]]; then
   log_info "检测到已在项目根目录，跳过克隆"
   WORK_DIR="$(pwd)"
else
   log_info "克隆代码..."
   git clone https://github.com/wyhc7/ai-gateway.git .
   WORK_DIR="$(pwd)"
fi

# 第 3 步：安装依赖并构建前端
log_info "第 3 步：安装依赖并构建前端..."
npm install --prefix server --omit=dev
npm install --prefix web
npm run build --prefix web
npm install --prefix web --omit=dev

# 第 4 步：创建系统用户
log_info "第 4 步：创建系统用户..."
if id "ai-gateway" &>/dev/null; then
   log_warn "用户 ai-gateway 已存在"
else
   useradd --system --create-home --shell /usr/sbin/nologin ai-gateway
fi

# 第 5 步：创建数据目录
log_info "第 5 步：创建数据目录..."
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
chown -R ai-gateway:ai-gateway "$WORK_DIR"
chown -R ai-gateway:ai-gateway "$DATA_DIR"

# 第 6 步：安装 systemd 服务
log_info "第 6 步：安装 systemd 服务..."
NODE_BIN=$(command -v node)
cat > /etc/systemd/system/ai-gateway.service <<EOF
[Unit]
Description=AI Gateway - 自托管多平台 AI 中转站
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-gateway
Group=ai-gateway
WorkingDirectory=$WORK_DIR
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN $WORK_DIR/server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ai-gateway

# 第 7 步：启动服务
log_info "第 7 步：启动服务..."
systemctl start ai-gateway

# 等待服务启动
sleep 2

# 第 8 步：验证安装
if systemctl is-active --quiet ai-gateway; then
   log_info "安装成功！"
   echo ""
   echo "========================================="
   echo "访问地址"
   echo "========================================="
   echo "管理界面: http://localhost:3001"
   echo "API 端点: http://localhost:3001/api/v1"
   echo "健康检查: http://localhost:3001/api/health"
   echo ""
   echo "========================================="
   echo "后续管理命令"
   echo "========================================="
   echo "查看状态: sudo systemctl status ai-gateway"
   echo "重启服务: sudo systemctl restart ai-gateway"
   echo "查看日志: sudo journalctl -u ai-gateway -f"
   echo "停止服务: sudo systemctl stop ai-gateway"
   echo ""
   echo "配置文件: $DATA_DIR/config.json"
   echo "========================================="
   echo ""
   log_info "请访问管理界面配置平台和网关 Key"
else
   log_error "服务启动失败，请运行以下命令查看错误："
   echo "sudo journalctl -u ai-gateway -n 50"
   exit 1
fi
