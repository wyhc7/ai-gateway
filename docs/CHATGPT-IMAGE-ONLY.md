# 只接 GPT 网页版生图（gpt-image-2）

> 目标：**只要生图**。文本对话一律不接，客户端只看到生图模型。
> 链路：`客户端 → ai-gateway（路由/Key 池/故障切换）→ chatgpt2api（私有协议转换层）→ chatgpt.com`
> 写代码的助手：`scripts/chatgpt-image.mjs`

---

## 0. 为什么必须多一层 chatgpt2api

chatgpt.com 的生图接口是私有的，网关硬啃不动：

| 环节 | 私有细节 | 网关侧复刻成本 |
|---|---|---|
| 请求前 | `backend-api/sentinel/chat-requirements` 拿 PoW token，再过 arkose | 高，且随时变 |
| 响应 | 私有 SSE，图片以 file 句柄分批下发 | 高 |
| 鉴权 | `access_token` + 浏览器指纹头 | 中 |

所以定位是：**chatgpt2api 干脏活，网关只做统一的 OpenAI 兼容入口 + 多 Key 轮询 + 冷却与故障切换**。
网关侧本来就支持 `/api/v1/images/generations`（`server/proxy.js` 的 `handleImages`），本次只补了两个洞（见第 5 节）。

---

## 1. 本机/服务器起 chatgpt2api

```bash
git clone https://github.com/basketikun/chatgpt2api.git
cd chatgpt2api
```

Docker（推荐）：

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/basketikun/chatgpt2api:latest
    ports: ["3000:3000"]
    environment:
      CHATGPT2API_AUTH_KEY: "<强密钥·随便设一个>"   # 网关就用它当 API Key
      HTTP_PROXY: "http://<支持区域出口>:<端口>"     # 需要出口时才写
      HTTPS_PROXY: "http://<支持区域出口>:<端口>"
```

```bash
docker compose up -d
curl http://localhost:3000/v1/models      # 通了再往下走
```

uv 方式：`uv sync && uv run main.py`，前端可选 `web/`。

**出口国家必须是 OpenAI 支持区**（美/日/新/韩等）。香港、台湾、大陆 IP 一律打不通，这点跟 Codex 通道一样。

---

## 2. 导入 ChatGPT 账号（只要生图权限的号）

1. 浏览器登录 `chatgpt.com`（**Plus / Team / Pro**，免费号生图额度基本为 0）
2. F12 → Application → Cookies → 复制 `access_token`
3. chatgpt2api 后台「账号」页 → access_token 导入 → 粘贴 → 保存
4. 后台点一次测试生图，确认这个号本身能出图

> 这一步跳过 device-code，所以不会触发手机号验证；token 过期时在 chatgpt2api 侧重导。

---

## 3. 网关侧建「只生图」平台

### 3.1 界面方式

平台管理 → 添加平台 → 选模板 **「ChatGPT 网页版（chatgpt2api）· 只生图」**：

| 字段 | 值 |
|---|---|
| 协议 | `openai-chat` |
| Base URL | `http://127.0.0.1:3000/v1`（跨机就写 `http://<IP>:3000/v1`） |
| 生图路径 | `/images/generations`（模板已填） |
| API Key | chatgpt2api 的 `CHATGPT2API_AUTH_KEY` |
| 模型 | `gpt-image-2`（已预填；Plus 号想要 Codex 生图再加 `codex-gpt-image-2`） |

不要点「拉取列表」去收全套模型——会把 `gpt-5` 之类对话模型也收进来，客户端就有机会把图片请求发到对话通道。

### 3.2 脚本方式（最快，一条命令）

```bash
export ADMIN_KEY=<网关管理密钥>        # server/data/config.json 里的 admin_api_key
export C2A_KEY=<chatgpt2api 的 auth-key>
node scripts/chatgpt-image.mjs onboard
```

脚本干的事：`POST /api/providers`（protocol/base_url/images_path/模型清单）→ `POST /api/providers/<id>/keys` 塞 Key。
已经有指向同一 base_url 的生图平台就改成更新，不会建重复。

### 3.3 纯 curl 等价物

```bash
curl -X POST http://127.0.0.1:3080/api/providers \
  -H "X-Admin-Key: <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{
    "name": "ChatGPT 网页版 · 只生图",
    "base_url": "http://127.0.0.1:3000/v1",
    "protocol": "openai-chat",
    "images_path": "/images/generations",
    "model_names": ["gpt-image-2"]
  }'

# 假设返回 id = <PID>
curl -X POST http://127.0.0.1:3080/api/providers/<PID>/keys \
  -H "X-Admin-Key: <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"api_key":"<C2A_AUTH_KEY>","name":"chatgpt2api"}'
```

---

## 4. 调用

### 4.1 文生图

```bash
curl -s http://127.0.0.1:3080/api/v1/images/generations \
  -H "Authorization: Bearer <GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"一只橘猫坐在窗台上，清晨侧光","n":1,"size":"1024x1024"}'
```

响应是上游原样：`{"data":[{"b64_json":"..."}]}` 或 `{"data":[{"url":"..."}]}`，网关一字不改。

### 4.2 图编辑（multipart）

```bash
curl -s http://127.0.0.1:3080/api/v1/images/edits \
  -H "Authorization: Bearer <GATEWAY_KEY>" \
  -F model=gpt-image-2 \
  -F prompt="给这只猫加一顶小红帽" \
  -F size=1024x1024 \
  -F image=@./cat.png
```

### 4.3 脚本

```bash
node scripts/chatgpt-image.mjs gen "一只橘猫坐在窗台上"
# → out/images/gen-2026-10-23T...-0.png

node scripts/chatgpt-image.mjs edit ./cat.png "加一顶小红帽"
node scripts/chatgpt-image.mjs models     # 只列生图模型
node scripts/chatgpt-image.mjs ping       # 上游 + 网关双向探活
node scripts/chatgpt-image.mjs probe      # 直连 chatgpt2api，绕开网关判断是谁的问题
```

参数可用环境变量覆盖：`GW_BASE` `GW_KEY` `ADMIN_KEY` `C2A_BASE` `C2A_KEY` `IMG_MODEL`
`IMG_SIZE`（默认 `1024x1024`）`IMG_N` `IMG_QUALITY` `IMG_TIMEOUT_MS`（默认 300000）。

### 4.4 给第三方客户端

base_url 填 `http://<网关>:3080/v1`，Key 填网关访问密钥。
**给这个场景单独发一把只放行 `gpt-image-2` 的访问密钥**——「只生图」就靠这把钥匙从权限上锁死，
比指望客户端自觉更硬。

```bash
curl -X POST http://127.0.0.1:3080/api/keys -H "X-Admin-Key: <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"生图客户端","allowed_models":["gpt-image-2"]}'
```

返回里的 `token` 只显示一次。

---

## 5. 本次改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `server/templates.js` | 新增模板 `chatgpt-image`「只生图」，模型只有 `gpt-image-2 / codex-gpt-image-2 / gpt-image-1`；`chatgpt-web` 补 `images_path` | 用户只拉生图模型，避免误用对话通道 |
| `server/index.js` | `CALL_PLAN_FIELDS` 补 `images_path` | 之前前端传了 `images_path` 会被白名单过滤静默丢掉，生图请求永远打到默认路径 |
| `scripts/chatgpt-image.mjs` | 新增 | 建平台 / 探活 / 生成 / 编辑 / 直连排障一条命令搞定 |
| `server/test/provider-images-path.test.js` | 新增 4 条断言 | 锁死上面两个洞，回归不再复发 |

生图超时保持 `IMAGES_TOTAL_TIMEOUT_MS` 默认 300 秒（`server/proxy.js`），
gpt-image-2 实测 30~90 秒，排队时更久；要改就设环境变量，不要动代码。

---

## 6. 排障表

| 现象 | 先查 | 处理 |
|---|---|---|
| `model_not_found` | `/v1/models` 里有没有 `gpt-image-2` | 平台没配模型，补 `model_names` 或点刷新 |
| `404` + 上游路径不对 | provider 的 `images_path` | 反代加前缀就写成 `/gpt/v1/images/generations` |
| `401` | chatgpt2api 的 `access_token` 过期 | chatgpt2api 后台重导 token |
| `403` | 号不是 Plus/Pro，或免费额度耗光 | 换号 |
| 502 / 卡 60 秒断 | 出口 IP 被 Cloudflare 拦 | 上 WARP 稳定代理（chatgpt2api 自带 compose） |
| `no_keys` 全部冷却 | 多个请求打到同一个号触发限流 | 加号池 Key，网关会轮询 + 冷却恢复 |
| 出图但内容为空 | 上游返回的是 file 句柄 SSE | 升级 chatgpt2api，`probe` 里能看到原始响应结构 |

`probe` 的判定逻辑：直连 chatgpt2api 能出图、走网关不能 → 网关侧问题（路径 / Key / 协议）；
两边都不出 → 账号或出口问题。别在网关里瞎改。
