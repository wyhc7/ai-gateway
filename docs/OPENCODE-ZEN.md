# OpenCode Zen 免费通道（zen-free）

一条**免凭据**的内置通道：不需要 API Key、不需要任何外部进程、不需要单独部署服务，
在「平台管理」里选一个模板即可用。

## 启用

**方式一：管理界面（推荐）**

平台管理 → 添加平台 → 预设模板选 **OpenCode Zen 免费通道** → 保存。
名称与地址已预填，模型列表已预置 8 个可用模型，**无需填写任何凭据**。

**方式二：环境变量自动初始化（一键部署脚本默认已开启）**

```bash
ZEN_AUTOSEED=1 node server/index.js
```

启动时若不存在该平台则自动创建；设成 `0` 或不设置则不自动创建。

各部署脚本（`docker-compose.yml`、`deploy/linux/*`、`deploy/macos/*`、
`deploy/windows/*`）都已经写好这个变量：**部署完打开管理界面就能看到这个平台**，
不需要手工添加。

在管理界面删掉它会写入 `zen_seed_dismissed` 标记，之后重启不会再被重建 ——
删除是一次性动作，不会自己复活。

**方式三：接口**

```bash
curl -X POST http://localhost:3001/api/providers \
  -H "Authorization: Bearer <管理密钥>" -H "Content-Type: application/json" \
  -d '{"name":"OpenCode Zen 免费通道","base_url":"https://opencode.ai/zen/v1","protocol":"zen-free"}'
```

创建后即可按普通 OpenAI 平台调用：

```bash
curl http://localhost:3001/api/v1/chat/completions \
  -H "Authorization: Bearer <网关 API Key>" -H "Content-Type: application/json" \
  -d '{"model":"nemotron-3-ultra-free","messages":[{"role":"user","content":"你好"}]}'
```

## 它为什么能免凭据

上游 `https://opencode.ai/zen/v1` 的免费档凭据是一个公开常量 `public`，
但它并不是"开放 API"——它是 **OpenCode 客户端专用通道**。上游没有任何办法证明
请求真的来自 OpenCode，只能检查请求本身长得像不像。准入判定全部落在 HTTP 请求里：

| 条件 | 不满足时 |
| ---- | -------- |
| `authorization: Bearer public` | 池化匿名凭据，缺失也能用 |
| `user-agent` 含 `opencode/<版本>`，版本 >= **1.18.0** | 低版本 → `426 UpgradeRequired`；无该 token → 403 |
| `x-opencode-client` / `-session` / `-request` / `-project` 四个头齐全 | 403 `FreeTierError` |
| `x-opencode-session` 匹配 `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/` | 格式非法 → 403 |
| `body.tools` 声明 **bash / glob / grep / read** 四个小写工具 | 403 `FreeTierError` |
| `body.stream === true` | 非流式 → 403 `FreeTierError` |

所以 `server/zen-lane.js` 要在转发前把普通 OpenAI 请求整形一遍：

- **补客户端指纹头**，会话 ID 本地铸造（上游只校验格式，不校验这个 ID 是否它发过的）
- **工具四件套**：客户端没带就补诱饵，带了同名但大小写不同就小写化，
  并在响应侧把名字**还原**回去 —— 调用方全程不知道自己的工具名被改过
- **强制流式**：客户端要非流式时，网关把上游 SSE 聚合成一次性 JSON 再返回
  （上游发的是 text/event-stream，不能直接甩给非流式客户端）

## 可用模型

开箱可用的种子列表：`nemotron-3-ultra-free`（综合最好）、
`nemotron-3.5-lightning-free`、`longcat-2.5-preview-free`、`mimo-v2.6-flash-free`、
`mimo-v2.5-free`、`ling-3.0-flash-fin-free`、`big-pickle`、`space-bunny-free`

上游的 `/models` 会把付费模型一并列出（实测 88 个里大部分是付费档），而那些模型用
公共凭据调用一律 401。列表本身**不标注免费与否**（每项只有 `id`/`object`/`created`/
`owned_by`），所以「哪些能用」没法从列表读出来，只能真发一次请求实测。

因此模型列表由三部分组成：

- **种子白名单**（`ZEN_FREE_MODELS`）：人工确认过可用的一份清单，保证全新安装开箱即用
- **实测收编**：`/models` 里**名字以 `-free` 结尾、且还没见过**的型号，点「刷新模型」
  时各发一个最小请求（`max_tokens: 1`，拿到状态码即断开）实测。200 的收编进列表并标记
  `free`；4xx 的记入 `zen_probe_cache`，12 小时内不再重测；5xx / 429 / 超时视为上游抖动，
  **不记档**，下次刷新重试。并发 3、单次上限 8 个、超时 12 秒
- **手工添加**：你手动填进模型列表的型号，只要上游还列着，刷新就不会把它冲掉

**所以上游新上免费型号时，点一次「刷新模型」就能拿到，不必等网关更新白名单。**
白名单由此退化成「种子 + 已确认可用项」，不再是唯一的准入名单。

判定为不可用的结论有 12 小时 TTL：上游今天 403 的型号明天放开了，也会被重新测出来。

用「刷新模型」时留意一点：探测本身会消耗免费额度（每次一个 `max_tokens: 1` 的请求），
且刷新耗时随候选数增加，最坏约 30 秒。

## 限制与注意事项

- **模型能力有限**：都是免费档小模型，长上下文与复杂推理明显吃力，别当生产主力
- **限时免费**：官方定位是"在 OpenCode 内试用"，随时可能调整准入条件或收紧额度；
  `426 UpgradeRequired` 就是版本门槛上调过的先例
- **配额按会话累计**：撞到过额度上限（`FreeUsageLimitError`），且换出口 IP 不一定重置
- **按出口地区放行**：部分模型（如 `muse-spark-*`）只在特定地区可用，会返回 403
- **人格残留**：模型知道自己在工具环境里，偶尔会提到"我的工具"，业务侧可用 system 消息压制
- **上游偶发挂死**：约每 100~120 个请求出现一次连接既不发数据也不关闭，
  转发层的空闲超时与重试会兜住（客户端无感）
- **反代他人服务存在条款风险**：这条通道本质上是把 OpenCode 客户端的免费额度
  挪作他用。请自行评估上游条款与封禁风险，仅限个人自用，勿对外提供服务

## 与「Zen 付费模型」的关系

Zen 上游不是一条端点，而是按模型分流：

| 端点 | 模型 |
| ---- | ---- |
| `/chat/completions` | DeepSeek / Kimi / GLM / MiniMax / Qwen3.8 Max，以及全部 free 模型 |
| `/responses` | GPT / Grok / Muse Spark |
| `/messages` | Claude |
| `/models/{id}` | Gemini |
| `/systemone` | Jev |

**本通道只覆盖免费档**，并且固定使用公共凭据 `public`。

想用 Zen 的付费模型（DeepSeek / Kimi / GLM 这些），必须有真实的 Zen API Key。
那种情况下**不要**选本协议：另建一个「OpenAI 兼容」平台，地址同样填
`https://opencode.ai/zen/v1`，协议选 `openai-chat`，填入你的 Key。
付费档不校验工具四件套、也不强制流式，走普通 openai-chat 才是对的 ——
把免费档的整形逻辑套到付费模型上只会画蛇添足。

一个平台只能配一个协议，所以表里其它端点（responses / messages / systemone）
需要各自建平台或另行适配。别指望 `/models` 列出来的模型全都可用。

## 这是反代吗

是。但它与项目里其它"逆向通道"（Grok/Codex 订阅、chatgpt2api）有一个关键区别：

| | 订阅账号通道 | 本通道 |
| --- | --- | --- |
| 需要凭据 | 需要（OAuth / token） | **不需要** |
| 需要外部进程 | chatgpt2api 需要单独部署 | **不需要，代码内置** |
| 失效方式 | 账号被封 | 上游调整准入条件 |

它复现的是**公开的请求格式**，没有绕过任何密码学认证或访问控制。
通道能用的前提是上游把准入判定放在请求特征上——这是上游的设计选择，
本通道只是把这个选择复现成了软件。

## 排错

| 现象 | 原因 |
| ---- | ---- |
| 403 `FreeTierError` | 指纹头或工具四件套没送到（改了 `extra_headers` 覆盖掉关键头？） |
| 426 `UpgradeRequired` | UA 里的版本号低于上游当前门槛，改 `extra_headers.user-agent` 提版本 |
| 401 | 选了付费模型，改用列表内的免费模型（名字像免费档但没被收编，说明实测没通过） |
| 403 `RegionError` | 该模型按出口地区放行，需配合 `HTTPS_PROXY` 换出口 |
| 非流式请求变慢 | 正常：上游只支持流式，网关要先聚合完整段再返回 |
