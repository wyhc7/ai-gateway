// 用户余额与计费：整数微元、余额流水、按 token 分档计费、调用前余额门禁。
//
// 设计取舍（延续本项目「一份 JSON、零外部服务」的底线）：
// 1) 余额以「微元」整数存在 account.balance_micro，1 元 = 1,000,000 微元。
//    全程整数运算，不引入浮点累计误差；对外展示时才除以 micros_per_unit。
// 2) 只有「绑定了用户账号」的客户端 Key 才计费、才受余额门禁约束。
//    网关主密钥、升级前创建的老访问密钥、CI 脚本一律不扣不拦，老部署零影响。
// 3) 每次余额变动都记一条流水（充值 / 扣减 / 调用扣费），全局数组有上限，
//    用户面板按 account_id 过滤后倒序展示。
// 4) 扣费挂在 api-keys.js 的 recordUsage 上（真实用量结算），充值用同步落盘，
//    调用扣费用批量落盘，避免在代理热路径上同步写文件。
//
// 多模态说明：本模块只管「算钱」，不管「怎么从响应里抠出用量」。
// 调用方把已经归类好的用量（缓存命中的输入 / 未命中的输入 / 输出 / 张数）
// 直接传进来，见 consumeForUsage 的签名。
//
// 模块循环说明：store.js 会 import 本文件的纯函数，本文件又需要用 store.state。
// 因此这里顶层只做 `import * as store`，所有状态访问都在函数体内惰性读取，
// 顶层不触碰 store.state —— ESM 求值时 store 的 `state = load()` 尚未执行也不会踩 TDZ。
import { persist, persistImmediate, genId } from './store.js'
import * as store from './store.js'

export const MICROS_PER_UNIT = 1_000_000

// 统一四档定价。单位是「每百万 tokens」，与上游账单口径一致，避免换算歧义。
//
// 数值来源（1 元 = 1,000,000 微元）：
//   输入·缓存命中    0.01 元/百万 →     10,000 微元
//   输入·缓存未命中   0.1 元/百万 →    100,000 微元
//   输出             0.5 元/百万 →    500,000 微元
//   生图             0.06 元/张  →     60,000 微元（按张数累乘）
//
// 缓存命中判定：上游给了明确的缓存字段就用命中价；拿不到的按未命中价算，
// 宁可少给折扣也不漏收（见 proxy.js 的 extractUsage）。
export function DEFAULT_BILLING() {
  return {
    unit: '元',
    currency: 'CNY',
    micros_per_unit: MICROS_PER_UNIT,
    price_input_cached_micro_per_mtok: 10_000,
    price_input_uncached_micro_per_mtok: 100_000,
    price_output_micro_per_mtok: 500_000,
    price_per_image_micro: 60_000,
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

  // 老配置（v0.7 之前）只有一个 price_per_1k_tokens_micro，单位是「每 1000 tokens」。
  // 迁移时把它折算成新口径的「未命中输入价」——每 1000 tokens 的价 × 1000
  // 就是每百万 tokens 的价。这样老部署升级后账单量级不会突变，
  // 只是从此会区分输入/输出/缓存命中。
  if (obj.price_input_uncached_micro_per_mtok == null && obj.price_per_1k_tokens_micro != null) {
    const old = Math.max(0, Number(obj.price_per_1k_tokens_micro) || 0)
    obj.price_input_uncached_micro_per_mtok = Math.trunc(old * 1000)
  }
  delete obj.price_per_1k_tokens_micro

  if (typeof obj.unit !== 'string' || !obj.unit.trim()) obj.unit = d.unit
  if (typeof obj.currency !== 'string' || !obj.currency.trim()) obj.currency = d.currency

  const num = (key, fallback, min, max) => {
    const n = Number(obj[key])
    obj[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
  }
  num('micros_per_unit', d.micros_per_unit, 1, 1_000_000_000)
  num('price_input_cached_micro_per_mtok', d.price_input_cached_micro_per_mtok, 0, 1e15)
  num('price_input_uncached_micro_per_mtok', d.price_input_uncached_micro_per_mtok, 0, 1e15)
  num('price_output_micro_per_mtok', d.price_output_micro_per_mtok, 0, 1e15)
  num('price_per_image_micro', d.price_per_image_micro, 0, 1e15)
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

// 微元 → 可读字符串，最多 6 位小数、去掉尾随零。
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

// 把「元」为单位的输入换算成微元整数。非法 / 溢出返回 null。
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
    // 用量明细一并留档：月末对账时不用再去翻日志
    usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : undefined,
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
export function applyBalance(accountId, { amount_micro, type = 'adjust', note = '', actor = '', model = '', usage = null, immediate = true } = {}) {
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
    note, actor, model, usage
  })
  if (immediate) persistImmediate()
  else persist()
  return serializeBalance(accountId)
}

// ---------------------------------------------------------------------------
// 计价核心
//
// usage 形状（字段缺失一律当 0）：
//   {
//     input_cached:    命中缓存的输入 token 数,
//     input_uncached:  未命中缓存的输入 token 数,
//     output:          输出 token 数,
//     images:          生成张数,
//     total:           兼容字段：仅当上面三项全为 0 时，把它整体按「未命中输入」计价
//   }
//
// 为什么保留 total：部分上游只给一个 total_tokens，拆不出输入输出。
// 这时按最贵的一档（未命中输入）计，宁可略高也不能白送。
// ---------------------------------------------------------------------------
export function computeUsageCostMicro(usage = {}) {
  const b = billingConfig()
  const n = (v) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? x : 0
  }
  const cached = n(usage.input_cached)
  const uncached = n(usage.input_uncached)
  const output = n(usage.output)
  const images = n(usage.images)
  const total = n(usage.total)

  const pCached = Math.max(0, Number(b.price_input_cached_micro_per_mtok) || 0)
  const pUncached = Math.max(0, Number(b.price_input_uncached_micro_per_mtok) || 0)
  const pOutput = Math.max(0, Number(b.price_output_micro_per_mtok) || 0)
  const pImage = Math.max(0, Number(b.price_per_image_micro) || 0)
  const fee = Math.max(0, Number(b.request_fee_micro) || 0)

  // 拆解得到的输入总量
  const inputSum = cached + uncached
  // 只有完全拆不出输入、也没有输出时，才把 total 兜底进去
  const fallbackTotal = inputSum === 0 && output === 0 ? total : 0

  let cost = 0
  cost += (cached / 1_000_000) * pCached
  cost += ((uncached + fallbackTotal) / 1_000_000) * pUncached
  cost += (output / 1_000_000) * pOutput
  cost += images * pImage
  cost += fee

  // 逐项乘完只有最后取整一次，减少累计误差；不足 1 微元的调用按 1 微元计，
  // 否则极小请求会算出 0 而完全不扣，流水里就看不到这次调用了。
  const rounded = Math.round(cost)
  if (rounded <= 0 && cost > 0) return 1
  return rounded
}

// 真实用量结算：由 api-keys.js 的 recordUsage 在每次调用结束时触发。
// 失败请求不扣费；只有绑定了账号的 Key 才计费；算出来 0 元时不产生流水噪音。
export function consumeForUsage(auth, { usage = null, ok = true, model = '' } = {}) {
  if (!ok || !billingConfig().enabled) return null
  const ownerId = auth?._key?.owner_account_id
  if (!ownerId) return null
  if (!usage || typeof usage !== 'object') return null
  const cost = computeUsageCostMicro(usage)
  if (cost <= 0) return null
  const normalized = {
    input_cached: Math.trunc(Number(usage.input_cached) || 0),
    input_uncached: Math.trunc(Number(usage.input_uncached) || 0),
    output: Math.trunc(Number(usage.output) || 0),
    images: Math.trunc(Number(usage.images) || 0)
  }
  const bits = []
  if (normalized.input_cached) bits.push(`缓存输入 ${normalized.input_cached}`)
  if (normalized.input_uncached) bits.push(`输入 ${normalized.input_uncached}`)
  if (normalized.output) bits.push(`输出 ${normalized.output}`)
  if (normalized.images) bits.push(`${normalized.images} 张`)
  return applyBalance(ownerId, {
    amount_micro: -cost,
    type: 'consume',
    note: bits.length ? bits.join(' / ') : 'API 调用扣费',
    model,
    usage: normalized,
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

// 每百万 tokens 单价的展示串
function perMtok(micro) {
  const b = billingConfig()
  return `${formatUnits(micro, b.micros_per_unit)} ${b.unit} / 百万 tokens`
}

// 计费说明（给面板展示用），不暴露可调参数之外的内部细节。
export function pricingInfo() {
  const b = billingConfig()
  const mc = Number(b.price_input_cached_micro_per_mtok) || 0
  const mu = Number(b.price_input_uncached_micro_per_mtok) || 0
  const mo = Number(b.price_output_micro_per_mtok) || 0
  const mi = Number(b.price_per_image_micro) || 0
  return {
    unit: b.unit,
    currency: b.currency,
    enabled: b.enabled,
    micros_per_unit: b.micros_per_unit,
    // 原始微元值，前端要做换算时用这些
    price_input_cached_micro_per_mtok: mc,
    price_input_uncached_micro_per_mtok: mu,
    price_output_micro_per_mtok: mo,
    price_per_image_micro: mi,
    request_fee_micro: b.request_fee_micro,
    // 直接可渲染的字符串
    price_input_cached_display: perMtok(mc),
    price_input_uncached_display: perMtok(mu),
    price_output_display: perMtok(mo),
    price_per_image_display: `${formatUnits(mi, b.micros_per_unit)} ${b.unit} / 张`,
    request_fee_display: `${formatUnits(b.request_fee_micro, b.micros_per_unit)} ${b.unit} / 次`,
    // 前端价目表直接遍历这个
    table: [
      { key: 'input_cached', label: '输入（缓存命中）', unit_label: '百万 tokens', amount: formatUnits(mc, b.micros_per_unit), currency: b.unit },
      { key: 'input_uncached', label: '输入（缓存未命中）', unit_label: '百万 tokens', amount: formatUnits(mu, b.micros_per_unit), currency: b.unit },
      { key: 'output', label: '输出', unit_label: '百万 tokens', amount: formatUnits(mo, b.micros_per_unit), currency: b.unit },
      { key: 'image', label: '生图', unit_label: '张', amount: formatUnits(mi, b.micros_per_unit), currency: b.unit }
    ]
  }
}
