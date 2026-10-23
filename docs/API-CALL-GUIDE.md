# ai-gateway 调用教程（生图）

本机实测参数，直接抄就能跑。所有示例都用真实的 host 与 model 名。

---

## 0. 三条你必须知道的

| 问题 | 答案 |
|---|---|
| 调哪里 | `http://<网关地址>:3001/api/v1` |
| 用什么 Key | `<网关 Key>`（网关主 Key，不受模型限制） |
| 用哪个模型 | **`gpt-image-2`** —— 这是唯一走 ChatGPT 网页版账号池的生图模型 |

**不要用** `GPT-Image-2.5-Sunburst` 或 `Hunyuan Image Alpha`，那两个走 WorkBuddy 渠道，和你的 ChatGPT 账号额度无关。实测 `GPT-Image-2.5-Sunburst` 会报 `11102 model service info not found`。

---

## 1. 最快：curl

```bash
curl -X POST http://<网关地址>:3001/api/v1/images/generations \
  -H "Authorization: Bearer <网关 Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只柴犬坐在樱花树下，日系写真风格",
    "n": 1,
    "size": "1024x1024"
  }'
```

**响应结构**

```json
{
  "created": 1761255432,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUg...",   // base64，直接解码就是 PNG
      "url": "http://127.0.0.1:3000/images/2026/10/23/xxx.png",
      "revised_prompt": "一只柴犬坐在樱花树下..."
    }
  ]
}
```

**两个坑**

1. `url` 里的 `127.0.0.1` 是**服务器自己**的地址，你在外网打不开。要么用 `b64_json` 自己解码，要么让我把 `/images/` 反代出来。
2. 图片约 **1.3 ~ 3.3 MB**，`b64_json` 会让响应体膨胀到 4 MB 左右。请求时记得把超时设到 60 秒以上（实测 16~24 秒）。

---

## 2. 把 base64 存成文件

```bash
curl -s -X POST http://<网关地址>:3001/api/v1/images/generations \
  -H "Authorization: Bearer <网关 Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red apple on a wooden table","n":1,"size":"1024x1024"}' \
  | jq -r '.data[0].b64_json' \
  | base64 -d > out.png
```

Windows PowerShell：

```powershell
$body = @{
  model  = "gpt-image-2"
  prompt = "a red apple on a wooden table"
  n      = 1
  size   = "1024x1024"
} | ConvertTo-Json

$r = Invoke-RestMethod -Uri "http://<网关地址>:3001/api/v1/images/generations" `
  -Method Post -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer <网关 Key>" } `
  -Body $body -TimeoutSec 120

[IO.File]::WriteAllBytes("$PWD\out.png", [Convert]::FromBase64String($r.data[0].b64_json))
```

---

## 3. Python

```python
import base64, requests

BASE = "http://<网关地址>:3001/api/v1"
KEY  = "<网关 Key>"

r = requests.post(
    f"{BASE}/images/generations",
    headers={"Authorization": f"Bearer {KEY}"},
    json={
        "model": "gpt-image-2",
        "prompt": "一只柴犬坐在樱花树下，日系写真风格",
        "n": 1,
        "size": "1024x1024",
    },
    # 生成要 16~24 秒，比默认超时长得多
    timeout=120,
)
r.raise_for_status()
item = r.json()["data"][0]

if item.get("b64_json"):
    with open("out.png", "wb") as f:
        f.write(base64.b64decode(item["b64_json"]))
    print("已保存 out.png")
else:
    print("图片地址（仅服务器内网可访问）:", item.get("url"))
```

用 OpenAI 官方 SDK 也行，因为接口是 OpenAI 兼容的：

```python
from openai import OpenAI
import base64

client = OpenAI(
    base_url="http://<网关地址>:3001/api/v1",
    api_key="<网关 Key>",
    timeout=120,
)

img = client.images.generate(
    model="gpt-image-2",
    prompt="一只柴犬坐在樱花树下，日系写真风格",
    n=1,
    size="1024x1024",
)

with open("out.png", "wb") as f:
    f.write(base64.b64decode(img.data[0].b64_json))
```

---

## 4. Node.js

```js
import { writeFileSync } from 'node:fs'

const BASE = 'http://<网关地址>:3001/api/v1'
const KEY = '<网关 Key>'

const resp = await fetch(`${BASE}/images/generations`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-image-2',
    prompt: '一只柴犬坐在樱花树下，日系写真风格',
    n: 1,
    size: '1024x1024'
  }),
  signal: AbortSignal.timeout(120_000)   // 必须给足，生成要 16~24 秒
})

if (!resp.ok) {
  console.error('HTTP', resp.status, await resp.text())
  process.exit(1)
}

const json = await resp.json()
writeFileSync('out.png', Buffer.from(json.data[0].b64_json, 'base64'))
console.log('已保存 out.png')
```

---

## 5. 接第三方客户端（Cherry Studio / LobeChat / NextChat / ChatBox 等）

| 设置项 | 填什么 |
|---|---|
| API 类型 / 提供商 | **OpenAI** |
| Base URL / 接口地址 | `http://<网关地址>:3001/api/v1` |
| API Key | `<网关 Key>` |
| 模型 | `gpt-image-2` |

**注意**

- Base URL 一定带 `/api/v1`，不要只写 `http://<网关地址>:3001`（会 404）。
- 有些客户端会在末尾自动补 `/v1`，那就填 `http://<网关地址>:3001/api`，避免变成 `/api/v1/v1`。
- 客户端如果只支持「聊天」不支持「生图」，就只能文本对话；生图必须走 `/images/generations`。

---

## 6. 查可用模型

```bash
curl http://<网关地址>:3001/api/v1/models \
  -H "Authorization: Bearer <网关 Key>"
```

当前 154 个模型，其中带 image 的 4 个：

| 模型 | 来源平台 | 是否用你的 ChatGPT 账号 |
|---|---|---|
| **`gpt-image-2`** | ChatGPT 网页版（chatgpt2api）· 生图 | **是** ← 你要的 |
| `GPT-Image-2.5-Sunburst` | WorkBuddy 国际版 | 否（实测报错 11102） |
| `Hunyuan Image Alpha · x5.00` | WorkBuddy 国内版 | 否 |
| `Hunyuan Image Alpha Edit` | WorkBuddy 国内版 | 否 |

---

## 7. 管理接口（查账号额度、加账号）

管理接口和生图接口**不是同一套鉴权**，要用 `admin_api_key`。

```bash
ADMIN="<管理 Key>"
GW="http://<网关地址>:3001"

# 看所有账号的剩余额度
curl -s -H "X-Admin-Key: $ADMIN" $GW/api/chatgpt-accounts | jq '.accounts[] | {email, status, image_quota, quota_reset_at, refresh_token}'

# 看平台清单
curl -s -H "X-Admin-Key: $ADMIN" $GW/api/providers | jq '.[] | {name, protocol, image_only, models: (.models|length)}'

# 看请求日志
curl -s -H "X-Admin-Key: $ADMIN" "$GW/api/logs?limit=20" | jq '.logs[] | {time, method, path, status}'
```

> 管理接口的 Key 是 `X-Admin-Key` 头，**不是** `Authorization: Bearer`。混用会 401。

---

## 8. 参数说明

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 固定 `gpt-image-2` |
| `prompt` | string | 提示词，**中文可用**（实测中文正常） |
| `n` | int | 生成几张。默认 1。测过 1，多张未压测 |
| `size` | string | `1024x1024`。实测返回 1254×1254（上游会微调） |

**不要传** `quality`、`style`、`response_format` 这些 OpenAI 官方参数。上游走的是网页版协议，不认这些字段，传了可能被忽略或报错。

---

## 9. 常见错误对照

| 现象 | 原因 | 解决 |
|---|---|---|
| `404 Not Found` | Base URL 少写 `/api/v1` | 补全成 `http://<网关地址>:3001/api/v1` |
| `401 管理密钥无效或缺失` | 用管理接口却没带 `X-Admin-Key` | 管理接口加 `-H "X-Admin-Key: ak-..."` |
| `403` / 网关 Key 无效 | Key 抄错或用了别的 Key | 用 `<网关 Key>` |
| `content_policy_violation` | 提示词触发内容审核 | 换中性描述。实测「柴犬在樱花树下」第一次被拒，换词后 200 |
| `no available image quota (tried N tokens)` | 三个账号额度全用完 | 换账号或等次日重置 |
| `11102 model service info not found` | 用了 WorkBuddy 的模型名 | 改用 `gpt-image-2` |
| 请求超时 | 没设长超时 | 客户端超时设 ≥ 60 秒，实测 16~24 秒 |
| 图片 URL 打不开 | `url` 是 `127.0.0.1:3000` | 用 `b64_json`，或让我反代 `/images/` |

---

## 10. 当前账号池状态

```
<账号邮箱>    正常   剩余 18 次
<账号邮箱>          正常   剩余 23 次
<账号邮箱>    正常   剩余  4 次
                                    合计   45 次
```

**轮询机制**：转换层按 `_index % len(tokens)` 轮流用账号，第 N 次请求用第 N 个。所以连调 3 次会各用一次，额度自动均摊。某个账号耗尽会自动跳过，不会失败。

**配额重置**：每日重置，时间点各账号不同（见 `quota_reset_at`）。

---

## 11. 一条命令验证全链路

```bash
GWKEY="<网关 Key>"
curl -s -o /dev/null -w "HTTP %{http_code}  耗时 %{time_total}s\n" \
  -X POST http://<网关地址>:3001/api/v1/images/generations \
  -H "Authorization: Bearer $GWKEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a simple red circle on white background","n":1,"size":"1024x1024"}'
```

期望输出：`HTTP 200  耗时 15~25s`
