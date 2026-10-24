#!/usr/bin/env python3
"""用 Microsoft 凭据诊断 Outlook 邮箱：能刷新、能收信、验证码收件人是谁。

用于「ChatGPT 加了号但读不到验证码」这类场景：
先确认邮箱链路本身通不通，再看验证码有没有真的发进来。

凭据一律走环境变量，**不写死在文件里**（这个仓库是公开的）：

    export MS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    export MS_REFRESH_TOKEN='<Microsoft refresh_token>'
    export MS_EMAIL=someone@outlook.com
    python outlook-diagnose.py

可选的密码探测（默认不做，会触发风控）：

    export MS_PASSWORD='...'
    python outlook-diagnose.py --check-password

退出码：0 正常，1 配置缺失，2 链路不通。
"""
import argparse
import email
import imaplib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from email.header import decode_header

TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
IMAP_HOST = "outlook.office365.com"
SCOPES = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access"


def env(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        print(f"missing env: {name}", file=sys.stderr)
        raise SystemExit(1)
    return v


def decode_mime(raw: str | None) -> str:
    if not raw:
        return ""
    out = []
    for text, enc in decode_header(raw):
        if isinstance(text, bytes):
            out.append(text.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def refresh_ms(client_id: str, refresh_token: str) -> dict:
    """用 refresh_token 换 access_token。scope 只要 IMAP/SMTP。"""
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": SCOPES,
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def check_password(client_id: str, mail: str, password: str) -> None:
    """探测密码是否正确。

    注意：微软已经停掉了 ROPC（grant_type=password），
    所以这里只报告结论，不把它当作权威判断依据。
    """
    print("\n" + "=" * 60)
    print("4. 密码探测（可选）")
    print("=" * 60)
    if not password:
        print("  MS_PASSWORD 未设置，跳过")
        return
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "grant_type": "password",
        "username": mail,
        "password": password,
        "scope": SCOPES,
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            json.load(r)
        print("  password is VALID")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        print(f"  HTTP {e.code}: {body[:300]}")
        if "AADSTS70003" in body:
            print("  -> grant_type=password 已被微软停用，无法用这种方式判断密码")
        elif "AADSTS50126" in body:
            print("  -> 用户名或密码不正确")
        elif "AADSTS50053" in body:
            print("  -> 账号因多次错误尝试被锁定")
        elif "AADSTS50057" in body:
            print("  -> 账号已禁用")
        elif "AADSTS50076" in body or "AADSTS50079" in body:
            print("  -> 需要 MFA 二次验证，不是密码问题")
        elif "invalid_grant" in body:
            print("  -> 凭据无效或账号状态异常")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-password", action="store_true",
                    help="额外探测密码（会真实登录，可能触发风控）")
    ap.add_argument("--keyword", default="openai",
                    help="筛选邮件的关键词，默认 openai")
    args = ap.parse_args()

    client_id = env("MS_CLIENT_ID")
    ms_rt = env("MS_REFRESH_TOKEN")
    mail = env("MS_EMAIL")

    print("=" * 60)
    print("1. 刷新 Microsoft token")
    print("=" * 60)
    print(f"  mailbox: {mail}")
    try:
        tok = refresh_ms(client_id, ms_rt)
    except urllib.error.HTTPError as e:
        print(f"  refresh FAILED HTTP {e.code}")
        print("  " + e.read().decode(errors="replace")[:400])
        return 2
    except Exception as e:
        print(f"  refresh FAILED: {type(e).__name__}: {e}")
        return 2

    at = tok["access_token"]
    print(f"  OK  access_token len={len(at)}  expires_in={tok.get('expires_in')}")
    print(f"  rotated refresh_token: {'yes' if tok.get('refresh_token') else 'no'}")

    print("\n" + "=" * 60)
    print("2. IMAP 登录")
    print("=" * 60)
    auth = f"user={mail}\x01auth=Bearer {at}\x01\x01".encode()
    try:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, 993)
        conn.authenticate("XOAUTH2", lambda _: auth)
    except Exception as e:
        print(f"  IMAP FAILED: {type(e).__name__}: {str(e)[:300]}")
        return 2
    print("  OK  XOAUTH2 authenticated")

    try:
        conn.select("INBOX", readonly=True)
        status, msgs = conn.search(None, "ALL")
        ids = (msgs[0] or b"").split()
        print(f"  INBOX messages: {len(ids)}")

        print("\n" + "=" * 60)
        print(f"3. 匹配 '{args.keyword}' 的邮件")
        print("=" * 60)
        found = 0
        for mid in ids[::-1]:
            status, payload = conn.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])")
            if status != "OK" or not payload:
                continue
            msg = email.message_from_bytes(payload[0][1])
            frm = decode_mime(msg.get("From"))
            subj = decode_mime(msg.get("Subject"))
            to = decode_mime(msg.get("To"))
            blob = f"{frm} {subj}".lower()
            if args.keyword.lower() in blob:
                found += 1
                print(f"  [{found}] {msg.get('Date', '')}")
                print(f"      from: {frm}")
                print(f"      to  : {to}")
                print(f"      subj: {subj}")
        if found == 0:
            print(f"  no message matched '{args.keyword}'")
    finally:
        try:
            conn.logout()
        except Exception:
            pass

    if args.check_password:
        check_password(client_id, mail, (os.environ.get("MS_PASSWORD") or "").strip())

    return 0


if __name__ == "__main__":
    sys.exit(main())
