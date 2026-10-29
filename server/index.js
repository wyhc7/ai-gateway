import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { state, persist, persistImmediate, getProvider, genId, todayKey, getAdminKey } from './store.js'
import { handleChat, handleImages, handleModels, refreshModels, previewModels, refreshWorkbuddyCatalog, DEFAULT_PROTOCOL } from './proxy.js'
import { autoRefreshModelsTick } from './model-auto-refresh.js'
import {
  pickBridgeProvider,
  bridgeBaseOf,
  proxyAccountsRequest,
  sanitizeAccounts,
  collectAccountsForExport,
  restoreAccountsFromBackup
} from './chatgpt-accounts.js'
import {
  createApiKey,
  updateApiKey,
  deleteApiKey,
  rotateApiKey,
  resetApiKeyUsage,
  getApiKey,
  serializeApiKey,
  resolveAuth,
  modelPool,
  filterModelsForAuth
} from './api-keys.js'
import { TEMPLATES } from './templates.js'
import { SUBSCRIPTION_PLANS, findPlan } from './subscription-plans.js'
import { filterModelsForProvider, isImageModel } from './providers-image-only.js'
import { startWorkbuddyLogin, pollWorkbuddyLogin, cancelWorkbuddyLogin, refreshWorkbuddyToken, ensureWorkbuddyToken } from './workbuddy-oauth.js'
import { workbuddyRealmFor, expiryToMs, jwtExpiresAtMs } from './workbuddy-core.js'
import { fetchWorkbuddyCheckinStatus, performWorkbuddyCheckin, beijingDayKey, fetchWorkbuddyCredits, workbuddyCreditsStale } from './workbuddy-checkin.js'
import { addLog, getLogs, initLogger } from './logger.js'
import { checkUpdate, applyUpdate, normalizeForceMode, FORCE_MODES } from './update.js'
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

// images_path 必须在内：只生图的平台（chatgpt2api 挂反代子路径、或上游把生图放在
// /v1/image/generations 这类非标准位置）全靠它把生图请求指对地方，漏掉它
// callPlan 只会退回协议的默认 /images/generations，请求直接 404。
const CALL_PLAN_FIELDS = ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'images_path', 'models_path', 'models_method']

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
    // 记录到运行日志（chat / images 请求由各自的 handler 单独记录更详细的信息，避免重复；
    // /v1/* 是 /api/v1/* 的标准 OpenAI 别名，同样交给 handler 记录）
    const quietPath = req.path.startsWith('/api') ? req.path.slice(4) : req.path
    if (!quietPath.startsWith('/v1/chat/completions') && !quietPath.startsWith('/v1/images/generations')) {
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

// 从请求里取出调用方的令牌。支持三种常见带法，覆盖不同客户端：
//   Authorization: Bearer <Key>   —— OpenAI 系客户端的标准做法
//   x-api-key: <Key>              —— Anthropic 系客户端
//   ?api_key=<Key>                —— 少数把 Key 拼进 URL 的老客户端
function extractGatewayToken(req) {
  const auth = String(req.headers.authorization || '')
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const headerKey = req.headers['x-api-key']
  if (headerKey) return String(headerKey).trim()
  const q = req.query?.api_key
  if (q) return String(q).trim()
  // Authorization 里塞了裸 Key（不带 Bearer 前缀）的客户端也存在，一并兼容
  if (auth.trim()) return auth.trim()
  return ''
}

// 网关调用鉴权。
//
// /api/v1/* 与 /v1/* 是同一批 handler 的两组路径别名（第三方客户端常把 base_url
// 配成 http://host:port/v1），鉴权与模型权限必须对两组路径同时生效——只守一组
// 等于给了个绕过的后门：拿受限 Key 改个前缀就能随便用模型。
//
// 通过后把调用方身份挂在 req.apiAuth 上，供下游按 Key 的模型白名单放行与过滤。
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/v1/') && !req.path.startsWith('/v1/')) return next()
  const result = resolveAuth(extractGatewayToken(req))
  if (!result.ok) {
    return res.status(result.status || 401).json({ error: { message: result.message, type: 'invalid_api_key' } })
  }
  req.apiAuth = result.auth
  next()
})

// 管理端鉴权：除 /api/v1/*（网关调用，走网关 Key）与 /api/health（健康检查）外，
// 所有管理接口都必须携带管理密钥（X-Admin-Key 头或 Authorization: Bearer）
//
// 常量放在这里是因为鉴权中间件在路由注册之前就执行，需要提前引用。
const CHATGPT_OAUTH_CALLBACK_PATH = '/api/chatgpt-accounts/oauth/callback'
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  if (req.path.startsWith('/api/v1/') || req.path === '/api/health') return next()
  // 书签脚本用的回调端点必须豁免：它跑在 platform.openai.com 的页面里，
  // 那里没有管理密钥（也不能有——密钥会出现在页面 JS 里）。
  // 它的鉴权换成 provider_id + session_id：session 是 32 位随机串、
  // 10 分钟过期、成功即销毁，泄漏也只能用一次，且拿到它做不了别的事。
  if (req.path === CHATGPT_OAUTH_CALLBACK_PATH) return next()
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
  const apiKeys = state.api_keys || []
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
      todayTokens: state.stats.todayTokens || 0,
      accessKeys: apiKeys.length,
      activeAccessKeys: apiKeys.filter((k) => k.enabled && !(Number(k.expires_at) > 0 && now >= Number(k.expires_at))).length
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

// 订阅方案与模板分开返回：模板只服务「添加平台」，订阅有自己的入口。
// 混在 /api/templates 里，前端就得再按 group 过滤一遍，谁忘了过滤订阅平台
// 就又从「添加平台」里冒出来了。
app.get('/api/subscriptions/plans', (req, res) => {
  res.json({ plans: SUBSCRIPTION_PLANS })
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
  // 来自「添加订阅」的方案：image_only / auth_kind 是方案属性，不能由客户端随意决定
  // 口径——前端只是把它抄过来，真正的判据在这里。这样即便有人直接拿 curl 建平台，
  // 也不会造出一个「声称只生图但塞了文本模型」的平台。
  const plan = req.body.plan_id ? findPlan(req.body.plan_id) : null
  const imageOnly = plan ? Boolean(plan.image_only) : Boolean(req.body.image_only)
  const names = (plan ? plan.default_models || [] : model_names).filter(Boolean)
  const provider = {
    id: genId(),
    name,
    base_url,
    protocol: protocol || DEFAULT_PROTOCOL,
    enabled,
    // 只生图平台在建平台这一刻就把非生图模型剔掉：前端模板、导入备份、
    // 手填 model_names 三条路都从这里过，闸门放在最前面最省事
    models: (imageOnly ? names.filter(isImageModel) : names).map((id) => ({ id, owned_by: name })),
    keys: [],
    extra_headers: extra_headers || {},
    ...(imageOnly ? { image_only: true } : {}),
    ...pickCallPlan(req.body),
    // WorkBuddy 的登录起点版本（cn / intl）。国际版的登录入口只认 IDE 客户端，
    // 起点也不同，所以建平台时就定下来，授权框据此预选。
    ...(protocol === 'workbuddy-oauth' ? { workbuddy_region: req.body.workbuddy_region === 'intl' ? 'intl' : 'cn' } : {}),
    created_at: Date.now()
  }
  // 这里刻意不按 defaultModelsFor 补模型：订阅与免费通道的模型清单要么随上游版本变，
  // 要么得由用户自己定。建平台时偷偷塞一份，等于把他决定不预填的又填了回去。
  // 空着就空着——界面会提示点「刷新」，到那时 defaultModelsFor 才作为兜底生效。
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
  // 平台级出站代理：整个平台的 Key 共用一个出口。空串 = 清空（回直连），
  // undefined = 不动——同 Key 级语义，别让改个名字顺手清掉代理配置。
  if (req.body.proxy !== undefined) p.proxy = String(req.body.proxy || '').trim()
  if (extra_headers !== undefined) p.extra_headers = extra_headers
  // image_only 是只增不减的锁：只生图平台在编辑表单里被拖进文本模型，
  // 也在这里被剔掉。允许关掉它等于给「只生图」留后门，不提供这个开关。
  if (req.body.image_only) p.image_only = true
  if (model_names !== undefined) {
    p.models = filterModelsForProvider(p, model_names.filter(Boolean)).map((id) => ({ id, owned_by: p.name }))
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
  // 整份展开而不是逐字段列举：refreshModels 以后新增的字段（比如免费通道实测
  // 收编的 discovered）不该因为这里忘了同步而被静默丢掉——路由只负责序列化 provider
  res.json({ ...result, provider: serializeProvider(result.provider) })
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
    const { access_token, refresh_token, expires_in, account_id, email, uid, domain } = req.body
    if (!access_token) return res.status(400).json({ error: { message: 'access_token 不能为空' } })
    // 未显式指定时保持 grok，兼容既有调用与前端
    const CRED_PROVIDERS = new Set(['codex', 'workbuddy'])
    const credProvider = CRED_PROVIDERS.has(req.body.provider) ? req.body.provider : 'grok'
    const label = { codex: 'Codex 账号', workbuddy: 'WorkBuddy 账号', grok: 'Grok 账号' }[credProvider]
    // WorkBuddy 上游按 uid + realm 识别身份，缺 uid 等于存一个必定调不通的 Key，
    // 与其让它在第一次请求时以「401」的形式暴露，不如当场说清楚缺什么
    if (credProvider === 'workbuddy' && !uid) {
      return res.status(400).json({ error: { message: 'WorkBuddy 账号必须提供 uid（登录态文件里的 account.uid）' } })
    }
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
    // WorkBuddy 专属：uid 进 X-User-Id，domain 进 X-Domain
    if (uid) key.uid = uid
    if (domain) key.domain = domain
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
  const { api_key, name, enabled, access_token, refresh_token, expires_in, account_id, email, proxy } = req.body
  if (api_key !== undefined && api_key) key.api_key = api_key
  if (name !== undefined) key.name = name
  if (enabled !== undefined) key.enabled = Boolean(enabled)
  // 出站代理：让这个账号从指定 IP 出去。上游按出口 IP 做风控，所以是账号级配置。
  // 传空串 = 清空（回到直连），undefined = 不动。两种语义要分开，
  // 否则「只想改个名字」会把已配好的代理顺手抹掉。
  if (proxy !== undefined) key.proxy = String(proxy || '').trim()
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

// WorkBuddy 登录态 JSON 批量导入（两个版本平台通用）。
//
// 与「导入 Token」（单个粘贴）的分工：那个面向一个账号的手工粘贴；这个面向
// 用户手里成沓的 workbuddy-<uid>.json —— 选文件或粘数组，一次导入多个账号。
//
// 三条设计约束，都有对应的真实失败形态：
//  1. **按域名分流，不按用户在对话框里选的平台**：登录态自己的 domain 决定
//     归属 realm（workbuddyRealmFor）。国内域名进国内版平台、国际域名进国际版
//     平台。混着两个域的数组能一次导入——用户手里就是一个文件一个账号，
//     不会替网关分好类。没有对应版本的平台时该账号失败，其它账号照常导入。
//  2. **同一 uid 重复导入 = 更新，不堆重复 Key**：登录态文件是会轮换的，
//     重新导入应当是换 token。匹配只看 uid 不看 domain——重新登录后 domain
//     也可能变，身份是 uid。更新时顺手清掉冷却与 last_error：留着旧账会让
//     账号刚导入就先背一个过期的 401 冷却，用户看不出是旧账。
//  3. **单条失败不拖垮整批**：坏条目不 return，记 failed 继续下一条。
app.post('/api/providers/import-workbuddy-json', api(async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : []
  if (entries.length === 0) {
    return res.status(400).json({ error: { message: 'entries 不能为空：至少导入一个账号' } })
  }
  // 目标平台按「版本」分组：workbuddy_region 建平台时就定死了（缺省按国内版）。
  // 一个版本有多个平台时取第一个启用的——多平台是用户自己的编排，导入只认
  // 第一个，结果里写明落点，用户看得见自己导去了哪。
  const wbPlatforms = state.providers.filter((p) => p.protocol === 'workbuddy-oauth' && p.enabled)
  const providerFor = (region) => wbPlatforms.find((p) => (p.workbuddy_region === 'intl' ? 'intl' : 'cn') === region) || null

  const results = []
  let added = 0
  let updated = 0
  for (const entry of entries) {
    const access_token = String(entry?.access_token || '').trim()
    const uid = String(entry?.uid || '').trim()
    if (!access_token || !uid) {
      results.push({ status: 'failed', error: '读不到 access_token 或 uid，请确认导入的是完整的登录态文件' })
      continue
    }
    const domain = String(entry?.domain || '').trim()
    const realm = workbuddyRealmFor(domain)
    const region = realm === 'cn' ? 'cn' : 'intl'
    const target = providerFor(region)
    if (!target) {
      results.push({
        status: 'failed', realm, uid,
        error: region === 'intl' ? '没有可用的国际版 WorkBuddy 平台（请先创建一个）' : '没有可用的国内版 WorkBuddy 平台（请先创建一个）'
      })
      continue
    }
    // 过期时刻的优先级：绝对 expires_at（秒/毫秒自适配）> 相对 expires_in > JWT exp。
    // 之所以不信 expires_in：它是「前端算出来的剩余秒数」，前端一旦把文件里的秒值
    // 当毫秒减 Date.now()，就会算出负数并被抹成 0，落库 expires_at = 0 → 该账号
    // 永不主动续期（workbuddyTokenNeedsRefresh 对 0 直接返回 false）。
    const absolute = expiryToMs(entry?.expires_at ?? entry?.expiresAt)
    const expiresIn = Number(entry?.expires_in)
    const relative = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
    const expires_at = absolute || relative || jwtExpiresAtMs(access_token) || 0
    const refresh_token = String(entry?.refresh_token || '').trim()

    const existing = (target.keys || []).find(
      (k) => k.type === 'oauth' && k.provider === 'workbuddy' && String(k.uid || '') === uid
    )
    if (existing) {
      existing.access_token = access_token
      if (refresh_token) existing.refresh_token = refresh_token
      if (domain) existing.domain = domain
      if (expires_at) existing.expires_at = expires_at
      if (entry?.name) existing.name = String(entry.name)
      // 新 token 到位，旧的失败记录与冷却一并清零：留着会让账号刚导入
      // 就先背一个过期的 401 冷却，用户看不出是旧账。
      existing.cooldown_until = 0
      existing.last_error = null
      existing.last_error_at = null
      updated++
      results.push({ status: 'updated', realm, provider: target.name, provider_id: target.id, uid, name: existing.name })
      continue
    }

    const key = {
      id: genId(),
      type: 'oauth',
      provider: 'workbuddy',
      name: String(entry?.name || '').trim() || `WorkBuddy 账号 ${(target.keys || []).length + 1}`,
      enabled: true,
      cooldown_until: 0,
      last_error: null,
      last_error_at: null,
      created_at: Date.now(),
      access_token,
      token_type: 'Bearer',
      uid
    }
    if (refresh_token) key.refresh_token = refresh_token
    if (domain) key.domain = domain
    if (expires_at) key.expires_at = expires_at
    target.keys = target.keys || []
    target.keys.push(key)
    added++
    results.push({ status: 'added', realm, provider: target.name, provider_id: target.id, uid, name: key.name })
  }
  if (added + updated > 0) persistImmediate()
  const failed = results.filter((r) => r.status === 'failed').length
  addLog({ type: 'system', detail: `WorkBuddy 登录态 JSON 导入：新增 ${added}、更新 ${updated}、失败 ${failed}` })
  res.json({ results, added, updated, failed })
}))

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

// —— WorkBuddy（腾讯 CodeBuddy 国际版）扫码授权 ——
// 与设备码流程同构，差异全在 workbuddy-oauth.js：上游返回的是登录页地址
//（打开后扫码/网页登录），cookie 会话随 state 存在服务端内存，5 分钟过期。
// start 必须带 provider_id，否则 poll 成功后凭据无处可去，只会返回而不入库。
app.post('/api/oauth/workbuddy/login/start', api(async (req, res) => {
  const { provider_id = null, name = '', region = 'cn' } = req.body || {}
  if (provider_id && !getProvider(provider_id)) {
    return res.status(404).json({ error: { message: '平台不存在' } })
  }
  try {
    // region 决定登录起点：cn / global 走 copilot.tencent.com，intl 走 codebuddy.ai
    //（国际版只认 IDE 客户端，platform=ide）。落地后由 token 的 domain 决定后续路由。
    const flow = await startWorkbuddyLogin({ providerId: provider_id, name, region })
    addLog({ type: 'oauth', action: 'device_start', provider_id, detail: `WorkBuddy 等待扫码登录（${region}）` })
    res.status(201).json(flow)
  } catch (err) {
    res.status(502).json({ error: { message: err.message } })
  }
}))

app.post('/api/oauth/workbuddy/login/:state/poll', api(async (req, res) => {
  const result = await pollWorkbuddyLogin(req.params.state)
  if (result.status !== 'done') return res.json(result)

  const { credential, provider_id } = result
  const p = provider_id ? getProvider(provider_id) : null
  if (!p) return res.json({ status: 'done', credential: serializeKey(credential) })

  const key = {
    id: genId(),
    type: 'oauth',
    provider: 'workbuddy',
    name: credential.name || `WorkBuddy 账号 ${(p.keys || []).length + 1}`,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    created_at: Date.now(),
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
    expires_at: credential.expires_at,
    domain: credential.domain,
    uid: credential.uid,
    token_type: 'Bearer'
  }
  p.keys = p.keys || []
  p.keys.push(key)
  persistImmediate()
  addLog({ type: 'oauth', action: 'bound', provider_id, detail: `${key.name} 已绑定` })
  res.json({ status: 'done', key_id: key.id, provider: serializeProvider(p) })
}))

app.delete('/api/oauth/workbuddy/login/:state', (req, res) => {
  res.json({ ok: cancelWorkbuddyLogin(req.params.state) })
})

// —— WorkBuddy 每日签到 ——
// 签到按北京时间的自然日重置，宿主机时区不能当判据：网关可能跑在 UTC 机器上，
// 用本地日期会在凌晨把「今天」判成昨天。
function workbuddyCheckinDay() {
  return beijingDayKey()
}

// 查一次额度并写回 Key。查询与写入绑在一起：手动刷新、签到后刷新都走这里，
// 分开写迟早会漏掉一个字段，页面上的「剩余 / 总量」就会自相矛盾。
async function refreshWorkbuddyCreditsInto(key) {
  const credits = await fetchWorkbuddyCredits(key)
  key.credits_remain = credits.remain
  key.credits_used = credits.used
  key.credits_size = credits.size
  key.credits_unit = credits.unit
  key.credits_at = credits.fetched_at
  delete key.credits_error
  return credits
}

// 单账号签到。返回值区分三种结果，前端与日志据此措辞：
//   already  今日已签（上游或本地记录任一判定）
//   inactive 该账号没有可签到活动（国际版账号常见）
//   ok       本次领取成功
async function workbuddyCheckinOne(key) {
  const status = await fetchWorkbuddyCheckinStatus(key)
  if (status.checked_in) {
    key.checkin_date = workbuddyCheckinDay()
    return { status: 'already', summary: status }
  }
  if (status.active === false) {
    return { status: 'inactive', summary: status }
  }
  await performWorkbuddyCheckin(key)
  key.checkin_date = workbuddyCheckinDay()
  // 签到是「新增一个额度包」，总量与剩余一起上涨（见 workbuddy-checkin.js 里
  // packageBalance 的注释）。签完必须重查一次，否则卡头会一直显示签到前的总量，
  // 签到发的那部分额度在页面上等于不存在。
  // 查额度失败不影响签到本身——签到已经领到了，只是数字晚点更新。
  let credits = null
  try {
    credits = await refreshWorkbuddyCreditsInto(key)
  } catch (err) {
    key.credits_error = err.message
  }
  return {
    status: 'ok',
    summary: { ...status, checked_in: true, today_credit: status.daily_credit || status.today_credit },
    credits
  }
}

app.get('/api/oauth/workbuddy/accounts/:providerId/:keyId/checkin', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  try {
    const summary = await fetchWorkbuddyCheckinStatus(key)
    res.json({ summary, checked_in_today: key.checkin_date === workbuddyCheckinDay() })
  } catch (err) {
    res.status(400).json({ error: { message: err.message } })
  }
}))

app.post('/api/oauth/workbuddy/accounts/:providerId/:keyId/checkin', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  try {
    const result = await workbuddyCheckinOne(key)
    persistImmediate()
    const label = { ok: '成功', already: '今日已签', inactive: '该账号无签到活动' }[result.status] || result.status
    const delta = result.credits ? `，额度 ${result.credits.remain} / ${result.credits.size}` : ''
    addLog({ type: 'oauth', action: 'checkin', provider_id: p.id, detail: `${key.name} 签到：${label}${delta}` })
    res.json(result)
  } catch (err) {
    // 签到失败只影响这一个账号，不进冷却——它不影响对话能力
    key.last_error = err.message
    key.last_error_at = Date.now()
    persistImmediate()
    res.status(400).json({ error: { message: err.message } })
  }
}))

// 剩余额度。查询结果缓存在 Key 上：额度是慢变量，没必要每次进页面都打上游，
// 前端只在缓存过期时才回来查。
app.get('/api/oauth/workbuddy/accounts/:providerId/:keyId/credits', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  try {
    const credits = await refreshWorkbuddyCreditsInto(key)
    persistImmediate()
    res.json(credits)
  } catch (err) {
    key.credits_error = err.message
    persistImmediate()
    res.status(400).json({ error: { message: err.message } })
  }
}))

// 自动签到：每小时一轮，逐账号判断今天是否已签，未签就领。
// 判据只有两处——key.checkin_date（成功后写入，避免同一天反复打上游）
// 与上游返回的 todayCheckedIn（本地记录丢失时的兜底）。
// 失败的账号每小时最多再试一次，不会因为一个坏账号把整轮拖死。
const WORKBUDDY_CHECKIN_TICK_MS = 60 * 60 * 1000

async function workbuddyAutoCheckinTick() {
  const day = workbuddyCheckinDay()
  const now = Date.now()
  for (const p of state.providers || []) {
    if (p.protocol !== 'workbuddy-oauth') continue
    for (const key of p.keys || []) {
      if (!key.enabled || key.type !== 'oauth' || !key.access_token) continue
      if (key.checkin_date === day) {
        // 今天已经签过的号：签到那一刻已经重查过额度，但一整天里额度还会因为
        // 使用而变化。缓存过期就补一次，免得卡头一整天停在旧数字上。
        if (workbuddyCreditsStale(key, now)) {
          try {
            await refreshWorkbuddyCreditsInto(key)
          } catch (err) {
            key.credits_error = err.message
          }
        }
        continue
      }
      if (key.checkin_last_attempt_at && now - key.checkin_last_attempt_at < WORKBUDDY_CHECKIN_TICK_MS) continue
      key.checkin_last_attempt_at = now
      try {
        const r = await workbuddyCheckinOne(key)
        const label = { ok: '成功', already: '今日已签', inactive: '该账号无签到活动' }[r.status] || r.status
        // 把签到后的剩余/总量写进日志：签到到底涨了多少，翻日志就能看出来，
        // 不用再去页面上对着数字猜。
        const delta = r.credits ? `，额度 ${r.credits.remain} / ${r.credits.size}` : ''
        addLog({ type: 'oauth', action: 'checkin', provider_id: p.id, detail: `${key.name} 自动签到：${label}${delta}` })
      } catch (err) {
        addLog({ type: 'oauth', action: 'checkin', provider_id: p.id, detail: `${key.name} 自动签到失败：${err.message}` })
      }
    }
  }
  persistImmediate()
}

// unref：这是常驻服务的定时器，但测试进程里不该因为它而退不出去
const workbuddyCheckinTimer = setInterval(() => {
  workbuddyAutoCheckinTick().catch(() => {})
}, WORKBUDDY_CHECKIN_TICK_MS)
workbuddyCheckinTimer.unref?.()

// —— WorkBuddy 凭据保活 ——
//
// 为什么需要这个：续期原本只在「调用前」和「401/403 后」触发（见
// proxy.resolveKeyToken）。这个设计对高频账号没问题，但对**冷账号**是致命的：
// 一个号如果一整个 token 周期都没被选中过，就永远没人去刷它，
// 等下次选中时 refresh_token 可能已经作废 —— 号就这样无声地死了。
//
// 7 个号轮询，单个号确实可能长期轮不到。所以这里补一个主动保活：
// 每小时扫一遍，把「已经过了续期窗口」的号刷掉。
//
// 直接复用 ensureWorkbuddyToken：它内部先判断 tokenNeedsRefresh，
// 没到期就原样返回、不发请求 —— 所以这个 tick 对绝大多数账号是完全空转，
// 不会白白消耗 refresh_token 的寿命。
const WORKBUDDY_KEEPALIVE_TICK_MS = 60 * 60 * 1000

async function workbuddyTokenKeepaliveTick() {
  for (const p of state.providers || []) {
    if (p.protocol !== 'workbuddy-oauth') continue
    for (const key of p.keys || []) {
      if (!key.enabled || key.type !== 'oauth' || !key.refresh_token) continue
      try {
        const { credential, refreshed } = await ensureWorkbuddyToken(key)
        if (!refreshed) continue
        Object.assign(key, credential)
        persistImmediate()
        delete key.last_refresh_error
        addLog({
          type: 'oauth', action: 'refresh', provider_id: p.id,
          detail: `${key.name} 凭据已保活续期`
        })
      } catch (err) {
        // 失败不反复刷屏：写进字段，界面能看见，下一轮再试
        key.last_refresh_error = err.message
        persistImmediate()
        addLog({ type: 'oauth', action: 'refresh', provider_id: p.id, detail: `${key.name} 保活续期失败：${err.message}` })
      }
    }
  }
}

const workbuddyKeepaliveTimer = setInterval(() => {
  workbuddyTokenKeepaliveTick().catch(() => {})
}, WORKBUDDY_KEEPALIVE_TICK_MS)
workbuddyKeepaliveTimer.unref?.()

// —— WorkBuddy 积分倍率复取 ——
//
// 倍率必须持续来自上游。只在用户点「刷新」时取一次然后存盘，那不是获取，
// 是把某一天的快照当成了常量。按 TTL 复取，界面上标出取数时间——
// 过没过期一眼能看出来，不用猜这个数是不是还准。
const WORKBUDDY_RATES_TTL_MS = 15 * 60 * 1000

async function workbuddyRefreshRates() {
  for (const p of state.providers || []) {
    if (p.protocol !== 'workbuddy-oauth') continue
    if (p.model_rates_at && Date.now() - p.model_rates_at < WORKBUDDY_RATES_TTL_MS) continue
    try {
      // 模型清单与倍率一起刷新：它们来自同一次目录抓取，分开取会让清单里的
      // 模型和倍率表对不上——两个 realm 的模型名是两套，各取各的必然错位
      await refreshWorkbuddyCatalog(p)
    } catch (err) {
      // 取不到不告警刷屏：倍率是展示信息，TTL 到了还会再试
      p.model_rates_error = err.message
    }
  }
}

// 启动后先补一轮（延迟几秒，别和启动期其它初始化抢），之后按 TTL 复取
const workbuddyRatesWarm = setTimeout(() => { workbuddyRefreshRates().catch(() => {}) }, 15 * 1000)
workbuddyRatesWarm.unref?.()
const workbuddyRatesTimer = setInterval(() => {
  workbuddyRefreshRates().catch(() => {})
}, WORKBUDDY_RATES_TTL_MS)
workbuddyRatesTimer.unref?.()

// —— 凌晨自动刷新模型 ——
//
// 每分钟 tick 一次，到点（默认 05:00，配置项 auto_refresh_models_at 可改）
// 且今天没跑过就开刷。判断与执行都在 model-auto-refresh.js，这里只挂钟。
const AUTO_REFRESH_TICK_MS = 60 * 1000
const autoRefreshModelsTimer = setInterval(() => {
  autoRefreshModelsTick().catch(() => {})
}, AUTO_REFRESH_TICK_MS)
autoRefreshModelsTimer.unref?.()

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

// WorkBuddy 账号续期。
//
// 与 Grok / Codex 同一套语义（无条件续期，失败记 last_error 但不进冷却——续期失败
// 只说明这一枚 refresh_token 的状态，不该让整个账号立刻不可用）。
// 端点、参数、响应信封都在 workbuddy-oauth.js 里，这里只做路由与落盘。
app.post('/api/oauth/workbuddy/accounts/:providerId/:keyId/refresh', api(async (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  const key = (p.keys || []).find((k) => k.id === req.params.keyId)
  if (!key) return res.status(404).json({ error: { message: '账号不存在' } })
  if (key.type !== 'oauth') {
    return res.status(400).json({ error: { message: '该凭据不是 OAuth 账号，无需续期' } })
  }
  try {
    const next = await refreshWorkbuddyToken(key)
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

// ---------------------------------------------------------------------------
// 客户端访问密钥管理
//
// 与「平台 Key」完全是两码事，不要混淆：
//   平台 Key（/api/providers/:id/keys）—— 网关往上访问平台时用的上游凭据。
//   访问密钥（本组接口）           —— 网关往下发给客户端用的钥匙，本文件管的就是它。
// 每个访问密钥可以限定「只能用哪些模型」，转发时按白名单放行。
// 明文只在创建与轮换的响应里出现一次，列表接口一律只回前缀片段。
// ---------------------------------------------------------------------------
// 转换层账号管理（chatgpt2api 等自建转换层）
//
// 账号池在转换层那边，但它的 auth-key 必须留在服务器上。所以这里做一层代理：
// 浏览器带**管理密钥**调 /api/chatgpt-accounts/*，网关在这一侧补 auth-key 再打
// 上游。auth-key 不出服务器，转换层端口也不用对外开放。
//
// 只代理账号管理这一小撮路径（白名单在 server/chatgpt-accounts.js），不做通用
// 隧道：上游还挂着模型调用端点，转发面越大越容易被当成万能代理用。
// ---------------------------------------------------------------------------
function resolveBridgeTarget(req, res) {
  const pid = req.query?.provider_id || req.body?.provider_id
  const provider = pickBridgeProvider(state.providers, pid)
  if (!provider) {
    res.status(400).json({
      error: {
        message: pid
          ? `找不到平台 ${pid}，或该平台没有可用的 base_url`
          : '当前没有任何转换层平台。请先在「添加订阅」里用 ChatGPT 网页版（chatgpt2api）方案建一个平台'
      }
    })
    return null
  }
  return provider
}

function bridgeError(res, e) {
  const status = Number(e?.statusCode) || 502
  return res.status(status).json({ error: { message: e?.message || String(e) } })
}

app.get('/api/chatgpt-accounts', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  try {
    const up = await proxyAccountsRequest(provider, 'GET', '/api/accounts')
    if (up.status !== 200) {
      return res.status(up.status).json({ error: { message: up.body?.error?.message || up.body?.detail?.error || `转换层返回 HTTP ${up.status}` } })
    }
    res.json({
      provider: { id: provider.id, name: provider.name, base_url: bridgeBaseOf(provider) },
      accounts: sanitizeAccounts(up.body)
    })
  } catch (e) {
    bridgeError(res, e)
  }
}))

app.post('/api/chatgpt-accounts/import', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens : []
  const clean = tokens.map((t) => String(t || '').trim()).filter(Boolean)
  if (clean.length === 0) {
    return res.status(400).json({ error: { message: '请提供至少一个 access_token（tokens 数组）' } })
  }
  try {
    const up = await proxyAccountsRequest(provider, 'POST', '/api/accounts', { tokens: clean })
    if (up.status !== 200) {
      return res.status(up.status).json({ error: { message: up.body?.error?.message || up.body?.detail?.error || `转换层返回 HTTP ${up.status}` } })
    }
    addLog({
      type: 'provider',
      method: 'POST',
      path: '/api/chatgpt-accounts/import',
      status: 200,
      detail: `向转换层 ${provider.name} 导入 ${clean.length} 个 token（新增 ${up.body?.added ?? '?'}）`
    })
    res.json({
      added: up.body?.added ?? 0,
      skipped: up.body?.skipped ?? 0,
      accounts: sanitizeAccounts(up.body)
    })
  } catch (e) {
    bridgeError(res, e)
  }
}))

app.post('/api/chatgpt-accounts/refresh', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  try {
    // 上游 refresh 需要 tokens；不传时先拉一次全量，用现有 token 逐个刷新
    let tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map((t) => String(t || '').trim()).filter(Boolean) : []
    if (tokens.length === 0) {
      const list = await proxyAccountsRequest(provider, 'GET', '/api/accounts')
      const items = Array.isArray(list.body?.items) ? list.body.items : []
      tokens = items.map((a) => String(a?.access_token || '')).filter(Boolean)
    }
    if (tokens.length === 0) {
      return res.json({ refreshed: 0, errors: [], accounts: [] })
    }
    const up = await proxyAccountsRequest(provider, 'POST', '/api/accounts/refresh', { tokens })
    const after = await proxyAccountsRequest(provider, 'GET', '/api/accounts')
    res.json({
      refreshed: up.body?.refreshed ?? 0,
      errors: up.body?.errors || [],
      accounts: sanitizeAccounts(after.body)
    })
  } catch (e) {
    bridgeError(res, e)
  }
}))

app.delete('/api/chatgpt-accounts', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map((t) => String(t || '').trim()).filter(Boolean) : []
  if (tokens.length === 0) {
    return res.status(400).json({ error: { message: '删除账号需要提供 tokens（上游按 token 定位，不接受邮箱）' } })
  }
  try {
    const up = await proxyAccountsRequest(provider, 'DELETE', '/api/accounts', { tokens })
    if (up.status !== 200) {
      return res.status(up.status).json({ error: { message: up.body?.error?.message || `转换层返回 HTTP ${up.status}` } })
    }
    res.json({ ok: true })
  } catch (e) {
    bridgeError(res, e)
  }
}))

// --- OAuth 授权加号：start 拿链接，finish 换 token 三件套 ---
app.post('/api/chatgpt-accounts/oauth/start', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  const emailHint = String(req.body?.email_hint || '').trim()
  try {
    const up = await proxyAccountsRequest(provider, 'POST', '/api/accounts/oauth/start', { email_hint: emailHint })
    if (up.status !== 200) {
      return res.status(up.status).json({ error: { message: up.body?.error?.message || up.body?.detail?.error || `转换层返回 HTTP ${up.status}` } })
    }
    // state 前段就是 session_id，前端展示链接时不必再拆
    const url = String(up.body?.authorize_url || '')
    let state = ''
    try {
      state = new URL(url).searchParams.get('state') || ''
    } catch {
      /* 上游给的不是标准 URL，就不回 state */
    }
    res.json({
      session_id: up.body?.session_id || '',
      authorize_url: url,
      state,
      expires_in: up.body?.expires_in || '600'
    })
  } catch (e) {
    bridgeError(res, e)
  }
}))

// 一条独立的「回调接收」端点，专给书签脚本用。
//
// 为什么要单独一条而不是复用上面的 /oauth/finish：
//   1. 书签脚本跑在 platform.openai.com 的页面里，提交是跨域的，
//      必须自己回 CORS 头；而普通 /api/* 不接受跨域。
//   2. 书签里不能塞管理密钥（它会出现在页面 JS 里），所以鉴权换成
//      「平台 id + session_id」这对组合：session_id 是 32 位随机串，
//      10 分钟过期，泄漏也只能用一次，且拿到它本身做不了别的事。
//   3. 表单提交（application/x-www-form-urlencoded）而不是 JSON：
//      书签里拼 JSON fetch 有 preflight，表单没有。
//
// 返回一个给人看的小 HTML 页，而不是 JSON —— 用户点完书签总得看到结果。
app.options('/api/chatgpt-accounts/oauth/callback', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }).sendStatus(204)
})

app.post('/api/chatgpt-accounts/oauth/callback', express.urlencoded({ extended: false }), api(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
  const providerId = String(req.body?.provider_id || '').trim()
  const sessionId = String(req.body?.session_id || '').trim()
  const callback = String(req.body?.callback || '').trim()
  const html = (title, body, ok) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#303133}
h2{color:${ok ? '#1a7f37' : '#c45656'}}code{background:#f4f4f5;padding:2px 6px;border-radius:3px;word-break:break-all}</style>
<h2>${title}</h2><div>${body}</div><p style="color:#909399;font-size:13px">可以关掉这个页面了，账号列表在网关面板里刷新即可。</p>`
  const reply = (status, title, body, ok) => res.status(status).type('html').send(html(title, body, ok))

  if (!sessionId || !callback) {
    return reply(400, '缺少参数', '书签脚本需要 <code>session_id</code> 与 <code>callback</code>。请回到网关面板重新生成书签。', false)
  }
  const provider = pickBridgeProvider(state.providers, providerId || undefined)
  if (!provider) {
    return reply(400, '找不到转换层平台', '请确认网关里已经建好「ChatGPT 网页版（chatgpt2api）· 生图」平台。', false)
  }

  // state 前缀必须对上 session_id，否则说明授权窗口属于另一次会话
  let cbState = ''
  try {
    cbState = new URL(callback).searchParams.get('state') || ''
  } catch {
    return reply(400, 'callback 不是合法 URL', `收到的内容是：<code>${callback.slice(0, 160)}</code>`, false)
  }
  if (cbState && !cbState.startsWith(sessionId)) {
    return reply(400, 'state 不匹配', `这次授权对应的是另一次会话（期望 <code>${sessionId.slice(0, 8)}…</code>，收到 <code>${cbState.slice(0, 8)}…</code>）。<br>请回面板点「生成授权链接」并重新生成书签。`, false)
  }

  try {
    const up = await proxyAccountsRequest(provider, 'POST', '/api/accounts/oauth/finish', { session_id: sessionId, callback })
    if (up.status !== 200) {
      const msg = up.body?.error?.message || up.body?.detail?.error || `转换层返回 HTTP ${up.status}`
      return reply(up.status, '兑换 token 失败', `转换层说：<code>${String(msg).slice(0, 300)}</code>`, false)
    }
    const list = sanitizeAccounts(up.body)
    const fresh = list.find((a) => a.refresh_token) || list[0]
    addLog({
      type: 'provider',
      method: 'POST',
      path: '/api/chatgpt-accounts/oauth/callback',
      status: 200,
      detail: `书签脚本完成 OAuth 加号：${fresh?.email || '(未知邮箱)'}（转换层 ${provider.name}）`
    })
    return reply(200, '加号成功 ✅', `账号：<code>${fresh?.email || '(未知邮箱)'}</code><br>自动续期：${fresh?.refresh_token ? '已开启' : '未开启'}<br>剩余生图额度：${fresh?.image_quota ?? '—'} 次`, true)
  } catch (e) {
    return reply(502, '连不上转换层', `<code>${String(e?.message || e).slice(0, 300)}</code>`, false)
  }
}))

app.post('/api/chatgpt-accounts/oauth/finish', api(async (req, res) => {
  const provider = resolveBridgeTarget(req, res)
  if (!provider) return
  const sessionId = String(req.body?.session_id || '').trim()
  const callback = String(req.body?.callback || '').trim()
  if (!sessionId || !callback) {
    return res.status(400).json({ error: { message: 'session_id 与 callback 都必填' } })
  }
  // 本地先校 state，不匹配直接退回，别白跑一次上游
  let cbState = ''
  try {
    cbState = new URL(callback).searchParams.get('state') || ''
  } catch {
    return res.status(400).json({ error: { message: 'callback 不是合法 URL，请粘贴完整的 platform.openai.com/auth/callback?... 地址' } })
  }
  if (cbState && !cbState.startsWith(sessionId)) {
    return res.status(400).json({
      error: {
        message: `state 不匹配（期望 ${sessionId}.xxx，收到 ${cbState.slice(0, 24)}...）。多半是你授权的窗口对应另一次会话，请重新点「生成授权链接」。`
      }
    })
  }
  try {
    const up = await proxyAccountsRequest(provider, 'POST', '/api/accounts/oauth/finish', { session_id: sessionId, callback })
    if (up.status !== 200) {
      return res.status(up.status).json({ error: { message: up.body?.error?.message || up.body?.detail?.error || `转换层返回 HTTP ${up.status}` } })
    }
    addLog({
      type: 'provider',
      method: 'POST',
      path: '/api/chatgpt-accounts/oauth/finish',
      status: 200,
      detail: `转换层 ${provider.name} 完成 OAuth 授权加号`
    })
    res.json({ ok: true, accounts: sanitizeAccounts(up.body) })
  } catch (e) {
    bridgeError(res, e)
  }
}))

// ---------------------------------------------------------------------------
app.get('/api/keys', (req, res) => {
  const keys = (state.api_keys || []).map(serializeApiKey)
  res.json({
    keys,
    // 管理界面选模型用的候选池（所有启用平台的模型并集）
    available_models: modelPool(),
    // 主密钥仍然有效且不受任何限制，界面上要与受限 Key 区分展示
    owner_key: state.gateway_api_key,
    base_url: `${req.protocol}://${req.get('host')}`
  })
})

app.post('/api/keys', (req, res) => {
  const { name, allowed_models, denied_models, enabled, expires_at, note } = req.body || {}
  const { key, token } = createApiKey({ name, allowed_models, denied_models, enabled, expires_at, note })
  addLog({ type: 'apikey', method: 'POST', path: '/api/keys', status: 201, detail: `已创建访问密钥「${key.name}」（${key.model_scope === 'all' ? '全部模型' : `${key.allowed_models.length} 条模型规则`}）` })
  // token 是明文，仅此一次；前端必须提示用户立刻保存
  res.status(201).json({ key, token })
})

app.put('/api/keys/:id', (req, res) => {
  const key = updateApiKey(req.params.id, req.body || {})
  if (!key) return res.status(404).json({ error: { message: '访问密钥不存在' } })
  addLog({ type: 'apikey', method: 'PUT', path: `/api/keys/${req.params.id}`, status: 200, detail: `已更新访问密钥「${key.name}」` })
  res.json({ key })
})

app.delete('/api/keys/:id', (req, res) => {
  const existing = getApiKey(req.params.id)
  if (!existing) return res.status(404).json({ error: { message: '访问密钥不存在' } })
  deleteApiKey(req.params.id)
  addLog({ type: 'apikey', method: 'DELETE', path: `/api/keys/${req.params.id}`, status: 200, detail: `已删除访问密钥「${existing.name}」` })
  res.json({ ok: true })
})

// 轮换：换一把新钥匙，名称/权限/用量保留。用户误把 Key 贴进聊天记录时用这个补救，
// 不必删了重建再重新配一遍模型白名单。
app.post('/api/keys/:id/rotate', (req, res) => {
  const out = rotateApiKey(req.params.id)
  if (!out) return res.status(404).json({ error: { message: '访问密钥不存在' } })
  addLog({ type: 'apikey', method: 'POST', path: `/api/keys/${req.params.id}/rotate`, status: 200, detail: `已轮换访问密钥「${out.key.name}」` })
  res.json(out)
})

app.post('/api/keys/:id/reset-usage', (req, res) => {
  const key = resetApiKeyUsage(req.params.id)
  if (!key) return res.status(404).json({ error: { message: '访问密钥不存在' } })
  res.json({ key })
})

app.post('/api/v1/chat/completions', api(handleChat))

// 生图（OpenAI /images/generations 兼容）：走与对话相同的平台匹配、Key 轮询与故障切换，
// 请求体原样透传给上游（chatgpt2api 等自建生图服务可直接挂在网关后面统一调度）。
app.post('/api/v1/images/generations', api(handleImages))

app.get('/api/v1/models', handleModels)

// OpenAI 标准路径别名：第三方客户端（Cherry Studio / NextChat / OpenWebUI 等）
// 通常把 base_url 配成 http://host:port/v1，会请求 /v1/* 而非 /api/v1/*。
// 两组路径指向同一批 handler，行为完全一致。
app.post('/v1/chat/completions', api(handleChat))
app.post('/v1/images/generations', api(handleImages))
app.get('/v1/models', handleModels)

app.get('/api/v1/models/:providerId', (req, res) => {
  const p = getProvider(req.params.providerId)
  if (!p) return res.status(404).json({ error: { message: '平台不存在' } })
  // 与 /v1/models 口径一致：受限 Key 只看得到自己被放行的模型
  res.json({ object: 'list', data: filterModelsForAuth(p.models, req.apiAuth) })
})

// ---------------------------------------------------------------------------
// 导入导出
//
// 导出脱敏：凭据（api_key / access_token / refresh_token）只留前后各 4 位、
// 中间打码——备份文件常在群里/网盘里转，明文 Key 等于把账号送人。
// last_error / last_error_at 是运行时状态，不进备份。
// 订阅平台（OAuth 账号）的模型目录、倍率表、签到/额度状态按字段白名单
// 整体还原：只挑固定字段重建会把它们全弄丢，导入后订阅平台直接残废。
// ---------------------------------------------------------------------------

const SECRET_FIELDS = ['api_key', 'access_token', 'refresh_token']

// 平台级订阅状态：导入时原样带回（倍率表不重建，省得导入后全员重新刷新）
const PROVIDER_RUNTIME_FIELDS = [
  'model_rates', 'model_rates_at', 'model_rates_error', 'models_source',
  'models_updated_at', 'model_realm', 'model_upstream_id'
]

// 订阅 Key 的运行时状态：额度与签到进度跟着账号走，重建时丢掉就等于
// 把用户攒的额度和连续签到记录清零
const KEY_RUNTIME_FIELDS = [
  'credits_size', 'credits_remain', 'credits_used', 'credits_unit', 'credits_at',
  'checkin_date', 'checkin_last_attempt_at'
]

// 模型记录整体保留：倍率、名字、上下文窗口、realm 都是上游事实，
// normalizeModels 那种只留 id/owned_by 的压法会把倍率表打回裸 id
const IMPORT_MODEL_FIELDS = [
  'id', 'name', 'owned_by', 'rate', 'rate_discounted', 'context', 'realm',
  'chat', 'auto_select', 'vendor', 'icon', 'description'
]

function maskSecret(v) {
  const s = String(v ?? '')
  if (!s) return s
  // 短值全打码：前后各留 4 位对短 Key 等于没脱敏
  if (s.length <= 8) return '*'.repeat(8)
  return `${s.slice(0, 4)}${'*'.repeat(8)}${s.slice(-4)}`
}

function isMasked(v) {
  return typeof v === 'string' && v.includes('*')
}

function sanitizeKeyForExport(k) {
  const out = { ...k }
  for (const f of SECRET_FIELDS) if (f in out) out[f] = maskSecret(out[f])
  delete out.last_error
  delete out.last_error_at
  return out
}

// 导出格式：一个文件两层数据。
//
// 早先只导出平台数组（纯 JSON array），账号池是漏在外面的 —— 换机器恢复时
// 平台回来了、11 个号却还得一个一个重新加，而每个号都要过一次 OAuth。
// 现在改成对象形态，把账号池一起打包。
//
// 但纯数组仍要能读：老备份文件是数组，用户的浏览器收藏和历史下载里都有。
// 所以 version 字段只用于**说明**，不用于拒绝 —— 判断依据是「有没有
// providers 键」，数组就是老格式。
const BACKUP_FORMAT = 'ai-gateway-backup'
const BACKUP_VERSION = 1

app.get('/api/providers/export', async (req, res) => {
  const providers = state.providers.map((p) => ({
    ...p,
    keys: Array.isArray(p.keys) ? p.keys.map(sanitizeKeyForExport) : []
  }))

  // 账号池取失败不能把整份备份搞砸：用户点导出是为了拿平台配置，
  // 因为转换层暂时连不上就一行都导不出来，那是更糟的结果。
  // 所以这里吞掉错误并记进 warnings，让文件照常下载。
  let accounts = { provider_id: '', items: [] }
  const warnings = []
  try {
    accounts = await collectAccountsForExport(state.providers, req.query.provider_id)
  } catch (e) {
    warnings.push(`账号池未导出：${e?.message || e}`)
  }

  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    // 账号池里有完整 token，这里明写一句，免得有人把备份随手传群
    secret_warning: 'chatgpt_accounts 含完整 access_token / refresh_token，等同账号密码，勿外传',
    providers,
    chatgpt_accounts: accounts
  }
  if (warnings.length) payload.warnings = warnings

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', `attachment; filename="providers_${todayKey()}.json"`)
  res.end(JSON.stringify(payload, null, 2))
})

app.post('/api/providers/import', async (req, res) => {
  const raw = req.body
  // 新格式 { providers: [...] } 与老格式 [...] 都接
  const data = Array.isArray(raw) ? raw : raw?.providers
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: { message: '数据格式错误：需要平台数组，或含 providers 数组的备份对象' } })
  }
  const backupAccounts = Array.isArray(raw?.chatgpt_accounts)
    ? raw.chatgpt_accounts
    : Array.isArray(raw?.chatgpt_accounts?.items)
      ? raw.chatgpt_accounts.items
      : null
  const accountProviderId = raw?.chatgpt_accounts?.provider_id || ''

  const imported = []
  const skipped = []
  const maskedKeys = []
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
      models: restoreModels(item.models, item.name),
      keys: [],
      extra_headers: item.extra_headers || {},
      ...pickCallPlan(item),
      created_at: Date.now()
    }
    for (const f of PROVIDER_RUNTIME_FIELDS) {
      if (item[f] !== undefined) provider[f] = item[f]
    }
    if (Array.isArray(item.keys)) {
      for (const k of item.keys) {
        const key = {
          id: genId(),
          type: k.type === 'oauth' ? 'oauth' : undefined,
          provider: k.provider || 'grok',
          name: k.name || 'Key 1',
          // 脱敏值（含 *）视为占位符：置空并在结果里点名，
          // 提醒用户这把 Key 得重新填，别让它静默变成一把空 Key
          api_key: isMasked(k.api_key) ? '' : (k.api_key || ''),
          access_token: isMasked(k.access_token) ? '' : (k.access_token || ''),
          refresh_token: isMasked(k.refresh_token) ? '' : (k.refresh_token || ''),
          account_id: k.account_id,
          email: k.email,
          token_type: k.token_type || 'Bearer',
          expires_at: k.expires_at || 0,
          enabled: k.enabled !== undefined ? k.enabled : true,
          cooldown_until: 0,
          last_error: null,
          last_error_at: null,
          created_at: Date.now()
        }
        for (const f of KEY_RUNTIME_FIELDS) {
          if (k[f] !== undefined) key[f] = k[f]
        }
        if (isMasked(k.api_key) || isMasked(k.access_token) || isMasked(k.refresh_token)) {
          maskedKeys.push(`${item.name} / ${key.name}`)
        }
        provider.keys.push(key)
      }
    }
    state.providers.push(provider)
    imported.push(item.name)
  }
  persistImmediate()

  // 账号池写回放在平台落盘之后：新平台刚 push 进去，pickBridgeProvider
  // 才可能认得出来（备份里记的 provider_id 在新机器上必然不存在，
  // 这时靠 image_only 回退定位）。
  let accounts = null
  const accountErrors = []
  if (backupAccounts && backupAccounts.length) {
    try {
      const r = await restoreAccountsFromBackup(state.providers, accountProviderId, backupAccounts)
      accounts = r
    } catch (e) {
      // 平台导入已经成功了，不能因为号池写回失败就整体报错 —— 那样前端会
      // 以为什么都没进去。账号问题单独回传，让用户按提示处理。
      accountErrors.push(e?.message || String(e))
    }
  }

  res.json({
    ok: true,
    imported: imported.length,
    names: imported,
    skipped,
    masked_keys: maskedKeys,
    accounts,
    account_errors: accountErrors
  })
})

// 模型记录整体还原：字符串形态（旧导出/手工编辑）兼容成 { id, owned_by }，
// 对象形态按白名单保留倍率、上下文、realm 等上游事实。
function restoreModels(models, name) {
  if (!Array.isArray(models)) return []
  return models
    .map((m) => {
      if (typeof m === 'string') return { id: m, owned_by: name }
      const out = {}
      for (const f of IMPORT_MODEL_FIELDS) if (m?.[f] !== undefined) out[f] = m[f]
      if (!out.id) return null
      if (!out.owned_by) out.owned_by = name
      return out
    })
    .filter(Boolean)
}

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }))

// ---------------------------------------------------------------------------
// 系统更新
//
// 管理与 /api/ 同一条鉴权链，无需额外处理。检查走缓存（60 秒），避免前端每次
// 进页面都去 fetch 一次远程；「立即更新」前会强制清缓存重新比对。
// ---------------------------------------------------------------------------
app.get('/api/update/check', api(async (req, res) => {
  const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase())
  res.json(await checkUpdate({ force }))
}))

// 更新失败也回 200：HTTP 层没出错，出错的是更新过程本身，而前端要拿到完整步骤
// 日志才能指出卡在哪一步。前端按 result.ok 分支，而不是按响应码。
//
// force：强制更新档位（soft / normal / hard）。不传就是常规更新。
// 非法值直接 400 —— 静默降级成常规更新会让人以为「强制过了」，而实际上什么都没丢，
// 下一次照样卡在同一个地方。
app.post('/api/update/apply', api(async (req, res) => {
  const raw = req.body?.force
  const forceMode = normalizeForceMode(raw)
  if (raw !== undefined && raw !== null && raw !== '' && raw !== false && forceMode === null) {
    return res.status(400).json({ error: { message: `force 取值非法：${raw}，可用值为 ${FORCE_MODES.join(' / ')}` } })
  }
  const result = await applyUpdate({ force: forceMode })
  addLog({
    type: 'system',
    method: 'POST',
    path: '/api/update/apply',
    status: result.ok ? 200 : 500,
    detail: result.ok
      ? (result.up_to_date
          ? '检查更新：已是最新版本'
          : `已更新 ${result.from} → ${result.to}${result.forced ? `（强制 ${result.force_mode}）` : ''}${result.restart?.ok ? '' : `（${result.restart?.message || '需手动重启'}）`}`)
      : `更新失败${forceMode ? `（强制 ${forceMode}）` : ''}：${result.message}`
  })
  res.json(result)
}))

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
