import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { state, persist, persistImmediate, getProvider, genId, todayKey, getAdminKey } from './store.js'
import { handleChat, handleModels, refreshModels, previewModels, defaultModelsFor, DEFAULT_PROTOCOL } from './proxy.js'
import { TEMPLATES } from './templates.js'
import { addLog, getLogs, initLogger } from './logger.js'
import {
  startDeviceFlow,
  pollDeviceFlow,
  cancelDeviceFlow,
  listPendingSessions,
  refreshAccessToken,
  XAI_OAUTH_BASE_URL
} from './oauth.js'
import {
  startDeviceFlow as startCodexDeviceFlow,
  pollDeviceFlow as pollCodexDeviceFlow,
  cancelDeviceFlow as cancelCodexDeviceFlow,
  listPendingSessions as listCodexPendingSessions,
  refreshAccessToken as refreshCodexToken,
  CODEX_API_BASE_URL,
  CODEX_VERIFICATION_URI
} from './codex-oauth.js'

// —— 出网代理支持 ——
// 部署在受限网络（部分机房、需要代理出口的环境）时，设置 HTTPS_PROXY / HTTP_PROXY
// 环境变量即可让网关所有上游请求（含 Grok OAuth 的 auth.x.ai / cli-chat-proxy.grok.com）
// 自动走代理。Node 的全局 fetch 默认不读代理环境变量，这里显式用 undici ProxyAgent
// 全局接管；未设置代理时零开销，行为与之前完全一致。
const OUTBOUND_PROXY = (process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || '').trim()
if (OUTBOUND_PROXY) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici')
    setGlobalDispatcher(new ProxyAgent({
      uri: OUTBOUND_PROXY,
      connect: { timeout: Number(process.env.PROXY_CONNECT_TIMEOUT_MS || 15000) }
    }))
    console.log(`[proxy] 全局出网代理已启用: ${OUTBOUND_PROXY}`)
  } catch (err) {
    console.error(`[proxy] 代理初始化失败，将直连上游: ${err.message}`)
  }
}

const app = express()
// 不暴露框架指纹，降低被针对性扫描的概率
app.disable('x-powered-by')
const PORT = process.env.PORT || 3001
const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIST = process.env.WEB_DIST || join(__dirname, '..', 'web', 'dist')
const WEB_DIST_ROOT = resolve(WEB_DIST)

const CALL_PLAN_FIELDS = ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'models_path', 'models_method']

// 常数时间比较密钥，防止时序侧信道攻击（直接比较长度差异也会泄露信息，先哈希成等长再比较）
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// 自定义 JSON 请求体解析：相比 express.json 多了两层容错
// 1) 客户端把整段原始 HTTP 请求（请求行+头）误塞进 body 时，剥离头后解析 JSON
// 2) 捕获客户端中途断连（aborted），给出清晰日志而非默认 400
function _readRawBody(req, res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        const e = new Error('request entity too large'); e.type = 'entity.too.large'
        req.destroy(); reject(e); return
      }
      chunks.push(c)
    })
    req.on('aborted', () => { const e = new Error('request aborted'); e.type = 'request.aborted'; reject(e) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// 从可能裹了原始 HTTP 请求行的 body 中恢复出 JSON。
// 策略：先试整体解析；失败则依次尝试 BOM 剥离、首条空行之后、首个 { / [ 之后。
function recoverBody(text) {
  const tryParse = (s) => { try { JSON.parse(s); return s } catch { return null } }
  let r = tryParse(text)
  if (r !== null) return r
  const t = text.replace(/^\uFEFF/, '')
  r = tryParse(t); if (r !== null) return r
  // 情形A：整段原始 HTTP 请求（请求行+头+空行+JSON），取首个空行之后
  const m = t.match(/\r?\n\r?\n([\s\S]*)$/)
  if (m) { r = tryParse(m[1].trim()); if (r !== null) return r }
  // 情形B：首个 { 起即为 JSON（请求行/头里不含 {）
  const i = t.indexOf('{')
  if (i > 0) { r = tryParse(t.slice(i)); if (r !== null) return r }
  // 情形C：首个 [ 起即为 JSON（数组载荷）
  const j = t.indexOf('[')
  if (j > 0) { r = tryParse(t.slice(j)); if (r !== null) return r }
  return null
}

async function jsonBody(req, res, next) {
  const ct = req.headers['content-type'] || ''
  if (req.method === 'GET' || req.method === 'HEAD' || (!ct.includes('application/json') && !ct.includes('text/plain'))) {
    return next()
  }
  try {
    const raw = await _readRawBody(req, res, 50 * 1024 * 1024)
    req._rawBody = raw
    const text = raw.toString('utf8')
    // 空请求体不是错误：前端对所有请求统一带 Content-Type: application/json，
    // 但「刷新模型」「重置 Key」「删除」这类接口只用路径参数、不发 body。
    // express.json 对空 body 的处理就是给出 {}，这里必须保持一致，
    // 否则会误报「请求体不是合法的 JSON」。
    if (text.trim() === '') {
      req.body = {}
      return next()
    }
    const recovered = recoverBody(text)
    if (recovered === null) {
      const err = new SyntaxError('请求体不是合法的 JSON'); err.type = 'entity.parse.failed'
      throw err
    }
    if (recovered !== text.replace(/^\uFEFF/, '') && recovered !== text) {
      console.warn(`[body修复] ${req.method} ${req.path} 已修复非标准请求体（剥离嵌入的 HTTP 请求行/头后解析）`)
    }
    req.body = JSON.parse(recovered)
    next()
  } catch (err) {
    next(err)
  }
}
app.use(jsonBody)

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    const buf = req._rawBody
    const snippet = buf ? buf.toString('latin1') : ''
    const head = snippet.slice(0, 800)
    const tail = snippet.slice(-400)
    const firstBrace = snippet.indexOf('{')
    const firstBlank = snippet.search(/\r?\n\r?\n/)
    console.error(`[请求体解析失败] ${req.method} ${req.path} err=${err.message} len=${buf ? buf.length : 'n/a'} firstBrace=${firstBrace} firstBlank=${firstBlank}`)
    if (snippet) {
      console.error(`[请求体解析失败] head=${JSON.stringify(head)}`)
      console.error(`[请求体解析失败] tail=${JSON.stringify(tail)}`)
    }
    return res.status(400).json({ error: { message: '请求体不是合法的 JSON' } })
  }
  if (err.type === 'request.aborted') {
    if (res.headersSent) return
    console.log(`[客户端断连] ${req.method} ${req.path} 请求体传输完成前断开`)
    return res.status(400).json({ error: { message: '客户端在请求体传输完成前断开了连接，请重试' } })
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: '请求体过大（超过 50MB 限制）' } })
  }
  return next(err)
})

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${res.statusCode} ${req.method} ${req.path} ${ms}ms`)
    // 记录到运行日志（chat 请求由 handleChat 单独记录更详细的信息，避免重复）
    if (!req.path.startsWith('/api/v1/chat/completions')) {
      addLog({ type: 'api', method: req.method, path: req.path, status: res.statusCode, duration_ms: ms })
    }
  })
  next()
})

function maskKey(value) {
  if (!value) return ''
  if (value.length <= 10) return '******'
  return `***...${value.slice(-4)}`
}

// OAuth 凭据比静态 Key 更敏感：refresh_token 长期有效，泄露等于把整个订阅账号交出去。
// 列表接口一律只回掩码和状态，明文绝不出现在响应里。
function serializeKey(k) {
  const out = { ...k }
  if (k.type === 'oauth') {
    out.access_token = k.access_token ? maskKey(k.access_token) : ''
    out.refresh_token = k.refresh_token ? '***（已保存）' : ''
    out.refresh_token_present = Boolean(k.refresh_token)
    out.id_token = undefined
    out.token_present = Boolean(k.access_token)
    const skew = 60 * 60 * 1000
    out.credential_state = !k.access_token
      ? 'missing'
      : k.expires_at && Date.now() + skew >= k.expires_at
        ? 'expiring'
        : 'valid'
  } else {
    out.api_key = maskKey(k.api_key)
    out.api_key_present = Boolean(k.api_key)
  }
  return out
}

function serializeProvider(p) {
  return {
    ...p,
    keys: (p.keys || []).map(serializeKey)
  }
}

function api(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      res.status(500).json({ error: { message: err.message || '服务器内部错误' } })
    }
  }
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/v1/')) return next()
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (token && safeEqual(token, state.gateway_api_key)) return next()
  return res.status(401).json({ error: { message: '无效的 API Key，请在「仪表盘 → 对接方式」获取网关 API Key' } })
})

// 管理端鉴权：除 /api/v1/*（网关调用，走网关 Key）与 /api/health（健康检查）外，
// 所有管理接口都必须携带管理密钥（X-Admin-Key 头或 Authorization: Bearer）
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  if (req.path.startsWith('/api/v1/') || req.path === '/api/health') return next()
  const adminKey = getAdminKey()
  const provided = req.headers['x-admin-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (adminKey && provided && safeEqual(provided, adminKey)) return next()
  return res.status(401).json({ error: { message: '管理密钥无效或缺失，请在登录框输入管理密钥（见服务端启动日志或 config.json 的 admin_api_key 字段）' } })
})

app.get('/api/gateway', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`
  res.json({ base_url: `${base}/api/v1`, api_key: state.gateway_api_key })
})

app.get('/api/status', (req, res) => {
  const now = Date.now()
  const keys = state.providers.flatMap((p) => p.keys)
  res.json({
    gateway_api_key: state.gateway_api_key,
    stats: state.stats,
    overview: {
      totalProviders: state.providers.length,
      enabledProviders: state.providers.filter((p) => p.enabled).length,
      totalKeys: keys.length,
      cooldownKeys: keys.filter((k) => k.enabled && k.cooldown_until && k.cooldown_until > now).length,
      totalModels: state.providers.reduce((n, p) => n + p.models.length, 0),
      totalTokens: state.stats.totalTokens || 0,
      todayTokens: state.stats.todayTokens || 0
    },
    providers: state.providers.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      enabled: p.enabled,
      keyCount: p.keys.length,
      modelCount: p.models.length,
      models_updated_at: p.models_updated_at || null,
      stats: state.stats.perProvider[p.id] || { requests: 0, success: 0, failed: 0, tokens: 0 },
      keys: p.keys.map((k) => ({ id: k.id, name: k.name, enabled: k.enabled, status: keyStatus(k), last_error: k.last_error || null, last_error_at: k.last_error_at || null }))
    }))
  })
})

function keyStatus(k) {
  if (!k.enabled) return { status: 'disabled' }
  if (k.cooldown_until && k.cooldown_until > Date.now()) {
    return { cooldown: true, until: k.cooldown_until, last_error: k.last_error }
  }
  return { cooldown: false }
}

function normalizeModels(models, name) {
  if (!Array.isArray(models)) return []
  return models
    .map((m) => typeof m === 'string' ? { id: m, owned_by: name } : { id: m?.id || '', owned_by: m?.owned_by || name })
    .filter((m) => m.id)
}

app.get('/api/templates', (req, res) => {
  res.json({ templates: TEMPLATES })
})

app.get('/api/providers', (req, res) => {
  res.json(state.providers.map(serializeProvider))
})

function pickCallPlan(body) {
  const out = {}
  for (const field of CALL_PLAN_FIELDS) {
    if (body[field] !== undefined) out[field] = body[field]
  }
  return out
}

app.post('/api/providers', (req, res) => {
  const { name, base_url, protocol, enabled = true, extra_headers = {}, api_key, model_names = [] } = req.body
  if (!name || !base_url) {
    return res.status(400).json({ error: { message: '平台名称和 Base URL 为必填项' } })
  }
  const provider = {
    id: genId(),
    name,
    base_url,
    protocol: protocol || DEFAULT_PROTOCOL,
    enabled,
    models: model_names.filter(Boolean).map((id) => ({ id, owned_by: name })),
    keys: [],
    extra_headers: extra_headers || {},
    ...pickCallPlan(req.body),
    created_at: Date.now()
  }
  // 订阅类平台（Grok）常没有 /models：创建时若未填模型，预填内置默认列表，避免空模型不可用
  if (provider.models.length === 0) {
    const def = defaultModelsFor(provider.protocol)
    if (def && def.length) provider.models = def
  }
  if (api_key) {
    provider.keys.push({
      id: genId(),
      name: `Key 1`,
      api_key,
      enabled: true,
      cooldown_until: 0,
      last_error: null,
      last_error_at: null,
      created_at: Date.now()
    })
  }
  state.providers.push(provider)
  persistImmediate()
  res.status(201).json(serializeProvider(provider))
})

app.post('/api/providers/preview-models', api(async (req, res) => {
  const { base_url, protocol, api_key, extra_headers, provider_id } = req.body
  const result = await previewModels({ base_url, protocol, api_key, extra_headers, provider_id, ...pickCallPlan(req.body) })
  if (!result.ok) {
    return res.status(400).json({ error: { message: result.error } })
  }
  res.json({ ok: true, models: result.models })
}))

app.put('/api/providers/:id', (req, res) => {
  const p = getProvider(req.params.id)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const { name, base_url, protocol, enabled, extra_headers, model_names } = req.body
  if (name !== undefined) p.name = name
  if (base_url !== undefined) p.base_url = base_url
  if (protocol !== undefined) p.protocol = protocol
  if (enabled !== undefined) p.enabled = Boolean(enabled)
  if (extra_headers !== undefined) p.extra_headers = extra_headers
  if (model_names !== undefined) {
    p.models = model_names.filter(Boolean).map((id) => ({ id, owned_by: p.name }))
  }
  Object.assign(p, pickCallPlan(req.body))
  persistImmediate()
  res.json(serializeProvider(p))
})

app.delete('/api/providers/:id', (req, res) => {
  const idx = state.providers.findIndex((p) => p.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: { message: '平台不存在' } })
  state.providers.splice(idx, 1)
  persistImmediate()
  res.json({ ok: true })
})

app.post('/api/providers/:id/models/refresh', api(async (req, res) => {
  const result = await refreshModels(req.params.id)
  if (!result.ok) {
    return res.status(400).json({ error: { message: result.error } })
  }
  res.json({ ok: true, count: result.count, provider: serializeProvider(result.provider) })
}))

app.post('/api/providers/:id/keys', (req, res) => {
  const p = getProvider(req.params.id)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const { api_key, name = '', enabled = true } = req.body

  // OAuth 凭据直接导入：粘贴 access_token / sso_token 当订阅账号用（Grok 商城账号常见）。
  // 没有 refresh_token / expires_at 时按长期有效处理，不主动续期。
  // 也支持 Codex：把 ~/.codex/auth.json 里的 tokens 粘进来即可，
  // 此时 provider 传 codex，并建议带上 account_id（上游 ChatGPT-Account-Id 头要用）。
  if (req.body.type === 'oauth') {
    const { access_token, refresh_token, expires_in, account_id, email } = req.body
    if (!access_token) return res.status(400).json({ error: { message: 'access_token 不能为空' } })
    // 未显式指定时保持 grok，兼容既有调用与前端
    const credProvider = req.body.provider === 'codex' ? 'codex' : 'grok'
    const label = credProvider === 'codex' ? 'Codex 账号' : 'Grok 账号'
    const key = {
      id: genId(),
      type: 'oauth',
      provider: credProvider,
      name: name || `${label} ${(p.keys || []).length + 1}`,
      enabled: Boolean(enabled),
      cooldown_until: 0,
      last_error: null,
      last_error_at: null,
      created_at: Date.now(),
      access_token,
      token_type: 'Bearer'
    }
    if (refresh_token) key.refresh_token = refresh_token
    if (account_id) key.account_id = account_id
    if (email) key.email = email
    const expiresIn = Number(expires_in)
    if (Number.isFinite(expiresIn) && expiresIn > 0) key.expires_at = Date.now() + expiresIn * 1000
    p.keys = p.keys || []
    p.keys.push(key)
    persistImmediate()
    return res.status(201).json(serializeProvider(p))
  }

  if (!api_key) return res.status(400).json({ error: { message: 'API Key 不能为空' } })
  const key = {
    id: genId(),
    name: name || `Key ${p.keys.length + 1}`,
    api_key,
    enabled: Boolean(enabled),
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    created_at: Date.now()
  }
  p.keys.push(key)
  persistImmediate()
  res.status(201).json(serializeProvider(p))
})

app.put('/api/providers/:id/keys/:keyId', (req, res) => {
  const p = getProvider(req.params.id)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = p.keys.find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: 'Key 不存在' } })
  const { api_key, name, enabled, access_token, refresh_token, expires_in, account_id, email } = req.body
  if (api_key !== undefined && api_key) key.api_key = api_key
  if (name !== undefined) key.name = name
  if (enabled !== undefined) key.enabled = Boolean(enabled)
  if (key.type === 'oauth') {
    if (access_token) key.access_token = access_token
    if (refresh_token) key.refresh_token = refresh_token
    // Codex 上游的 ChatGPT-Account-Id 头用，导入时后补也允许
    if (account_id) key.account_id = account_id
    if (email) key.email = email
    const expiresIn = Number(expires_in)
    if (Number.isFinite(expiresIn) && expiresIn > 0) key.expires_at = Date.now() + expiresIn * 1000
  }
  persistImmediate()
  res.json(serializeProvider(p))
})

app.delete('/api/providers/:id/keys/:keyId', (req, res) => {
  const p = getProvider(req.params.id)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const idx = p.keys.findIndex((k) => k.id === req.params.keyId)
  if (idx < 0) return res.status(404).json({ error: { message: 'Key 不存在' } })
  p.keys.splice(idx, 1)
  persistImmediate()
  res.json(serializeProvider(p))
})

app.post('/api/providers/:id/keys/:keyId/reset', (req, res) => {
  const p = getProvider(req.params.id)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = p.keys.find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: 'Key 不存在' } })
  key.cooldown_until = 0
  key.last_error = null
  key.last_error_at = null
  persistImmediate()
  res.json(serializeProvider(p))
})

// ---------------------------------------------------------------------------
// Grok 订阅账号（OAuth）授权
//
// 设备码流程分两步，前端才有机会展示"等待用户在浏览器确认"的中间态：
//   start —— 申请 user_code，返回验证地址
//   poll  —— 前端按 retry_after 节奏反复调用，直到 done / error / expired
// 授权成功后若带了 provider_id，凭据直接绑定为该平台的一个 Key，
// 之后与普通 API Key 走同一套轮询、冷却、故障转移逻辑。
// ---------------------------------------------------------------------------
app.post('/api/oauth/grok/device/start', api(async (req, res) => {
  const { provider_id = null, name = '' } = req.body || {}
  if (provider_id && !getProvider(provider_id)) {
    return res.status(404).json({ error: { message: '平台不存在' } })
  }
  try {
    const flow = await startDeviceFlow({ providerId: provider_id, name })
    addLog({ type: 'oauth', action: 'device_start', provider_id, detail: `等待用户确认（${flow.user_code}）` })
    res.status(201).json(flow)
  } catch (err) {
    res.status(502).json({ error: { message: err.message } })
  }
}))

app.post('/api/oauth/grok/device/:id/poll', api(async (req, res) => {
  const result = await pollDeviceFlow(req.params.id)
  if (result.status !== 'done') return res.json(result)

  const { credential, provider_id } = result
  const p = provider_id ? getProvider(provider_id) : null
  if (!p) return res.json({ status: 'done', credential: serializeKey(credential) })

  const key = {
    id: genId(),
    type: 'oauth',
    provider: 'grok',
    name: credential.name || `Grok 账号 ${(p.keys || []).length + 1}`,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    created_at: Date.now(),
    ...credential
  }
  p.keys = p.keys || []
  p.keys.push(key)
  persistImmediate()
  addLog({ type: 'oauth', action: 'bound', provider_id, detail: `${key.name} 已绑定` })
  res.json({ status: 'done', key_id: key.id, provider: serializeProvider(p) })
}))

app.delete('/api/oauth/grok/device/:id', (req, res) => {
  res.json({ ok: cancelDeviceFlow(req.params.id) })
})

app.get('/api/oauth/grok/device', (req, res) => {
  res.json({ sessions: listPendingSessions() })
})

app.post('/api/oauth/grok/accounts/:providerId/:keyId/refresh', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  if (key.type !== 'oauth') {
    return res.status(400).json({ error: { message: '该凭据不是 OAuth 账号，无需续期' } })
  }
  try {
    const next = await refreshAccessToken(key)
    Object.assign(key, next)
    key.last_error = null
    key.cooldown_until = 0
    persistImmediate()
    addLog({ type: 'oauth', action: 'refresh', provider_id: p.id, detail: `${key.name} 续期成功` })
    res.json({ ok: true, provider: serializeProvider(p) })
  } catch (err) {
    // 续期失败只影响这一个账号——记录错误让它进入冷却，别的账号照常服务
    key.last_error = err.message
    key.last_error_at = Date.now()
    persistImmediate()
    res.status(400).json({ error: { message: err.message } })
  }
}))

app.get('/api/oauth/grok/defaults', (req, res) => {
  res.json({ base_url: XAI_OAUTH_BASE_URL, protocol: 'grok-oauth' })
})

// —— Codex（ChatGPT 订阅账号）设备码授权 ——
// 流程与 Grok 一致，差异都在 codex-oauth.js 里（JSON 端点、两步换 token）。
// start 必须带 provider_id：不带的话 poll 成功后凭据无处可去，
// 只会返回 credential 而不入库（Grok 早期踩过这个坑）。
app.post('/api/oauth/codex/device/start', api(async (req, res) => {
  const { provider_id = null, name = '' } = req.body || {}
  if (provider_id && !getProvider(provider_id)) {
    return res.status(404).json({ error: { message: '平台不存在' } })
  }
  try {
    const flow = await startCodexDeviceFlow({ providerId: provider_id, name })
    addLog({ type: 'oauth', action: 'device_start', provider_id, detail: `Codex 等待用户确认（${flow.user_code}）` })
    res.status(201).json(flow)
  } catch (err) {
    res.status(502).json({ error: { message: err.message } })
  }
}))

app.post('/api/oauth/codex/device/:id/poll', api(async (req, res) => {
  const result = await pollCodexDeviceFlow(req.params.id)
  if (result.status !== 'done') return res.json(result)

  const { credential, provider_id } = result
  const p = provider_id ? getProvider(provider_id) : null
  if (!p) return res.json({ status: 'done', credential: serializeKey(credential) })

  const key = {
    id: genId(),
    type: 'oauth',
    provider: 'codex',
    name: credential.name || `Codex 账号 ${(p.keys || []).length + 1}`,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    created_at: Date.now(),
    ...credential
  }
  p.keys = p.keys || []
  p.keys.push(key)
  persistImmediate()
  addLog({ type: 'oauth', action: 'bound', provider_id, detail: `${key.name} 已绑定${key.account_id ? `（${key.account_id}）` : ''}` })
  res.json({ status: 'done', key_id: key.id, provider: serializeProvider(p) })
}))

app.delete('/api/oauth/codex/device/:id', (req, res) => {
  res.json({ ok: cancelCodexDeviceFlow(req.params.id) })
})

app.get('/api/oauth/codex/device', (req, res) => {
  res.json({ sessions: listCodexPendingSessions() })
})

app.post('/api/oauth/codex/accounts/:providerId/:keyId/refresh', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  if (key.type !== 'oauth') {
    return res.status(400).json({ error: { message: '该凭据不是 OAuth 账号，无需续期' } })
  }
  try {
    const next = await refreshCodexToken(key)
    Object.assign(key, next)
    key.last_error = null
    key.cooldown_until = 0
    persistImmediate()
    addLog({ type: 'oauth', action: 'refresh', provider_id: p.id, detail: `${key.name} 续期成功` })
    res.json({ ok: true, provider: serializeProvider(p) })
  } catch (err) {
    key.last_error = err.message
    key.last_error_at = Date.now()
    persistImmediate()
    res.status(400).json({ error: { message: err.message } })
  }
}))

app.get('/api/oauth/codex/defaults', (req, res) => {
  res.json({ base_url: CODEX_API_BASE_URL, protocol: 'codex-oauth', verification_uri: CODEX_VERIFICATION_URI })
})

app.post('/api/v1/chat/completions', api(handleChat))

app.get('/api/v1/models', handleModels)

app.get('/api/v1/models/:providerId', (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  res.json({ object: 'list', data: p.models })
})

app.get('/api/providers/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', `attachment; filename="providers_${todayKey()}.json"`)
  res.end(JSON.stringify(state.providers, null, 2))
})

app.post('/api/providers/import', (req, res) => {
  const data = req.body
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: { message: '数据格式错误：必须是平台数组' } })
  }
  const imported = []
  const skipped = []
  for (const item of data) {
    if (!item.name || !item.base_url) {
      skipped.push(item.name || '未知平台')
      continue
    }
    const provider = {
      id: genId(),
      name: item.name,
      base_url: item.base_url,
      protocol: item.protocol || DEFAULT_PROTOCOL,
      enabled: item.enabled !== undefined ? item.enabled : true,
      models: normalizeModels(item.models, item.name),
      keys: Array.isArray(item.keys) ? item.keys.map((k) => ({
        id: genId(),
        type: k.type === 'oauth' ? 'oauth' : undefined,
        provider: k.provider || 'grok',
        name: k.name || 'Key 1',
        api_key: k.api_key || '',
        access_token: k.access_token || '',
        refresh_token: k.refresh_token || '',
        account_id: k.account_id,
        email: k.email,
        token_type: k.token_type || 'Bearer',
        expires_at: k.expires_at || 0,
        enabled: k.enabled !== undefined ? k.enabled : true,
        cooldown_until: 0,
        last_error: null,
        last_error_at: null,
        created_at: Date.now()
      })) : [],
      extra_headers: item.extra_headers || {},
      ...pickCallPlan(item),
      created_at: Date.now()
    }
    state.providers.push(provider)
    imported.push(item.name)
  }
  persistImmediate()
  res.json({ ok: true, imported: imported.length, names: imported, skipped })
})

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }))

app.get('/api/logs', (req, res) => {
  const logs = getLogs({
    limit: req.query.limit,
    type: req.query.type,
    status: req.query.status,
    q: req.query.q
  })
  res.json({ logs })
})

if (existsSync(join(WEB_DIST, 'index.html'))) {
  app.use(express.static(WEB_DIST))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api/')) return next()
    // 规范化后的路径必须仍位于 WEB_DIST 内，防止 ../ 越界探测服务器文件系统（路径遍历）
    const safePath = resolve(WEB_DIST, `.${req.path}`)
    if (safePath !== WEB_DIST_ROOT && !safePath.startsWith(WEB_DIST_ROOT + sep)) {
      return res.status(404).send('Not Found')
    }
    // 不存在的静态资源直接 404，避免返回 index.html 造成 MIME 错误难以排查
    if (req.path !== '/' && !existsSync(safePath)) {
      return res.status(404).send('Not Found')
    }
    res.sendFile(join(WEB_DIST, 'index.html'))
  })
  console.log(`[gateway] 生产模式已加载管理界面: ${WEB_DIST}`)
}

app.listen(PORT, '0.0.0.0', () => {
  initLogger()
  console.log(`[gateway] AI 中转站后端已启动: http://0.0.0.0:${PORT}`)
  console.log(`[gateway] 管理密钥（登录管理界面用）: ${getAdminKey()}`)
  console.log('[gateway] 如需更换，可设置环境变量 ADMIN_KEY 或修改 config.json 的 admin_api_key 字段')
  addLog({ type: 'system', method: '-', path: '-', status: 0, detail: `AI 中转站后端启动（端口 ${PORT}，${state.providers.length} 个平台）` })
})

setInterval(() => {
  const today = todayKey()
  if (state.stats && state.stats.todayDate !== today) {
    state.stats.todayDate = today
    state.stats.todayRequests = 0
    state.stats.todaySuccess = 0
    state.stats.todayFailed = 0
    state.stats.todayTokens = 0
    persist()
  }
}, 60 * 60 * 1000)
