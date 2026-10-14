#!/bin/bash
# AI 中转站完整自动化部署脚本（Ubuntu/Debian）
# 全新部署: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/linux/complete-deploy.sh | sudo bash
# 更新代码: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/linux/complete-deploy.sh | sudo bash -s -- --update

set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 日志函数
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

MODE=${1:-install}

# 检查是否为 root
if [[ $EUID -ne 0 ]]; then
   log_error "请使用 sudo 运行此脚本"
   exit 1
fi

WORK_DIR=/opt/ai-gateway
DATA_DIR="$WORK_DIR/data"

# ---- 更新模式 ----
if [[ "$MODE" == "--update" ]]; then
   log_info "========================================="
   log_info "  AI 中转站代码更新"
   log_info "========================================="
   echo ""

   if [[ ! -d "$WORK_DIR/server" ]]; then
      log_error "未检测到 $WORK_DIR，请先执行全新部署。"
      exit 1
   fi

   log_step "从 GitHub 拉取最新代码..."
   TMP_REPO="/tmp/ai-gateway-update"
   rm -rf "$TMP_REPO"
   git clone --depth 1 https://github.com/wyhc7/ai-gateway.git "$TMP_REPO"

   log_step "更新后端代码..."
   cp -r "$TMP_REPO/server"/* "$WORK_DIR/server/"
   cp "$TMP_REPO/package.json" "$WORK_DIR/"

   log_step "更新前端源码..."
   rm -rf "$WORK_DIR/web/src"
   cp -r "$TMP_REPO/web/src" "$WORK_DIR/web/"
   cp -r "$TMP_REPO/web/index.html" "$WORK_DIR/web/" 2>/dev/null || true
   cp -r "$TMP_REPO/web/vite.config.ts" "$WORK_DIR/web/" 2>/dev/null || true
   cp -r "$TMP_REPO/web/tailwind.config.js" "$WORK_DIR/web/" 2>/dev/null || true
   cp -r "$TMP_REPO/web/postcss.config.js" "$WORK_DIR/web/" 2>/dev/null || true
   cp "$TMP_REPO/web/package.json" "$WORK_DIR/web/"

   log_step "安装后端依赖..."
   npm install --prefix "$WORK_DIR/server" --omit=dev

   log_step "构建前端..."
   npm install --prefix "$WORK_DIR/web"
   npm run build --prefix "$WORK_DIR/web"

   log_step "设置权限..."
   chown -R ai-gateway:ai-gateway "$WORK_DIR"

   log_step "重启服务..."
   systemctl restart ai-gateway

   rm -rf "$TMP_REPO"

   sleep 2
   if systemctl is-active --quiet ai-gateway; then
      log_info "更新完成！访问 http://localhost:3001"
   else
      log_error "服务启动失败，请查看日志: sudo journalctl -u ai-gateway -n 50 --no-pager"
   fi
   exit 0
fi

# ---- 全新安装模式 ----

# 检查系统
if [[ ! -f /etc/debian_version ]] && [[ ! -f /etc/lsb-release ]]; then
   log_error "此脚本仅支持 Ubuntu/Debian 系统"
   exit 1
fi

log_info "========================================="
log_info "  AI 中转站自动部署脚本"
log_info "========================================="
echo ""

# 第 1 步：安装 Node.js
log_step "第 1 步：安装 Node.js 20 LTS..."
if command -v node &>/dev/null; then
   NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
   if [[ $NODE_VERSION -ge 20 ]]; then
      log_info "Node.js 已安装（版本: $(node -v)），跳过安装"
   else
      log_warn "Node.js 版本过低（当前: $(node -v)，要求: >= 20）"
      log_info "正在升级..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt install -y nodejs
   fi
else
   log_info "Node.js 未安装，正在安装..."
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
log_info "Node.js 版本: $(node -v)"

# 第 2 步：检测/克隆项目
log_step "第 2 步：检测项目目录..."

if [[ -f "server/package.json" && "$(pwd)" == "$WORK_DIR" ]]; then
   log_info "项目已在 $WORK_DIR"
elif [[ -f "server/package.json" ]]; then
   log_info "检测到项目根目录 $(pwd)，复制到 $WORK_DIR..."
   mkdir -p "$WORK_DIR"
   cp -a server web package.json deploy "$WORK_DIR/"
   cd "$WORK_DIR"
else
   log_info "准备项目目录 $WORK_DIR..."
   rm -rf "$WORK_DIR"
   git clone --depth 1 https://github.com/wyhc7/ai-gateway.git "$WORK_DIR"
   cd "$WORK_DIR"
fi

# 第 3 步：安装依赖并构建前端
log_step "第 3 步：安装依赖并构建前端..."
log_info "安装后端依赖..."
npm install --prefix server --omit=dev

log_info "安装前端依赖..."
npm install --prefix web

log_info "构建前端..."
npm run build --prefix web

log_info "安装前端生产依赖..."
npm install --prefix web --omit=dev

# 第 4 步：创建系统用户
log_step "第 4 步：创建系统用户..."
if id "ai-gateway" &>/dev/null; then
   log_warn "用户 ai-gateway 已存在"
else
   useradd --system --create-home --shell /usr/sbin/nologin ai-gateway
   log_info "创建系统用户: ai-gateway"
fi

# 第 5 步：创建数据目录
log_step "第 5 步：创建数据目录..."
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
chown -R ai-gateway:ai-gateway "$WORK_DIR"
chown -R ai-gateway:ai-gateway "$DATA_DIR"
log_info "数据目录: $DATA_DIR"

# 第 6 步：安装 systemd 服务
log_step "第 6 步：安装 systemd 服务..."
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
log_info "systemd 服务已安装"

# 第 7 步：启动服务
log_step "第 7 步：启动服务..."
systemctl start ai-gateway

sleep 2

# 第 8 步：验证安装
if systemctl is-active --quiet ai-gateway; then
   log_info "========================================="
   log_info "  部署成功！"
   log_info "========================================="
   echo ""
   echo "访问地址"
   echo "========================================="
   echo "管理界面: http://localhost:3001"
   echo "API 端点: http://localhost:3001/api/v1"
   echo "健康检查: http://localhost:3001/api/health"
   echo ""
   echo "配置文件: $DATA_DIR/config.json"
   echo "========================================="
   echo ""
log_info "后续管理命令："
    echo "  查看状态: sudo systemctl status ai-gateway"
    echo "  重启服务: sudo systemctl restart ai-gateway"
    echo "  查看日志: sudo journalctl -u ai-gateway -f"
    echo "  停止服务: sudo systemctl stop ai-gateway"
    echo "  更新代码: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/linux/complete-deploy.sh | sudo bash -s -- --update"
    echo ""
    log_info "请在浏览器中打开 http://localhost:3001，进入「仪表盘」复制网关 API Key"
   echo ""
else
   log_error "部署失败！请查看日志："
   echo "sudo journalctl -u ai-gateway -n 100 --no-pager"
   exit 1
fi

# 第 9 步：测试访问
log_step "第 9 步：测试服务..."
HEALTH_CHECK=$(curl -s http://localhost:3001/api/health)
if echo "$HEALTH_CHECK" | grep -q "ok"; then
   log_info "健康检查通过: $HEALTH_CHECK"
else
   log_warn "健康检查异常，请检查服务状态"
fi

echo ""
log_info "========================================="
log_info "  部署完成！"
log_info "========================================="
