// 用户余额与计费：整数微点、余额流水、按 token 扣费、调用前余额门禁。
//
// 设计取舍（延续本项目「一份 JSON、零外部服务」的底线）：
// 1) 余额以「微点」整数存在 account.balance_micro，1 点 = 1,000,000 微点。
//    全程整数运算，不引入浮点累计误差；对外展示时才除以 micros_per_unit。
// 2) 只有「绑定了用户账号」的客户端 Key 才计费、才受余额门禁约束。
//    网关主密钥、升级前创建的老访问密钥、CI 脚本一律不扣不拦，老部署零影响。
// 3) 每次余额变动都记一条流水（充值 / 扣减 / 调用扣费），全局数组有上限，
//    用户面板按 account_id 过滤后倒序展示。
// 4) 扣费挂在 api-keys.js 的 recordUsage 上（真实用量结算），充值用同步落盘，
//    调用扣费用批量落盘，避免在代理热路径上同步写文件。
//
// 模块循环说明：store.js 会 import 本文件的纯函数，本文件又需要用 store.state。
// 因此这里顶层只做 `import * as store`，所有状态访问都在函数体内惰性读取，
// 顶层不触碰 store.state —— ESM 求值时 store 的 `state = load()` 尚未执行也不会踩 TDZ。
import { persist, persistImmediate, genId } from './store.js'
import * as store from './store.js'

export const MICROS_PER_UNIT = 1_000_000

// 默认计价：每 1000 tokens 扣 1 点，无每次请求基础费。管理员可在 config.json
// 的 billing 段调整；前端只展示，不提供编辑入口（避免误改把余额体系搞乱）。
export function DEFAULT_BILLING() {
  return {
    unit: '点',
    currency: 'POINT',
    micros_per_unit: MICROS_PER_UNIT,
    price_per_1k_tokens_micro: MICROS_PER_UNIT,
    request_fee_micro: 0,
    enabled: true,
    ledger_limit: 500
  }
}

// 纯函数：补齐字段并夹到合法范围，返回是否发生改动。
// 不读 store.state，供 store.js 的 load() 在模块求值阶段安全调用。
export function normalizeBilling(obj) {
  if (!obj || typeof obj !== 'object') return false
  const d = DEFAULT_BILLING()
  const before = JSON.stringify(obj)
  if (typeof obj.unit !== 'string' || !obj.unit.trim()) obj.unit = d.unit
  if (typeof obj.currency !== 'string' || !obj.currency.trim()) obj.currency = d.currency
  const num = (key, fallback, min, max) => {
    const n = Number(obj[key])
    obj[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
  }
  num('micros_per_unit', d.micros_per_unit, 1, 1_000_000_000)
  num('price_per_1k_tokens_micro', d.price_per_1k_tokens_micro, 0, 1e15)
  num('request_fee_micro', d.request_fee_micro, 0, 1e15)
  num('ledger_limit', d.ledger_limit, 50, 5000)
  obj.enabled = obj.enabled !== false
  return JSON.stringify(obj) !== before
}

// 老配置里的账号没有 balance_micro，逐个补 0（「最初无余额」）。
export function normalizeAccountBalances(root) {
  if (!root || !Array.isArray(root.accounts)) return false
  let changed = false
  for (const a of root.accounts) {
    if (!a || typeof a !== 'object') continue
    const n = Number(a.balance_micro)
    const next = Number.isFinite(n) ? Math.trunc(n) : 0
    if (a.balance_micro !== next) { a.balance_micro = next; changed = true }
  }
  return changed
}

// 流水数组归一化：丢掉损坏条目，保持全局上限。
export function normalizeLedger(root) {
  if (!root) return false
  if (Array.isArray(root.billing_ledger)) {
    const before = root.billing_ledger.length
    const cleaned = root.billing_ledger.filter((e) => e && typeof e === 'object' && e.account_id)
    const limit = Number.isFinite(Number(root.billing?.ledger_limit))
      ? Math.min(5000, Math.max(50, Number(root.billing.ledger_limit)))
      : 500
    const trimmed = cleaned.length > limit ? cleaned.slice(-limit) : cleaned
    const changed = trimmed.length !== before || trimmed.some((e, i) => e !== root.billing_ledger[i])
    root.billing_ledger = trimmed
    return changed
  }
  root.billing_ledger = []
  return true
}

// 读配置时兜底：即使有人手工删了 billing 段也不会让面板崩掉。
export function billingConfig() {
  const b = store.state.billing
  if (!b || typeof b !== 'object') {
    store.state.billing = DEFAULT_BILLING()
    return store.state.billing
  }
  return b
}

function accountsArray() {
  if (!Array.isArray(store.state.accounts)) store.state.accounts = []
  return store.state.accounts
}

function accountById(id) {
  return accountsArray().find((a) => a.id === id) || null
}

// 微点 → 可读字符串，最多 6 位小数、去掉尾随零。
export function formatUnits(micro, microsPerUnit) {
  const per = Number(microsPerUnit) > 0 ? Number(microsPerUnit) : MICROS_PER_UNIT
  const v = (Number(micro) || 0) / per
  return Number(v.toFixed(6)).toString()
}

export function balanceMicroOf(accountId) {
  const a = accountById(accountId)
  return a ? Math.trunc(Number(a.balance_micro) || 0) : 0
}

export function serializeBalance(accountId) {
  const b = billingConfig()
  const micro = balanceMicroOf(accountId)
  return {
    micro,
    value: Number((micro / b.micros_per_unit).toFixed(6)),
    display: `${formatUnits(micro, b.micros_per_unit)} ${b.unit}`,
    unit: b.unit,
    currency: b.currency,
    micros_per_unit: b.micros_per_unit
  }
}

// 把「点」为单位的输入换算成微点整数。非法 / 溢出返回 null。
export function parseAmountToMicro(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n === 0) return null
  const per = billingConfig().micros_per_unit
  const micro = Math.round(n * per)
  // 留足安全余量，避免有人在充值框贴一个 1e30 把 JSON 写成科学计数法
  if (!Number.isSafeInteger(micro) || Math.abs(micro) > 9_000_000_000_000_000) return null
  return micro
}

function appendLedger(entry) {
  const b = billingConfig()
  if (!Array.isArray(store.state.billing_ledger)) store.state.billing_ledger = []
  store.state.billing_ledger.push({
    id: genId(),
    account_id: entry.account_id,
    type: entry.type,
    delta_micro: Math.trunc(entry.delta_micro),
    balance_after_micro: Math.trunc(entry.balance_after_micro),
    note: String(entry.note || '').slice(0, 200),
    actor: String(entry.actor || '').slice(0, 64),
    model: String(entry.model || '').slice(0, 120),
    at: Date.now()
  })
  const limit = Math.min(5000, Math.max(50, Number(b.ledger_limit) || 500))
  const list = store.state.billing_ledger
  if (list.length > limit) list.splice(0, list.length - limit)
}

function serializeLedgerEntry(e) {
  const b = billingConfig()
  return {
    ...e,
    delta_display: `${e.delta_micro > 0 ? '+' : ''}${formatUnits(e.delta_micro, b.micros_per_unit)} ${b.unit}`,
    balance_display: `${formatUnits(e.balance_after_micro, b.micros_per_unit)} ${b.unit}`
  }
}

export function ledgerOf(accountId, limit = 30) {
  const all = Array.isArray(store.state.billing_ledger) ? store.state.billing_ledger : []
  return all.filter((e) => e.account_id === accountId).slice(-limit).reverse().map(serializeLedgerEntry)
}

// 余额变动的唯一入口。delta_micro > 0 充值，< 0 扣减；余额下限夹到 0，
// 流水里的 delta 记「实际变动」，保证任何时刻都能拿流水把余额对回去。
export function applyBalance(accountId, { amount_micro, type = 'adjust', note = '', actor = '', model = '', immediate = true } = {}) {
  const a = accountById(accountId)
  if (!a) return null
  const before = Math.trunc(Number(a.balance_micro) || 0)
  const delta = Math.trunc(Number(amount_micro) || 0)
  if (delta === 0) return serializeBalance(accountId)
  const target = before + delta
  const after = target < 0 ? 0 : target
  a.balance_micro = after
  appendLedger({
    account_id: accountId,
    type,
    delta_micro: after - before,
    balance_after_micro: after,
    note, actor, model
  })
  if (immediate) persistImmediate()
  else persist()
  return serializeBalance(accountId)
}

// 真实用量结算：由 api-keys.js 的 recordUsage 在每次调用结束时触发。
// 失败请求不扣费；只有绑定了账号的 Key 才计费；单价为 0 时不产生流水噪音。
export function consumeForUsage(auth, { tokens = 0, ok = true, model = '' } = {}) {
  if (!ok || !billingConfig().enabled) return
  const ownerId = auth?._key?.owner_account_id
  if (!ownerId) return
  const b = billingConfig()
  const per1k = Math.max(0, Number(b.price_per_1k_tokens_micro) || 0)
  const fee = Math.max(0, Number(b.request_fee_micro) || 0)
  const t = Math.max(0, Number(tokens) || 0)
  const cost = Math.round((t / 1000) * per1k) + fee
  if (cost <= 0) return
  applyBalance(ownerId, {
    amount_micro: -cost,
    type: 'consume',
    note: 'API 调用扣费',
    model,
    immediate: false
  })
}

// 调用前门禁：只拦「绑定用户且余额耗尽」的调用。返回错误对象或 null。
// 主密钥 / 老 Key / 未绑定账号的 Key 一律放行，升级前的行为完全不变。
export function balanceGateError(auth) {
  if (!billingConfig().enabled) return null
  const ownerId = auth?._key?.owner_account_id
  if (!ownerId) return null
  const a = accountById(ownerId)
  if (!a) return null
  if (a.enabled === false) {
    return { status: 403, type: 'account_disabled', message: '该密钥绑定的账号已被停用，请联系管理员' }
  }
  if (balanceMicroOf(ownerId) > 0) return null
  return {
    status: 402,
    type: 'insufficient_balance',
    message: `余额不足，当前剩余 0 ${billingConfig().unit}。请联系管理员充值后再调用。`
  }
}

// 计费说明（给面板展示用），不暴露可调参数之外的内部细节。
export function pricingInfo() {
  const b = billingConfig()
  return {
    unit: b.unit,
    currency: b.currency,
    enabled: b.enabled,
    micros_per_unit: b.micros_per_unit,
    price_per_1k_tokens_micro: b.price_per_1k_tokens_micro,
    price_per_1k_tokens_display: `${formatUnits(b.price_per_1k_tokens_micro, b.micros_per_unit)} ${b.unit} / 1K tokens`,
    request_fee_micro: b.request_fee_micro,
    request_fee_display: `${formatUnits(b.request_fee_micro, b.micros_per_unit)} ${b.unit} / 次`
  }
}
