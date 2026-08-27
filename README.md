# AI Gateway

[English](README_EN.md) | 简体中文

一个**零依赖配置、开箱即用**的自托管 AI 中转站（网关）。可视化平台管理、多 Key 自动故障切换、模型自动拉取、仪表盘真实统计、Token 消耗记录。

## 功能

- **多平台多 Key 管理** — 内置 23 个 AI 平台模版（OpenAI、DeepSeek、通义千问、Gemini、Claude 等），一键创建
- **自动故障切换** — 平台 Key 不可用时自动轮换到下一个 Key，请求不中断
- **模型自动拉取** — 输入 API Key 后一键拉取平台可用模型列表
- **仪表盘统计** — 请求量、成功率、Token 消耗（每日/总计）、Key 健康状态，10 秒自动刷新
- **完全兼容 OpenAI API** — 任何 OpenAI SDK / 客户端均可无缝接入，无需修改代码
- **思考功能透传** — 流式 / 非流式响应完整透传，DeepSeek R1 的 reasoning_content 等思考输出原样保留
- **深色主题响应式界面** — 桌面端、移动端均可使用

## 快速开始

```bash
# 安装依赖
npm run install:all

# 构建前端
npm --prefix web run build

# 启动（后端托管前端，单端口）
cd server && node index.js
```

访问 `http://localhost:3001` 进入管理界面。

首次打开管理界面会要求输入**管理密钥**（见下方「管理密钥」章节）。

### 环境变量

| 变量 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `PORT` | `3001` | 监听端口 |
| `DATA_DIR` | `server/data` | 数据目录（含平台 Key，请做好备份） |
| `WEB_DIST` | `web/dist` | 前端构建产物目录 |
| `ADMIN_KEY` | 自动生成 | 管理界面登录密钥，见下文 |

### 管理密钥

所有管理接口（平台/Key 增删改、日志、配置导出等）均需要管理密钥鉴权，首次打开 Web 界面时会弹出登录框。管理密钥的获取方式：

- **服务端启动日志**：启动时控制台会打印 `管理密钥（登录管理界面用）: ak-xxxx`
- **配置文件**：`server/data/config.json` 中的 `admin_api_key` 字段
- **环境变量**：设置 `ADMIN_KEY` 可覆盖配置文件中的值（Docker 部署推荐）

网关调用密钥（`gateway_api_key`，供 OpenAI SDK 客户端使用）与管理密钥相互独立，后者权限更高，请勿混用。

## 部署

支持 **5 种部署形态**：

| 形态 | 说明 |
| ---- | ---- |
| Docker Compose | 一键启动，数据卷持久化 |
| Linux systemd | 开机自启，崩溃自动重启 |
| macOS launchd | Mac 本机 / 家庭服务器 |
| Windows | 开箱即用，支持 NSSM 服务化 |
| Termux | Android 手机随身网关 |

### Docker 部署

```bash
docker compose up -d --build
```

拉取更新（data 目录自动保留）：

```bash
git pull && docker compose up -d --build
```

### Ubuntu / Debian 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/linux/complete-deploy.sh | sudo bash
```

拉取更新：

```bash
sudo bash /opt/ai-gateway/deploy/linux/complete-deploy.sh --update
```

### macOS 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/macos/install.sh | bash
```

拉取更新：

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/macos/install.sh | bash -s -- --update
```

### Windows

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/windows/start.bat -o start.bat && start.bat
```

拉取更新：在项目目录中执行 `git pull` 后重新运行 `start.bat`。

如需注册为系统服务，请参阅 [DEPLOYMENT.md](docs/DEPLOYMENT.md) 中的 Windows NSSM 章节。

### Termux (Android) 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/termux/install.sh | bash
```

拉取更新：

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai/main/deploy/termux/install.sh | bash -s -- --update
```

详见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 如何使用

### 1. 添加平台

在 Web 界面「平台管理」选择模版或手动填写 AI 平台信息 + API Key。

### 2. 拉取模型

点击「拉取模型」自动获取该平台的可用模型列表。

### 3. 调用 API

与 OpenAI SDK 完全兼容：

```python
from openai import OpenAI

client = OpenAI(
    api_key="<网关 API Key>",
    base_url="http://localhost:3001/api/v1"
)

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}]
)
print(resp.choices[0].message.content)
```

网关 API Key 可在「仪表盘 → 对接方式」复制。

## 外网访问

详见 [DEPLOYMENT.md](docs/DEPLOYMENT.md) 中的外网访问教程：

- Tailscale（推荐）
- Cloudflare Tunnel
- frp 内网穿透
- DDNS

## 项目结构

```
server/        — Node.js 后端（Express）
  index.js     — API 路由 + 鉴权
  proxy.js     — 模型匹配、故障切换、转发
  store.js     — 配置持久化与统计
  templates.js — 23 个平台模板
web/           — Vue 3 + Element Plus 管理界面
deploy/        — 各系统部署脚本与配置
docs/          — 部署文档
```

## License

[MIT](LICENSE)