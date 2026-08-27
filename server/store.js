import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const BACKUP_PATH = join(DATA_DIR, 'config.json.bak')

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
  // 管理端密钥：保护 /api/* 管理接口（可用环境变量 ADMIN_KEY 覆盖）
  admin_api_key: process.env.ADMIN_KEY || `ak-${crypto.randomUUID()}`,
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

function tryParseJSON(text, path) {
  try {
    return JSON.parse(text)
  } catch {
    return null
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
      console.error(`[store] 已从备份恢复 ${backup.providers.length} 个平台`)
      writeFileSync(CONFIG_PATH, JSON.stringify(backup, null, 2), 'utf-8')
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
  writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf-8')
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
    writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf-8')
    return
  }
  try {
    writeFileSync(BACKUP_PATH, JSON.stringify(state, null, 2), 'utf-8')
    writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[store] 写配置失败:', err.message)
  }
}

function savePersist(state) {
  try {
    writeFileSync(BACKUP_PATH, JSON.stringify(state, null, 2), 'utf-8')
    writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf-8')
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

export function bumpStats(providerId) {
  const today = todayKey()
  state.stats = ensureStats(state.stats)
  if (state.stats.todayDate !== today) {
    state.stats.todayDate = today
    state.stats.todayRequests = 0
    state.stats.todaySuccess = 0
    state.stats.todayFailed = 0
    state.stats.todayTokens = 0
  }
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
  const today = todayKey()
  state.stats = ensureStats(state.stats)
  state.stats.totalTokens += n
  if (state.stats.todayDate !== today) {
    state.stats.todayDate = today
    state.stats.todayTokens = 0
  }
  state.stats.todayTokens += n
  if (providerId) {
    const p = state.stats.perProvider[providerId] || { requests: 0, success: 0, failed: 0, tokens: 0 }
    p.tokens = (p.tokens || 0) + n
    state.stats.perProvider[providerId] = p
  }
  scheduleFlush()
}