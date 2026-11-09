import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { normalizeBilling, normalizeAccountBalances, normalizeLedger } from './billing.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const BACKUP_PATH = join(DATA_DIR, 'config.json.bak')

// 原子写：先写同目录临时文件再 rename 覆盖目标。
// writeFileSync 直接覆盖在写入中途断电/崩溃时会留下半截文件，
// 而 rename 是文件系统级的原子替换——要么旧文件完整、要么新文件完整，绝不会损坏。
function atomicWrite(path, data) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, 'utf-8')
  renameSync(tmp, path)
}

function defaultStats() {
  return {
    totalRequests: 0,
    todayRequests: 0,
    totalSuccess: 0,
    totalFailed: 0,
    todaySuccess: 0,
    todayFailed: 0,
    totalFailovers: 0,
    totalTokens: 0,
    todayTokens: 0,
    todayDate: todayKey(),
    perProvider: {}
  }
}

const DEFAULT_STATE = () => ({
  providers: [],
  gateway_api_key: `gk-${crypto.randomUUID()}`,
  // 发给客户端的访问密钥：每把可单独限定可用的模型、停用、设到期时间。
  // 只存 SHA-256 摘要，明文只在创建/轮换时返回一次（见 api-keys.js）。
  api_keys: [],
  // 管理端密钥：保护 /api/* 管理接口（可用环境变量 ADMIN_KEY 覆盖）
  admin_api_key: process.env.ADMIN_KEY || `ak-${crypto.randomUUID()}`,
  // 管理面板账号（用户名 + scrypt 密码摘要）。老配置没有此字段，load() 会补空数组，
  // 由「首次引导」用 admin_api_key 认领出第一个管理员。
  accounts: [],
  // 会话令牌的 HMAC 密钥：随机一次并持久化，重启后已签发的令牌仍然有效。
  // 与 admin_api_key 分开，是为了将来轮换管理密钥时不必把所有人都踢下线。
  session_secret: crypto.randomBytes(32).toString('hex'),
  // 用户余额计费：计价参数、余额流水。账号余额本身存 account.balance_micro，
  // 见 billing.js。老配置没有这两个字段，load() 会补齐。
  billing: {
    unit: '元',
    currency: 'CNY',
    micros_per_unit: 1_000_000,
    price_input_cached_micro_per_mtok: 10_000,
    price_input_uncached_micro_per_mtok: 100_000,
    price_output_micro_per_mtok: 500_000,
    price_per_image_micro: 60_000,
    request_fee_micro: 0,
    enabled: true,
    ledger_limit: 500
  },
  billing_ledger: [],
  // 自助注册开关。默认关闭：升级到这一版的现有部署不该突然对外开放注册口，
  // 要开由管理员在「账号管理」里显式点开。
  registration: {
    enabled: false
  },
  stats: defaultStats(),
  created_at: Date.now()
})

// 管理密钥统一入口：环境变量 ADMIN_KEY 优先，其次持久化配置
export function getAdminKey() {
  return process.env.ADMIN_KEY || state.admin_api_key || ''
}

// 使用可配置时区计算"今日"（默认北京时间），避免 UTC 导致的跨日统计错位
const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Shanghai'

export function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function genId() {
  return crypto.randomUUID()
}

function ensureStats(stats) {
  const base = defaultStats()
  const merged = { ...base, ...(stats || {}) }
  if (!merged.perProvider || typeof merged.perProvider !== 'object') merged.perProvider = {}
  if (!Number.isFinite(merged.totalRequests)) merged.totalRequests = 0
  if (!Number.isFinite(merged.todayRequests)) merged.todayRequests = 0
  if (!Number.isFinite(merged.totalSuccess)) merged.totalSuccess = 0
  if (!Number.isFinite(merged.totalFailed)) merged.totalFailed = 0
  if (!Number.isFinite(merged.todaySuccess)) merged.todaySuccess = 0
  if (!Number.isFinite(merged.todayFailed)) merged.todayFailed = 0
  if (!Number.isFinite(merged.totalFailovers)) merged.totalFailovers = 0
  if (!Number.isFinite(merged.totalTokens)) merged.totalTokens = 0
  if (!Number.isFinite(merged.todayTokens)) merged.todayTokens = 0
  if (!merged.todayDate) merged.todayDate = todayKey()
  return merged
}

// 客户端 Key 的落盘结构补齐：老配置没有这个字段，字段缺失的旧记录也要能补全。
// 返回 [规范化后的数组, 是否发生了变化]，变化了才落盘，避免每次启动都白写一遍。
function ensureApiKeys(keys) {
  if (!Array.isArray(keys)) return [[], true]
  let changed = false
  const out = []
  for (const k of keys) {
    if (!k || typeof k !== 'object' || !k.key_hash) { changed = true; continue }
    const next = {
      id: k.id || crypto.randomUUID(),
      name: String(k.name || '未命名 Key'),
      key_hash: String(k.key_hash),
      key_preview: String(k.key_preview || '******'),
      enabled: k.enabled === undefined ? true : Boolean(k.enabled),
      allowed_models: Array.isArray(k.allowed_models) ? k.allowed_models.filter((r) => typeof r === 'string' && r.trim()) : [],
      denied_models: Array.isArray(k.denied_models) ? k.denied_models.filter((r) => typeof r === 'string' && r.trim()) : [],
      expires_at: Number(k.expires_at) || 0,
      note: String(k.note || ''),
      // 用户自助密钥的归属账号：计费与余额门禁全靠它识别「这把 Key 归谁」。
      // 老 Key / 管理员手工发的 Key 为空字符串，不计费也不拦，行为与升级前一致。
      owner_account_id: typeof k.owner_account_id === 'string' ? k.owner_account_id : '',
      created_at: Number(k.created_at) || Date.now(),
      last_used_at: Number(k.last_used_at) || 0,
      usage: {
        requests: Number(k.usage?.requests) || 0,
        failed: Number(k.usage?.failed) || 0,
        tokens: Number(k.usage?.tokens) || 0
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(k)) changed = true
    out.push(next)
  }
  return [out, changed]
}

function tryParseJSON(text, path) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// 账号系统字段迁移：老配置（本项目升级前生成的 config.json）没有这两个字段。
// 缺了 accounts 会导致 authStatus() 认为「未初始化」、每次刷新都弹初始化框；
// 缺了 session_secret 会让每次启动重新签名密钥、已登录的人全被踢下线。
// 补齐后交给调用方 scheduleFlush() 落盘，重启不会再补第二遍。
function ensureAccountFields(obj) {
  let changed = false
  if (!Array.isArray(obj.accounts)) { obj.accounts = []; changed = true }
  if (!obj.session_secret) { obj.session_secret = crypto.randomBytes(32).toString('hex'); changed = true }
  // 计费字段：老配置既没有 billing 段，也没有 account.balance_micro 和流水数组。
  // 三个归一化函数都是纯函数（不读 state），可在 load() 阶段安全调用。
  if (!obj.billing || typeof obj.billing !== 'object') { obj.billing = DEFAULT_BILLING_FALLBACK(); changed = true }
  else if (normalizeBilling(obj.billing)) changed = true
  if (normalizeAccountBalances(obj)) changed = true
  if (normalizeLedger(obj)) changed = true
  // 注册开关：老配置没有这一段，补一个默认关闭的，别让升级顺带开了注册口
  if (!obj.registration || typeof obj.registration !== 'object' || Array.isArray(obj.registration)) {
    obj.registration = { enabled: false }
    changed = true
  } else if (typeof obj.registration.enabled !== 'boolean') {
    obj.registration.enabled = false
    changed = true
  }
  return changed
}

// 与 billing.DEFAULT_BILLING() 保持一致的字面量：这里不 import 是有意的，
// store.js 在模块求值期就会调用它，避免再去触碰 billing 的惰性状态访问。
function DEFAULT_BILLING_FALLBACK() {
  return {
    unit: '元',
    currency: 'CNY',
    micros_per_unit: 1_000_000,
    price_input_cached_micro_per_mtok: 10_000,
    price_input_uncached_micro_per_mtok: 100_000,
    price_output_micro_per_mtok: 500_000,
    price_per_image_micro: 60_000,
    request_fee_micro: 0,
    enabled: true,
    ledger_limit: 500
  }
}

function load() {
  mkdirSync(DATA_DIR, { recursive: true })

  if (!existsSync(CONFIG_PATH)) {
    const state = DEFAULT_STATE()
    save(state)
    return state
  }

  const primary = tryParseJSON(readFileSync(CONFIG_PATH, 'utf-8'))
  if (primary) {
    let changed = false
    if (!primary.gateway_api_key) {
      primary.gateway_api_key = `gk-${crypto.randomUUID()}`
      changed = true
    }
    if (!primary.admin_api_key) {
      primary.admin_api_key = process.env.ADMIN_KEY || `ak-${crypto.randomUUID()}`
      changed = true
    }
    if (!primary.stats) {
      primary.stats = defaultStats()
      changed = true
    } else {
      const before = JSON.stringify(primary.stats)
      primary.stats = ensureStats(primary.stats)
      if (JSON.stringify(primary.stats) !== before) changed = true
    }
    const [apiKeys, keysChanged] = ensureApiKeys(primary.api_keys)
    primary.api_keys = apiKeys
    if (keysChanged) changed = true
    if (ensureAccountFields(primary)) changed = true
    if (changed) scheduleFlush()
    return primary
  }

  console.error('[store] config.json 已损坏，尝试从备份恢复...')
  if (existsSync(BACKUP_PATH)) {
    const backup = tryParseJSON(readFileSync(BACKUP_PATH, 'utf-8'))
    if (backup && backup.providers) {
      let changed = false
      if (!backup.gateway_api_key) {
        backup.gateway_api_key = `gk-${crypto.randomUUID()}`
        changed = true
      }
      if (!backup.admin_api_key) {
        backup.admin_api_key = process.env.ADMIN_KEY || `ak-${crypto.randomUUID()}`
        changed = true
      }
      if (!backup.stats) {
        backup.stats = defaultStats()
        changed = true
      } else {
        const before = JSON.stringify(backup.stats)
        backup.stats = ensureStats(backup.stats)
        if (JSON.stringify(backup.stats) !== before) changed = true
      }
      const [apiKeys, keysChanged] = ensureApiKeys(backup.api_keys)
      backup.api_keys = apiKeys
      if (keysChanged) changed = true
      if (ensureAccountFields(backup)) changed = true
      console.error(`[store] 已从备份恢复 ${backup.providers.length} 个平台`)
      atomicWrite(CONFIG_PATH, JSON.stringify(backup, null, 2))
      return backup
    }
  }

  console.error('[store] 备份也不可用，使用全新配置。原损坏文件保留至 config.json.corrupted')
  try {
    const corrupted = readFileSync(CONFIG_PATH, 'utf-8')
    writeFileSync(`${CONFIG_PATH}.corrupted`, corrupted, 'utf-8')
  } catch { /* ignore */  }
  const state = DEFAULT_STATE()
  save(state)
  return state
}

function save(state) {
  mkdirSync(DATA_DIR, { recursive: true })
  atomicWrite(CONFIG_PATH, JSON.stringify(state, null, 2))
}

let _dirty = false
let _flushTimer = null

function scheduleFlush() {
  _dirty = true
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => flush(), 2000)
    _flushTimer.unref()
  }
}

function flush() {
  _flushTimer = null
  if (!_dirty) return
  _dirty = false

  if (!existsSync(CONFIG_PATH)) {
    atomicWrite(CONFIG_PATH, JSON.stringify(state, null, 2))
    return
  }
  try {
    // 先原子写备份再原子写主文件：备份失败不会影响主文件，主文件替换永远是完整的
    atomicWrite(BACKUP_PATH, JSON.stringify(state, null, 2))
    atomicWrite(CONFIG_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[store] 写配置失败:', err.message)
  }
}

function savePersist(state) {
  try {
    atomicWrite(BACKUP_PATH, JSON.stringify(state, null, 2))
    atomicWrite(CONFIG_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[store] 保存配置失败:', err.message)
  }
}

export function persistImmediate() {
  if (_flushTimer) {
    clearTimeout(_flushTimer)
    _flushTimer = null
  }
  _dirty = false
  savePersist(state)
}

export const state = load()

export function getProvider(id) {
  return state.providers.find((p) => p.id === id)
}

export function persist() {
  scheduleFlush()
}

// 跨日翻转统一在此处理：四个「今日」计数必须一起归零，
// 否则会出现「todayTokens 已归零、todayRequests 还带着昨天的值」的错位。
function rolloverDaily(stats) {
  const today = todayKey()
  if (stats.todayDate !== today) {
    stats.todayDate = today
    stats.todayRequests = 0
    stats.todaySuccess = 0
    stats.todayFailed = 0
    stats.todayTokens = 0
  }
}

export function bumpStats(providerId) {
  state.stats = ensureStats(state.stats)
  rolloverDaily(state.stats)
  state.stats.totalRequests += 1
  state.stats.todayRequests += 1
  if (providerId) {
    const p = state.stats.perProvider[providerId] || { requests: 0, success: 0, failed: 0, tokens: 0 }
    p.requests += 1
    state.stats.perProvider[providerId] = p
  }
  scheduleFlush()
}

export function markResult(providerId, ok) {
  state.stats = ensureStats(state.stats)
  if (ok) {
    state.stats.totalSuccess += 1
    state.stats.todaySuccess += 1
  } else {
    state.stats.totalFailed += 1
    state.stats.todayFailed += 1
  }
  if (providerId) {
    const p = state.stats.perProvider[providerId] || { requests: 0, success: 0, failed: 0, tokens: 0 }
    if (ok) p.success += 1
    else p.failed += 1
    state.stats.perProvider[providerId] = p
  }
  scheduleFlush()
}

export function bumpFailover() {
  state.stats.totalFailovers += 1
  scheduleFlush()
}

export function bumpTokens(providerId, tokenCount) {
  const n = Number(tokenCount) || 0
  if (n <= 0) return
  state.stats = ensureStats(state.stats)
  rolloverDaily(state.stats)
  state.stats.totalTokens += n
  state.stats.todayTokens += n
  if (providerId) {
    const p = state.stats.perProvider[providerId] || { requests: 0, success: 0, failed: 0, tokens: 0 }
    p.tokens = (p.tokens || 0) + n
    state.stats.perProvider[providerId] = p
  }
  scheduleFlush()
}