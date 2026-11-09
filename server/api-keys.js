// 网关访问密钥（发给客户端的「客户端 Key」）
//
// 与 state.gateway_api_key 的分工：
//   gateway_api_key —— 部署时自动生成的「主密钥」，等同管理员，不受任何限制，
//                      为了兼容既有部署保持原样，连明文存储都没改。
//   state.api_keys[] —— 后台按需创建的客户端 Key：每个可单独限定「能用哪些模型」、
//                       随时停用、设到期时间、独立统计用量。
//
// 存储策略：只落 SHA-256 摘要（key_hash），明文仅在创建/轮换的响应里返回一次。
// 这样 config.json 万一外泄，里面也不会多出一把能直接用的客户端钥匙。
// 注意各平台的 api_key 字段仍是明文存储的（那才是真正值钱的东西），别只盯着这里。
import crypto from 'node:crypto'
import { state, persist, persistImmediate, genId } from './store.js'
import { consumeForUsage } from './billing.js'

// 客户端 Key 前缀。带前缀是为了在日志/配置里一眼认出这是网关的 Key，
// 而不是某个上游平台的 Key。
const KEY_PREFIX = 'sk-'

// 单把 Key 的规则条数上限。规则是逐条正则匹配的，热路径上别让配置失控。
const MAX_RULES = 200
const MAX_RULE_LEN = 128

export function generateToken() {
  // 24 字节随机 → 32 位 base64url，约 192 bit 熵，暴力枚举不可行
  return `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex')
}

// 常数时间比较两个十六进制摘要，避免用 === 比较时泄露前缀匹配长度
function hashEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex')
  const bb = Buffer.from(String(b || ''), 'hex')
  if (ba.length !== bb.length || ba.length === 0) return false
  return crypto.timingSafeEqual(ba, bb)
}

// 展示用的前缀片段：sk-AbCd…WxYz。明文不回传，界面上靠它区分不同 Key。
export function previewOf(token) {
  const t = String(token || '')
  if (t.length <= 14) return '******'
  return `${t.slice(0, 8)}…${t.slice(-4)}`
}

export function normalizeRules(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const rule = String(raw ?? '').trim().slice(0, MAX_RULE_LEN)
    if (!rule) continue
    const dedupeKey = rule.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(rule)
    if (out.length >= MAX_RULES) break
  }
  return out
}

// 规则 → 正则。支持精确名（gpt-4o）与通配（*、gpt-*、*-free、claude-*-latest）。
// 先整体转义再放开 \*，这样规则里的 . + ( ) 等字符不会被当成正则元字符。
const regexCache = new Map()

export function ruleMatches(rule, modelId) {
  const pattern = String(rule || '').trim()
  const id = String(modelId || '')
  if (!pattern || !id) return false
  if (pattern === '*') return true
  let re = regexCache.get(pattern)
  if (!re) {
    // 缓存有上限：规则来自管理端配置，理论上可控，但热路径上不能无限增长
    if (regexCache.size > 1000) regexCache.clear()
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
    re = new RegExp(`^${escaped}$`, 'i')
    regexCache.set(pattern, re)
    // 正则本身是转义后拼的，不会抛错；万一遇到异常输入按不匹配处理
  }
  try {
    return re.test(id)
  } catch {
    return false
  }
}

// 判断一把客户端 Key 能否使用某个模型。
// 语义：denied 优先于 allowed；allowed 为空数组 = 不限制。
export function modelAllowed(auth, modelId) {
  if (!auth || auth.unrestricted !== false) return { allowed: true }
  const id = String(modelId || '').trim()
  // 空模型名不在这里拦——交给下游的模型匹配逻辑回一个更准确的 404
  if (!id) return { allowed: true }

  for (const rule of auth.denied_models || []) {
    if (ruleMatches(rule, id)) return { allowed: false, code: 'model_denied', rule }
  }
  const allowed = auth.allowed_models || []
  if (allowed.length === 0) return { allowed: true }
  for (const rule of allowed) {
    if (ruleMatches(rule, id)) return { allowed: true }
  }
  return { allowed: false, code: 'model_forbidden' }
}

// 按 Key 的模型权限裁剪模型列表（/v1/models 用）。
// 客户端据此选模型，列表与真实放行范围必须一致，否则用户只会看到一堆必然 403 的名字。
export function filterModelsForAuth(models, auth) {
  if (!auth || auth.unrestricted !== false) return models
  return models.filter((m) => modelAllowed(auth, m?.id).allowed)
}

function isExpired(k) {
  return Number(k?.expires_at || 0) > 0 && Date.now() >= Number(k.expires_at)
}

export function keyState(k) {
  if (!k.enabled) return 'disabled'
  if (isExpired(k)) return 'expired'
  return 'active'
}

// 对外序列化：绝不带明文，也不带摘要。摘要虽然不可逆，但没必要给出去。
export function serializeApiKey(k) {
  return {
    id: k.id,
    name: k.name || '',
    key_preview: k.key_preview || '',
    enabled: Boolean(k.enabled),
    state: keyState(k),
    allowed_models: k.allowed_models || [],
    denied_models: k.denied_models || [],
    model_scope: (k.allowed_models || []).length === 0
      ? 'all'
      : (k.allowed_models.length === 1 && k.allowed_models[0] === '*' ? 'all' : 'restricted'),
    expires_at: Number(k.expires_at) || 0,
    note: k.note || '',
    // 归属账号：用户面板只显示自己的密钥，管理员面板也能一眼看出哪把是账号自助的
    owner_account_id: typeof k.owner_account_id === 'string' ? k.owner_account_id : '',
    created_at: k.created_at || 0,
    last_used_at: k.last_used_at || 0,
    usage: {
      requests: k.usage?.requests || 0,
      failed: k.usage?.failed || 0,
      tokens: k.usage?.tokens || 0
    }
  }
}

function buildKey(input = {}) {
  const token = generateToken()
  return {
    id: genId(),
    name: String(input.name || '').trim() || '未命名 Key',
    key_hash: hashToken(token),
    key_preview: previewOf(token),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    allowed_models: normalizeRules(input.allowed_models),
    denied_models: normalizeRules(input.denied_models),
    expires_at: Number(input.expires_at) || 0,
    note: String(input.note || '').slice(0, 500),
    owner_account_id: typeof input.owner_account_id === 'string' ? input.owner_account_id : '',
    created_at: Date.now(),
    last_used_at: 0,
    usage: { requests: 0, failed: 0, tokens: 0 },
    _token: token
  }
}

// 创建：明文只在这里返回一次，入库的是摘要
export function createApiKey(input = {}) {
  const key = buildKey(input)
  const token = key._token
  delete key._token
  state.api_keys = Array.isArray(state.api_keys) ? state.api_keys : []
  state.api_keys.push(key)
  persistImmediate()
  return { key: serializeApiKey(key), token }
}

export function getApiKey(id) {
  return (state.api_keys || []).find((k) => k.id === id)
}

export function updateApiKey(id, patch = {}) {
  const key = getApiKey(id)
  if (!key) return null
  if (patch.name !== undefined) key.name = String(patch.name).trim() || key.name
  if (patch.enabled !== undefined) key.enabled = Boolean(patch.enabled)
  if (patch.allowed_models !== undefined) key.allowed_models = normalizeRules(patch.allowed_models)
  if (patch.denied_models !== undefined) key.denied_models = normalizeRules(patch.denied_models)
  if (patch.expires_at !== undefined) key.expires_at = Number(patch.expires_at) || 0
  if (patch.note !== undefined) key.note = String(patch.note).slice(0, 500)
  persistImmediate()
  return serializeApiKey(key)
}

export function deleteApiKey(id) {
  const list = state.api_keys || []
  const idx = list.findIndex((k) => k.id === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  persistImmediate()
  return true
}

// 轮换：换一把新钥匙，权限、名称、用量全部保留
export function rotateApiKey(id) {
  const key = getApiKey(id)
  if (!key) return null
  const token = generateToken()
  key.key_hash = hashToken(token)
  key.key_preview = previewOf(token)
  key.created_at = key.created_at || Date.now()
  persistImmediate()
  return { key: serializeApiKey(key), token }
}

export function resetApiKeyUsage(id) {
  const key = getApiKey(id)
  if (!key) return null
  key.usage = { requests: 0, failed: 0, tokens: 0 }
  key.last_used_at = 0
  persistImmediate()
  return serializeApiKey(key)
}

// 鉴权结果。命中主密钥 → 不受限；命中客户端 Key → 带上它的模型白名单。
const OWNER_AUTH = Object.freeze({
  kind: 'owner',
  id: '__owner__',
  name: '主密钥（网关 Key）',
  unrestricted: true,
  allowed_models: [],
  denied_models: []
})

function authOfKey(k) {
  return {
    kind: 'key',
    id: k.id,
    name: k.name || k.key_preview,
    unrestricted: false,
    allowed_models: k.allowed_models || [],
    denied_models: k.denied_models || [],
    // 必须是 state.api_keys 里的原对象引用：recordUsage 直接改它的 usage/last_used_at，
    // 换成副本用量统计就落不了盘。owner_account_id 由 buildKey/ensureApiKeys 保证存在，
    // 老配置没有时读到 undefined，billing 侧按「未绑定」处理。
    _key: k
  }
}

// 解析请求携带的令牌。返回 { ok, auth } 或 { ok:false, status, message }，
// 让中间件能针对「没带 Key / Key 已停用 / Key 已过期 / Key 不存在」给出不同提示——
// 统一回一句「无效的 API Key」会让用户完全不知道去哪修。
export function resolveAuth(token) {
  const t = String(token || '').trim()
  if (!t) {
    return { ok: false, status: 401, message: '缺少 API Key：请在请求头带 Authorization: Bearer <Key>' }
  }
  // 摘要在循环外算一次：这个函数在每个代理请求上都会跑，Key 一多就变成
  // 「每个请求对同一串令牌做 N 次 sha256」的白费功
  const presented = hashToken(t)
  if (hashEquals(presented, hashToken(state.gateway_api_key))) return { ok: true, auth: OWNER_AUTH }

  let disabled = null
  let expired = null
  for (const k of state.api_keys || []) {
    if (!hashEquals(k.key_hash, presented)) continue
    if (!k.enabled) { disabled = k; continue }
    if (isExpired(k)) { expired = k; continue }
    k.last_used_at = Date.now()
    persist()
    return { ok: true, auth: authOfKey(k) }
  }
  if (disabled) return { ok: false, status: 403, message: `该 API Key（${disabled.name}）已被停用` }
  if (expired) return { ok: false, status: 403, message: `该 API Key（${expired.name}）已过期` }
  return { ok: false, status: 401, message: '无效的 API Key' }
}

// 记录用量。批量经 store 的 scheduleFlush 落盘，不在请求路径上做同步写。
// 如果这把 Key 绑定了用户账号，同时按真实用量结算余额（见 billing.js）；
// 失败请求不扣费，主密钥与未绑定账号的老 Key 完全不受影响。
//
// usage 是已归类的用量：{ input_cached, input_uncached, output, images }。
// 这里只做两件事——累加仪表盘的 token 统计、把 usage 原样交给计费层。
export function recordUsage(auth, { usage = null, ok = true, model = '' } = {}) {
  if (!auth || auth.kind !== 'key' || !auth._key) return
  const key = auth._key
  key.usage = key.usage || { requests: 0, failed: 0, tokens: 0 }
  key.usage.requests += 1
  if (!ok) key.usage.failed += 1
  // 仪表盘的 tokens 是「token 总数」口径，不含生图张数（那张数不是 token）
  const n = usage
    ? (Number(usage.input_cached) || 0) + (Number(usage.input_uncached) || 0) +
      (Number(usage.output) || 0) + (Number(usage.total) || 0)
    : 0
  if (n > 0) key.usage.tokens += n
  key.last_used_at = Date.now()
  persist()
  consumeForUsage(auth, { usage, ok, model })
}

// ---------------------------------------------------------------------------
// 用户自助密钥
//
// 每个 user 账号最多一把自助 Key：「最初无密钥」就是这里查不到记录。
// 复用同一套 api_keys 存储与 resolveAuth 链路，只是额外带上 owner_account_id，
// 于是计费、余额门禁、模型权限、停用/过期全都能复用，不另起一套鉴权。
// 明文同样只在创建/轮换时返回一次，config.json 里只有 SHA-256 摘要。
// ---------------------------------------------------------------------------

export function serializeUserKey(k) {
  const base = serializeApiKey(k)
  return { ...base, owner_account_id: k.owner_account_id || '' }
}

export function userKeysOf(accountId) {
  if (!accountId) return []
  return (state.api_keys || [])
    .filter((k) => k.owner_account_id === accountId)
    .map(serializeUserKey)
    .sort((a, b) => b.created_at - a.created_at)
}

export function userKeyOf(accountId, id) {
  if (!accountId || !id) return null
  const k = (state.api_keys || []).find((x) => x.id === id && x.owner_account_id === accountId)
  return k ? serializeUserKey(k) : null
}

// 一个账号最多一把自助 Key：重复点「生成」不给第二把，避免余额归属混乱。
export function createUserKey(accountId, { name = '', username = '' } = {}) {
  if (!accountId) throw Object.assign(new Error('缺少账号信息'), { status: 400 })
  const existing = (state.api_keys || []).find((k) => k.owner_account_id === accountId)
  if (existing) throw Object.assign(new Error('该账号已有调用密钥，可直接轮换或删除后再生成'), { status: 409 })
  const label = String(name || '').trim() || `${username || '用户'}的调用密钥`
  const { key, token } = createApiKey({
    name: label,
    owner_account_id: accountId,
    allowed_models: [],
    denied_models: [],
    enabled: true,
    note: '用户面板自助生成，按余额计费'
  })
  return { key: serializeUserKey(getApiKey(key.id)), token }
}

export function rotateUserKey(accountId, id) {
  const owned = (state.api_keys || []).find((k) => k.id === id && k.owner_account_id === accountId)
  if (!owned) return null
  const out = rotateApiKey(id)
  return out ? { key: serializeUserKey(getApiKey(id)), token: out.token } : null
}

export function deleteUserKey(accountId, id) {
  const owned = (state.api_keys || []).find((k) => k.id === id && k.owner_account_id === accountId)
  if (!owned) return false
  return deleteApiKey(id)
}

// 管理界面选模型用的候选池：所有启用平台的模型并集（带来源平台名，便于分组展示）
export function modelPool() {
  const out = []
  const seen = new Set()
  for (const p of state.providers || []) {
    for (const m of p.models || []) {
      if (!m?.id || seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ id: m.id, provider_id: p.id, provider_name: p.name, enabled: Boolean(p.enabled) })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
