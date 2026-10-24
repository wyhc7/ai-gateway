# AI Gateway

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/wyhc7/ai-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/wyhc7/ai-gateway/actions/workflows/ci.yml)

A **zero external dependencies, out-of-the-box** self-hosted AI relay gateway: no database, no Redis, just one JSON config file. Visual platform management, multi-key automatic failover, automatic model discovery, real dashboard statistics, and token usage tracking. It works with both regular OpenAI-compatible providers and **ChatGPT / Grok / Codex subscription accounts** (OAuth or access_token import), scheduling them all behind a single OpenAI-compatible endpoint.

> "Zero dependencies" here means **no external services** (database, cache, message queue) — you still need `npm run install:all` once to install npm packages.

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

- **25+ platform templates** — OpenAI-compatible providers (DeepSeek, Qwen, Gemini, SiliconFlow, OpenRouter, etc.) and ChatGPT web (chatgpt2api, image generation only), one-click setup
- **Automatic failover** — rotates to the next key automatically when a platform key becomes unavailable, requests are never interrupted
- **Tiered cooldown with half-open probing** — distinguishes key-level failures (401/403, long cooldown) from upstream hiccups (5xx/rate limits, short cooldown with a cap on how many keys cool down at once); once a cooldown is half over, one probe request is let through so recovery is immediate
- **Automatic model discovery** — fetch a platform's available model list with one click after entering an API key
- **ChatGPT account pool management** — add accounts straight from the dashboard and see each account's remaining image quota, reset time and renewal status; OAuth is preferred so you get a `refresh_token` and automatic renewal, and multiple accounts share the load round-robin (see [ChatGPT web](#chatgpt-web-image-generation-only))
- **Access keys with per-key model scoping** — issue a separate key to each caller and restrict which models it may use (`gpt-*` wildcards supported), with enable/disable, expiry, rotation, and per-key usage counters (see [Access keys](#4-access-keys-per-caller-permissions))
- **One-click update and upgrade** — the dashboard compares your deployment's git HEAD against the upstream branch, lists the incoming commits and their blast radius, then pulls, merges, installs, builds and restarts on one click; file ownership is repaired first so leftovers from a past root build no longer cause `EACCES` (see [System update](#system-update-one-click-upgrade))
- **Token accounting** — prefers the upstream `usage` field; falls back to estimating from output length (reasoning included) when upstream omits it, so counts are never silently missed
- **Dashboard statistics** — request volume, success rate, token usage (daily/total), key health status, auto-refresh every 10 seconds
- **Fully OpenAI API compatible** — works with any OpenAI SDK / client seamlessly, no code changes required
- **Reasoning passthrough** — streaming and non-streaming responses are forwarded intact, including reasoning output such as DeepSeek R1's `reasoning_content`
- **Egress proxy support** — set `HTTPS_PROXY` / `HTTP_PROXY` to route all outbound traffic through a proxy, so restricted networks (some datacenters, proxy-only egress) can still reach upstream
- **Dark-theme responsive UI** — works on both desktop and mobile

## Quick Start

Requires **Node.js 18+** (global `fetch`, `AbortSignal.timeout` and the built-in test runner are used).

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

> You can start the backend without building the frontend: every `/api/*` route works, only opening the site in a browser returns 404. API-only deployments can skip the `web` build.

### Environment Variables

| Variable | Default | Description |
| ---- | ------ | ----------- |
| `PORT` | `3001` | Listening port |
| `DATA_DIR` | `server/data` | Data directory (contains platform keys — back it up!) |
| `WEB_DIST` | `web/dist` | Frontend build output directory |
| `ADMIN_KEY` | auto-generated | Admin dashboard login key, see below |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Route Node's global fetch through a proxy (required for upstream access on restricted networks) |

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

## Subscription Account Access (OAuth / Reverse-Engineered Channels)

The gateway does more than API keys — it can treat **subscription accounts** as upstreams and schedule them uniformly. See [docs/MODEL-ACCESS-GUIDE.md](docs/MODEL-ACCESS-GUIDE.md) for a comparison of the three channels.

### Gemini (easiest)

Google's official OpenAI-compatible endpoint. Pick the `Google Gemini` template and paste an [AI Studio API key](https://aistudio.google.com/apikey). No regional blocking (only the GFW inside mainland China, which `HTTPS_PROXY` can handle), and there is a free tier.

### Codex (ChatGPT Plus/Pro coding agent)

Pick the `Codex subscription` template → device-code OAuth (open `auth.openai.com/codex/device` in a browser and confirm with the subscription account). The gateway converts between the Responses API and chat/completions in both directions. Details in [docs/CODEX-ONBOARDING.md](docs/CODEX-ONBOARDING.md).

### ChatGPT web (image generation only)

Talks the private `chatgpt.com/backend-api/conversation` protocol, so it needs [chatgpt2api](https://github.com/basketikun/chatgpt2api) as a reverse proxy exposing an OpenAI-compatible endpoint, then the `ChatGPT web (chatgpt2api) · image-gen` template. One-click deploy script: [scripts/deploy-chatgpt2api.bat](scripts/deploy-chatgpt2api.bat); details in [docs/CHATGPT2API-ONBOARDING.md](docs/CHATGPT2API-ONBOARDING.md).

**Always add accounts through OAuth, never by pasting a bare access_token.** This decides whether the account survives past ten days:

| How the account was added | Gets a `refresh_token` | After expiry |
| ------------------------- | ---------------------- | ------------ |
| **OAuth (recommended)** | ✅ yes | Renews automatically, usable long-term |
| Pasting an access_token | ❌ no | The access_token expires (~10 days) and the account is dead — re-add it |

The dashboard's "Manage accounts" dialog walks through the full OAuth flow; once authorized you can click a browser bookmarklet to send the callback back in one click instead of copying the address bar. A command-line equivalent lives in [docs/ACCOUNT-TOOLS.md](docs/ACCOUNT-TOOLS.md).

Also note that `chatgpt2api` ships with `auto_remove_invalid_accounts` **on**, meaning an account is **deleted outright** the moment a renewal fails instead of being flagged as unhealthy — which makes incidents impossible to diagnose after the fact. Recommend turning it off in `/opt/chatgpt2api/config.json`:

```json
"auto_remove_invalid_accounts": false
```

#### Generating images

The model is fixed to `gpt-image-2` behind the standard OpenAI `/v1/images/generations` route:

```bash
curl -X POST http://localhost:3001/api/v1/images/generations \
  -H "Authorization: Bearer <gateway API key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a shiba inu under a cherry tree","n":1,"size":"1024x1024"}'
```

Decode `data[0].b64_json` and you have a PNG. Generation takes **16–25 seconds**, so set client timeouts to 60 s or more — the default will fail every time. Full parameters, examples in four languages and an error-to-cause table are in [docs/API-CALL-GUIDE.md](docs/API-CALL-GUIDE.md); the account pool and quota mechanics are in [docs/CHATGPT-IMAGE-ONLY.md](docs/CHATGPT-IMAGE-ONLY.md).

> Note: the upstreams behind Codex and ChatGPT web are sensitive to egress region. The server must be able to egress from an OpenAI-supported region (US/JP/SG/KR), otherwise it gets blocked. Combine with the egress proxy section below.

## Egress Proxy (required on restricted networks)

Some datacenters and local networks cannot reach upstreams directly (for example, Hong Kong datacenter IPs get blocked by Cloudflare / OpenAI). On startup the gateway detects `HTTPS_PROXY` / `HTTP_PROXY` and takes over Node's global fetch via undici's ProxyAgent — covering every upstream, including Grok OAuth's auth domain and Codex's chatgpt.com. When unset it is a zero-overhead no-op.

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 node server/index.js
```

- Only proxies **gateway → upstream** traffic; client → gateway requests are unaffected
- Tune the connect timeout with `PROXY_CONNECT_TIMEOUT_MS`

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

### 4. Access keys (per-caller permissions)

Don't hand out the master key. Create a separate access key for each caller under "Access Keys" and scope which models it may use:

| Capability | Notes |
| ---- | ---- |
| Allow / deny rules | Exact names (`gpt-4o`), wildcards (`gpt-*`, `*-free`, `claude-*-latest`) or `*`. Leave the allow list empty to permit everything |
| Deny list | Takes precedence over the allow list — useful for "open up a family, block the expensive one" |
| Disable / expiry | A disabled key gets a 403 immediately; expiry timestamps are enforced |
| Per-key usage | Request, failure, and token counters per key; request logs record which key made the call |
| Rotation | Issues a new secret while keeping scope and counters; the old one dies instantly |

A scoped caller only sees its own models in `/v1/models`, and using a model outside its scope returns an explicit 403 (`"type": "model_forbidden"`).

Two deliberate trade-offs:

- **The plaintext secret is shown only once**, at creation or rotation — the server stores just a SHA-256 digest. Lost keys must be rotated, never recovered, so a leaked `config.json` does not also leak usable client keys.
- **Auth covers both `/api/v1/*` and `/v1/*`** (the latter is what many third-party clients use). Older versions only guarded `/api/v1/*`, which let a scoped key bypass its restrictions by changing the path prefix — if an old client of yours uses `/v1` without a key, add one after upgrading.

## Public Network Access

See the public access tutorial in [DEPLOYMENT.md](docs/DEPLOYMENT.md):

- Tailscale (recommended)
- Cloudflare Tunnel
- frp
- DDNS

## System Update (one-click upgrade)

The dashboard's "System Update" page compares the deployment's git HEAD with the upstream branch and lists the commits behind, the changed files and their blast radius; on confirmation it updates and restarts in one go. A dot appears on that sidebar entry whenever an update is available.

```bash
# Same pipeline from the command line; deployments that are not git repos (Docker, manual copies) go this way
sudo bash deploy/linux/complete-deploy.sh --update
```

The design is deliberately conservative — a button on a web page should not be able to break the server:

- **Fast-forward only** (`git merge --ff-only`), never `reset --hard`, never overwrites local changes on the server
- **Refuses outright when the work tree is dirty**, naming the offending files and handing the decision back to you
- **Trims steps by blast radius**: backend-only JS changes skip the frontend build, cutting an update from a minute to seconds; dependencies are reinstalled only when `package.json` / `package-lock.json` changed, so new code cannot fail to import a package that was never installed
- **Restarts via `systemctl --no-block`**: waiting synchronously means systemd's stop of this very service interrupts the restart we just requested, leaving the service stopped
- **Uses `uptime` going backwards to detect restart completion**: the old process still answers right after a restart is issued, so probing `/api/health` alone would wrongly report "it's back already"
- **Labels post-merge failures explicitly**: it tells you "the code is in, fix and retry" rather than implying you have to start over
- **Repairs file ownership before updating**: if files owned by root ever leaked into a deployment directory whose service runs as a normal user, `vite build` hits `EACCES: permission denied, unlink` when overwriting old artifacts. The update pipeline scans for foreign owners **before** `git fetch` and re-`chown`s them back to the service user — running as root it fixes them itself, running as a normal user it uses a narrowly scoped sudo rule (see [docs/DEPLOY-OWNERSHIP.md](docs/DEPLOY-OWNERSHIP.md)). A failed repair never aborts the update; it just records why.

| Variable | Default | Description |
|---|---|---|
| `UPDATE_REPO_DIR` | `server/..` | Git repo root to compare against |
| `UPDATE_BRANCH` | `main` | Upstream branch to compare with |
| `UPDATE_SERVICE` | `ai-gateway` | systemd unit restarted after the update |
| `UPDATE_NO_RESTART` | unset | Set to `1` to update code without restarting |

Not a git repo, no `origin`, fetch failures and the like all produce a concrete reason and a fallback on the page — never a silent failure.

## Project Structure

```
server/        — Node.js backend (Express)
  index.js     — API routes + auth
  proxy.js     — model matching, failover, forwarding, protocol conversion
  api-keys.js  — access keys: model rule matching, auth resolution, usage counters
  chatgpt-accounts.js — ChatGPT account pool proxy: allowlisted forwarding, quota normalization, redaction
  providers-image-only.js — model filtering for image-generation-only platforms
  ownership.js — repairs file ownership before updates (avoids EACCES from root builds)
  store.js     — config persistence and statistics
  update.js    — system update: repair ownership, compare upstream commits, trim steps, fast-forward merge, restart
  templates.js — 25+ platform templates
  codex-oauth.js / codex-responses.js — Codex device-code auth + bidirectional Responses conversion
  oauth.js     — Grok subscription OAuth
  test/        — integration tests
web/           — Vue 3 + Element Plus admin dashboard
deploy/        — deployment scripts and configs for each platform
scripts/       — helper scripts: account add tool, TOTP generator, mailbox diagnostics, chatgpt2api deploy, smoke tests
docs/          — deployment and onboarding docs (including quick-reference cards per subscription channel)
```

## Development

```bash
# Run the backend integration tests (Node's built-in test runner, no extra dependencies)
npm test --prefix server

# End-to-end smoke test for access keys (real process + mock upstream, over HTTP; manual)
node scripts/smoke-api-keys.mjs

# ChatGPT account add (start session / submit callback / list pool / compute 2FA)
node scripts/add-account.mjs start  --email a@b.com
node scripts/add-account.mjs finish --session <sid> --callback '<browser address bar>'
node scripts/add-account.mjs list
node scripts/add-account.mjs totp   --secret <Base32 secret>
```

Full notes on the account and diagnostic scripts are in [docs/ACCOUNT-TOOLS.md](docs/ACCOUNT-TOOLS.md), which also records the fact that `auth.openai.com` is blocked by Cloudflare — scripted login does not work there and a real browser is required.

Tests spin up a local mock upstream and cover the core paths: failover, streaming passthrough, token accounting, and model allowlist enforcement.
`test/api-keys.test.js` additionally covers access-key rule matching, digest-only storage (asserting the plaintext never hits disk),
the disable/expiry/rotation lifecycle, and that a scoped key hitting a forbidden model gets a 403 without ever reaching the upstream.
CI runs them on every push, and additionally re-checks every week that the one-click install URLs in the README and deploy scripts are still reachable —
a broken link there never turns the build red, but it does break the very first thing a new user tries.

## License

[MIT](LICENSE)
