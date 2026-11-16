# 上下文档位与长上下文超时

对应 `server/workbuddy-core.js`（目录）、`server/workbuddy-lane.js`（整形）、`server/proxy.js`（计时）。

## 一、多档上下文

### 事实

上游对部分模型下发多个上下文档位（2026-11-16 抓包，`www.codebuddy.cn` 企业模型端点）：

```json
"glm-5.3": {
  "maxInputTokens": 1000000,
  "maxOutputTokens": 64000,
  "contextWindow": { "defaultLength": 300000, "supportedLengths": [300000, 600000, 1000000] }
}
```

只有一档的模型（如 `glm-4.6`、`glm-5.0`）不给 `contextWindow`，只有 `maxInputTokens`。

### 以前的问题

`normalizeModel` 只取 `contextWindow.defaultLength`，把 `supportedLengths` 整个丢掉。
官方客户端里能选 300K / 600K / 1M，到了网关只显示一个 300K，看起来像「网关不支持」。

### 现在

目录里多一个字段：

```json
{ "id": "glm-5.3", "context": 300000, "context_options": [300000, 600000, 1000000] }
```

- `context` 仍是默认档（`defaultLength`，取不到时回落 `maxInputTokens`）
- `context_options` **只在多于一个档位时**才写（只有一个值时「可选」没有意义）
- 前端模型列表显示成 `300K · 可选 300K/600K/1M`

调用时点档：

```json
POST /v1/chat/completions
{ "model": "glm-5.3", "context_length": 1000000, "messages": [...] }
```

网关把它换成上游认的 **camelCase** `contextLength` 再发。

### ⚠️ 一条必须记住的边界

**只发上游声明过的值。**

实测：给 `deepseek-v4-flash`（档位 `[300000, 1000000]`）传 `contextLength: 600000`，
上游回 `403 / 11140 request illegal`，而这条错误的 `displayMsg` 与账号风控同形：

```
"displayMsg": {"zh": "账号存在异常行为，已被限制使用"}
```

也就是说，**发错一个数字可能让账号看起来像被风控了**。所以：

- 校验在本地做（`pickWorkbuddyContextLength`），不在上游试错；
- 不在档位表里 → 摘掉字段、回退默认档，并给出可读原因；
- 模型没有档位信息 → 一个字段都不发。

日志里会说明原因（如 `context_length=400000 不在可选档位（300000 / 600000 / 1000000）内，已回退默认档`）。

## 二、长上下文超时

### 现象

上下文一长就报「上游请求超时」。

### 根因

不在总时长，在**单次等响应头**的 80 秒（`CONNECT_TIMEOUT_MS`）。

大上下文请求发出后，上游要先把整个输入 prefill 完才吐第一个字节，这期间一个包都不发。
30 万 token 在腾讯侧要几十秒到几分钟，80 秒一到网关就掐断连接、记成一次超时，
换 Key 重来 —— 同一段大输入重试依旧超时。

### 修复

等响应头的预算随输入规模放大：

```
基础 80s + 每 1 万输入 token 再加 3s，上限 10 分钟
```

| 输入 | 旧预算 | 新预算 |
|---|---|---|
| 1K token | 80s | 80s |
| 30 万 token | 80s | 170s |
| 96 万 token | 80s | 368s |

同时两处配套修正：

1. **总预算改到序列化之后算**。整形会按模型元数据补 `max_tokens`
   （补在副本上，原始 body 不变），原来按客户端传的值算，workbuddy 这类
   「客户端不传 max_tokens」的渠道永远拿到 2 分钟兜底值 —— 长回答被拦腰截断。
2. **全程预算至少容得下两次尝试**（`connectBudgetMs * 2`），
   否则第一次刚超时、第二次就被「累计预算用完」拦下，白白浪费换 Key 的机会。

### 报错文案

超时不再只有一句「上游请求超时」，会带阶段与规模：

```
上游请求超时：143 秒内没有开始响应（输入约 210051 tokens，长上下文预填充可能超过预算；
可用 CONNECT_TIMEOUT_MAX_MS / PRE_HEADER_MS_PER_10K_TOKENS 调大）
```

```
等待响应头超过 340 秒（输入约 210051 tokens，已尝试 3 个 Key）
```

### 调参

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 80000 | 等响应头的基础预算 |
| `PRE_HEADER_MS_PER_10K_TOKENS` | 3000 | 每 1 万输入 token 追加的毫秒数 |
| `CONNECT_TIMEOUT_MAX_MS` | 600000 | 单次等响应头的硬上限 |
| `PRE_HEADER_TIMEOUT_MS` | 200000 | 等响应头的全程下限 |

只想对长上下文更宽容，改 `PRE_HEADER_MS_PER_10K_TOKENS` 即可，其它不用动。

## 三、顺带修的：`X-Product-Code`

`workbuddy-core.js` 里 `HTTP_HEADER_PRODUCT_CODE` 一直只定义、从未发出去。
实测 `/v2/chat/completions` 不带它时基线请求回 `403 / 11140`，补上
`X-Product-Code: codebuddy` 后同一账号同一请求回 `200`。

现在按账号 realm 取产品身份（国内 `codebuddy`、国际 `workbuddy`），
`X-Product: SaaS` 一并发送。

## 自检

```powershell
cd D:\w\Documents\dsh\ai-gateaway
node server/test/workbuddy-context.test.js
node server/test/proxy-preheader-timeout.test.js
```

## 生效前提

`context_options` 来自模型目录，**刷新一次模型列表**后才会出现：

平台详情 → 刷新模型 → 带多档的模型才会显示「可选 …」。
不刷新的话请求里的 `context_length` 会被当作「该模型没有档位信息」而忽略（不会报错）。
