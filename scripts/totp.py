#!/usr/bin/env python3
"""从 TOTP 密钥实时算 6 位验证码。

商家给的 2FA 密钥是标准 Base32，配合 TOTP（SHA1 / 30 秒 / 6 位）出码。

用法：
    python totp.py <secret>
    python totp.py <secret> --watch     # 每秒刷新
    python totp.py --stdin              # 从标准输入读密钥（避免泄漏到 shell 历史）

输出刻意用英文：Windows 中文终端会把 UTF-8 中文打成乱码，
脚本里如果解析输出就会失败。只保留 "code=<6位>" 一行给机器用。
"""
import base64
import hashlib
import hmac
import struct
import sys
import time

PERIOD = 30
DIGITS = 6


def totp(secret: str, at: float | None = None) -> str:
    """按 RFC 6238 算 TOTP。secret 是 Base32 字符串。"""
    key_b32 = (secret or "").strip().replace(" ", "").upper()
    if not key_b32:
        raise ValueError("secret is empty")
    # Base32 长度必须是 8 的倍数，不足补 '='
    pad = (-len(key_b32)) % 8
    key = base64.b32decode(key_b32 + "=" * pad)

    now = at if at is not None else time.time()
    counter = int(now // PERIOD)

    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    # 动态截断
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def seconds_left(at: float | None = None) -> int:
    now = at if at is not None else time.time()
    return PERIOD - int(now) % PERIOD


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}

    if "--stdin" in flags:
        secret = sys.stdin.readline().strip()
    elif args:
        secret = args[0]
    else:
        print("usage: totp.py <secret> [--watch] [--stdin]", file=sys.stderr)
        return 1

    try:
        totp(secret)  # 先校验一次，密钥格式不对立刻报
    except Exception as e:
        print(f"invalid secret: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    if "--watch" in flags:
        try:
            while True:
                # \r 回到行首，原地刷新
                print(f"\rcode={totp(secret)}  left={seconds_left():2d}s", end="", flush=True)
                time.sleep(1)
        except KeyboardInterrupt:
            print()
        return 0

    # 机器可解析的一行放最前，人看的提示放后面
    code = totp(secret)
    print(f"code={code}")
    print(f"left={seconds_left()}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
