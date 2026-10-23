#!/usr/bin/env bash
#
# 给「网页一键更新」装属主自愈所需的免密 sudo 白名单。
#
# 为什么需要它：更新以 ai-gateway 用户跑，而手工排障时若用 root 动过仓库，
# 文件会变成 root:root，ai-gateway 就删不掉 web/dist、也写不了 .git/index，
# 更新接连失败在 EACCES 上。自愈要 chown 回 ai-gateway，但那需要 root。
#
# 提权面刻意收到最小：只允许执行**一条** chown，只针对**一个**目录，
# 目标属主/组固定写死，不接受任意参数。这样即使服务被攻破，
# 攻击者也只能把 /opt/ai-gateway 归还给 ai-gateway —— 没有可利用的越权路径。
#
# 用法：
#   sudo bash deploy/linux/install-ownership-sudo.sh [仓库目录] [服务用户]
# 默认 /opt/ai-gateway 与 ai-gateway。

set -euo pipefail

REPO_DIR="${1:-/opt/ai-gateway}"
USER_NAME="${2:-ai-gateway}"
SUDOERS_FILE="/etc/sudoers.d/ai-gateway-chown"
CHOWN_BIN="$(command -v chown || echo /usr/bin/chown)"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root 权限运行：sudo bash $0 $*" >&2
  exit 1
fi

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  echo "用户 $USER_NAME 不存在，先创建服务用户再跑本脚本" >&2
  exit 1
fi

if [ ! -d "$REPO_DIR" ]; then
  echo "目录 $REPO_DIR 不存在" >&2
  exit 1
fi

# 规范化成绝对路径且去掉结尾斜杠：sudoers 里的路径必须与进程实际传的字符串
# 逐字节一致，/opt/ai-gateway/ 和 /opt/ai-gateway 是两条不同的规则。
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<EOF
# 由 deploy/linux/install-ownership-sudo.sh 生成，请勿手工编辑。
# 唯一用途：让 ai-gateway 在网页点「更新」时能把部署目录的属主改回自己，
# 从而自愈掉手工用 root 操作留下的 root:root 文件。
# 只能对这一个目录、这一组属主执行 chown，参数全部写死。
$USER_NAME ALL=(root) NOPASSWD: $CHOWN_BIN -R $USER_NAME\\:$USER_NAME $REPO_DIR
EOF

# visudo -c 校验语法：写坏 sudoers 会锁死 sudo，必须先验后装。
if ! visudo -cf "$TMP" >/dev/null 2>&1; then
  echo "sudoers 语法校验失败，未安装：" >&2
  cat "$TMP" >&2
  exit 1
fi

install -m 0440 -o root -g root "$TMP" "$SUDOERS_FILE"
echo "已写入 $SUDOERS_FILE"
echo "规则：$USER_NAME ALL=(root) NOPASSWD: $CHOWN_BIN -R $USER_NAME:$USER_NAME $REPO_DIR"

# 立即验证：以服务用户 `sudo -n -l` 不带参数列出该用户被授予的全部命令，
# 再 grep 这条规则。
#
# 不能写 `sudo -l <命令> <参数...>`：那要求参数与规则逐字对应，稍有出入就报
# "not allowed to run"，把有效规则误判成失效（第一版就栽在这）。
# 不带参数列全量，只判断"这条 chown 在不在白名单里"，稳定得多。
if su -s /bin/bash "$USER_NAME" -c "sudo -n -l" 2>/dev/null \
  | grep -q -- "NOPASSWD.*$CHOWN_BIN -R $USER_NAME:$USER_NAME $REPO_DIR"; then
  echo "验证：免密 sudo 可用 ✅"
else
  echo "验证：规则未在 sudo -l 输出中命中，请人工检查 ⚠️" >&2
  echo "  su -s /bin/bash $USER_NAME -c 'sudo -n -l'" >&2
fi

echo
echo "如不再需要，删除即可：rm -f $SUDOERS_FILE"
