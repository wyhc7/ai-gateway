# 加号工具与排查脚本

这一组脚本解决四件事：**加号、算 2FA、诊断邮箱、体检加号用的节点**。
都放在 `scripts/`，凭据一律走环境变量或命令行参数，不写死在文件里。

---

## 0. node-check.mjs —— 加号前先看出口 IP

加号时 OpenAI 看到的是**你本机代理的出口 IP**，不是服务器的。
机场节点的 IP 大多已被公开标记为代理，这种 IP 上登录新号最容易触发风控。

```bash
node scripts/node-check.mjs --proxy http://127.0.0.1:7897
node scripts/node-check.mjs --proxy http://127.0.0.1:7897 --count 6   # 看轮换
```

输出里只看两行判断：

```
机房    否 ✓        ← 是的话是机房 IP，不像家宽
代理    否 ✓        ← 是的话被公开标成代理，别用
```

`--count` 还会告诉你这个节点是固定 IP 还是轮换的。

实测对比（同一个机场，不同节点）：

| 节点 | `hosting` | `proxy` | 结果 |
|---|---|---|---|
| 日本 Melbicom | false | **true** | 不顺，登录反复中断 |
| 台湾中华电信 | false | **false** | 一次就过 |

脚本用 `curl` 走代理：Node 原生 fetch 既不认 `HTTPS_PROXY`，
也没有内置 socks 支持，为一个体检脚本装 `undici` 不划算。

---

## 1. add-account.mjs —— 加号

把「生成授权链接 → 收 callback → 写进池子」收成三条命令。

```bash
# 1) 起会话，拿到授权链接
node scripts/add-account.mjs start --email a@b.com

# 2) 浏览器打开链接、登录、点 Authorize，把白屏页的地址栏整条复制下来
node scripts/add-account.mjs finish --session <上一步的 session> --callback '<整条地址栏>'

# 3) 看池子
node scripts/add-account.mjs list
```

管理密钥的读取顺序：

```
--admin-key 参数  >  ADMIN_API_KEY 环境变量  >  data/config.json
```

所以在服务器 `/opt/ai-gateway` 目录下直接跑，什么都不用传。

### 为什么中间还有人工一步

ChatGPT 的 OAuth 只允许回调到 `platform.openai.com/auth/callback`，
这个地址写死在客户端里，改了就是 `redirect_uri_mismatch`。
所以 `code` 永远只出现在**你的浏览器地址栏**里，只能由浏览器送回来。

工具负责前后两端：开头生成链接、结尾校验并落库。中间那一下交给浏览器。

### 内置的校验

`finish` 会先自己核对 `state` 前缀和 `--session` 是否对得上，对不上直接报错，
不会白跑一趟转换层。报错信息会指出「这条 callback 属于另一次授权」。

---

## 2. totp.py / add-account.mjs totp —— 2FA 出码

商家卖的号通常给的是 **Base32 密钥**（不是验证码），要配合标准 TOTP 出 6 位码。

```bash
# 两种实现，输出一致，随便挑
python scripts/totp.py <Base32 密钥>
node scripts/add-account.mjs totp --secret <Base32 密钥>
```

输出刻意用英文和 `key=value`：

```
code=262581
left=12s
```

原因是 Windows 中文终端会把 UTF-8 中文打成乱码，脚本解析会失败。
要机器读就用第一行。

参数固定为 SHA1 / 30 秒 / 6 位（RFC 6238 默认值），这也是市面上常见
TOTP 工具的默认设置。如果商家的码算出来对不上，先确认他们有没有改
周期或位数。

---

## 3. outlook-diagnose.py —— 邮箱链路诊断

「加了号但读不到验证码」时先跑这个，确认邮箱本身通不通。

凭据全部走环境变量：

```bash
export MS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export MS_REFRESH_TOKEN='<Microsoft refresh_token>'
export MS_EMAIL=someone@outlook.com
python scripts/outlook-diagnose.py
```

它会依次报告：

| 步骤 | 检查什么 |
|---|---|
| 1 | Microsoft `refresh_token` 还能不能换新 token |
| 2 | IMAP XOAUTH2 认证能不能过 |
| 3 | 收件箱里有没有 OpenAI 的验证码邮件，**收件人是谁** |

第 3 步的关键是**看收件人**：验证码可能压根没发到你手上那个地址。

可选的密码探测：

```bash
export MS_PASSWORD='...'
python scripts/outlook-diagnose.py --check-password
```

> 注意：微软已经停用了 `grant_type=password`（ROPC），
> 这条路返回 `AADSTS70003` 是**正常现象，不代表密码错**。
> 所以不要拿它来判断密码对不对——这也是为什么它默认不跑。

---

## 4. probe-openai-login.py —— 登录接口探测

判断「能不能脚本化登录 ChatGPT」，不提交任何凭据。

```bash
python scripts/probe-openai-login.py
```

**这个脚本的结论很明确：`auth.openai.com` 会被 Cloudflare 拦。**

```
HTTP 403   Server: cloudflare   标题: Just a moment...
```

所以纯 HTTP 脚本登录走不通。真正能过 Cloudflare 的是**真实浏览器**——
DSH 内置浏览器实测等待约 10 秒即自动通过，之后可以正常填表、点授权。

想自动化就得上 Playwright 之类带真浏览器的方案，而不是 `fetch`。

---

## 一次完整的加号流程

以带 2FA 的商家号为例：

```bash
# 1. 起会话
node scripts/add-account.mjs start --email <账号邮箱>
#    → 输出 session=xxx 和一条 authorize_url

# 2. 浏览器打开链接：填邮箱 → 填密码 → 填 2FA 码 → 点 Authorize
python scripts/totp.py <2FA密钥> --watch   # 边看边填
#    页面跳到 platform.openai.com/auth/callback?...（白屏正常）

# 3. 把整条地址栏交给工具
node scripts/add-account.mjs finish --session xxx --callback '<整条地址栏>'

# 4. 确认
node scripts/add-account.mjs list
```

`finish` 成功后会直接把账号池打出来，不用再单独查。

---

## 踩过的坑

| 坑 | 表现 | 解法 |
|---|---|---|
| Cloudflare | `403 Just a moment...` | 用真实浏览器，别用 HTTP 脚本 |
| `redirect_uri` 写死 | 改回调地址就 `redirect_uri_mismatch` | 接受它，callback 只能由浏览器送回 |
| `state` 不匹配 | `finish` 报错 | 别同时开两次授权，重新 `start` |
| 2FA 码过期 | 填进去报验证码错误 | 30 秒一轮，填之前现算 |
| 脚本登录 | 微软返回 `AADSTS70003` | ROPC 已停用，不代表密码错 |
| 中文乱码 | Windows 终端输出 `??` | 脚本输出统一用英文 |
| **点账户卡片跳 Google** | 授权页有「选择账户」，点了卡片却跳到 `accounts.google.com` | **必须点「使用其他账户」后手输邮箱**，别点卡片 |
| **会话超时被误报成密码错** | 在密码页报 `Incorrect email address or password`，但密码是对的 | `expires_in` 只有 600 秒。**先登录再起会话**，别在 2FA 页耗掉时间 |
| **`finish` 的字段名** | 传 `callback_url` 报「session_id 与 callback 都必填」 | 字段名是 `callback`，不是 `callback_url` |

### 两条流程上的经验

**1. 先登录，再起 OAuth 会话。**

会话只有 600 秒。如果在 2FA 页才开始算，取码、等下一轮 30 秒周期、
再填进去，很容易耗到超时 —— 而超时的报错是 `Incorrect email address or password`，
会让人误以为密码错了（实测踩过一次，白折腾十几分钟）。

正确顺序：先用邮箱密码正常登录进 ChatGPT → 再 `start` → 打开授权链接 →
因为已登录，点账户卡片直接就过（或者手输邮箱走一遍极快的流程）→ 拿 callback。

**2. 加号要拉开间隔。**

实测：45 分钟内连加 3 个号，全部在约 19 分钟后失效，错误是
`oauth_refresh_http_401: Your session has ended`。这三条不是账号本身坏，
是并发登录触发了上游的批量识别。

建议同一 IP 上 2 小时内只加 1 个号；批量进号就分天。

顺带一句：这条也和**加号时的出口 IP** 有关。实测两个节点对比很明显 ——
`proxy: true` 的机场节点（日本 Melbicom）加号不顺，换成
`proxy: false` 的台湾中华电信节点后一次就过。加号前先查一下 IP 属性，
见 `scripts/node-check.mjs`。
