# 部署目录属主自愈与免密 sudo 白名单

## 问题：一次 EACCES 会伪装成好几种失败

手工排障时若用 `root` 在部署目录里跑过 `git reset --hard`、`npm run build`，
文件属主会变成 `root:root`。而服务与「网页一键更新」都以 `ai-gateway` 跑，
于是后续每一步都以不同的面貌失败：

```
error during build:
EACCES: permission denied, unlink '/opt/ai-gateway/web/dist/assets/index-133K9ulT.css'
```

```
fatal: Unable to create '/opt/ai-gateway/.git/index.lock': Permission denied
```

```
npm error code EACCES
npm error syscall mkdir
npm error path /opt/ai-gateway/web/node_modules/.bin
```

界面上看到的是「更新失败」，根因却只有一条：**属主不对**。

## 做法：更新前体检 + 自愈

`server/ownership.js` 在 `applyUpdate()` 的最开头（早于 `git fetch`）执行：

1. 限深扫描仓库（跳过 `node_modules`），找出所有不属于 `ai-gateway` 的路径
2. 有异常就 `chown -R ai-gateway:ai-gateway` 改回来
3. 复扫一遍确认真的修好了
4. 把这个动作写进更新步骤日志，让人知道「不是代码有问题，是权限被谁动过」

修复失败**不会中止更新**——多数情况下 `git` 与 `build` 仍能跑完，
中止反而把本来能完成的更新拦死。此时步骤日志里会给出可复制的命令。

## 为什么需要一条免密 sudo 规则

`chown` 需要 root，而「网页一键更新」以 `ai-gateway` 运行。不给提权，
自愈就只能"发现并报告"，修不了——这恰好是面板点更新时最常见的情形。

所以加一条**极窄**的白名单：

```
ai-gateway ALL=(root) NOPASSWD: /usr/bin/chown -R ai-gateway:ai-gateway /opt/ai-gateway
```

## 这条规则能做什么、不能做什么

| 能 | 不能 |
|---|---|
| 把 `/opt/ai-gateway` 整棵树归还给 `ai-gateway` | 改任何其它路径的属主 |
| 在更新流程里自动执行，无需人工 | 改成任何其它属主/属组（参数写死） |
| | 执行 `chown` 以外的任何命令 |
| | 拿到交互式 root shell |

参数固定意味着：即使服务被攻破，攻击者最多也只能把部署目录归还给服务账号本身，
拿不到任何额外权限。这是刻意为「修一个特定目录的属主」而收窄的提权面。

## 安装

```bash
sudo bash deploy/linux/install-ownership-sudo.sh
# 默认 /opt/ai-gateway + ai-gateway，也可显式指定：
# sudo bash deploy/linux/install-ownership-sudo.sh /srv/ai-gateway ai-gateway
```

脚本做的事：

1. 用 `mktemp` 生成临时规则文件
2. `visudo -c` 校验语法（写坏 sudoers 会锁死 sudo，必须先验后装）
3. `install -m 0440 -o root -g root` 装到 `/etc/sudoers.d/ai-gateway-chown`
4. 以服务用户 `sudo -n -l` 验证规则命中

路径会被 `pwd -P` 规范化：`/opt/ai-gateway/` 与 `/opt/ai-gateway` 在 sudoers 里是
两条不同的规则，结尾斜杠会让匹配失败。

## 验证

以服务用户身份确认规则生效：

```bash
su -s /bin/bash ai-gateway -c "sudo -n -l /usr/bin/chown -R ai-gateway:ai-gateway /opt/ai-gateway"
```

应看到 `NOPASSWD` 字样。再造一次故障验证自愈：

```bash
# 故意污染
chown -R root:root /opt/ai-gateway/web/dist
# 确认服务用户删不掉（复现原故障）
su -s /bin/bash ai-gateway -c "rm -rf /opt/ai-gateway/web/dist"   # Permission denied
# 以服务用户调自愈
su -s /bin/bash ai-gateway -c "cd /opt/ai-gateway/server && node --input-type=module -e '
import { ensureOwnership } from \"/opt/ai-gateway/server/ownership.js\";
console.log(await ensureOwnership(\"/opt/ai-gateway\"));'"
# 现在应该删得掉了
su -s /bin/bash ai-gateway -c "rm -rf /opt/ai-gateway/web/dist"   # OK
```

## 回滚

```bash
sudo rm -f /etc/sudoers.d/ai-gateway-chown
```

删掉后自愈退化为「发现并报告」，更新流程仍会继续，只是需要人工 `chown`。
不会因为缺这条规则而让更新失败。

## 预防：别再让属主错乱

在服务器上手工操作时，始终切到服务账号：

```bash
sudo -u ai-gateway bash -c 'cd /opt/ai-gateway && git pull && cd web && npm run build'
sudo systemctl restart ai-gateway
```

或者干脆用面板的「更新」按钮——它本来就以 `ai-gateway` 跑，不会造成属主错乱。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `UPDATE_SERVICE_USER` | `ai-gateway` | 期望的属主 |
| `UPDATE_REPO_DIR` | `server/..` | 仓库根 |

`SUDO_CHOWN` 常量（`server/ownership.js`）固定为 `/usr/bin/chown`，
必须与 sudoers 规则里的路径逐字节一致。
