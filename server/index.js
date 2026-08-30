import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { state, persist, persistImmediate, getProvider, genId, todayKey, getAdminKey } from './store.js'
import { handleChat, handleModels, refreshModels, previewModels, DEFAULT_PROTOCOL } from './proxy.js'
import { TEMPLATES } from './templates.js'
import { addLog, getLogs, initLogger } from './logger.js'

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

app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req._rawBody = buf } }))

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    const buf = req._rawBody
    const snippet = buf ? buf.toString('latin1') : ''
    const head = snippet.slice(0, 500)
    const tail = snippet.slice(-300)
    console.error(`[请求体解析失败] ${req.method} ${req.path} err=${err.message} len=${buf ? buf.length : 'n/a'}`)
    if (snippet) {
      console.error(`[请求体解析失败] head=${JSON.stringify(head)}`)
      console.error(`[请求体解析失败] tail=${JSON.stringify(tail)}`)
    }
    return res.status(400).json({ error: { message: '请求体不是合法的 JSON' } })
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

function serializeProvider(p) {
  return {
    ...p,
    keys: (p.keys || []).map((k) => ({
      ...k,
      api_key: maskKey(k.api_key),
      api_key_present: Boolean(k.api_key)
    }))
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
  const { api_key, name, enabled } = req.body
  if (api_key !== undefined && api_key) key.api_key = api_key
  if (name !== undefined) key.name = name
  if (enabled !== undefined) key.enabled = Boolean(enabled)
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
        name: k.name || 'Key 1',
        api_key: k.api_key || '',
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
