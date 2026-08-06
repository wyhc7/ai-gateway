import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const LOG_PATH = join(DATA_DIR, 'logs.jsonl')
const MAX_MEMORY = 500
let _seq = 0

const logs = []

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

export function initLogger() {
  mkdirSync(DATA_DIR, { recursive: true })
  loadFromFile()
  try {
    // 启动时重写文件，控制体积（仅保留内存中的最近记录）
    writeFileSync(LOG_PATH, logs.map((l) => JSON.stringify(l)).join('\n') + (logs.length ? '\n' : ''), 'utf-8')
  } catch { /* ignore */ }
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
  try {
    appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n', 'utf-8')
  } catch { /* ignore */ }
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