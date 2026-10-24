#!/usr/bin/env python3
"""探测 auth.openai.com 的登录接口是否可脚本化。

不提交任何真实凭据，只做无副作用的探测：
  1. 能否拿到登录页 HTML（判断 Cloudflare 是否拦截）
  2. 登录接口对空请求返回什么（判断是否需要人机验证）
  3. 有没有 sentinel / turnstile 之类的挑战字段

目的是决定「自动登录」可行性，而不是真的登录。
"""
import json
import re
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def fetch(url, data=None, headers=None, method=None, timeout=30):
    h = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h,
                                 method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return None, {}, f"{type(e).__name__}: {e}".encode()


print("=" * 60)
print("1. 探测登录页 https://auth.openai.com/log-in")
print("=" * 60)
st, hd, body = fetch("https://auth.openai.com/log-in")
print(f"  HTTP: {st}")
print(f"  Server: {hd.get('Server', '-')}")
print(f"  CF-RAY: {hd.get('CF-RAY', '-')}   (有值说明走了 Cloudflare)")
print(f"  content-type: {hd.get('Content-Type', '-')}")
text = body.decode("utf-8", errors="replace")
print(f"  响应长度: {len(text)}")

# 关键判定：是否被 Cloudflare 挑战页拦下
lowered = text.lower()
signals = {
    "just a moment (CF挑战页)": "just a moment" in lowered,
    "cf-challenge": "cf-challenge" in lowered or "cf_chl_opt" in lowered,
    "turnstile": "turnstile" in lowered,
    "captcha": "captcha" in lowered,
    "sentinel": "sentinel" in lowered,
    "arkose": "arkose" in lowered,
    "openai 登录表单": "log-in" in lowered or "password" in lowered or "__next" in lowered,
}
print("  信号检测:")
for name, hit in signals.items():
    print(f"    {'✓' if hit else ' '} {name}")

print()
print("=" * 60)
print("2. 探测登录接口（空 body，只看拒绝方式）")
print("=" * 60)
st2, hd2, body2 = fetch(
    "https://auth.openai.com/api/accounts/authorize/continue",
    data=b"{}",
    headers={"Content-Type": "application/json", "Origin": "https://auth.openai.com",
             "Referer": "https://auth.openai.com/log-in"},
)
print(f"  HTTP: {st2}")
print(f"  响应前 500 字节:")
print("  " + body2.decode("utf-8", errors="replace")[:500])

print()
print("=" * 60)
print("3. 结论")
print("=" * 60)
if "just a moment" in lowered or "cf_challenge" in lowered:
    print("  ⚠️  登录页被 Cloudflare 挑战页拦截 —— 脚本登录不可行，必须人工")
elif st == 200 and ("__next" in lowered or "password" in lowered):
    print("  ✅ 登录页正常返回，没有 CF 挑战 —— 自动登录有戏")
else:
    print("  ❓ 情况不明，看上面细节")
