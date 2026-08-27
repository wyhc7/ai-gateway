#!/usr/bin/env bash
# AI 中转站 macOS 一键部署/更新脚本
# 全新部署: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/macos/install.sh | bash
# 更新代码: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/macos/install.sh | bash -s -- --update
set -euo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m 操作失败，请检查上方报错"; exit 1' ERR

APP_DIR=${APP_DIR:-$HOME/.ai-gateway}
PORT=${PORT:-3001}
LABEL=com.ai-gateway.server
PLIST_DEST=$HOME/Library/LaunchAgents/${LABEL}.plist

MODE=${1:-install}

# ---- 更新模式 ----
if [[ "$MODE" == "--update" ]]; then
  echo "==> 更新 AI 中转站代码"

  if [[ ! -d "$APP_DIR/server" ]]; then
    echo "[x] 未检测到 $APP_DIR，请先执行全新部署。"
    exit 1
  fi

  echo "  从 GitHub 拉取最新代码..."
  TMP_REPO="/tmp/ai-gateway-update"
  rm -rf "$TMP_REPO"
  git clone --depth 1 https://github.com/wyhc7/ai.git "$TMP_REPO"

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
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  launchctl load "$PLIST_DEST"
  launchctl start "$LABEL"

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

echo "==> 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "正在安装 Node.js..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "[x] 请先安装 Homebrew: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\" 然后重试"
    exit 1
  fi
  brew install node
fi
echo "   Node.js $(node -v)"

echo "==> 获取项目"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../.."
if [ -f "$REPO_DIR/server/package.json" ]; then
  echo "   检测到本地项目: $REPO_DIR"
elif [ -f "$SCRIPT_DIR/../../server/package.json" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  echo "   检测到本地项目: $REPO_DIR"
else
  REPO_DIR="/tmp/ai-gateway-install"
  rm -rf "$REPO_DIR"
  git clone --depth 1 https://github.com/wyhc7/ai.git "$REPO_DIR"
  echo "   已从 GitHub 克隆"
fi

echo "==> 复制代码到 $APP_DIR"
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
cp -r "$REPO_DIR/server" "$APP_DIR/"
cp -r "$REPO_DIR/web" "$APP_DIR/"
cp "$REPO_DIR/package.json" "$APP_DIR/"

echo "==> 安装依赖并构建前端"
npm install --prefix "$APP_DIR/server" --omit=dev
npm install --prefix "$APP_DIR/web"
npm run build --prefix "$APP_DIR/web"

echo "==> 生成并加载 launchd 服务"
NODE_BIN="$(command -v node)"
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@PORT@|$PORT|g" \
    "$REPO_DIR/deploy/macos/com.ai-gateway.server.plist" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
launchctl start "$LABEL"

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "========================================"
    echo "  安装完成!"
    echo "========================================"
    echo "  管理界面: http://localhost:$PORT"
    echo "  API 端点: http://localhost:$PORT/api/v1"
    echo "  停止服务: launchctl unload $PLIST_DEST"
    echo "  更新代码: curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/macos/install.sh | bash -s -- --update"
    echo "========================================"
    exit 0
  fi
  sleep 1
done

echo "警告: 服务已启动但健康检查未通过，请查看日志: $APP_DIR/logs/stderr.log"