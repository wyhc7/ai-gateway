# ChatGPT 网页/手机版接入速查卡（ai-gateway + chatgpt2api）

> 目标：把 **ChatGPT 网页版 / 手机版**账号接入 ai-gateway 统一调度（对话、生图、联网搜索）。
> 与 Codex 接入的区别：Codex 走 `backend-api/codex` 编程通道（device-code OAuth，见 `CODEX-ONBOARDING.md`）；
> 本卡走 chatgpt.com 的**对话/生图通道**，用 **access_token 直导入**——可绕过 device-code 的手机号验证。
> 实测日期：2026-09-02（ai-gateway 转发层已 mock 全链路验证 ✅）

---

## 0. 为什么不直连 chatgpt.com，而组合 chatgpt2api

chatgpt.com 的对话接口（`backend-api/conversation`）是**私有协议**：
- 请求前要过 **sentinel / arkose 反滥用挑战**（`/backend-api/sentinel/chat-requirements` 拿 PoW token）
- 响应是 **私有 SSE 格式**，需完整解析
- 这些逻辑在 chatgpt2api 里是几百行 Python 逆向，在网关里复刻不划算且易碎

→ 复用当初给 Grok 定的「**组合架构**」思路：**ai-gateway 做统一调度 + 负载均衡，chatgpt2api 做 ChatGPT 私有协议 → OpenAI 兼容的转换层**。ai-gateway 侧**零代码改动**（已新增 `chatgpt-web` 模板，protocol=openai-chat）。

```
ChatGPT 账号(access_token)
        │ 导入
   chatgpt2api (本机 Docker/uv, :3000/v1  OpenAI 兼容)
        │  base_url 指向
   ai-gateway (chatgpt-web 平台, openai-chat 协议)
        │  /api/v1/chat/completions
   你的客户端 / 下游应用
```

---

## 1. 本地部署 chatgpt2api

> ⚠️ 沙箱 / 服务器均**无 Docker**，chatgpt2api 必须跑在**你本机**（Windows 装 Docker Desktop 或 uv+Python）。
> 端口默认 3000（Web 面板 + API 同端口，API 路径 /v1）。

### Docker（推荐，本机有 Docker Desktop）

```bash
git clone https://github.com/basketikun/chatgpt2api.git
cd chatgpt2api
# 先在 config.json 设 auth-key（或 docker-compose.yml 里设 CHATGPT2API_AUTH_KEY）
docker compose up -d
# API: http://localhost:3000/v1
```

### uv（本机有 Python）

```bash
git clone https://github.com/basketikun/chatgpt2api.git
cd chatgpt2api
uv sync && uv run main.py
# 前端 web/ : bun install && bun run dev（可选）
```

### 稳定代理（可选）

图片链路常被 Cloudflare 拦，可启用 `docker-compose.warp.yml`（WARP + Privoxy + FlareSolverr）。

---

## 2. 导入 ChatGPT access_token（绕开手机号）

chatgpt2api 不要求走 device-code 登录，**直接粘贴已有的 ChatGPT access_token** 即可：
- 来源：浏览器登录 chatgpt.com 后 F12 → Application → Cookies → `access_token`（或 Authorization 头）；手机 App 已登录号可抓包提取
- 导入方式：后台「账号」页支持 access_token 导入 / CPA 文件 / sub2api 服务器 / 远程 CPA
- 账号需 **Plus / Team / Pro**（免费号生图受限；对话额度按订阅）

> 这正是相对 Codex device-code 流程的优势：**已有登录会话就能用，不触发手机号验证**。

---

## 3. ai-gateway 平台配置（零代码改动）

新建平台时选模板 **`ChatGPT 网页/手机版（chatgpt2api）`**（已内置，group=本地中转）：
- protocol: `openai-chat`（OpenAI 兼容，ai-gateway 默认协议）
- base_url: `http://127.0.0.1:3000/v1`（chatgpt2api 改端口时同步改这里）
- api_key: chatgpt2api 的 `auth-key`（请求头 `Authorization: Bearer <auth-key>`）
- 模型：默认预填 gpt-5 / gpt-5-mini / gpt-image-2 等，也可从 /v1/models 拉取

或 API 创建：
```bash
curl -X POST <GATEWAY>/api/providers -H "X-Admin-Key: <ADMIN>" -H "Content-Type: application/json" \
  -d '{"name":"ChatGPT 网页版","protocol":"openai-chat","base_url":"http://127.0.0.1:3000/v1","api_key":"<C2A_AUTH_KEY>"}'
```

对话验证（网关 key 从 `GET /api/gateway` 取 `.api_key`）：
```bash
curl <GATEWAY>/api/v1/chat/completions -H "Authorization: Bearer <GATEWAY_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"你好"}]}'
```

---

## 4. 支持的模型（chatgpt2api 暴露）

`gpt-image-2`、`codex-gpt-image-2`、`auto`、`gpt-5`、`gpt-5-1`、`gpt-5-2`、`gpt-5-3`、`gpt-5-3-mini`、`gpt-5-mini`
- 生图 / 编辑走 `/v1/images/generations`、`/v1/images/edits`
- 联网搜索走 `tools: web_search`
- Codex 生图（`codex-gpt-image-2`）仅 Plus/Team/Pro

---

## 5. 坑位清单

1. **部署位置**：chatgpt2api 可跑本机或任意有 Docker 的服务器；若放原香港服务器会因 IP 被 OpenAI 封而失败，建议放出口在支持区域的服务器或给容器配代理；ai-gateway 与 chatgpt2api 需网络互通
2. **端口冲突**：chatgpt2api 默认 3000，ai-gateway 平台 base_url 要对应；改端口同步改
3. **access_token 失效**：ChatGPT token 有时效，chatgpt2api 号池支持自动刷新/重登；token 失效时对话报错需在 chatgpt2api 侧更新
4. **sentinel/arkose**：chatgpt2api 内部处理，用户无感；若频繁 401 多为 Cloudflare 拦，上 WARP 稳定代理
5. **免费号限制**：免费 ChatGPT 号生图额度极低/受限，对话也可能受限；优先 Plus/Pro
6. **与 Codex 通道区别**：本卡是 chatgpt.com 对话/生图，不是 Codex 编程（`backend-api/codex`）；两者账号体系相通（同一订阅），但走不同上游、不同模型
7. **合规风险**：chatgpt2api 是对官网接口的逆向，项目声明仅供个人学习、存在封号风险；勿用重要/常用号

---

## 6. 部署到另一台服务器（远程）

比本机更优：原香港服务器 IP 被 OpenAI 封，chatgpt2api 访问 chatgpt.com 同样会失败；放另一台出口在支持区域的服务器即绕过。

### 前提（最关键）
chatgpt2api 容器访问 chatgpt.com 的出口必须在 OpenAI 支持区域（美/日/新/韩等），否则被封。两种满足方式：
- **A. 服务器本身在支持区域**：直接 Docker 跑，无需额外代理
- **B. 服务器在任意地区，但给 chatgpt2api 配代理**：容器 env 设 `HTTP_PROXY`/`HTTPS_PROXY` 指向支持区域节点（WARP、或你的 Clash 节点）；chatgpt2api 自带 WARP 方案 `docker-compose.warp.yml`

> 注意：ai-gateway 调 chatgpt2api 是**服务器间直连**，ai-gateway 本身不需要代理（chatgpt.com 的流量已由 chatgpt2api 侧代理处理）。

### 与 ai-gateway 连通
- chatgpt-web 平台 base_url 改为 `http://<另一台服务器IP>:3000/v1`（不要用 127.0.0.1）
- 两台服务器需互通：同厂商内网最佳；跨公网需开放防火墙 3000 端口
- 安全：防火墙只放行 ai-gateway 服务器 IP；auth-key 设强；公网建议套 HTTPS 或隧道（frp / Cloudflare Tunnel），避免 key 明文暴露

### 远程 docker compose 示例（方案 B，容器走代理）
```yaml
services:
  app:
    image: ghcr.io/basketikun/chatgpt2api:latest
    ports: ["3000:3000"]
    environment:
      CHATGPT2API_AUTH_KEY: "<强密钥>"
      HTTP_PROXY: "http://<代理IP>:<端口>"    # 支持区域的 WARP / Clash 节点
      HTTPS_PROXY: "http://<代理IP>:<端口>"
```

部署后：另一台 `curl http://localhost:3000/v1/models` 通 → ai-gateway 改 base_url → 导入 access_token → 对话。
