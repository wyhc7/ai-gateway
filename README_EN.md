# AI Gateway

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/wyhc7/ai-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/wyhc7/ai-gateway/actions/workflows/ci.yml)

A **zero-config, out-of-the-box** self-hosted AI relay gateway. Visual platform management, multi-key automatic failover, automatic model discovery, real dashboard statistics, and token usage tracking.

> ⚠️ **Read this first**: this project supports two very different kinds of upstream — **official API keys** and **consumer subscription accounts** (OAuth / reverse-engineered channels). The latter **may violate the upstream provider's terms of service**. See [Terms & Risk Notice](#terms--risk-notice) before you start.

## Terms & Risk Notice

| Category | Credential source | Examples | ToS risk |
| -------- | ----------------- | -------- | -------- |
| **Official API endpoints** | API keys publicly issued by the provider | DeepSeek, Qwen, Gemini, SiliconFlow, OpenRouter, Ollama | None — this is the provider's intended usage |
| **Subscription account channels** | Session credentials of a consumer subscription | Grok subscription OAuth, Codex subscription OAuth, ChatGPT web (chatgpt2api) | **May violate the provider's terms of service** |

Subscription channels work by driving a **personal subscription** (ChatGPT Plus/Pro, SuperGrok, etc.) as if it were an API. Providers such as OpenAI and xAI generally prohibit:

- sharing account credentials with others
- using automated means to work around the usage limits and quotas attached to a subscription plan

The usual consequence is **account termination with no refund of subscription fees**. These channels also depend on non-public interfaces, so upstream changes can break them at any time.

**Therefore:**

- The subscription features are intended for **personal study, research and self-use only** — not for team sharing, commercial redistribution, or offering a service to others
- Read and accept the provider's current terms before using them; the risk is your own
- If your use case involves multiple users or commercial scenarios, use the provider's official API instead (this project supports that fully)
- This project is MIT-licensed and accepts no responsibility for account bans, data loss, or any indirect consequences arising from the use of subscription channels

## Features

- **Multi-platform, multi-key management** — 23 built-in AI platform templates (OpenAI, DeepSeek, Qwen, Gemini, Claude, and more), one-click creation
- **Automatic failover** — rotates to the next key automatically when a platform key becomes unavailable, requests are never interrupted
- **Tiered cooldown with half-open probing** — distinguishes key-level failures (401/403, long cooldown) from upstream hiccups (5xx/rate limits, short cooldown with a cap on how many keys cool down at once); once a cooldown is half over, one probe request is let through so recovery is immediate
- **Automatic model discovery** — fetch a platform's available model list with one click after entering an API key
- **Token accounting** — prefers the upstream `usage` field; falls back to estimating from output length (reasoning included) when upstream omits it, so counts are never silently missed
- **Dashboard statistics** — request volume, success rate, token usage (daily/total), key health status, auto-refresh every 10 seconds
- **Fully OpenAI API compatible** — works with any OpenAI SDK / client seamlessly, no code changes required
- **Reasoning passthrough** — streaming and non-streaming responses are forwarded intact, including reasoning output such as DeepSeek R1's `reasoning_content`
- **Dark-theme responsive UI** — works on both desktop and mobile

## Quick Start

```bash
# Install dependencies
npm run install:all

# Build the frontend
npm --prefix web run build

# Start (backend serves the frontend, single port)
cd server && node index.js
```

Open `http://localhost:3001` to access the admin dashboard.

On first launch you will be asked for the **admin key** (see the "Admin Key" section below).

### Environment Variables

| Variable | Default | Description |
| ---- | ------ | ----------- |
| `PORT` | `3001` | Listening port |
| `DATA_DIR` | `server/data` | Data directory (contains platform keys — back it up!) |
| `WEB_DIST` | `web/dist` | Frontend build output directory |
| `ADMIN_KEY` | auto-generated | Admin dashboard login key, see below |

### Admin Key

All admin endpoints (platform/key CRUD, logs, config export, etc.) require the admin key. A login dialog appears the first time you open the web dashboard. Ways to obtain it:

- **Server startup log**: the console prints `管理密钥（登录管理界面用）: ak-xxxx` on startup
- **Config file**: the `admin_api_key` field in `server/data/config.json`
- **Environment variable**: set `ADMIN_KEY` to override the config file value (recommended for Docker deployments)

The gateway API key (`gateway_api_key`, used by OpenAI SDK clients) and the admin key are independent of each other — the latter has higher privileges. Do not mix them up.

## Deployment

**5 deployment options** are supported:

| Option | Notes |
| ---- | ---- |
| Docker Compose | One-command startup, persistent data volume |
| Linux systemd | Auto-start on boot, auto-restart on crash |
| macOS launchd | Local Mac / home server |
| Windows | Works out of the box, NSSM service supported |
| Termux | A portable gateway on your Android phone |

### Docker

```bash
docker compose up -d --build
```

Pull updates (the data directory is preserved automatically):

```bash
git pull && docker compose up -d --build
```

### Ubuntu / Debian one-line install

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/linux/complete-deploy.sh | sudo bash
```

Pull updates:

```bash
sudo bash /opt/ai-gateway/deploy/linux/complete-deploy.sh --update
```

### macOS one-line install

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/macos/install.sh | bash
```

Pull updates:

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/macos/install.sh | bash -s -- --update
```

### Windows

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/windows/start.bat -o start.bat && start.bat
```

Pull updates: run `git pull` in the project directory, then run `start.bat` again.

To register it as a system service, see the Windows NSSM section in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Termux (Android) one-line install

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/termux/install.sh | bash
```

Pull updates:

```bash
curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/termux/install.sh | bash -s -- --update
```

See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for details.

## Usage

### 1. Add a platform

In the web dashboard under "Platform Management", pick a template or manually fill in the AI platform info + API key.

### 2. Fetch models

Click "Fetch Models" to retrieve the platform's available model list automatically.

### 3. Call the API

Fully compatible with the OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    api_key="<gateway API key>",
    base_url="http://localhost:3001/api/v1"
)

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}]
)
print(resp.choices[0].message.content)
```

The gateway API key can be copied from "Dashboard → Integration".

## Public Network Access

See the public access tutorial in [DEPLOYMENT.md](docs/DEPLOYMENT.md):

- Tailscale (recommended)
- Cloudflare Tunnel
- frp
- DDNS

## Project Structure

```
server/        — Node.js backend (Express)
  index.js     — API routes + auth
  proxy.js     — model matching, failover, forwarding
  store.js     — config persistence and statistics
  templates.js — 23 platform templates
  test/        — integration tests
web/           — Vue 3 + Element Plus admin dashboard
deploy/        — deployment scripts and configs for each platform
docs/          — deployment docs
```

## Development

```bash
# Run the backend integration tests (Node's built-in test runner, no extra dependencies)
npm test --prefix server
```

Tests spin up a local mock upstream and cover the core paths: failover, streaming passthrough, token accounting, and model allowlist enforcement.
CI runs them on every push, and additionally re-checks every week that the one-click install URLs in the README and deploy scripts are still reachable —
a broken link there never turns the build red, but it does break the very first thing a new user tries.

## License

[MIT](LICENSE)
