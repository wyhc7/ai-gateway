#!/usr/bin/env node
/**
 * ChatGPT 账号加号工具 —— 把「生成链接 → 收 callback → 写进池子」串成一条命令。
 *
 * 为什么需要它：
 *   加一个号原本要手工敲 7 条命令（起会话、拼 URL、提交、验额度……），
 *   每条命令的格式都不一样，容易漏参数。这里收敛成三件事：
 *     start    起会话，输出可打开的授权链接
 *     finish   拿浏览器里那串 callback 换 token，落进账号池
 *     list     看当前账号池和额度
 *
 * 浏览器那步仍然要人（或 DSH 内置浏览器）来做：ChatGPT 的 OAuth 只允许
 * 回调到 platform.openai.com/auth/callback，code 只出现在浏览器地址栏里。
 * 所以本工具负责「前后两端」，中间那一下交给浏览器。
 *
 * 用法：
 *   node scripts/add-account.mjs start  --email a@b.com [--base http://127.0.0.1:3001]
 *   node scripts/add-account.mjs finish --session <sid> --callback '<url>'
 *   node scripts/add-account.mjs list
 *   node scripts/add-account.mjs totp   --secret <base32>
 *
 * 管理密钥读取顺序：--admin-key 参数 > ADMIN_API_KEY 环境变量 > data/config.json
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHmac } from 'node:crypto'

const DEFAULT_BASE = process.env.AI_GATEWAY_BASE || 'http://127.0.0.1:3001'

// ---------- 参数与凭据 ----------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        i += 1
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function adminKeyOf(args) {
  if (args['admin-key']) return String(args['admin-key'])
  if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY
  // 兜底：从部署目录的 config.json 读，方便在服务器上直接跑
  for (const p of ['/opt/ai-gateway/data/config.json', resolve(process.cwd(), 'data/config.json')]) {
    try {
      const conf = JSON.parse(readFileSync(p, 'utf8'))
      if (conf?.admin_api_key) return conf.admin_api_key
    } catch {
      // 下一个
    }
  }
  return ''
}

async function call(base, path, { method = 'GET', adminKey, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey
  const resp = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const text = await resp.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // 保持 null
  }
  return { status: resp.status, json, text }
}

// ---------- TOTP：2FA 密钥出码 ----------

function totpBase32(secret, { digits = 6, period = 30, at = Date.now() } = {}) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  if (!clean) throw new Error('2FA 密钥为空或含非法字符')

  // Base32 → Buffer，不依赖 Buffer 的 base32 支持（Node 没有内置）
  let bits = ''
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error(`2FA 密钥含非法字符: ${ch}`)
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  const key = Buffer.from(bytes)

  const counter = Math.floor(at / 1000 / period)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  msg.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', key).update(msg).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(code).padStart(digits, '0')
}

// ---------- 子命令 ----------

async function cmdStart(args, base, adminKey) {
  const email = args.email ? String(args.email) : ''
  const r = await call(base, '/api/chatgpt-accounts/oauth/start', {
    method: 'POST',
    adminKey,
    body: { email_hint: email }
  })
  if (r.status !== 200 || !r.json) {
    console.error(`oauth/start 失败 HTTP ${r.status}`)
    console.error(r.text.slice(0, 400))
    return 1
  }
  const { session_id, authorize_url, expires_in } = r.json
  console.log(`session=${session_id}`)
  console.log(`expires_in=${expires_in}s`)
  console.log('')
  console.log('打开下面这个链接，登录并点 Authorize：')
  console.log(authorize_url)
  console.log('')
  console.log('页面会跳到 platform.openai.com/auth/callback?...（白屏正常），然后：')
  console.log(`  node scripts/add-account.mjs finish --session ${session_id} --callback '<整条地址栏>'`)
  return 0
}

async function cmdFinish(args, base, adminKey) {
  const sessionId = args.session ? String(args.session) : ''
  const callback = args.callback ? String(args.callback) : ''
  if (!sessionId || !callback) {
    console.error('需要 --session 和 --callback')
    return 1
  }

  // 先自己核对 state 前缀，避免白跑一趟转换层
  let state = ''
  try {
    state = new URL(callback).searchParams.get('state') || ''
  } catch {
    console.error('callback 不是合法 URL')
    return 1
  }
  if (state && !state.startsWith(sessionId)) {
    console.error(`state 不匹配：期望 ${sessionId.slice(0, 8)}…，收到 ${state.slice(0, 8)}…`)
    console.error('说明这条 callback 属于另一次授权，请重新 start')
    return 1
  }

  const r = await call(base, '/api/chatgpt-accounts/oauth/finish', {
    method: 'POST',
    adminKey,
    body: { provider_id: '', session_id: sessionId, callback }
  })
  if (r.status !== 200) {
    console.error(`oauth/finish 失败 HTTP ${r.status}`)
    console.error(r.text.slice(0, 500))
    return 1
  }

  const accounts = r.json?.accounts || r.json?.items || []
  const target = accounts.find((a) => state && a.email) || null
  console.log(`加号成功，账号池现有 ${accounts.length} 个`)
  console.log('')
  printTable(accounts)
  return 0
}

async function cmdList(args, base, adminKey) {
  const r = await call(base, '/api/chatgpt-accounts', { adminKey })
  if (r.status !== 200) {
    console.error(`读取账号池失败 HTTP ${r.status}`)
    console.error(r.text.slice(0, 400))
    return 1
  }
  const accounts = r.json?.accounts || []
  printTable(accounts)
  return 0
}

async function cmdTotp(args) {
  const secret = args.secret ? String(args.secret) : process.env.TOTP_SECRET || ''
  if (!secret) {
    console.error('需要 --secret 或 TOTP_SECRET 环境变量')
    return 1
  }
  try {
    const code = totpBase32(secret)
    const left = 30 - (Math.floor(Date.now() / 1000) % 30)
    console.log(`code=${code}`)
    console.log(`left=${left}s`)
    return 0
  } catch (e) {
    console.error(String(e.message || e))
    return 1
  }
}

function printTable(accounts) {
  if (!accounts.length) {
    console.log('（账号池为空）')
    return
  }
  let total = 0
  for (const a of accounts) {
    const q = Number(a.image_quota ?? a.quota ?? 0)
    total += Number.isFinite(q) ? q : 0
    const refresh = a.refresh_token ? '有' : '无'
    const plan = a.plan || '-'
    console.log(`  ${String(a.email || '?').padEnd(38)} ${String(a.status || '-').padEnd(5)} ${String(q).padStart(3)} 次  续期 ${refresh}  ${plan}`)
  }
  console.log(`  ${'合计'.padEnd(38)} ${''.padEnd(5)} ${String(total).padStart(3)} 次`)
}

// ---------- 入口 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const base = String(args.base || DEFAULT_BASE).replace(/\/+$/, '')
  const adminKey = adminKeyOf(args)

  if (cmd !== 'totp' && !adminKey) {
    console.error('找不到管理密钥：请用 --admin-key、ADMIN_API_KEY 环境变量，')
    console.error('或把脚本放在能读到 data/config.json 的目录下运行。')
    return 1
  }

  switch (cmd) {
    case 'start':
      return cmdStart(args, base, adminKey)
    case 'finish':
      return cmdFinish(args, base, adminKey)
    case 'list':
      return cmdList(args, base, adminKey)
    case 'totp':
      return cmdTotp(args)
    default:
      console.error('用法:')
      console.error('  node scripts/add-account.mjs start  --email a@b.com')
      console.error('  node scripts/add-account.mjs finish --session <sid> --callback \'<url>\'')
      console.error('  node scripts/add-account.mjs list')
      console.error('  node scripts/add-account.mjs totp   --secret <base32>')
      return 1
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e?.stack || String(e))
  process.exit(1)
})
