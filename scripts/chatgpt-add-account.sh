#!/bin/bash
# ============================================================
# ChatGPT 账号一键 OAuth 导入（chatgpt2api）
# 用法：
#   ./add-account.sh                     # 交互式，提示输入邮箱
#   ./add-account.sh you@mail.com        # 指定邮箱提示
#   ./add-account.sh you@mail.com <cb>   # 直接带 callback（跳过交互）
# 原理：oauth/start 生成 PKCE authorize URL → 浏览器授权 → 粘回 callback → oauth/finish 换三件套
# ============================================================
set -u

API="http://127.0.0.1:3000"
CONF="/opt/chatgpt2api/config.json"
KEY_FILE="/root/chatgpt2api-authkey.txt"

# 优先用环境变量，其次读文件
KEY="${CHATGPT2API_AUTH_KEY:-}"
[ -z "$KEY" ] && [ -f "$KEY_FILE" ] && KEY=$(cat "$KEY_FILE")
if [ -z "$KEY" ]; then
  echo "!! 找不到 auth-key，请设置 CHATGPT2API_AUTH_KEY 或检查 $KEY_FILE"
  exit 1
fi

EMAIL_HINT="${1:-}"
CALLBACK="${2:-}"

# ---------- 工具函数 ----------
say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "------------------------------------------------------------"; }

py() { /opt/chatgpt2api/.venv/bin/python "$@"; }

# ---------- 1. 生成 authorize URL ----------
say "==> 向 chatgpt2api 申请授权链接"
START_BODY=$(py - "$EMAIL_HINT" <<'PY'
import json, sys
print(json.dumps({"email_hint": sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else ""}))
PY
)

RESP=$(curl -s -X POST "$API/api/accounts/oauth/start" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "$START_BODY" -w '\n%{http_code}')

CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" != "200" ]; then
  say "!! oauth/start 失败 HTTP $CODE"
  say "$BODY"
  exit 1
fi

SID=$(py - "$BODY" <<'PY'
import json, sys
j = json.loads(sys.argv[1])
print(j["session_id"])
PY
)
URL=$(py - "$BODY" <<'PY'
import json, sys
j = json.loads(sys.argv[1])
print(j["authorize_url"])
PY
)
STATE=$(py - "$URL" <<'PY'
import sys, urllib.parse as u
q = u.urlparse(sys.argv[1]).query
print(u.parse_qs(q).get("state", [""])[0])
PY
)
EXPIRE=$(py - "$BODY" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get("expires_in", "600"))
PY
)

say "    session_id : $SID"
say "    state      : $STATE"
say "    有效期     : $EXPIRE 秒"
hr
say "【第 1 步】请在浏览器（已登录目标账号的那个）打开下面链接："
say ""
say "$URL"
say ""
hr

if [ -z "$CALLBACK" ]; then
  say "【第 2 步】点 Authorize，页面会跳到 platform.openai.com/auth/callback?code=..."
  say "          那条 URL 打不开是正常的，把地址栏整条复制下来粘到这里。"
  hr
  printf '粘贴 callback URL: '
  read -r CALLBACK
fi

CALLBACK=$(printf '%s' "$CALLBACK" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
if [ -z "$CALLBACK" ]; then
  say "!! 没有输入 callback，退出"
  exit 1
fi
case "$CALLBACK" in
  https://platform.openai.com/auth/callback*) ;;
  *) say "!! callback 看起来不对，应以 https://platform.openai.com/auth/callback 开头"; exit 1 ;;
esac

# 本地先校验 state，避免白跑一趟
CB_STATE=$(py - "$CALLBACK" <<'PY'
import sys, urllib.parse as u
q = u.urlparse(sys.argv[1]).query
print(u.parse_qs(q).get("state", [""])[0])
PY
)
if [ "$CB_STATE" != "$STATE" ]; then
  say "!! state 不匹配"
  say "   期望: $STATE"
  say "   实际: $CB_STATE"
  say "   说明浏览器里授权的是另一个窗口/另一次会话。请重新运行本脚本。"
  exit 1
fi
say "==> state 校验通过"

# ---------- 2. 兑换 token ----------
hr
say "==> 用 code 换 token 三件套"
FIN_BODY=$(py - "$SID" "$CALLBACK" <<'PY'
import json, sys
print(json.dumps({"session_id": sys.argv[1], "callback": sys.argv[2]}))
PY
)

FRESP=$(curl -s -X POST "$API/api/accounts/oauth/finish" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "$FIN_BODY" -w '\n%{http_code}')
FCODE=$(echo "$FRESP" | tail -1)
FBODY=$(echo "$FRESP" | sed '$d')

if [ "$FCODE" != "200" ]; then
  say "!! oauth/finish 失败 HTTP $FCODE"
  say "$FBODY"
  exit 1
fi

py - "$FBODY" <<'PY'
import json, sys, base64
j = json.loads(sys.argv[1])
item = (j.get("items") or [j.get("item") or {}])[0] or {}
def plan(at):
    try:
        p = json.loads(base64.urlsafe_b64decode(at.split(".")[1] + "=="))
        a = p.get("https://api.openai.com/auth", {})
        return a.get("chatgpt_plan_type", "?"), p.get("exp")
    except Exception:
        return "?", None
import datetime
plan_t, exp = plan(item.get("access_token", ""))
print("    邮箱        :", item.get("email"))
print("    状态        :", item.get("status"))
print("    来源        :", item.get("source_type"))
print("    套餐        :", plan_t)
if exp:
    print("    access 到期 :", datetime.datetime.utcfromtimestamp(exp).strftime("%Y-%m-%d %H:%M UTC"))
print("    refresh_token:", "YES ✅" if item.get("refresh_token") else "NO ✗")
PY

# ---------- 3. 清理重复记录 + 汇总 ----------
hr
say "==> 检查账号池"
curl -s -H "Authorization: Bearer $KEY" "$API/api/accounts" -o /tmp/_accs.json
py - <<'PY'
import json
d = json.load(open('/tmp/_accs.json'))
items = d.get('items') or []
# 同一邮箱存在多条且其中有无 refresh_token 的，删掉无 refresh 的那条
from collections import defaultdict
by_mail = defaultdict(list)
for a in items:
    by_mail[a.get('email')].append(a)
dups = []
for mail, arr in by_mail.items():
    if len(arr) > 1:
        for a in arr:
            if not a.get('refresh_token'):
                dups.append(a['access_token'])
if dups:
    print("    发现 %d 条无 refresh_token 的重复记录，稍后清理" % len(dups))
    open('/tmp/_dups.txt', 'w').write(json.dumps(dups))
else:
    print("    无重复记录")
print()
print("    === 账号池 ===")
for a in items:
    if a['access_token'] in dups:
        continue
    print("    ·", a.get('email'), "| quota:", a.get('quota'), "| refresh:", "YES" if a.get('refresh_token') else "NO", "| src:", a.get('source_type'))
PY

if [ -f /tmp/_dups.txt ]; then
  DUPS=$(cat /tmp/_dups.txt)
  DEL=$(py - "$DUPS" <<'PY'
import json, sys
print(json.dumps({"tokens": json.loads(sys.argv[1])}))
PY
)
  curl -s -X DELETE "$API/api/accounts" -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' -d "$DEL" -o /dev/null -w '    清理重复: HTTP %{http_code}\n'
  rm -f /tmp/_dups.txt
fi

# ---------- 4. 顺手触发网关模型刷新 ----------
ADMIN=$(python3 -c "import json;print(json.load(open('/opt/ai-gateway/data/config.json')).get('admin_api_key',''))" 2>/dev/null || true)
if [ -n "$ADMIN" ]; then
  curl -s -X POST "http://127.0.0.1:3001/api/providers/$(curl -s -H "X-Admin-Key: $ADMIN" http://127.0.0.1:3001/api/providers | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((p['id'] for p in d if p.get('image_only')),''))" 2>/dev/null)/refresh" \
    -H "X-Admin-Key: $ADMIN" -o /dev/null -w '    网关模型刷新: HTTP %{http_code}\n' 2>/dev/null || true
fi

hr
say "✅ 完成。refresh_token 已落盘，之后每 5 分钟自动续期，无需再手动抓 token。"
say "   单号额度 23 次/天，用完等刷新；要更多就再跑一次本脚本加号。"
