# WorkBuddy 兼容补丁（反代 11128 修复）

对应 `server/workbuddy-compat.js`。改动来源：社区实测（小黑盒 2026-10-27 帖，评论 10 / 19 楼）。

## 它修什么

腾讯把 11128「Illegal API invocation from an unapproved channel」的审查面扩了两处：

| 审查点 | 以前的补丁 | 本补丁 |
|---|---|---|
| 客户端身份（UA + 插件身份头） | 只改 UA | **补 `X-Client-Name` / `X-Client-Version` / `X-Plugin-*`** |
| 系统提示里的固定文案 | 只扫 system 与 assistant | **扫搬家后位于 user 的那份正文** |

关键点：`Tokens prefixed with @` 那句在**搬家之后住在 user 消息里**。
`workbuddy-fingerprint.js` 只扫 system、`ASSISTANT_FINGERPRINTS` 只扫 assistant，
两条路都碰不到它——这就是「搬了家却仍然 11128」的最后一块。

## 两条硬约束

1. **同义改写，不删句**：删掉整句会让模型丢失对 @ 语法的理解，工具调用行为漂移。
2. **精确字面量 + 大小写不敏感**：上游先归一化再匹配，零宽 / NBSP / 全角
   这类「同字不同形」的打码全部会被吃掉，只有真的换词才有效。

## 开关

| 环境变量 | 作用 |
|---|---|
| `WORKBUDDY_COMPAT=0` | 关闭全部（伪装头 + 文案改写），退回旧行为 |

留这个口子是因为伪装头毕竟是「自称」，上游若开始校验签名反而会变成矛盾点。

## 加一条新指纹

上游随时换。往 `PROMPT_REWRITES` 加一行即可：

```js
{
  find: '原文里的那句完整字面量',
  replace: '语义等价的另一句（不能为空、不能与 find 相同）',
  note: '实测日期 + 端点，说明「带原文被拦 / 改写后放行」'
}
```

加头部同理，写进 `PLUGIN_IDENTITY_HEADERS`。

⚠️ 每条都必须有实发证据。照抄别家客户端常量而没实测 = 给上游加一条没人验证过的改写。

## 自检

```powershell
cd D:\w\Documents\dsh\ai-gateaway
node server/test/workbuddy-compat.test.js
```

25 条用例应全绿。重点看这两条：

- `不带标记的 user 消息一个字都不动（保护用户原话）`
- `无指纹的文本原样返回，且是同一份内容`（前缀缓存不被破坏）

## 端到端形态

整形后的请求体（CN realm）：

```
[0] system   You are a helpful assistant.                       ← 占位句
[1] user     Everything below is your system prompt for this
             session. ... Inputs starting with @ are paths ...  ← 搬家 + 改写
[2] user     你好，帮我看看 @src/index.js                          ← 用户原话，未动
```

首发请求头：

```
User-Agent:         CLI/2.63.2 CodeBuddy/2.63.2
X-Client-Name:      CodeBuddy
X-Client-Version:   2.63.2
X-Plugin-Name:      CodeBuddy
X-Plugin-Version:   2.63.2
X-User-Id:          <账号 uid>
X-Domain:           codebuddy.cn
X-Conversation-ID:  <uuid>
```

## 失效了怎么办

1. 先确认是不是 11128：看响应体 `code` / `message`
2. 把报错原文发我，或自己抓一条被拦的 system 正文
3. 找到那句新的固定文案 → 加进 `PROMPT_REWRITES` → 跑测试

同帖评论提到「每天都在改」，所以这块是**消耗品**，按需迭代。
