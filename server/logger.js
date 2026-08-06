import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const LOG_PATH = join(DATA_DIR, 'logs.jsonl')
const MAX_MEMORY = 500
// 批量落盘：每 10 秒把攒下的日志一次性写入磁盘，避免每条日志同步写盘阻塞事件循环
const FLUSH_INTERVAL_MS = 10000
// 日志文件超过该大小（2MB）时自动截断，防止长期运行无限增长
const MAX_FILE_SIZE = 2 * 1024 * 1024

let _seq = 0

const logs = []
let _pending = []

function loadFromFile() {
  if (!existsSync(LOG_PATH)) return
  try {
    const text = readFileSync(LOG_PATH, 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines.slice(-MAX_MEMORY)) {
      try {
        logs.push(JSON.parse(line))
      } catch { /* 忽略损坏行 */ }
    }
  } catch { /* ignore */ }
}

function flushPending() {
  if (_pending.length === 0) return
  const batch = _pending
  _pending = []
  try {
    appendFileSync(LOG_PATH, batch.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  } catch (err) {
    // 写盘失败：回退重试（限制队列长度防止无限堆积）
    console.error('[logger] 写日志失败:', err.message)
    _pending = batch.concat(_pending)
    if (_pending.length > MAX_MEMORY) _pending = _pending.slice(-MAX_MEMORY)
  }
}

function trimFileIfNeeded() {
  try {
    if (statSync(LOG_PATH).size > MAX_FILE_SIZE) {
      const recent = [...logs].slice(-MAX_MEMORY)
      writeFileSync(LOG_PATH, recent.map((l) => JSON.stringify(l)).join('\n') + (recent.length ? '\n' : ''), 'utf-8')
    }
  } catch { /* ignore */ }
}

function startFlushTimer() {
  const timer = setInterval(() => {
    trimFileIfNeeded()
    flushPending()
  }, FLUSH_INTERVAL_MS)
  if (timer.unref) timer.unref()
  // 进程退出前兜底落盘，避免丢失最后 10 秒的日志
  // 注意：注册 SIGINT/SIGTERM 会覆盖 Node 默认终止行为，flush 后必须主动 exit
  const onSignal = () => {
    try {
      flushPending()
    } catch { /* ignore */ }
    process.exit(0)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('beforeExit', () => flushPending())
}

export function initLogger() {
  mkdirSync(DATA_DIR, { recursive: true })
  loadFromFile()
  try {
    // 启动时重写文件，控制体积（仅保留内存中的最近记录）
    writeFileSync(LOG_PATH, logs.map((l) => JSON.stringify(l)).join('\n') + (logs.length ? '\n' : ''), 'utf-8')
  } catch { /* ignore */ }
  startFlushTimer()
}

export function addLog(entry) {
  _seq += 1
  const rec = {
    id: `${Date.now().toString(36)}-${_seq.toString(36)}`,
    ts: Date.now(),
    time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    ...entry
  }
  logs.push(rec)
  if (logs.length > MAX_MEMORY) logs.shift()
  _pending.push(rec)
  return rec
}

export function getLogs({ limit = 100, type, status, q } = {}) {
  let list = [...logs].reverse()
  if (type && type !== 'all') list = list.filter((l) => l.type === type)
  if (status !== undefined && status !== '' && status !== null) {
    const s = String(status)
    if (/^\dxx$/i.test(s)) {
      const cls = Number(s[0])
      list = list.filter((l) => {
        const v = Number(l.status)
        return cls === 0 ? v === 0 : Math.floor(v / 100) === cls
      })
    } else {
      list = list.filter((l) => String(l.status) === s)
    }
  }
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase()
    list = list.filter((l) =>
      [l.model, l.provider_name, l.key, l.error, l.path, l.detail]
        .some((v) => v != null && String(v).toLowerCase().includes(needle))
    )
  }
  const n = Number(limit)
  return list.slice(0, Number.isFinite(n) && n > 0 ? n : 100)
}