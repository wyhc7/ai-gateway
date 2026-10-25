# 凭据保护

这个仓库是公开的，而它同时又是「自建网关」的文档仓 —— 两者天然冲突：
文档写真实地址和 Key 才好抄，写进去就等于公开。

已经出过三次事故，所以这里不是讲道理，是讲机制。

---

## 出过的三次事故

| # | 时间 | 出了什么事 | 怎么出的 |
|---|---|---|---|
| 1 | 2026-10-24 | 泄露服务器 root 明文密码 | 调试用的 SSH askpass helper（`.sshpass.bat` / `.sshlogin.bat`）被 `git add -A` 带进提交 |
| 2 | 2026-10-24 | 泄露网关主 Key、管理 Key、服务器 IP、账号邮箱、2FA 密钥 | `docs/API-CALL-GUIDE.md` 为了让示例「直接能抄」，写死了真实值 |
| 3 | 2026-10-25 | **反向事故**：新写的源码被自己的规则吃掉，静默漏提交 | `.gitignore` 里裸通配 `*cred*` 命中 `web/src/components/CreditsPanel.vue`，`git add -A` 后该文件根本不进暂存区，`git status` 也不报 |

前两次都**不是**「忘了写 .gitignore」，而是「没想到这里也算凭据」。
第三次是反过来的：拦得太狠，把源码一起拦掉了 —— 而且**静默**，
如果不是提交后翻 diff 发现少了个文件，会一直以为部署失败是别的原因。

事故 3 的教训特别值得记：**忽略规则的错误有两种方向，只有一种会被发现。**
漏拦凭据会在扫描时报警；错拦源码则是无声的 —— 文件从 git 眼里消失了，
`git status` 干净得很。所以忽略规则也必须被测试覆盖，见文末。

---

## 第一层：.gitignore 按模式拦

不在具体文件名上打补丁 —— 因为每次随手起的名字都不一样（`.sshpass.bat`、
`.sshlogin.bat`、`.keepass.txt`……）。改成按语义拦。

但「按语义」不等于「用裸通配」。凭据一定是**数据文件**，源码一定是**代码文件**，
所以规则同时约束「名字」和「扩展名」：

```gitignore
*pass*.bat          # askpass helper 只会是 bat
*login*.bat
*login*.txt
*.cred
.cred*
*cred*.json         # 只拦数据形态，放行 XxxCredits.vue / secret-util.js
*cred*.txt
*cred*.pem
*cred*.key
.secret*
*secret*.json
*secret*.txt
*secret*.pem
*secret*.key
.sshask*
.keepass*
```

对比一下被删掉的那版，只差在有没有扩展名约束：

```gitignore
*cred*          # ✗ 连 CreditsPanel.vue 一起拦
*secret*        # ✗ 连 server/secret-util.js 一起拦
```

还有一个容易漏的点：`secret*.key` 是**前缀**匹配，`vendor-secret.key` 这种
secret 在中间的写法能穿过去。两边都加通配 `*secret*.key` 才严实。

代价是**会误伤自己人**：`scripts/check-secrets.mjs` 名字里带 secret，
如果想让它扩展名也受约束就要留例外：

```gitignore
!scripts/check-secrets.mjs
```

### 怎么验证规则对不对

改完 `.gitignore` 别靠眼看，逐项问 git 本身：

```bash
git check-ignore -v <path>    # 命中：打印是哪一行规则命中的
git check-ignore -q <path>    # 只看结果：退出码 0 命中，1 未命中
```

`server/test/gitignore.test.js` 把这个检查固化成 24 条用例：源码必须放行、
真凭据必须拦住、构建产物必须排除。**改忽略规则时这个测试必须一起跑**，
否则事故 3 会以另一种形态重演。

---

## 第二层：提交前扫描内容

文件名干净不代表内容干净 —— 事故 2 就是 `API-CALL-GUIDE.md` 这种
「名字毫无问题、内容满是凭据」的文件。

`scripts/check-secrets.mjs` 扫暂存区的**内容**，命中就拒绝提交。

### 装法（新克隆后执行一次）

```bash
git config core.hooksPath .githooks
```

### 它会抓什么

| 规则 | 抓什么 | 为什么危险 |
|---|---|---|
| `gateway-key` | `gk-xxxxxxxx-....` | 等同管理员，能用任意模型、烧光额度 |
| `admin-key` | `ak-` + 32 位十六进制 | 能改配置、删平台、删账号 |
| `chatgpt2api-key` | 48 位十六进制 | 能直接操作账号池 |
| `openai-oauth-code` | `oaistb_...` | 授权码，一次性但能直接换 token |
| `openai-token` | `eyJhbGciOiJSUzI1NiIs...` | JWT，约 10 天有效 |
| `ms-refresh-token` | `M.C537_BAY....` | 能长期续期邮箱访问 |
| `public-ip` | URL 里的公网 IP | 暴露部署位置，便于针对性扫描 |
| `outlook-email` | 真实邮箱 | 暴露账号池成员 |
| `totp-secret` | 32 位 Base32（含数字） | 拿到就能过 2FA |
| `password-assign` | `password = xxx` | 硬编码密码 |
| `ssh-askpass` | `@echo <密码>` | askpass helper |

### 手动跑

```bash
node scripts/check-secrets.mjs          # 扫暂存区（hook 用的就是它）
node scripts/check-secrets.mjs --all    # 扫整个工作区
```

### 误报怎么办

在被报的文件里加一行注释：

```js
// 允许误报: totp-secret —— 这是 RFC 4648 的 Base32 字符表，不是密钥
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
```

**按规则 id 逐条批准，不是整个文件放行**，这样同一个文件里的真实凭据仍然会被拦。

### 设计取舍

**宁可误报，不可漏报。** 误报时人能看到「哪个文件哪一行」，一眼判断；
漏报则是不可见的 —— 而不可见的风险才是真风险。

但误报也不能失控：第一版用裸 IP 匹配，把 `8.8.8.8`（DNS 表）、
`172.32.0.1`（测试夹具）、`1.2.3.4`（文档示例）全报成凭据，27 条里
只有 5 条是真的。**误报一多，人就开始无脑忽略告警，这比不做检查更糟。**
所以公网 IP 规则收紧成「只认 URL 里出现的」，并且跳过被 `.gitignore`
忽略的文件（`server/data/config.json` 里本来就该有真实 Key）。

---

## 什么时候该换 Key

**泄露即视为已泄露。** 只要真实值进过提交历史，就应当轮换，哪怕已经删掉 ——
历史是可以被翻出来的，而且 fork / 镜像 / 搜索引擎缓存都可能留副本。

轮换网关 Key：

```bash
# 在服务器上，备份后改 config.json 的两个 Key，然后重启
systemctl restart ai-gateway
```

换完记得同步更新所有调用方。

---

## 还需要人做的那部分

自动化能挡住「不小心提交」，挡不住这些：

- **已经推到远程的历史**：GitHub 分支保护默认禁止强推，删历史要走
  Settings → 临时关闭保护 → 强推 → 重新开启。仓主之外的贡献者无权操作。
- **轮换决策**：换 Key 会让现有调用方失效，什么时候换、通知谁，只有人知道。
- **判断误报**：扫描器给出证据，最终判断仍然是人。
