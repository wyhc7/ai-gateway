# Ubuntu 一键安装指南

本项目提供 Ubuntu 22.04+ 一键安装脚本，自动完成依赖安装、代码克隆、依赖安装、前端构建、systemd 服务配置和启动。

## 快速开始

```bash
# 克隆代码
git clone https://github.com/wyhc7/ai.git && cd ai

# 以 root 权限运行安装脚本
sudo bash deploy/linux/install-ubuntu.sh
```

脚本会自动执行以下步骤：

1. 安装 Node.js（>= 18）、git、curl
2. 克隆代码到 `/opt/ai-gateway`
3. 安装依赖并构建前端
4. 创建 `ai-gateway` 系统用户
5. 安装 systemd 服务并开机自启
6. 启动服务并显示访问地址

## 安装后访问

- **管理界面**：http://localhost:3001
- **API 端点**：http://localhost:3001/api/v1
- **健康检查**：http://localhost:3001/api/health

在管理界面「仪表盘」中复制网关 API Key 和 Base URL，即可在客户端中使用。

## 后续管理

```bash
# 查看服务状态
sudo systemctl status ai-gateway

# 重启服务
sudo systemctl restart ai-gateway

# 停止服务
sudo systemctl stop ai-gateway

# 查看日志
sudo journalctl -u ai-gateway -f

# 查看最近 100 行日志
sudo journalctl -u ai-gateway -n 100
```

## 配置文件位置

- **数据目录**：`/opt/ai-gateway/data/`
- **配置文件**：`/opt/ai-gateway/data/config.json`
- **服务文件**：`/etc/systemd/system/ai-gateway.service`

## 升级

```bash
cd /opt/ai-gateway
git pull
npm install --prefix server --omit=dev
npm install --prefix web --omit=dev
npm run build --prefix web
systemctl restart ai-gateway
```

## 故障排查

### 服务启动失败

```bash
# 查看详细日志
sudo journalctl -u ai-gateway -n 100
```

### 端口被占用

编辑 `/etc/systemd/system/ai-gateway.service`，修改 `PORT=3001`，然后重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart ai-gateway
```

### 权限错误

```bash
# 检查目录权限
ls -la /opt/ai-gateway

# 修复权限
sudo chown -R ai-gateway:ai-gateway /opt/ai-gateway
```

## 外网访问（可选）

### 使用 Tailscale（推荐）

```bash
# 安装 Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# 启动 Tailscale
sudo tailscaled
sudo tailscale up

# 从其他设备安装 Tailscale 客户端并登录同一账号
# 然后访问 http://<TailscaleIP>:3001
```

### 使用 Cloudflare Tunnel

详见 [部署文档](docs/DEPLOYMENT.md#方案-b-cloudflare-tunnel-免费-https)

## 需要帮助？

- 文档：https://github.com/wyhc7/ai/blob/main/docs/DEPLOYMENT.md
- 问题反馈：https://github.com/wyhc7/ai/issues
