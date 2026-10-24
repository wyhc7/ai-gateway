#!/usr/bin/env node
/**
 * 提交前凭据扫描 —— 拦住「真实 Key / 密码 / IP 被写进文档」这类事故。
 *
 * 为什么需要：
 *   这个仓库是公开的。历史上已经出过两次事故：
 *     1. .sshpass.bat / .sshlogin.bat 里是明文服务器密码，被 git add -A 带进去
 *     2. docs/API-CALL-GUIDE.md 里写死了真实的网关主 Key、管理 Key、服务器 IP
 *   两次都不是「忘了 .gitignore」，而是「没想到这里也算凭据」。
 *   靠记性挡不住，所以把它变成一个能自动跑的检查。
 *
 * 用法：
 *   node scripts/check-secrets.mjs            # 扫暂存区（pre-commit 用）
 *   node scripts/check-secrets.mjs --all      # 扫全工作区
 *   node scripts/check-secrets.mjs --fix-hint # 只打印怎么改，不退出非零
 *
 * 退出码：0 干净，1 发现疑似凭据。
 *
 * 设计取舍：宁可误报也不漏报。规则命中后给的是「哪个文件哪一行」，
 * 人可以一眼判断是误报还是真事；漏报则不可见。白名单靠 --allow 注释行批准。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// 规则表。每条：{ id, re, why, hint }
// re 必须带全局标志，扫描时用 matchAll。
const RULES = [
  {
    id: 'gateway-key',
    re: /\bgk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    why: '网关 API Key（等同管理员权限，可用任意模型）',
    hint: '换成 <网关 Key>，真实值只放在服务器的 data/config.json'
  },
  {
    id: 'admin-key',
    re: /\bak-[0-9a-f]{32}\b/g,
    why: '管理密钥（能改配置、删平台、删账号）',
    hint: '换成 <管理 Key>，真实值只放在服务器的 data/config.json'
  },
  {
    id: 'chatgpt2api-key',
    re: /\b[0-9a-f]{48}\b/g,
    why: '疑似 chatgpt2api authkey（48 位十六进制）',
    hint: '换成 <转换层 Key>，真实值放在 /root/chatgpt2api-authkey.txt'
  },
  {
    id: 'openai-oauth-code',
    re: /\boaistb_[A-Za-z0-9_-]{20,}/g,
    why: 'ChatGPT OAuth 授权码',
    hint: '授权码一次性有效，别提交，也别贴进文档'
  },
  {
    id: 'openai-token',
    re: /\beyJhbGciOiJSUzI1NiIs[A-Za-z0-9_-]{40,}/g,
    why: 'OpenAI access_token（JWT）',
    hint: '这类 token 约 10 天有效，泄露即等于账号被盗用'
  },
  {
    id: 'ms-refresh-token',
    re: /\bM\.C[0-9]{3}_BAY\.[A-Za-z0-9!*_-]{40,}/g,
    why: 'Microsoft refresh_token（可长期续期邮箱访问）',
    hint: '换成 <Microsoft refresh_token>，真实值只走环境变量'
  },
  {
    id: 'public-ip',
    // 只认「出现在 URL 或 host:port 里」的公网 IP。
    // 早先按裸 IP 匹配，结果 DNS 服务器表（8.8.8.8）、测试夹具（172.32.0.1）、
    // 文档示例（1.2.3.4）全被报成凭据 —— 误报一多，人就开始无脑忽略告警，
    // 这比不做检查更糟。真实泄漏总是带着 scheme 或端口出现，收紧到这两种形态。
    re: /(?:https?:\/\/)(?!(?:127\.0\.0\.1|localhost|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.))(?:\d{1,3}\.){3}\d{1,3}\b/g,
    why: 'URL 里写死了公网 IP（暴露部署位置，便于针对性扫描）',
    hint: '换成 <网关地址> 或 127.0.0.1'
  },
  {
    id: 'outlook-email',
    re: /\b[A-Za-z0-9._%+-]+@(?:outlook|hotmail|hanmail|gmail|qq|163)\.(?:com|net)\b/g,
    why: '真实邮箱（暴露账号池成员）',
    hint: '换成 <账号邮箱> 或 a@example.com'
  },
  {
    id: 'totp-secret',
    // 32 位全大写 Base32，且必须含至少一个数字。
    // 加数字这个约束是为了避开 RFC 4648 的 26+6 字符表定义本身 ——
    // 那串常量在实现 TOTP 的代码里必然出现，不排除就会天天误报。
    re: /\b(?=[A-Z2-7]{32}\b)(?=[A-Z]*\d)[A-Z2-7]{32}\b/g,
    why: '疑似 TOTP 2FA 密钥（32 位 Base32，拿到就能过二次验证）',
    hint: '换成 <Base32 密钥>'
  },
  {
    id: 'password-assign',
    re: /(?:password|passwd|密码)\s*[:=]\s*['"]?[^\s'"<>{}\[]]{6,}/gi,
    why: '疑似硬编码密码',
    hint: '改用环境变量。文档里写 <密码> 即可'
  },
  {
    id: 'ssh-askpass',
    re: /@echo\s+\S{8,}/g,
    why: '疑似 SSH askpass helper（里面是明文服务器密码）',
    hint: '这类文件不该进仓库，.gitignore 已按 *pass*.bat 拦'
  }
]

// 不扫的路径。二进制、依赖、构建产物没有意义。
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage'])
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.tar', '.woff', '.woff2', '.ttf', '.map'
])

// 允许出现的例外。加了一行 `允许误报: <规则id>` 注释的文件整份跳过该规则。
function allowedIds(text) {
  const out = new Set()
  for (const m of text.matchAll(/允许误报:\s*([a-z0-9-]+)/g)) out.add(m[1])
  return out
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8'
  })
  return out.split('\n').filter(Boolean)
}

function walk(dir, acc = []) {
  for (const ent of readdirSyncSafe(dir)) {
    const p = `${dir}/${ent.name}`
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(p, acc)
    } else {
      const dot = ent.name.lastIndexOf('.')
      const ext = dot >= 0 ? ent.name.slice(dot).toLowerCase() : ''
      if (!SKIP_EXT.has(ext)) acc.push(p)
    }
  }
  return acc
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function scan(files) {
  const hits = []
  for (const f of files) {
    if (isIgnored(f)) continue
    let text
    try {
      const st = statSync(f)
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue // 二进制
    const allow = allowedIds(text)
    const lines = text.split('\n')
    for (const rule of RULES) {
      if (allow.has(rule.id)) continue
      lines.forEach((line, i) => {
        // 每个规则自己带 g，用 matchAll 前要重置 lastIndex
        rule.re.lastIndex = 0
        for (const m of line.matchAll(rule.re)) {
          // 占位符与示例域不算
          const v = m[0]
          if (isPlaceholder(v)) continue
          hits.push({ file: f, line: i + 1, id: rule.id, value: v, why: rule.why, hint: rule.hint })
        }
      })
    }
  }
  return hits
}

function isPlaceholder(v) {
  // <...> 包裹的、明显是示例的，都放过
  if (v.startsWith('<') && v.endsWith('>')) return true
  // 监听地址/回环不是「部署位置」：启动日志里必然出现，报了只会训练人忽略告警
  if (/(?:^|\/\/)(?:127\.0\.0\.1|0\.0\.0\.0)\b/.test(v)) return true
  if (/^(?:127\.0\.0\.1|0\.0\.0\.0)$/.test(v)) return true
  if (/example\.(?:com|org|net)$/.test(v)) return true
  // someone@ / user@ / a@ 这类明显是文档占位
  if (/^(?:someone|someone|user|you|me|a|test|foo|bar|demo|sample)@/i.test(v)) return true
  if (/@(?:example|test|localhost)/.test(v)) return true
  // 文档里常见的全 x 占位
  if (/^[x*]{8,}$/i.test(v)) return true
  return false
}

// 被 .gitignore 忽略的文件不该扫：它们本来就不会进仓库，
// 里面的真实 Key（如 server/data/config.json）是设计上就该待在本地的。
let ignoredCache = null
function isIgnored(file) {
  if (ignoredCache === null) {
    try {
      // --no-index 才能让 check-ignore 也认已跟踪的文件
      const out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], {
        encoding: 'utf8',
        cwd: process.cwd()
      })
      ignoredCache = out.split('\n').filter(Boolean)
    } catch {
      ignoredCache = []
    }
  }
  const norm = file.replace(/\\/g, '/')
  const rel = norm.startsWith(process.cwd().replace(/\\/g, '/') + '/')
    ? norm.slice(process.cwd().replace(/\\/g, '/').length + 1)
    : norm
  return ignoredCache.some((ig) => {
    const dir = ig.endsWith('/') ? ig.slice(0, -1) : ig
    return rel === dir || rel.startsWith(dir + '/')
  })
}

function main(argv) {
  const all = argv.includes('--all')
  const hintOnly = argv.includes('--fix-hint')

  const files = all
    ? walk(process.cwd().replace(/\\/g, '/'))
    : stagedFiles().filter((f) => {
        try {
          return statSync(f).isFile()
        } catch {
          return false
        }
      })

  if (files.length === 0) {
    console.log('没有需要检查的文件')
    return 0
  }

  const hits = scan(files)
  if (hits.length === 0) {
    console.log(`✓ 已扫描 ${files.length} 个文件，未发现疑似凭据`)
    return 0
  }

  console.error(`\n✖ 发现 ${hits.length} 处疑似凭据：\n`)
  const byFile = new Map()
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, [])
    byFile.get(h.file).push(h)
  }
  for (const [file, list] of byFile) {
    console.error(`  ${file}`)
    for (const h of list) {
      console.error(`    行 ${h.line}  [${h.id}]  ${h.value}`)
      console.error(`       ${h.why}`)
      console.error(`       → ${h.hint}`)
    }
    console.error('')
  }
  console.error('确属误报时，在该文件加一行注释：允许误报: <规则id>\n')

  return hintOnly ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
