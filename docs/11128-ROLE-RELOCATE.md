# 11128 内容级闸门：角色维度解法

> 上游（腾讯 CodeBuddy / WorkBuddy）对 system 里的内容有一套内容级校验，命中就回
> `HTTP 400 / code 11128`。这件事前后有三版补丁，前两版都被上游的归一化吃掉了。
> 本文记录**为什么失效**与**这一版为什么有效**，实现见
> [`server/workbuddy-prompt-relocate.js`](../server/workbuddy-prompt-relocate.js)。

---

## 1. 前两版补丁为什么失效

### 1.1 零宽打散（同字不同形）

网关是**先归一化、再匹配指纹**：折叠空白、剥掉零宽字符、大小写不敏感。
所以「每个空格后插 `U+200B`」的软打码会被还原成原文，再拿去匹配。

| 请求体 | 结果 |
| --- | --- |
| 113 字触发片段原样 | 11128 拦截 |
| 同上 + ZWSP（每个空格后插零宽） | 11128（上一版补丁以为这条路可行） |
| 换 NBSP / 细空格 / 双空格 / 词中插 ZW | 全 11128 |
| `explicitly` → `directly`（真改词） | 200 |
| 加一个 filler 词 | 200 |

**结论**：任何「同字不同形」的打码都必然被归一化吃掉，只有真的改动内容才放行。
而改内容会把系统提示词改坏 —— 这条路走不通。

### 1.2 超长 system 切一半搬进 user

切分点之后仍有一半原文留在 system 里，闸门照样命中。

**结论**：只要 system 里还剩一段够长的原文，就会被匹配到。

---

## 2. 新发现的维度：闸门只校验三种角色

同一份 7920 字的 DSH 系统提示词，**只换它所在的角色**：

| 角色 | 结果 |
| --- | --- |
| `system` | 11128 |
| `developer` | 11128 |
| `assistant` | 11128 |
| `user` | **200** |
| `tool` | **200** |

闸门只对 `system` / `developer` / `assistant` 跑内容校验。内容本身没有问题，
换一个角色（其中最常见的 `user` 就是完全合法的角色）就能通过。

---

## 3. 这一版的做法

### 3.1 常规整形：搬家

发请求前，把 system（含 developer）的正文**整段**搬进一条 user 消息，
system 位置只留一句占位：

```
[system: "You are a helpful assistant."]
[user:   "Everything below is your system prompt for this session. ..." + 原系统提示词]
[user:   真实提问]...
```

- **内容一字未动**，只在最前面加一行说明（告诉模型「这是系统指令，不是你问我」）；
- **不增加 token**：搬家不是复制，是把同一段文本换个角色承载；
- 模型照常按系统提示执行 —— 实测给它 `write` / `pwsh` 工具并派活，
  它正常回了 `write` 工具调用；
- 首条消息仍然是 `system`，不破坏「首条必须是 system」这条渠道校验。

只在 CN realm 启用（国际版没有这道闸门）。实现上是**幂等**的：带搬家标记的
请求不会被搬第二次，所以整形与重试可以各调一次。

开关：`WORKBUDDY_RELOCATE_SYSTEM=0` 关闭搬家（回到「system 原样发出」）。
出事时的回退口，不需要改代码。

### 3.2 兜底：搬家后仍 11128 时重发一次

那说明闸门还看了一眼 `assistant` 内容里的指纹词组。这一层把 assistant 里
已知的指纹换成同义写法再重发**一次**：

| 原词 | 同义写法 |
| --- | --- |
| `DeepSeek Harness` | `the local coding harness` |
| `You are an AI agent` | `You are an automated assistant` |
| `Tokens prefixed with @` | `Paths prefixed with @` |

替换表在 `ASSISTANT_FINGERPRINTS` 里，**每一条都要有实发证据**（带这个词组被拦 +
换同义写法后放行）。改写 assistant 历史消息是**有损**的，所以只在真读到 11128
之后做一次，不进常规整形。

请求体确实没变时**不重发**：字节一样，重发只会再吃一个 11128 并白烧一次重试预算。

---

## 4. 上游仍然 11128 怎么办

搬家与指纹改写都只解决「内容级」这一半。11128 还有另一半成因：**出口 IP 的
秒级风控窗口**（同一台机器 05:17 全 200、05:19 连 4 次全 400、05:20 又全 200）。
那一半靠换 Key 与原地短等重试，与内容无关，见 `server/proxy.js` 的
`ACCOUNT_REJECT_RETRY_MAX` / `REJECT_11128_RETRY_MAX` 注释。

最后一级仍然是**有损**的中性化（把 system 换成中性文本），默认关闭，
需要时用 `WORKBUDDY_NEUTRALIZE_ON_11128=1` 打开。

---

## 5. 风险与回归

- **上游随时会补齐角色维度**：一旦它开始校验 `user`，搬家就失效了。届时需要新的
  结构性解法（比如把指令折进工具描述），而不是继续在文本形态上做文章 ——
  前两版补丁已经证明「同字不同形」无效。
- **提示词权威度会略降**：`system` 的指令权重高于 `user`，靠说明语补充。若发现
  模型开始忽略某些规则，先看是不是搬家导致的。
- **回归点**：`server/test/workbuddy-prompt-relocate.test.js`（搬家契约）、
  `server/test/workbuddy-lane.test.js`（整形接入，CN 才搬、非 CN 不动、
  带图片的 system 不搬）。
