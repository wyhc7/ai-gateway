# ai-gateway 调用教程（生图）

本机实测参数，把三个占位符换成你自己的就能跑。

---

## 0. 先填三个值

| 变量 | 填什么 | 从哪拿 |
|---|---|---|
| `<网关地址>` | 你的部署地址，例 `http://127.0.0.1:3001` | 自己部署时定的域名或 IP |
| `<网关 Key>` | 形如 `gk-xxxxxxxx-xxxx-...` | 管理界面首页，或 `data/config.json` 的 `gateway_api_key` |
| 模型 | **固定 `gpt-image-2`** | —— |

**不要用** `GPT-Image-2.5-Sunburst` 或 `Hunyuan Image Alpha`，那两个走 WorkBuddy 渠道，和 ChatGPT 账号额度无关。实测 `GPT-Image-2.5-Sunburst` 会报 `11102 model service info not found`。

> 本教程不再写死任何真实地址与 Key —— 这份文件是公开仓库的一部分。
> 想看当前生效的值，去服务器的 `data/config.json`，或用管理界面查看。

---

## 1. 最快：curl

```bash
curl -X POST <网关地址>/api/v1/images/generations \
  -H "Authorization: Bearer <网关 Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a shiba inu sitting under a cherry tree, japanese photography style",
    "n": 1,
    "size": "1024x1024"
  }'
```

**返回是一个很大的 JSON**（1.3~3.3 MB），图片在 `data[0].b64_json`，是 base64 编码的 PNG。存成文件：

```bash
curl -s -X POST <网关地址>/api/v1/images/generations \
  -H "Authorization: Bearer <网关 Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a shiba inu under a cherry tree","n":1,"size":"1024x1024"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);require('fs').writeFileSync('out.png',Buffer.from(j.data[0].b64_json,'base64'));console.log('saved out.png');})"
```

> **一定要加超时。** 实测生成一次要 **16~25 秒**，curl 默认不超时但很多客户端默认 30 秒会掐断。

---

## 2. PowerShell

```powershell
$BASE = "<网关地址>/api/v1"
$KEY  = "<网关 Key>"

$body = @{
  model  = "gpt-image-2"
  prompt = "a shiba inu under a cherry tree"
  n      = 1
  size   = "1024x1024"
} | ConvertTo-Json

$r = Invoke-RestMethod -Uri "$BASE/images/generations" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $KEY" } `
  -ContentType "application/json" `
  -Body $body `
  -TimeoutSec 120

[IO.File]::WriteAllBytes("out.png", [Convert]::FromBase64String($r.data[0].b64_json))
Write-Host "saved out.png"
```

`-TimeoutSec 120` 不能省。

---

## 3. Python

```python
import base64
import httpx

BASE = "<网关地址>/api/v1"
KEY  = "<网关 Key>"

r = httpx.post(
    f"{BASE}/images/generations",
    headers={"Authorization": f"Bearer {KEY}"},
    json={
        "model": "gpt-image-2",
        "prompt": "a shiba inu under a cherry tree",
        "n": 1,
        "size": "1024x1024",
    },
    timeout=120,          # 生成要 16~25 秒，别用默认超时
)
r.raise_for_status()

with open("out.png", "wb") as f:
    f.write(base64.b64decode(r.json()["data"][0]["b64_json"]))
print("saved out.png")
```

用官方 `openai` SDK 也行，把 `base_url` 指过来即可：

```python
from openai import OpenAI

client = OpenAI(base_url="<网关地址>/api/v1", api_key="<网关 Key>")
r = client.images.generate(
    model="gpt-image-2",
    prompt="a shiba inu under a cherry tree",
    size="1024x1024",
    timeout=120,
)
```

---

## 4. Node.js

```javascript
const fs = require('node:fs')

const BASE = '<网关地址>/api/v1'
const KEY = '<网关 Key>'

const r = await fetch(`${BASE}/images/generations`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-image-2',
    prompt: 'a shiba inu under a cherry tree',
    n: 1,
    size: '1024x1024'
  }),
  signal: AbortSignal.timeout(120_000)   // 必须，默认会超时
})

const j = await r.json()
fs.writeFileSync('out.png', Buffer.from(j.data[0].b64_json, 'base64'))
console.log('saved out.png')
```

---

## 5. 第三方客户端怎么填

| 客户端 | Base URL 填 | 模型填 |
|---|---|---|
| Cherry Studio | `<网关地址>/api/v1` | `gpt-image-2` |
| NextChat | `<网关地址>` | `gpt-image-2` |
| Open WebUI | `<网关地址>/api/v1` | `gpt-image-2` |
| 官方 openai SDK | `<网关地址>/api/v1` | `gpt-image-2` |
| Postman / Apifox | `<网关地址>/api/v1/images/generations` | POST |

**Base URL 一定带 `/api/v1`**，不要只写 `<网关地址>`（会 404）。有些客户端会自动补 `/v1`，那就填 `<网关地址>/api`，避免变成 `/api/v1/v1`。

---

## 6. 参数说明

只传这几个就够，**多传会报错**：

```json
{
  "model": "gpt-image-2",
  "prompt": "英文描述效果最好",
  "n": 1,
  "size": "1024x1024"
}
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `model` | `gpt-image-2` | 固定 |
| `prompt` | 字符串 | **用英文**，中文容易触发 `content_policy_violation` |
| `n` | `1` | 一次一张，多张会被上游拒绝 |
| `size` | `1024x1024` / `1536x1024` / `1024x1536` | 横竖方三种 |

**不要传**：`quality`、`style`、`response_format`、`background` —— 这些参数上游不支持，传了直接 400。

---

## 7. 额度怎么算

每个 ChatGPT 账号每天约 **23 次**免费生图额度，用完等次日 UTC 08:00（北京时间 16:00）重置。

账号池里有几个号，就基本能用几份额度，请求按**轮询**分摊：

```
8 个账号  →  约 180 次/天
9 个账号  →  约 200 次/天
```

某个号额度用尽时网关会自动跳到下一个（`status` 变「限流」），不会整体失败。

查当前额度：

```bash
curl -s <网关地址>/api/chatgpt-accounts \
  -H "X-Admin-Key: <管理 Key>" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  let t=0;
  (j.accounts||[]).forEach(a=>{
    const q=a.image_quota??0; t+=q;
    console.log(a.email.padEnd(36), (a.status||'').padEnd(5), String(q).padStart(3)+' 次');
  });
  console.log('合计'.padEnd(36), ' '.repeat(5), String(t).padStart(3)+' 次');
});"
```

管理 Key 形如 `ak-xxxxxxxx...`，在 `data/config.json` 的 `admin_api_key`。**注意管理接口用 `X-Admin-Key` 头，不是 `Bearer`。**

---

## 8. 出错对照

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `401` | Key 不对 | 检查 `<网关 Key>` 是否抄全，前缀是 `gk-` |
| `403` / 网关 Key 无效 | 用了访问密钥但模型不在白名单 | 换主 Key，或在「访问密钥」页放开模型 |
| `404 Not Found` | Base URL 少写 `/api/v1` | 补全成 `<网关地址>/api/v1` |
| `400 content_policy_violation` | prompt 触发了内容审核 | **换英文 prompt**，别用中文描述 |
| `400` 其他 | 传了不支持的参数 | 只留 `model` / `prompt` / `n` / `size` |
| `429` | 账号池额度用尽 | 等重置，或加账号 |
| `500` + `11102` | 模型走错渠道 | 确认 `model` 是 `gpt-image-2` |
| 超时 / `ECONNRESET` | 客户端超时太短 | **设到 120 秒** |
| 返回 `url` 打不开 | 那是服务器本地路径 | 用 `b64_json`，别用 `url` |

---

## 9. 一句话总结

```bash
GW="<网关地址>/api/v1"
KEY="<网关 Key>"

curl -X POST $GW/images/generations \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a shiba inu under a cherry tree","n":1,"size":"1024x1024"}' \
  --max-time 120
```

拿 `data[0].b64_json` 解 base64 → PNG。就这样。
