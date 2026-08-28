#!/data/data/com.termux/files/usr/bin/bash
# AI 中转站 Termux (Android) 一键部署/更新脚本
# 全新部署: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/termux/install.sh | bash
# 更新代码: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/termux/install.sh | bash -s -- --update
set -euo pipefail

APP_DIR=${APP_DIR:-$HOME/ai-gateway}
DATA_DIR=${DATA_DIR:-$HOME/ai-gateway-data}
PORT=${PORT:-3000}

MODE=${1:-install}

echo "==> 检查 Termux 环境"
if ! command -v pkg >/dev/null 2>&1; then
  echo "[x] 请在 Termux 中运行本脚本"
  echo "    安装 Termux: https://f-droid.org/packages/com.termux/"
  exit 1
fi

pkg install -y nodejs-lts git curl

# ---- 更新模式 ----
if [[ "$MODE" == "--update" ]]; then
  echo "==> 更新 AI 中转站代码"

  if [[ ! -d "$APP_DIR/server" ]]; then
    echo "[x] 未检测到 $APP_DIR，请先执行全新部署。"
    exit 1
  fi

  echo "  从 GitHub 拉取最新代码..."
  TMP_REPO="$HOME/ai-gateway-update-tmp"
  rm -rf "$TMP_REPO"
  git clone --depth 1 https://github.com/wyhc7/ai-gateway.git "$TMP_REPO"

  echo "==> 更新后端代码..."
  cp -r "$TMP_REPO/server"/* "$APP_DIR/server/"
  cp "$TMP_REPO/package.json" "$APP_DIR/"

  echo "==> 更新前端源码..."
  rm -rf "$APP_DIR/web/src"
  cp -r "$TMP_REPO/web/src" "$APP_DIR/web/"
  cp "$TMP_REPO/web/index.html" "$APP_DIR/web/" 2>/dev/null || true
  cp "$TMP_REPO/web/vite.config.ts" "$APP_DIR/web/" 2>/dev/null || true
  cp "$TMP_REPO/web/tailwind.config.js" "$APP_DIR/web/" 2>/dev/null || true
  cp "$TMP_REPO/web/postcss.config.js" "$APP_DIR/web/" 2>/dev/null || true
  cp "$TMP_REPO/web/package.json" "$APP_DIR/web/"

  echo "==> 安装依赖并构建..."
  npm install --prefix "$APP_DIR/server" --omit=dev
  npm install --prefix "$APP_DIR/web"
  npm run build --prefix "$APP_DIR/web"

  rm -rf "$TMP_REPO"

  echo "==> 重启服务..."
  pkill -f "node.*server/index.js" 2>/dev/null || true
  sleep 1
  nohup "$HOME/bin/start-ai-gateway" > "$DATA_DIR/server.log" 2>&1 &

  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo "更新完成！访问 http://localhost:$PORT"
      exit 0
    fi
    sleep 1
  done
  echo "警告: 服务已启动但健康检查未通过"
  exit 1
fi

# ---- 全新安装模式 ----

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../.."

echo "==> 获取项目"
if [ -f "$REPO_DIR/server/package.json" ]; then
  echo "   检测到本地项目: $REPO_DIR"
elif [ -f "$SCRIPT_DIR/../../server/package.json" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  echo "   检测到本地项目: $REPO_DIR"
else
  REPO_DIR="$HOME/ai-gateway-install-tmp"
  rm -rf "$REPO_DIR"
  git clone --depth 1 https://github.com/wyhc7/ai-gateway.git "$REPO_DIR"
  echo "   已从 GitHub 克隆"
fi

echo "==> 复制代码到 $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -r "$REPO_DIR/server" "$APP_DIR/"
cp -r "$REPO_DIR/web" "$APP_DIR/"
cp "$REPO_DIR/package.json" "$APP_DIR/"

echo "==> 安装依赖并构建前端"
npm install --prefix "$APP_DIR/server" --omit=dev
npm install --prefix "$APP_DIR/web"
npm run build --prefix "$APP_DIR/web"

echo "==> 生成启动脚本"
mkdir -p "$HOME/bin"
cat > "$HOME/bin/start-ai-gateway" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
export PORT=$PORT
export DATA_DIR=$DATA_DIR
exec node "$APP_DIR/server/index.js"
EOF
chmod +x "$HOME/bin/start-ai-gateway"

echo "==> 配置开机自启"
mkdir -p "$PREFIX/var/service/ai-gateway" 2>/dev/null || true
cat > "$PREFIX/var/service/ai-gateway/run" <<EOF 2>/dev/null || true
#!/data/data/com.termux/files/usr/bin/bash
exec $HOME/bin/start-ai-gateway
EOF
chmod +x "$PREFIX/var/service/ai-gateway/run" 2>/dev/null || true

echo "==> 启动服务"
termux-wake-lock 2>/dev/null || true
pkill -f "node.*server/index.js" 2>/dev/null || true
sleep 1
nohup "$HOME/bin/start-ai-gateway" > "$DATA_DIR/server.log" 2>&1 &

for i in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    IP=$(ifconfig 2>/dev/null | grep 'inet 192.168' | awk '{print $2}' | head -1)
    echo ""
    echo "========================================"
    echo "  安装完成!"
    echo "========================================"
    echo "  本机访问:   http://localhost:$PORT"
    [ -n "$IP" ] && echo "  局域网访问: http://$IP:$PORT"
    echo "  API 端点:   http://localhost:$PORT/api/v1"
    echo "  停止服务:   pkill -f 'node.*server/index.js'"
    echo "  更新代码:   curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/termux/install.sh | bash -s -- --update"
    echo "========================================"
    exit 0
  fi
  sleep 1
done

echo "警告: 服务已启动但健康检查未通过，请查看日志"