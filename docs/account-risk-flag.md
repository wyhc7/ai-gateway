# 账号风控标记

上游（腾讯 WorkBuddy / CodeBuddy）会限制账号，返回的却是 **403**，与 token 失效长得一模一样。
以前界面上只显示「HTTP 403」，人会去反复续期一个根本没问题的凭据。

现在：识别到风控提示就在**账号行**打一个红色「风控」标记，鼠标悬停给出时间与上游原话。

## 判据：只看文案，不看状态码

实测样本（2026-11-16）：

```json
HTTP 403
{
  "code": 11140,
  "msg": "request illegal",
  "displayMsg": {
    "en": "Your account has been restricted due to unusual activity",
    "zh": "账号存在异常行为，已被限制使用"
  },
  "displayTips": { "zh": "系统检测到该账号存在异常使用行为，如需申诉请提交反馈" }
}
```

⚠️ **`11140` 不等于风控**。同一个 code 也用于普通参数非法（例如传了不在档位表里的
`contextLength`）。所以判定必须看文案，见 `server/risk-control.js` 的 `RISK_PATTERNS`。

刻意**不**匹配 `rate limit` / 429：限流几秒就好，标成风控会让人去申诉一个没问题的号。

## 存储

打在 Key 上，跟着配置一起落盘：

```json
{
  "id": "…",
  "name": "WorkBuddy 账号 5",
  "risk_flag": { "at": 1794890000000, "code": 11140, "message": "账号存在异常行为，已被限制使用" },
  "risk_flag_at": 1794890000000,
  "last_error": "风控：账号存在异常行为，已被限制使用"
}
```

- 与「冷却」是两件事：冷却会自己过期，风控**不会**——账号被限制后等多久都还是限制状态。
- 连续命中不刷新时间戳：`at` 停在**第一次**被限制的时刻（申诉会问「什么时候开始异常」）。
- 一旦该号跑通一次请求，标记自动消失（`clearRiskFlag`）。
- 也可手动解除：界面上点「解除标记」，走既有的 `POST /api/providers/:id/keys/:keyId/reset`。

> `applyCooldown` 里有一条保护：已被判定风控的号，`last_error` 始终显示风控原因。
> 否则后续更「普通」的失败（网络错误 / HTTP 502）会把这句最有用的信息盖掉。

## 界面

账号行内出现红色 `风控` 徽章，悬停显示：

```
账号被上游风控限制（code 11140）
上游原话：账号存在异常行为，已被限制使用
标记时间：2026/11/16 21:45:12
这个号跑通一次请求后标记会自动解除，也可以点「解除标记」手动清掉。
```

旁边同时出现「解除标记」按钮。

## 加一条新措辞

上游换个说法就漏判。往 `RISK_PATTERNS` 加一行即可：

```js
/新的措辞/,
```

并补一条用例到 `server/test/risk-flag.test.js`。

## 自检

```powershell
cd D:\w\Documents\dsh\ai-gateaway
node server/test/risk-flag.test.js
```

覆盖五种情形：风控标记写入、token 失效不误判、11140 参数非法不误判、
跑通后自动解除、连续命中保留首次时间。
