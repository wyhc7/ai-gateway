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

## ⚠️ 前提：`NoNewPrivileges=true` 会让上面全部失效

这是最容易踩的一次坑，而且报错完全指不到根因。

如果 systemd 单元里有：

```ini
[Service]
NoNewPrivileges=true
```

那么**免密 sudo 规则配得再对也没用**，因为这不是 sudoers 的问题：

```
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
sudo: If sudo is running in a container, you may need to adjust the container
      configuration to disable the flag.
```

`NoNewPrivileges` 是**内核 per-task flag**：一旦置位，本进程及所有后代都
不许通过 setuid/setgid 提权。`sudo` 二进制本身带 setuid 位，但内核会直接
忽略它——所以它不是"配置写错了"，而是"这条路被内核封死了"。

### 一次真实的故障链

面板点更新，日志长这样：

```
✓ 修正部署目录属主
  发现 18 个文件属主不是 ai-gateway（.git/objects/18、... 等 18 个），
  sudo 修正属主失败（sudo: The "no new privileges" flag is set...）
  请手工执行：chown -R ai-gateway:ai-gateway /opt/ai-gateway
✓ 安装前端依赖
✕ 构建管理界面
  前端构建失败：sh: 1: vite: not found
```

看起来是两个不相干的错误，其实是**一条链**：

1. 之前有人用 `root` 跑过 `git` 操作 → `.git/objects` 里 18 个文件属主变成 root
2. `NoNewPrivileges` 让自愈的 `sudo chown` 失败 → 属主修不了
3. 属主问题让 `npm install` 在中途报 EACCES 退出 → `web/node_modules` 只装了一半
4. 半装的依赖里没有 `vite` → 构建报 `vite: not found`

第 4 步的报错离根因已经很远了。**看到 `vite: not found` 先别去查 vite，
先看前一步的属主是不是没修成。**

### 解法

去掉那一行（其余沙箱项保留）：

```bash
# 备份
cp /etc/systemd/system/ai-gateway.service /root/ai-gateway.service.bak-$(date +%Y%m%d-%H%M%S)

# 删掉 NoNewPrivileges=true
sed -i '/^NoNewPrivileges=true$/d' /etc/systemd/system/ai-gateway.service

systemctl daemon-reload
systemctl restart ai-gateway
systemctl show ai-gateway -p NoNewPrivileges    # 应输出 NoNewPrivileges=no
```

`ProtectSystem=full` / `ProtectHome=true` / `PrivateTmp=true` 这些都**不用动** ——
它们限制的是文件系统可见性，与提权无关，去掉 `NoNewPrivileges` 不影响它们的保护。

### 取舍

去掉 `NoNewPrivileges` 确实少了一层内核保护。但这是一个**自托管单租户**服务，
部署目录本来就归它自己；而保留它意味着「网页一键更新」永远修不了属主，
每次都要人工 SSH 上去 chown——那才是更大的运维风险（以及更可能的手滑）。

想两头都要，就**只装 sudoers 白名单、不留 `NoNewPrivileges`**：
提权面被那条 `chown` 命令锁死（见下一节），比"完全禁止提权但每次都要人工介入"更实际。

如果你坚持保留 `NoNewPrivileges`，那就得接受属主自愈永远不可用，
改用 root 侧的 `ExecStartPre` 兜底：

```ini
[Service]
ExecStartPre=+/usr/bin/chown -R ai-gateway:ai-gateway /opt/ai-gateway
```

前缀 `+` 让这一行以 root 执行（绕过 `User=`），每次启动先修属主再起服务。
代价是属主只在**重启时**修正，更新过程中仍然可能失败。

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

**先确认 `NoNewPrivileges` 是关的**（不然下面全部白验）：

```bash
systemctl show ai-gateway -p NoNewPrivileges     # 必须是 NoNewPrivileges=no
```

然后以服务用户身份确认规则生效：

```bash
su -s /bin/bash ai-gateway -c "sudo -n -l /usr/bin/chown -R ai-gateway:ai-gateway /opt/ai-gateway"
```

应看到 `NOPASSWD` 字样。

最直接的验证是**真跑一次 chown**——`-l` 只是列规则，能列出不等于能执行：

```bash
su -s /bin/bash ai-gateway -c \
  "sudo -n /usr/bin/chown -R ai-gateway:ai-gateway /opt/ai-gateway/.git" \
  && echo "sudo chown 可用" || echo "仍然不可用"
```

这一步成功，说明整条链路真的通了。再造一次故障验证自愈：

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

## 别被 `server/package-lock.json` 的 diff 骗了

每次 `npm install --prefix server` 之后，`git status` 都会显示这个文件被改过：

```diff
"..": {
-  "version": "1.0.0"
+  "version": "1.0.0",
+  "devDependencies": {
+    "playwright": "^1.49.1"
+  }
}
```

**这是 npm 的正常行为，不是文件损坏，也不需要还原。**

根 `package.json` 里确实有 `playwright` 这个 devDependency；npm 装子目录时会把
上层 `package.json` 的元信息同步进子目录 lock 文件的 `".."` 条目。

还原它 => 下次 `npm install` 又改回来 => 无限循环。看到这条 diff 直接忽略。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `UPDATE_SERVICE_USER` | `ai-gateway` | 期望的属主 |
| `UPDATE_REPO_DIR` | `server/..` | 仓库根 |

`SUDO_CHOWN` 常量（`server/ownership.js`）固定为 `/usr/bin/chown`，
必须与 sudoers 规则里的路径逐字节一致。
