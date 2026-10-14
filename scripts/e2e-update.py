"""端到端验证：让服务器用它自己的更新功能完成一次真实更新。

这是最终验收 —— 不用 ssh 手工 git，而是调用管理界面的同一个接口，
验证「检查更新 → 立即更新 → 自动重启 → 新版本生效」整条链路。

判定要点（第一版脚本在这里判错过，记下来避免重犯）：
  **HEAD 变了不等于服务重启了**。合并是 git 操作，重启是进程替换，
  两者是独立的两件事。只看 HEAD 会把「合并成功但重启失败」误判成成功 ——
  而「重启失败」正是本功能最初要修的那个缺陷，误判等于把缺陷掩盖掉。
  所以必须比对 MainPID，并检查 restart.ok。

用法：
    set GW_SSH_HOST=... & set GW_SSH_PASS=...
    python scripts/e2e-update.py
"""
import os
import sys
import time

import paramiko

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = os.environ.get('GW_SSH_HOST', '')
USER = os.environ.get('GW_SSH_USER', 'root')
PASSWORD = os.environ.get('GW_SSH_PASS', '')
PORT = int(os.environ.get('GW_SSH_PORT', '22') or 22)
REPO = os.environ.get('GW_REPO', '/opt/ai-gateway')
SVC = os.environ.get('GW_SERVICE', 'ai-gateway')


def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                   timeout=25, banner_timeout=25, auth_timeout=25,
                   look_for_keys=False, allow_agent=False)
    return client


def run(client, cmd, timeout=600):
    _, out, err = client.exec_command(cmd, timeout=timeout)
    o = out.read().decode('utf-8', 'replace').strip()
    e = err.read().decode('utf-8', 'replace').strip()
    return o, e


def key_expr():
    return (f"$(python3 -c \"import json;print(json.load(open('{REPO}/data/config.json'))"
            f"['admin_api_key'])\")")


def state(client):
    o, _ = run(client, f'cd {REPO} && git rev-parse --short HEAD; '
                       f'systemctl show -p MainPID --value {SVC}; '
                       f'systemctl is-active {SVC}')
    parts = (o or '').split('\n')
    return {
        'head': parts[0] if len(parts) > 0 else '',
        'pid': parts[1] if len(parts) > 1 else '',
        'active': parts[2] if len(parts) > 2 else '',
    }


def main():
    if not HOST or not PASSWORD:
        print('缺少凭据：请设置 GW_SSH_HOST 与 GW_SSH_PASS。')
        return 2
    client = connect()
    print(f'[已连接] {USER}@{HOST}\n')

    print('===== 0. 更新前状态 =====')
    before = state(client)
    print(f"HEAD={before['head']}  MainPID={before['pid']}  active={before['active']}")

    print('\n===== 1. 检查更新 =====')
    o, _ = run(client, f'curl -s -H "x-admin-key: {key_expr()}" http://127.0.0.1:3001/api/update/check')
    print(o[:700])
    if '"can_update":true' not in o:
        print('\n[跳过] 当前没有可更新内容（can_update=false）。')
        client.close()
        return 0

    print('\n===== 2. 触发更新 =====')
    o, e = run(client, f'curl -s -m 300 -X POST -H "x-admin-key: {key_expr()}" '
                       f'http://127.0.0.1:3001/api/update/apply', timeout=420)
    print((o or e)[:2000])
    restart_ok = '"restart":{"ok":true' in (o or '')

    print('\n===== 3. 等待进程被替换 =====')
    replaced = False
    for i in range(20):
        time.sleep(3)
        cur = state(client)
        o, _ = run(client, f'curl -s -o /dev/null -w "%{{http_code}}" -m 5 http://127.0.0.1:3001/api/health 2>/dev/null')
        print(f"t=+{(i+1)*3}s active={cur['active']} pid={cur['pid']} health={o}")
        if cur['active'] == 'active' and o == '200' and cur['pid'] != before['pid']:
            replaced = True
            print('  -> 新进程已起来（MainPID 已变）')
            break

    after = state(client)
    print('\n===== 4. 结果 =====')
    o, _ = run(client, f'echo "NRestarts=$(systemctl show -p NRestarts --value {SVC})"; '
                       f'echo "Result=$(systemctl show -p Result --value {SVC})"; '
                       f'echo "--- deployed ---"; cat {REPO}/data/deployed-revision.json')
    print(o)

    print('\n===== 5. 日志（看自退出痕迹）=====')
    o, _ = run(client, f'journalctl -u {SVC} -n 40 --no-pager 2>&1 | grep -E "更新完成|Starting|Started|Stopped|Failed" | tail -12')
    print(o or '(无匹配)')

    print('\n===== 6. 判定 =====')
    print(f"HEAD: {before['head']} -> {after['head']}")
    print(f"MainPID: {before['pid']} -> {after['pid']}")
    print(f"接口自报 restart.ok = {restart_ok}")
    if after['head'] != before['head'] and replaced and restart_ok:
        print('✅ 端到端成功：代码已更新，服务由 systemd 自动拉起（无需人工重启）')
        code = 0
    elif after['head'] != before['head'] and not replaced:
        print('❌ 代码已更新，但进程未被替换 —— 自重启没生效')
        code = 1
    elif after['head'] == before['head'] and before['head'] != '':
        print('ℹ️ 无更新内容（已是最新）')
        code = 0
    else:
        print('⚠️ 状态异常，见上面输出')
        code = 1

    client.close()
    return code


if __name__ == '__main__':
    sys.exit(main())
