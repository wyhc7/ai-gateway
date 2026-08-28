# 多系统部署方案

本项目提供 **跨平台部署** 支持，覆盖 Docker、Linux（systemd）、macOS（launchd）、Windows（NSSM 服务）四种形态。后端服务在生产模式下会**同时托管管理界面与 OpenAI 兼容 API**（单进程、单端口），部署后直接访问 `http://<地址>:3001` 即可。

## 部署形态选型

| 形态 | 适用场景 | 特点 |
| ---- | -------- | ---- |
| **Docker / Docker Compose**（推荐） | 任意操作系统、生产环境 | 环境隔离、一键升级、数据卷持久化 |
| **Linux systemd** | 服务器、云主机 | 开机自启、崩溃自动重启、日志接入 journald |
| **macOS launchd** | Mac 本机 / 家庭服务器 | 登录自启、崩溃自动重启 |
| **Windows NSSM** | Windows 服务器 / 桌面机 | 注册为 Windows 服务，开机自启 |
| **Termux** | Android 手机 / 平板 | 随身携带的网关，局域网共享，配合 Tailscale 外网访问 |

> 生产模式与开发模式的区别：开发模式用 `npm start` 起后端（3001）+ Vite 前端（5173）；生产模式只需启动后端一个进程，由后端托管构建好的前端静态文件。

## 环境变量

| 变量 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `PORT` | `3001` | 对外监听端口（API 与管理界面同端口） |
| `DATA_DIR` | `server/data` | 数据目录（`config.json` 所在位置，含平台 Key，请妥善保管并做好备份） |
| `WEB_DIST` | `web/dist` | 前端构建产物目录（一般无需修改） |

## Docker 部署

### 方式一：Docker Compose（推荐）

```bash
# 1. 克隆代码
git clone https://github.com/wyhc7/ai-gateway.git && cd ai-gateway

# 2. 构建并启动
docker compose up -d --build
```

服务启动后：

- 管理界面 / 接入端点：`http://<服务器IP>:3001`
- 健康检查：`http://<服务器IP>:3001/api/health`
- 数据目录：宿主机 `./data`（已映射到容器 `/data`），备份时直接备份该目录

### 方式二：纯 Docker

```bash
# 构建镜像
docker build -t ai-gateway:latest .

# 运行
docker run -d \
  --name ai-gateway \
  --restart unless-stopped \
  -p 3001:3001 \
  -v "$(pwd)/data:/data" \
  ai-gateway:latest
```

### 查看日志与升级

```bash
docker compose logs -f
docker compose pull && docker compose up -d --build   # 升级
```

## Linux（systemd）部署

### 一键安装脚本

```bash
sudo bash deploy/linux/install.sh
```

脚本会：创建 `ai-gateway` 系统用户 → 复制代码到 `/opt/ai-gateway` → 安装依赖并构建前端 → 注册 systemd 服务并启动。

### 手动安装步骤

```bash
# 1. 安装 Node.js >= 18（以 Ubuntu/Debian 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 创建运行用户与目录
sudo useradd --system --create-home ai-gateway
sudo mkdir -p /opt/ai-gateway/data
sudo chown -R ai-gateway:ai-gateway /opt/ai-gateway

# 3. 复制代码并安装依赖（将仓库部署到 /opt/ai-gateway）
sudo -u ai-gateway npm install --prefix /opt/ai-gateway/server --omit=dev
sudo -u ai-gateway npm install --prefix /opt/ai-gateway/web
sudo -u ai-gateway npm run build --prefix /opt/ai-gateway/web
sudo -u ai-gateway npm install --prefix /opt/ai-gateway/web --omit=dev

# 4. 安装 systemd 服务（模板中替换路径）
NODE_BIN=$(command -v node)
sudo sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@APP_DIR@|/opt/ai-gateway|g" \
    -e "s|@PORT@|3001|g" \
    deploy/linux/ai-gateway.service > /etc/systemd/system/ai-gateway.service

# 5. 启动并设置开机自启
sudo systemctl daemon-reload
sudo systemctl enable --now ai-gateway
```

### 日常管理

```bash
sudo systemctl status ai-gateway      # 查看状态
sudo systemctl restart ai-gateway     # 重启
sudo journalctl -u ai-gateway -f      # 查看日志
```

### 可选：nginx 反向代理（含 SSE 流式支持）

```bash
sudo tee /etc/nginx/conf.d/ai-gateway.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name gateway.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;            # 关闭缓冲，保证 SSE 流式即时输出
        proxy_read_timeout 600s;        # 长响应（对话生成）超时
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

## macOS（launchd）部署

### 一键安装脚本

```bash
bash deploy/macos/install.sh
```

脚本会：复制代码到 `~/.ai-gateway` → 安装依赖并构建前端 → 生成 `~/Library/LaunchAgents/com.ai-gateway.server.plist` → 加载并启动服务。

### 手动步骤与日常管理

```bash
# 手动生成 plist 并加载
NODE_BIN=$(command -v node)
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@APP_DIR@|$HOME/.ai-gateway|g" \
    -e "s|@PORT@|3001|g" \
    deploy/macos/com.ai-gateway.server.plist > ~/Library/LaunchAgents/com.ai-gateway.server.plist
launchctl load ~/Library/LaunchAgents/com.ai-gateway.server.plist

launchctl start com.ai-gateway.server     # 启动
launchctl unload ~/Library/LaunchAgents/com.ai-gateway.server.plist   # 停止
tail -f ~/.ai-gateway/logs/stderr.log     # 查看日志
```

> launchd 在 macOS 登录后自动加载，适合本机常驻服务；若要开机即启动（登录前），将 plist 放入 `/Library/LaunchDaemons/` 并使用 `sudo launchctl load`。

## Windows 部署

### 方式一：开发模式一键启动

```bat
deploy\windows\start.bat
```

启动后端（3001）与前端 dev server（5173），前端已配置 `/api` 反向代理。

### 方式二：注册为 Windows 服务（生产模式）

前置条件：

1. 安装 [Node.js](https://nodejs.org)（>= 18）
2. 下载 [NSSM](https://nssm.cc/download) 并解压出 `nssm.exe`，放到 `deploy\windows\` 目录

以**管理员**身份打开 PowerShell 执行：

```powershell
# 安装服务（默认安装到 C:\ai-gateway，端口 3001）
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-service.ps1

# 指定目录 / 端口
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-service.ps1 -AppDir D:\ai-gateway -Port 8080

# 卸载服务
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-service.ps1 -Uninstall
```

### 日常管理

```bat
nssm status ai-gateway
nssm restart ai-gateway
nssm stop ai-gateway
```

## Termux（Android 手机 / 平板）部署

在 Android 手机上以生产模式运行 AI 中转站，随时可用、局域网共享给其他设备。

### 第 1 步：安装 Termux

从 **F-Droid** 下载安装（Play 商店版本已停更）：https://f-droid.org/packages/com.termux/

首次打开按提示 `pkg update`，并授予存储权限。

### 第 2 步：一键安装脚本

```bash
# 1. 克隆仓库（或在手机浏览器下载 ZIP 后解压，再执行脚本）
pkg install -y git
git clone https://github.com/wyhc7/ai-gateway.git && cd ai-gateway

# 2. 一键安装（自动装 nodejs-lts → 装依赖 → 构建前端 → 启动）
bash deploy/termux/install.sh
```

脚本默认配置：`PORT=3000`、数据目录 `~/ai-gateway-data`、应用目录 `~/ai-gateway`。可用环境变量覆盖：

```bash
PORT=8080 DATA_DIR=/sdcard/ai-gateway-data bash deploy/termux/install.sh
```

### 第 3 步：访问

```bash
# 本机访问
http://localhost:3000

# 局域网访问（手机与目标设备连同一个 WiFi）
http://<手机IP>:3000
```

查看手机 IP：

```bash
ifconfig
# 或查看 wlan0 的 inet 地址，如 192.168.1.100
```

### 开机自启与保活

Termux 默认在熄屏一段时间后进入休眠，会导致服务暂停，需要保活与开机启动：

```bash
# 1. 保活：防止熄屏休眠（Termux 会请求"忽略电池优化"权限）
pkg install -y termux-api
termux-wake-lock
# 恢复默认：termux-wake-unlock

# 2. 开机自启：安装 Termux:Boot 插件（F-Droid）
pkg install -y termux-boot
mkdir -p ~/.termux/boot
echo 'termux-wake-lock; exec ~/bin/start-ai-gateway' > ~/.termux/boot/ai-gateway
# Termux:Boot 每次开机自动执行该脚本
```

### 注意

- 手机系统后台限制可能杀进程，建议在系统设置中允许 Termux 自启动、忽略电池优化
- 首次 `vite build` 较慢属正常，请保持前台运行直至完成
- 生产模式为单进程，**无需**运行 Vite dev server，省电省内存
- 想让外网也能访问，见下方「开通外网访问」

## 开通外网访问

部署完成后服务默认只能本机 / 局域网访问。以下方案可让公网访问，按场景选择。

### 方案选型

| 方案 | 是否需要公网 IP / VPS | 难度 | 特点 |
| ---- | --------------------- | ---- | ---- |
| **Tailscale**（推荐） | 否 | 低 | 免费组网、零配置、端到端加密，仅授权设备可访问 |
| **Cloudflare Tunnel** | 否（需域名） | 中 | 免费、自带 HTTPS、可设访问策略 |
| **frp 内网穿透** | 需一台公网 VPS | 中 | 自定义域名/端口，国内访问速度取决于 VPS |
| **路由器端口映射 + DDNS** | 需公网 IP | 中 | 无需第三方，直接暴露 3001 端口 |

### 方案 A：Tailscale（个人使用推荐）

原理：把手机 / 服务器与你的电脑加入同一个虚拟局域网（tailnet），无论身处何地，用 Tailscale 分配的固定 IP 直接访问，端口不暴露公网。

```bash
# Termux 上安装并登录
pkg install -y tailscale
sudo tailscaled 2>/dev/null || tailscaled &
tailscale up

# Linux 服务器上安装
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 访问：tailnet 内任意设备打开
# http://<设备的TailscaleIP>:3000
tailscale ip -4    # 查看设备 IP
```

电脑 / 手机同样安装 Tailscale 客户端并登录同一账号后，直接访问设备的 tailnet IP 即可，全程加密，无需开放任何公网端口。

### 方案 B：Cloudflare Tunnel（免费 HTTPS）

原理：`cloudflared` 与 Cloudflare 建立出站隧道，用户请求先到 Cloudflare 再转发到你的服务，自动获得 HTTPS，无需公网 IP。

前置：一个域名，DNS 托管在 Cloudflare。

```bash
# 1. 安装 cloudflared（Linux）
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 2. 登录并创建隧道
cloudflared tunnel login
cloudflared tunnel create ai-gateway

# 3. 配置 ~/.cloudflared/config.yml
tunnel: <隧道ID>
credentials-file: /root/.cloudflared/<隧道ID>.json
ingress:
  - hostname: gateway.example.com
    service: http://localhost:3001
  - service: http_status:404

# 4. 配置 DNS 并启动
cloudflared tunnel route dns ai-gateway gateway.example.com
cloudflared tunnel run ai-gateway
```

之后访问 `https://gateway.example.com` 即为中转站（已自动 HTTPS）。Termux 中同样可 `pkg install cloudflared` 使用。

### 方案 C：frp 内网穿透（需公网 VPS）

原理：VPS 运行 `frps`（服务端），你的设备运行 `frpc`（客户端），frpc 主动连上 frps，把 VPS 公网端口转发到本地 3001。

```bash
# 1. VPS（公网）上配置 frps.toml 并启动
# frps.toml
bindPort = 7000
# 启动
wget -O frp.tar.gz https://github.com/fatedier/frp/releases/latest/download/frp_linux_amd64.tar.gz
tar xzf frp.tar.gz && cd frp_*_linux_amd64
./frps -c frps.toml

# 2. 你的设备（服务器 / 手机）配置 frpc.toml 并启动
# frpc.toml
serverAddr = "<VPS公网IP>"
serverPort = 7000
[[proxies]]
name = "ai-gateway"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3001
remotePort = 3001
# 启动
./frpc -c frpc.toml
```

访问 `http://<VPS公网IP>:3001` 即到达你的中转站。frp 客户端需保持在后台运行（systemd / termux-services）。

### 方案 D：路由器端口映射 + DDNS（需公网 IP）

家庭宽带如有公网 IP，可让路由把外网端口转发到网关：

1. 给设备设置**静态内网 IP**（如 `192.168.1.100`）
2. 路由器「端口转发 / 虚拟服务器」：外部端口 `3001` → 内网 `192.168.1.100:3001`，协议 TCP
3. 配置 **DDNS**（花生壳 / 阿里云 / 腾讯云）绑定动态公网 IP，获得固定域名
4. 访问 `http://<你的域名>:3001`

> 国内多数家庭宽带没有公网 IP（NAT 后），此方案优先确认运营商是否提供。

### 外网访问安全提醒

- 网关自带 `Authorization: Bearer <网关Key>` 鉴权，未携带合法 Key 的请求会被拒绝（401），这是第一道防线
- 暴露公网后建议通过 **HTTPS** 访问（Cloudflare Tunnel 方案已自带；Tailscale 全程加密）
- 管理接口（`/api/providers` 等）未强制校验网关 Key，**不要**直接暴露给不可信网络——如需公网使用管理界面，建议放在 Tailscale 内网或加 nginx 基础认证
- 定期检查日志：`journalctl -u ai-gateway -f`（Linux）、`tail -f ~/.ai-gateway/logs/stderr.log`（macOS）、`nssm status ai-gateway`（Windows）

## 数据与备份

所有运行时数据（平台配置、API Key、统计）保存在 `DATA_DIR/config.json`，**不写入数据库**。备份与迁移只需复制这一个文件：

```bash
# 默认数据目录
cp server/data/config.json /path/to/backup/config.json.$(date +%F)
```

迁移到新机器时，将备份的 `config.json` 放回对应数据目录并重启服务即可。

## 常见问题

**端口被占用？**
通过环境变量 `PORT` 换端口（如 `PORT=8080`）。systemd / plist / NSSM 部署时在对应配置中修改。

**外部客户端无法访问？**
检查防火墙 / 安全组是否放行端口；服务器场景建议通过 nginx 反代并开启 HTTPS。

**流式输出不生效？**
反向代理需关闭缓冲（nginx 配置见上文 `proxy_buffering off`），并保证长连接超时足够。

**数据丢失？**
确认 `DATA_DIR` 指向了正确目录（尤其容器场景，数据卷必须挂载到 `/data`）。
