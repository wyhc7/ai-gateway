"""远程运维：以 root 连上部署机执行诊断/修复动作。

凭据一律从环境变量读，**不写进代码**——这些脚本会留在工作区，硬编码密码
等于把服务器交给任何一个能看到仓库的人。

用法：
    set GW_SSH_HOST=1.2.3.4
    set GW_SSH_PASS=...
    python scripts/remote-ops.py <动作>

动作：
    diag          收集部署与更新功能的关键事实（只读）
    fix-perms     把 /opt/ai-gateway 属主归一给 ai-gateway（修 git fetch 失败）
    fix-restart   已废弃：NoNewPrivileges=true 让 sudo/polkit 两条提权路都不可用，
                  自重启改由 systemd 的 Restart=on-failure 承担，见 server/update.js
    apply         在服务器上执行一次「检查更新」（只读）

默认值只给非敏感项，主机与密码必须显式提供。
"""
import os
import sys

import paramiko

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = os.environ.get('GW_SSH_HOST', '')
USER = os.environ.get('GW_SSH_USER', 'root')
PASSWORD = os.environ.get('GW_SSH_PASS', '')
PORT = int(os.environ.get('GW_SSH_PORT', '22') or 22)
REPO = os.environ.get('GW_REPO', '/opt/ai-gateway')
SVC = os.environ.get('GW_SERVICE', 'ai-gateway')


def connect():
    if not HOST or not PASSWORD:
        print('缺少凭据：请设置 GW_SSH_HOST 与 GW_SSH_PASS 环境变量。')
        raise SystemExit(2)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                   timeout=25, banner_timeout=25, auth_timeout=25,
                   look_for_keys=False, allow_agent=False)
    return client


def run(client, cmd, timeout=180):
    _, out, err = client.exec_command(cmd, timeout=timeout)
    o = out.read().decode('utf-8', 'replace').strip()
    e = err.read().decode('utf-8', 'replace').strip()
    return o, e


def show(title, cmd, client, timeout=180):
    print(f'===== {title} =====')
    o, e = run(client, cmd, timeout=timeout)
    print(o or '(无输出)')
    if e:
        print(f'[stderr] {e}')
    print()


def action_diag(client):
    show('系统', 'cat /etc/os-release | head -3; node -v; git --version', client)
    show('仓库属主异常项', f'find {REPO} ! -user {SVC} -printf "%u:%g %m %p\\n" 2>/dev/null | head -20; '
                          f'echo "总数=$(find {REPO} ! -user {SVC} 2>/dev/null | wc -l)"', client)
    show('工作区', f'cd {REPO} && git rev-parse --short HEAD; git status --porcelain | head -10; echo "(空=干净)"', client)
    show('服务单元关键项', f'systemctl show -p Restart -p RestartSec -p NoNewPrivileges -p ProtectHome '
                          f'-p StartLimitBurst --value {SVC}', client)
    show('服务用户能力（生产沙箱内）',
         f'systemd-run --quiet --wait --pipe --collect --unit=sbx-diag '
         f'--property=User={SVC} --property=Group={SVC} --property=NoNewPrivileges=true '
         f'--property=ProtectSystem=full --property=ProtectHome=true --property=PrivateTmp=true '
         f'--property=WorkingDirectory={REPO} /bin/bash -c '
         f'"cd {REPO} && git fetch --quiet --no-tags origin main && echo FETCH_OK || echo FETCH_FAIL" 2>&1 | tail -3',
         client, timeout=240)
    show('更新检查接口', f'K=$(python3 -c "import json;print(json.load(open(\'{REPO}/data/config.json\'))[\'admin_api_key\'])") ; '
                        f'curl -s -H "x-admin-key: $K" http://127.0.0.1:3001/api/update/check | head -c 1500', client)
    run(client, 'systemctl reset-failed "sbx-*" 2>/dev/null; true')


def action_fix_perms(client):
    print('--- 修复前 ---')
    o, _ = run(client, f'find {REPO} ! -user {SVC} -printf "%u:%g %m %p\\n" 2>/dev/null | head -20')
    print(o or '(无异常项)')
    o, e = run(client, f'chown -R {SVC}:{SVC} {REPO} && echo CHOWN_OK')
    print(o or e)
    print('--- 修复后 ---')
    o, _ = run(client, f'find {REPO} ! -user {SVC} 2>/dev/null | wc -l')
    print(f'剩余异常项：{o}')
    o, e = run(client, f'sudo -u {SVC} git -c safe.directory={REPO} -C {REPO} fetch --no-tags origin main 2>&1 | tail -3; echo "exit=$?"', timeout=240)
    print(f'--- 以服务用户重测 fetch ---\n{o or e}')


def action_apply(client):
    show('检查更新（只读）',
         f'K=$(python3 -c "import json;print(json.load(open(\'{REPO}/data/config.json\'))[\'admin_api_key\'])") ; '
         f'curl -s -H "x-admin-key: $K" http://127.0.0.1:3001/api/update/check', client)


ACTIONS = {
    'diag': action_diag,
    'fix-perms': action_fix_perms,
    'apply': action_apply,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ACTIONS:
        print(__doc__)
        return 2
    client = connect()
    print(f'[已连接] {USER}@{HOST}\n')
    try:
        ACTIONS[sys.argv[1]](client)
    finally:
        client.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
