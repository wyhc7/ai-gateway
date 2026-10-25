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

### 路径：两个都通，随便挑一个

`server/index.js` 同时挂了两个路由（`1475` 与 `1483` 行），实测都返回 200：

```
POST <网关地址>/api/v1/images/generations    ← 标准写法，文档统一用这个
POST <网关地址>/v1/images/generations        ← 简写，等价
```

**本文档统一写 `/api/v1`。** 如果你的客户端会自动补 `/v1`，就填 `<网关地址>/api`，
否则会变成 `/api/v1/v1`（404）。

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

> **一定要加超时。** 实测生成一次要 **15~25 秒**（偶发到 90 秒），curl 默认不超时但很多客户端默认 30 秒会掐断。
> 本文档统一用 **180 秒**，留足余量。

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

**实际输出尺寸会和请求值略有出入。** 实测请求 `1024x1024`，返回的 PNG 是 **1254×1254**
（上游按自己的规范取整）。要精确尺寸就自己再裁一刀，别指望 `size` 逐像素生效。

**不要传**：`quality`、`style`、`response_format`、`background` —— 这些参数上游不支持，传了直接 400。

---

## 7. 额度怎么算

### 单个账号的额度

同一批新号实测（`plan` 都是 `free`，但**实际配额分档**）：

| 能力 | 正常号 | 低配额号 |
|---|---|---|
| 生图 `image_gen` | **25** | 10 |
| 文件上传 `file_upload` | 15 | 6 |
| 推理 `reason` | 50 | 20 |
| 深度研究 `deep_research` | 5 | 5 |
| 粘贴转文件 `paste_text_to_file` | 3 | 3 |

**低配额号不是"用掉了"，是真的只发了那么多。** 判据：`success`/`fail` 都是 0、
`last_used_at` 为 `null`，而五项能力整齐地成同一比例偏少（生图 40%、上传 40%、
推理 40%）—— 用掉的额度不会这么均匀。

买号时值得先查一眼，别按 25 算预算。

### 重置时间

**不是 UTC 08:00。** 实测是**账号注册时刻 + 24 小时**，同一批号各自独立：

```
某号 quota_reset_at: 2026-10-26T02:41:36+00:00   → 北京时间 10:41
另一个号:            2026-10-26T02:41:36+00:00   → 同一批号几乎同时重置
```

所以"每天几点重置"这个问题没有统一答案，**要按号看 `quota_reset_at`**。

### 池子总量

请求按**轮询**分摊，账号池里有多少额度就能用多少：

```
15 个号（14 个 25 + 1 个 10）  →  319 次/天
```

某个号额度用尽时网关会自动跳到下一个（`status` 变「限流」），不会整体失败。

### 查当前额度

```bash
curl -s <网关地址>/api/chatgpt-accounts \
  -H "X-Admin-Key: <管理 Key>" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  const accs=j.accounts||j.items||[];
  let t=0;
  accs.forEach(a=>{
    const q=a.image_quota??0; t+=q;
    console.log(
      a.email.padEnd(36),
      (a.status||'').padEnd(5),
      String(q).padStart(3)+' 次',
      a.refresh_token ? '可续期' : '仅 access_token'
    );
  });
  console.log('-'.repeat(60));
  console.log('合计'.padEnd(36), ' '.repeat(5), String(t).padStart(3)+' 次');
});"
```

看某一项能力的明细（`limits` 数组，比 `image_quota` 更全）：

```bash
curl -s <网关地址>/api/chatgpt-accounts \
  -H "X-Admin-Key: <管理 Key>" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const a=(JSON.parse(d).accounts||[]).find(x=>x.email.includes('关键词'));
  if(!a) return console.log('没找到');
  console.log(a.email, '| plan:', a.plan, '| 重置:', a.quota_reset_at);
  (a.limits||[]).forEach(l=>
    console.log('  ' + l.label.padEnd(8) + String(l.remaining).padStart(3) + '   下次重置 ' + l.reset_at));
});"
```

管理 Key 形如 `ak-xxxxxxxx...`，在 `data/config.json` 的 `admin_api_key`。**注意管理接口用 `X-Admin-Key` 头，不是 `Bearer`。**

| Key | 用途 | 请求头 |
|---|---|---|
| 网关 Key（`gk-`） | 调 AI 接口（对话、生图） | `Authorization: Bearer <key>` |
| 管理 Key（`ak-`） | 管理面板、查账号、改配置 | `X-Admin-Key: <key>` |

**两个 Key 不能互换**，用错会 401。

---

## 8. 出错对照

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `401` | Key 不对 | 检查 `<网关 Key>` 是否抄全，前缀是 `gk-` |
| `401` 但 Key 没错 | 把管理 Key 当网关 Key 用了 | `ak-` 是管理用的，走 `X-Admin-Key`，不能当 `Bearer` |
| `403` / 网关 Key 无效 | 用了访问密钥但模型不在白名单 | 换主 Key，或在「访问密钥」页放开模型 |
| `404 Not Found` | Base URL 少写 `/api/v1` | 补全成 `<网关地址>/api/v1` |
| `400 content_policy_violation` | prompt 触发了内容审核 | **换英文 prompt**，别用中文描述 |
| `400` 其他 | 传了不支持的参数 | 只留 `model` / `prompt` / `n` / `size` |
| `429` | 账号池额度用尽 | 等重置，或加账号 |
| `500` + `11102` | 模型走错渠道 | 确认 `model` 是 `gpt-image-2` |
| `502` + `all_keys_failed` | 上游账号全部失败 | 看响应里每个 key 的具体错误，多为 token 过期 |
| 超时 / `ECONNRESET` | 客户端超时太短 | **设到 120 秒**（实测 16~90 秒） |
| 返回 `url` 打不开 | 那是服务器本地路径 | 用 `b64_json`，别用 `url` |
| 图片存出来 0 字节 | `data[0]` 取错 / 响应是错误 JSON | 先打印出来看，别直接写文件 |

---

## 9. 一键脚本：gen.sh

前面都是片段，这个是能直接用的。存成 `gen.sh`：

```bash
#!/usr/bin/env bash
#
# 用法：
#   ./gen.sh "a red sports car on a mountain road at sunset"
#   ./gen.sh "prompt..." out.png 1536x1024
#
set -euo pipefail

GW="${GW:-http://127.0.0.1:3001/api/v1}"
KEY="${GW_KEY:?请先 export GW_KEY=<网关 Key>}"
PROMPT="${1:?用法: $0 \"prompt\" [输出文件] [尺寸]}"
OUT="${2:-out.png}"
SIZE="${3:-1024x1024}"

# 用文件传 body，避免 prompt 里的引号把 JSON 搞坏
BODY=$(mktemp)
JSON=$(mktemp)
trap 'rm -f "$BODY" "$JSON"' EXIT

node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    model: "gpt-image-2",
    prompt: process.argv[2],
    n: 1,
    size: process.argv[3]
  }));
' "$BODY" "$PROMPT" "$SIZE"

echo "生成中… ($SIZE)"
START=$(date +%s)

CODE=$(curl -s -o "$JSON" -w "%{http_code}" -m 180 -X POST "$GW/images/generations" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --data-binary "@$BODY")

ELAPSED=$(( $(date +%s) - START ))

if [ "$CODE" != "200" ]; then
  echo "失败 HTTP $CODE （${ELAPSED}s）" >&2
  head -c 600 "$JSON" >&2; echo >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) {
    console.error("响应里没有 b64_json：");
    console.error(JSON.stringify(j).slice(0, 400));
    process.exit(2);
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1024) {
    console.error("图片太小（" + buf.length + " 字节），多半不是图");
    process.exit(3);
  }
  fs.writeFileSync(process.argv[2], buf);
  console.log("已保存 " + process.argv[2] + "  " + (buf.length / 1024).toFixed(1) + " KB");
' "$JSON" "$OUT"

echo "耗时 ${ELAPSED}s"
```

```bash
chmod +x gen.sh
export GW_KEY="gk-xxxxxxxx..."
./gen.sh "a shiba inu sitting under a cherry blossom tree, japanese photography style"
```

**三个细节值得注意：**

1. **prompt 用 `node -e` 转义后写进临时文件**，再用 `--data-binary @file` 发送。直接拼进
   `-d '...'` 的话，prompt 里有个单引号或 `$` 就会把 JSON 弄坏——这是这类脚本最常见的翻车点。
2. **校验图片大小**：成功时是 1.3~3.3 MB，如果只有几百字节基本就是错误页被存成了 `.png`。
3. **`set -euo pipefail`**：任何一步出错立刻停，不会带着半截状态往下跑。

---

## 10. 批量生成

一批 prompt 存成 `prompts.txt`（一行一条），循环生成：

```bash
#!/usr/bin/env bash
set -uo pipefail   # 故意不加 -e：一条失败不该打断整批

GW="${GW:-http://127.0.0.1:3001/api/v1}"
KEY="${GW_KEY:?请先 export GW_KEY}"
OUTDIR="${OUTDIR:-./images}"
mkdir -p "$OUTDIR"

i=0
ok=0
fail=0

while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  i=$((i + 1))
  name=$(printf "%s/%03d.png" "$OUTDIR" "$i")
  echo "[$i] $line"

  if ./gen.sh "$line" "$name" 2>&1 | tail -2; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    echo "  -> 失败，跳过" >&2
    sleep 5      # 失败多半是额度或限流，停一下再试下一条
  fi
  sleep 2        # 主动拉开间隔，避免连续打爆上游
done < prompts.txt

echo "完成：成功 $ok，失败 $fail，共 $i"
```

**为什么要 `sleep 2`：** 网关会自动轮询账号，但连续快速请求容易让上游把某个号判成
限流，反而更慢。每次之间停 2 秒，总量反而更高。

**为什么要 `sleep 5`（失败后）：** 失败通常是额度用尽或短暂限流，立刻重试只会连撞。

### 带重试的版本

```bash
gen_with_retry() {
  local prompt="$1" out="$2" tries="${3:-3}" n=5
  for ((k = 1; k <= tries; k++)); do
    if ./gen.sh "$prompt" "$out" >/dev/null 2>&1; then
      echo "  ok (第 $k 次)"; return 0
    fi
    echo "  第 $k 次失败，${n}s 后重试" >&2
    sleep "$n"
    n=$((n * 2))     # 5 → 10 → 20 秒，退避
  done
  echo "  放弃：$out" >&2
  return 1
}
```

---

## 11. 一句话总结

```bash
GW="<网关地址>/api/v1"
KEY="<网关 Key>"

curl -X POST $GW/images/generations \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a shiba inu under a cherry tree","n":1,"size":"1024x1024"}' \
  --max-time 180
```

拿 `data[0].b64_json` 解 base64 → PNG。就这样。

**三个最容易踩的坑，记住就够：**

1. **prompt 用英文** —— 中文大概率 `content_policy_violation`
2. **超时给到 120~180 秒** —— 实测 16~90 秒，默认超时一定不够
3. **`gk-` 走 `Bearer`，`ak-` 走 `X-Admin-Key`** —— 换用必 401
