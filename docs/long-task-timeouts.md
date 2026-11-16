# 长任务的超时层次

长任务跑到一半失败，报错可能来自**四个完全不同的地方**。搞错层次会一直在错的地方调参。

| 层 | 位置 | 默认值 | 报错长什么样 |
|---|---|---|---|
| ① 客户端流空闲 | DSH `llm-pi-ai` 的 `streamIdleTimeoutMs` | 300000（5 分钟） | `pi-ai stream idle timeout after 300000ms` |
| ② 网关等响应头 | `CONNECT_TIMEOUT_MS` + 按输入 token 放大 | 80s 起；30 万 token → 320s，96 万 → 848s；上限 20 分钟 | `上游请求超时：N 秒内没有开始响应（输入约 X tokens…）` |
| ③ 网关流空闲 | `STREAM_IDLE_TIMEOUT_MS` | 900000（15 分钟） | `上游长时间无数据（空闲超时，已断开）` |
| ④ 网关流总时长 | `jsonTotalTimeout(max_tokens, true)` | 30 分钟起，按输出上限放大，封顶 4 小时 | `上游请求超时（已收到响应头，转发中途中断，总预算 N 秒）` |

②③④ 都是**网关自己**的消息，措辞不同、该调的参数也不同。看括号里的字样分辨：

- 带「输入约 X tokens」→ ②，改 `PRE_HEADER_MS_PER_10K_TOKENS` / `CONNECT_TIMEOUT_MAX_MS`
- 带「空闲超时」→ ③，改 `STREAM_IDLE_TIMEOUT_MS`
- 带「转发中途中断，总预算」→ ④，改 `STREAM_TOTAL_TIMEOUT_MAX_MS`

## 关键事实：网关心跳救不了 pi-ai

网关在流式期间每 15 秒发一次心跳：

```
: keep-alive
```

这是 **SSE 注释行**。浏览器与多数客户端把它当「连接还活着」，但 DSH 的
pi-ai 不会 —— 它的看门狗包的是**解析后的 chunk 迭代器**：

```js
// dsh-llm-pi-ai：watchdog 只在 iterator.next() 有产出时重新计时
const iterator = toStreamChunks(snapshot.models.streamSimple(...))[Symbol.asyncIterator]()
const result = await watchdog.next(iterator)
```

而 `toStreamChunks` 只对 `text_delta` / `thinking_delta` / `toolcall_*` 这类
**真实内容事件**产出 chunk。注释行不产生任何事件，所以：

> 只要模型超过 `streamIdleTimeoutMs` 一个字都不吐，客户端必然超时，
> 网关发多少心跳都没用。

大上下文的首字延迟（prefill）正好落在这个空窗里：30 万 token 的 prefill
要几十秒到几分钟，96 万更久。于是「长任务跑到一定长度就挂」。

## 怎么调

### 客户端（DSH）

`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      a:
        streamIdleTimeoutMs: 300000   # 5 分钟（插件默认值）
```

改完要**重启 dsh web** 才生效（profile 补丁层在启动时装载）。

**这里有个大小关系要自己定，两种都自洽，但不能混着来：**

| 选择 | 客户端 | 网关 | 谁先报错 | 代价 |
|---|---|---|---|---|
| 快速失败 | 5 分钟 | 等头 ≤ 4 分钟 | **网关**（带输入规模，能调参） | 长 prefill 直接失败，但原因清楚 |
| 容忍长任务 | 30 分钟 | 等头 ≤ 848s | 网关 | 真挂死时多等一会儿才报 |

**当前配置属于「反着的」那一类**：客户端 5 分钟 < 网关等头 848s / 流空闲 15 分钟，
所以上游静默超过 5 分钟时，**客户端先超时**，报的是那句没有上下文的
`pi-ai stream idle timeout after 300000ms`。

> ⚠️ 注意：客户端只统计「静默」时长，每来一个 chunk 就重置。
> 所以长回答（一直在吐字）不会因为这条中断；会中断的是**静默超过 5 分钟**的情形，
> 主要是大上下文的 prefill。想彻底避开，要么把客户端改大，要么用小一档的上下文
> （见 docs/workbuddy-context.md 的档位选择）。

### 网关

| 环境变量 | 默认 | 何时改 |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 80000 | 上游排队慢，但 prefill 不大 |
| `PRE_HEADER_MS_PER_10K_TOKENS` | 8000 | 长上下文等头不够用（按每万 token 追加毫秒） |
| `CONNECT_TIMEOUT_MAX_MS` | 1200000 | 单次等头上限（20 分钟） |
| `STREAM_IDLE_TIMEOUT_MS` | 900000 | 上游思考阶段极长且完全无输出（15 分钟） |
| `STREAM_TOTAL_TIMEOUT_MAX_MS` | 14400000 | 流式总时长上限（4 小时） |

## 排错顺序

看到超时先认层，不要三层一起调：

1. 报错里有 `pi-ai` → 客户端，改 `streamIdleTimeoutMs`；
2. 报错里有「等待响应头」→ 改 `PRE_HEADER_MS_PER_10K_TOKENS` / `CONNECT_TIMEOUT_MAX_MS`；
3. 报错里有「长时间无数据」→ 上游真的不回数据了，改 `STREAM_IDLE_TIMEOUT_MS`
   之前先确认不是上游限流或账号风控（见 docs/account-risk-flag.md）。

## 顺带一提：为什么网关不自己发真事件当心跳

技术上可以伪造一条空 delta 的 chunk：

```json
data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}
```

但有两个风险：一是这会污染「收到了模型输出」的语义，客户端与计费都可能把它
当内容；二是 pi-ai 的 `toStreamChunks` 对空 delta 未必产出 chunk，等于白做。
所以这里选择诚实地让客户端把空闲上限调大，而不是往流里塞假数据。
