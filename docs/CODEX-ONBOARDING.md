# Codex 接入速查卡（ai-gateway）

> 目标：把 ChatGPT Plus/Pro 订阅账号接入 ai-gateway 统一调度（protocol: `codex-oauth`）。
> 代码已就绪（commit `b8c0ba7`），本卡是**号到位后的 5 分钟执行流程** + 全部坑位记录。
> 实测日期：2026-09-02（本地 mock 全链路 ✅ / 真实设备码申请 ✅ / 浏览器授权 ❌ 卡手机号验证）

---

## 0. 状态总览

| 环节 | 状态 | 说明 |
|---|---|---|
| 网关代码（codex-oauth.js / codex-responses.js / UI） | ✅ | commit b8c0ba7 已部署生产 |
| 模板 `codex-oauth` | ✅ | chatgpt.com/backend-api/codex，默认模型 gpt-5.3-codex-spark ~ gpt-5.6-luna |
| 出网代理支持 | ✅ | commit c43acda：设 `HTTPS_PROXY` 即全局接管（含 auth.openai.com / chatgpt.com） |
| mock 上游全链路 | ✅ | 见 §5 复现方法 |
| 真实设备码申请 | ✅ | Clash 走支持区域节点即可通 |
| 浏览器授权（登录 ChatGPT） | ❌ | 卡 OpenAI 手机号风控；且**免费号调 codex API 会被订阅校验挡** |

**结论：万事俱备，唯一缺口 = 能登录的 ChatGPT 号（最好 Plus/Pro）。**

---

## 1. 两个硬前提

1. **真实 ChatGPT Plus/Pro 订阅号**（免费号无 Codex 权限）
   - 登录时可能触发手机号验证 → 需要能收码的海外手机号 / Google 账号路径 / 接码（OpenAI 对虚拟号风控严）
   - 授权前在 chatgpt.com → Settings → Safety 开启 **Allow device-code login**
2. **能直连 OpenAI 的代理出口**（OpenAI 支持区域：美/日/新/韩等，**不含** 香港/台湾/中国大陆）
   - 服务器（香港机房）与沙箱自带的代理都不行，必须用户自己的海外节点

---

## 2. 代理配置（最容易踩坑）

- 沙箱环境变量 `HTTPS_PROXY=http://127.0.0.1:56786` 是**沙箱自带代理，不出境**（出口=长沙）→ 网关默认走它必失败
- 用户 Clash 在 **`127.0.0.1:7897`**。Clash 是规则分流：ipinfo.io 可能走直连（显示 CN）但 **OpenAI 域名走海外节点**——所以：
  - ⚠️ **不要用 ipinfo 判断 OpenAI 可达性**（会误判）
  - ✅ 正确实测法：直接 POST 设备码端点，看是否返回 `device_auth_id`（见 §6 命令）
- 启动网关时显式指代理：
  ```bash
  HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PORT=3001 node server/index.js
  ```
  日志出现 `[proxy] 全局出网代理已启用: ...` 即生效。

---

## 3. 服务器端（生产）接入流程

```bash
# ① 给 systemd 服务加代理环境变量并重启（等效 Grok 已验证路径）
#    在服务单元加：Environment="HTTPS_PROXY=http://<海外代理>:<port>"
sudo systemctl daemon-reload && sudo systemctl restart <gateway-service>

# ② 建 codex 平台（管理端 API，X-Admin-Key 头）
curl -X POST <BASE>/api/providers -H "X-Admin-Key: <ADMIN>" -H "Content-Type: application/json" \
  -d '{"name":"Codex 订阅","base_url":"https://chatgpt.com/backend-api/codex","protocol":"codex-oauth"}'
#     → 响应里记下 provider id；模型列表自动预填，无需手填

# ③ 申请设备码（网关发起，走代理到 auth.openai.com）
curl -X POST <BASE>/api/oauth/codex/device/start -H "X-Admin-Key: <ADMIN>"
#     → {"session_id":"cx-...","user_code":"XXXXX-XXXXX","verification_uri":"https://auth.openai.com/codex/device","expires_in":901,...}

# ④ 把 user_code 给号主：浏览器（走代理）打开 verification_uri → 输码 → 登录 ChatGPT → Allow
#     ⏱ 15 分钟有效，授权前确认已开 device-code login

# ⑤ 轮询换 token（403=pending 属正常，隔 5s 重试）
curl -X POST <BASE>/api/oauth/codex/device/<session_id>/poll -H "X-Admin-Key: <ADMIN>"
#     → 成功返回 access_token / refresh_token / expires_in / account_id（从 id_token 解析）

# ⑥ key 落库（account_id 建议带上，上游 ChatGPT-Account-Id 头要用）
curl -X POST <BASE>/api/providers/<provider_id>/keys -H "X-Admin-Key: <ADMIN>" -H "Content-Type: application/json" \
  -d '{"type":"oauth","provider":"codex","name":"订阅号-1","access_token":"<AT>","refresh_token":"<RT>","expires_in":<SEC>,"account_id":"<AID>","email":"<EMAIL>"}'
#     ⚠️ provider 必须显式传 "codex"（不传默认 grok）

# ⑦ 对话验证（网关 key 从 GET /api/gateway 取，字段 api_key；调用走 /api/v1 不是 /v1）
curl <BASE>/api/v1/chat/completions -H "Authorization: Bearer <GATEWAY_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"你好"}]}'
```

---

## 4. 关键端点速查

| 用途 | 端点 |
|---|---|
| 网关 key | `GET /api/gateway`（X-Admin-Key）→ `.api_key` |
| 对话 | `<BASE>/api/v1/chat/completions`（Bearer 网关 key） |
| models | `<BASE>/api/v1/models` |
| 建平台 | `POST /api/providers`（name/base_url/protocol 必填） |
| 加 key | `POST /api/providers/:id/keys` |
| 设备码申请 | `POST /api/oauth/codex/device/start` |
| 授权轮询 | `POST /api/oauth/codex/device/:sessionId/poll` |
| codex 默认值 | `GET /api/oauth/codex/defaults` |
| OAuth 端点（上游） | `POST auth.openai.com/api/accounts/deviceauth/usercode`（无 client_id） |
| 刷新凭据 | `POST /api/oauth/codex/accounts/:providerId/:keyId/refresh` |

---

## 5. mock 上游复现（无号验证网关链路）

```bash
cd server
node _mock_codex_upstream.mjs          # 模拟 codex Responses API，127.0.0.1:13999
# 另开终端：
HTTPS_PROXY= PORT=3001 node index.js   # 本地 mock 无需代理
# 建平台时 base_url 指向 http://127.0.0.1:13999，protocol 仍为 codex-oauth
# 加 key 用假 token 即可（如 mock_at_abc123 / mock_rt_xyz）
# 之后对话/流式/models 全通即网关侧 OK
```

---

## 6. 代理可达性实测命令（别用 ipinfo）

```bash
# 走 7897 打设备码端点：返回 device_auth_id+user_code = 通；Country not supported = 节点区域不行
curl -x http://127.0.0.1:7897 -X POST https://auth.openai.com/api/accounts/deviceauth/usercode \
  -H "Content-Type: application/json" -H "Origin: https://chatgpt.com" -d '{}'
```

---

## 7. 坑位清单（全部实测踩过）

1. **免费号**：能授权成功拿 token，但调 `backend-api/codex` 会被订阅校验挡下 → 别浪费时间，直接上订阅号
2. **手机号风控**：国内网络/新环境登录 ChatGPT 必触发手机验证，没海外号登不进
3. **代理区域**：香港/台湾/大陆 IP 全被 OpenAI 封（`Country, region, or territory not supported`）
4. **沙箱 56786 vs 用户 7897**：56786 不出境；网关必须显式指 7897 或用户自己的海外节点
5. **ipinfo 误导**：规则分流下 ipinfo 显示 CN 不代表 OpenAI 不通，反之亦然 → 直接打设备码端点
6. **授权码 15 分钟过期**：过期要重新 device start
7. **provider 字段**：加 codex key 时 `provider:"codex"` 不传默认变 grok
8. **poll 的 403**：pending 阶段上游返回 403 是正常状态机（跟 Grok 设备码不同，codex 用 JSON 端点两步换 token）
9. **device-code login 开关**：ChatGPT Settings → Safety，没开授权页会报错
