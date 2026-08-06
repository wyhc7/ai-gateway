import { state, getProvider, bumpStats, bumpFailover, markResult, bumpTokens, persist, persistImmediate } from './store.js'
import { addLog } from './logger.js'

function extractTokenCount(usage) {
  if (!usage) return null
  let tokenCount = usage.total_tokens ?? usage.totalTokens ?? usage.total
  if (tokenCount == null && usage.input_tokens != null && usage.output_tokens != null) {
    tokenCount = usage.input_tokens + usage.output_tokens
  }
  if (tokenCount == null && usage.inputTokens != null && usage.outputTokens != null) {
    tokenCount = usage.inputTokens + usage.outputTokens
  }
  if (tokenCount == null && usage.prompt_tokens != null && usage.completion_tokens != null) {
    tokenCount = usage.prompt_tokens + usage.completion_tokens
  }
  return tokenCount != null ? Number(tokenCount) : null
}

// 鉴权失败/限流/上游 5xx 均触发 Key 自动切换（5xx 冷却回退到 network 30s）
const RETRYABLE_STATUS = new Set([401, 403, 429, 500, 502, 503, 504])
const COOLDOWN_MS = {
  401: 10 * 60 * 1000,
  403: 10 * 60 * 1000,
  429: 60 * 1000,
  network: 30 * 1000
}

const STREAM_CONNECT_TIMEOUT_MS = 1800000
const JSON_CONNECT_TIMEOUT_MS = 600000
const SSE_HEARTBEAT_INTERVAL_MS = 30000
const STREAM_IDLE_TIMEOUT_MS = 300000

export const DEFAULT_PROTOCOL = 'openai-chat'

const PROTOCOLS = {
  'openai-chat': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', modelsMethod: 'GET' },
  'openai-responses': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/responses', modelsMethod: 'GET' },
  'anthropic': { auth: 'anthropic', authHeader: 'x-api-key', authPrefix: '', modelsPath: '/models', chatPath: '/messages', modelsMethod: 'GET' },
  'custom': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', modelsMethod: 'GET' }
}

export function protocolInfo(protocol) {
  return PROTOCOLS[protocol] || PROTOCOLS.custom
}

export function callPlan(provider) {
  const proto = protocolInfo(provider.protocol)
  return {
    auth: provider.auth_type || proto.auth,
    authHeader: provider.auth_header || proto.authHeader,
    authPrefix: provider.auth_prefix || proto.authPrefix,
    authQueryParam: provider.auth_query_param || 'api_key',
    chatPath: provider.chat_path || proto.chatPath,
    modelsPath: provider.models_path || proto.modelsPath,
    modelsMethod: String(provider.models_method || proto.modelsMethod).toUpperCase()
  }
}

const roundRobin = new Map()

const EXTRA_HEADERS = {
  'x-ai': {},
  'openrouter.ai': { 'HTTP-Referer': 'https://local.ai-gateway.dev', 'X-Title': 'AI Gateway' }
}

function joinUrl(base, path, query) {
  const normalized = base.endsWith('/') ? base : `${base}/`
  const url = new URL(path.replace(/^\//, ''), normalized)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  return url.toString()
}

function nextRoundRobin(roundRobinKey, list) {
  const idx = roundRobin.get(roundRobinKey) || 0
  roundRobin.set(roundRobinKey, (idx + 1) % Math.max(list.length, 1))
  return idx
}

function autoHeaders(provider) {
  const h = {}
  const host = new URL(provider.base_url).host
  for (const [domain, headers] of Object.entries(EXTRA_HEADERS)) {
    if (host.includes(domain)) Object.assign(h, headers)
  }
  return h
}

function authHeaders(plan, apiKey) {
  if (plan.auth === 'anthropic') return { 'x-api-key': apiKey }
  if (plan.auth === 'query') return {}
  const headerName = plan.authHeader || 'Authorization'
  return { [headerName]: `${plan.authPrefix || ''}${apiKey}` }
}

function queryAuth(plan, apiKey) {
  return plan.auth === 'query' ? { [plan.authQueryParam || 'api_key']: apiKey } : null
}

function buildHeaders(provider, plan, apiKey) {
  const headers = { 'Content-Type': 'application/json', ...autoHeaders(provider) }
  for (const [k, v] of Object.entries(provider.extra_headers || {})) {
    if (k && v) headers[k] = v
  }
  Object.assign(headers, authHeaders(plan, apiKey))
  if (plan.auth === 'anthropic' && !headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function mergeAuthAndCustomHeaders(extraHeaders, plan, apiKey) {
  const headers = { 'Content-Type': 'application/json' }
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    if (k && v) headers[k] = v
  }
  Object.assign(headers, authHeaders(plan, apiKey))
  if (plan.auth === 'anthropic' && !headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function matchProvider(model, providerIdHint) {
  if (providerIdHint) {
    const p = getProvider(providerIdHint)
    if (p && p.enabled) return p
  }
  const candidates = state.providers.filter((p) => p.enabled && p.models.some((m) => m.id === model))
  if (candidates.length === 0) return null
  return candidates[nextRoundRobin(model, candidates)]
}

function resolveTarget(body) {
  let model = body?.model || ''
  let providerIdHint = null
  const prefix = 'provider:'
  if (model.startsWith(prefix)) {
    const slash = model.indexOf('/')
    if (slash > prefix.length) {
      providerIdHint = model.slice(prefix.length, slash)
      model = model.slice(slash + 1)
      body = { ...body, model }
    }
  }
  return { model, providerIdHint, body }
}

function usableKeys(provider) {
  const now = Date.now()
  return provider.keys.filter((k) => k.enabled && (!k.cooldown_until || k.cooldown_until <= now))
}

function applyCooldown(key, status) {
  key.cooldown_until = Date.now() + (COOLDOWN_MS[status] || COOLDOWN_MS.network)
  key.last_error = status === 'network' ? '网络错误' : `HTTP ${status}`
  key.last_error_at = Date.now()
  persist()
}

export async function refreshModels(providerId) {
  const provider = getProvider(providerId)
  if (!provider) return { ok: false, error: '平台不存在' }
  const keys = usableKeys(provider)
  if (keys.length === 0) return { ok: false, error: '该平台尚未配置可用的 Key' }
  const plan = callPlan(provider)

  let lastError = null
  for (const key of keys) {
    const url = joinUrl(provider.base_url, plan.modelsPath, queryAuth(plan, key.api_key))
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      const resp = await fetch(url, {
        method: plan.modelsMethod,
        headers: buildHeaders(provider, plan, key.api_key),
        signal: controller.signal
      })
      clearTimeout(timer)
      if (resp.ok) {
        const data = await resp.json()
        const models = (data.data || []).map((m) => ({ id: m.id, owned_by: m.owned_by || m.display_name || provider.name }))
        provider.models = models
        provider.models_updated_at = Date.now()
        persistImmediate()
        return { ok: true, count: models.length, provider }
      }
      lastError = `HTTP ${resp.status}${previewHint(resp.status)}`
      await resp.body?.cancel()
      if (RETRYABLE_STATUS.has(resp.status)) {
        applyCooldown(key, resp.status)
      }
    } catch (err) {
      lastError = err.name === 'AbortError' ? '请求超时' : `网络错误: ${err.message}`
      applyCooldown(key, 'network')
    }
  }
  return { ok: false, error: `所有 Key 均不可用，最后错误: ${lastError}` }
}

export async function previewModels({ base_url, protocol, api_key, extra_headers = {}, provider_id, auth_type, auth_header, auth_prefix, auth_query_param, chat_path, models_path, models_method }) {
  let target = {
    base_url,
    protocol,
    api_key,
    extra_headers,
    auth_type,
    auth_header,
    auth_prefix,
    auth_query_param,
    chat_path,
    models_path,
    models_method
  }
  if (provider_id) {
    const p = getProvider(provider_id)
    if (!p) return { ok: false, error: '平台不存在' }
    const key = usableKeys(p)[0]
    if (!key) return { ok: false, error: '该平台没有可用的 Key，请先添加' }
    target = {
      base_url: p.base_url,
      protocol: p.protocol,
      api_key: key.api_key,
      extra_headers: p.extra_headers,
      auth_type: p.auth_type,
      auth_header: p.auth_header,
      auth_prefix: p.auth_prefix,
      auth_query_param: p.auth_query_param,
      chat_path: p.chat_path,
      models_path: p.models_path,
      models_method: p.models_method
    }
  }
  if (!target.base_url || !target.api_key) return { ok: false, error: '请先填写 API 地址与 API Token' }
  const plan = callPlan(target)
  const url = joinUrl(target.base_url, plan.modelsPath, queryAuth(plan, target.api_key))
  const headers = mergeAuthAndCustomHeaders(target.extra_headers, plan, target.api_key)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    const resp = await fetch(url, { method: plan.modelsMethod, headers, signal: controller.signal })
    clearTimeout(timer)
    if (!resp.ok) {
      await resp.body?.cancel()
      const hint = previewHint(resp.status)
      return { ok: false, error: `拉取失败：HTTP ${resp.status}${hint}` }
    }
    const data = await resp.json()
    const models = (data.data || []).map((m) => ({ id: m.id, owned_by: m.owned_by || m.display_name || '' }))
    return { ok: true, models }
  } catch (err) {
    const msg = err.name === 'AbortError' ? '拉取超时' : `网络错误: ${err.message}`
    return { ok: false, error: `拉取失败：${msg}（请检查网络或按服务商文档手动填写模型名称）` }
  }
}

function previewHint(status) {
  if (status === 404) {
    return '：该平台未提供模型列表接口（GET /models），或接口格式选错（如平台仅支持 OpenAI Chat 却选择了 Responses）。请在下方「模型名称」中按服务商文档手动填写'
  }
  if (status === 401 || status === 403) {
    return '：API Token 无效或鉴权失败，请检查 Token 是否正确'
  }
  if (status === 429) {
    return '：请求过于频繁（限流），请稍后重试'
  }
  return '（请按服务商文档手动填写模型名称）'
}

const SSE_TERMINATORS = ['[DONE]', 'message_stop']

function parseSseUsage(lineBuffer) {
  const lines = lineBuffer.split('\n')
  const rest = lines.pop()
  let lastUsageData = null
  let sawTerminator = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') {
      sawTerminator = true
      continue
    }
    try {
      const json = JSON.parse(data)
      if (SSE_TERMINATORS.some((t) => t === json.type)) sawTerminator = true
      const usage = json.usage || (json.choices?.[0]?.usage)
      if (usage) lastUsageData = usage
    } catch { /* skip partial */ }
  }
  return { rest, lastUsageData, sawTerminator }
}

async function forwardWithFailover(provider, kind, body, res) {
  const keys = usableKeys(provider)
  if (keys.length === 0) {
    markResult(provider.id, false)
    respondJson(res, 503, { error: { message: '该平台没有可用的 Key（可能全部处于冷却状态）', type: 'no_keys' } })
    return { ok: false, error: '该平台没有可用的 Key（可能全部处于冷却状态）' }
  }
  const plan = callPlan(provider)
  const path = kind === 'chat' ? plan.chatPath : plan.modelsPath
  const startIdx = nextRoundRobin(provider.id, keys)
  const attempts = []
  let started = false
  const connectTimeoutMs = body?.stream ? STREAM_CONNECT_TIMEOUT_MS : JSON_CONNECT_TIMEOUT_MS
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[(startIdx + i) % keys.length]
    const upstream = joinUrl(provider.base_url, path, queryAuth(plan, key.api_key))
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), connectTimeoutMs)
      const resp = await fetch(upstream, {
        method: kind === 'chat' ? 'POST' : plan.modelsMethod,
        headers: buildHeaders(provider, plan, key.api_key),
        body: kind === 'chat' ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
      clearTimeout(timer)
      if (RETRYABLE_STATUS.has(resp.status)) {
        attempts.push(`${key.name || key.id.slice(0, 8)}: HTTP ${resp.status}`)
        applyCooldown(key, resp.status)
        bumpFailover()
        await resp.body?.cancel()
        continue
      }
      started = true
      res.status(resp.status)
      const contentType = resp.headers.get('content-type') || ''
      if (contentType) res.setHeader('Content-Type', contentType)
      res.setHeader('X-Upstream-Key', key.name || key.id)
      const isStream = resp.body && contentType.toLowerCase().includes('text/event-stream')
      if (isStream) {
        const reader = resp.body.getReader()
        const textDecoder = new TextDecoder()
        let lastUsageData = null
        let sseBuffer = ''
        let sawTerminator = false
        let clientClosed = false
        const lastActivity = { t: Date.now() }

        const onClientClose = () => {
          clientClosed = true
          controller.abort()
        }
        res.on('close', onClientClose)

        const watcher = setInterval(() => {
          const idle = Date.now() - lastActivity.t
          if (idle >= STREAM_IDLE_TIMEOUT_MS) {
            controller.abort()
            return
          }
          if (idle >= SSE_HEARTBEAT_INTERVAL_MS && !res.writableEnded) {
            try { res.write(': keep-alive\n\n') } catch { /* socket 已关闭 */ }
          }
        }, 5000)
        if (watcher.unref) watcher.unref()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.byteLength > 0) {
              res.write(value)
              lastActivity.t = Date.now()
            }
            sseBuffer += textDecoder.decode(value, { stream: true })
            const parsed = parseSseUsage(sseBuffer)
            sseBuffer = parsed.rest
            if (parsed.lastUsageData) lastUsageData = parsed.lastUsageData
            if (parsed.sawTerminator) sawTerminator = true
          }
        } catch (err) {
          const isClientAbort =
            clientClosed ||
            err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            err.code === 'ERR_STREAM_DESTROYED'
          if (!isClientAbort) {
            applyCooldown(key, 'network')
            markResult(provider.id, false)
          }
          if (!res.writableEnded) res.end()
          return {
            ok: false,
            error: err.name === 'AbortError' ? '上游请求超时或长时间无响应' : `流式转发中断: ${err.message}`
          }
        } finally {
          clearInterval(watcher)
          res.removeListener('close', onClientClose)
          reader.cancel().catch(() => {})
        }
        if (!res.writableEnded) res.end()
        // 流式数据完整读完即视为成功（部分上游不发送 [DONE]/message_stop 终止符）
        markResult(provider.id, true)
        if (lastUsageData) {
          bumpTokens(provider.id, extractTokenCount(lastUsageData))
        }
        return { ok: true }
      }
      if (resp.body) {
        let text
        try {
          text = await readJsonBody(resp, JSON_CONNECT_TIMEOUT_MS, controller)
        } catch (err) {
          const msg = err.name === 'AbortError' ? '上游响应超时' : `上游读取失败: ${err.message}`
          attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
          applyCooldown(key, 'network')
          bumpFailover()
          continue
        }
        if (!res.writableEnded) res.end(text)
        try {
          const data = JSON.parse(text)
          const usage = data.usage || (data.choices?.[0]?.usage)
          const tokenCount = extractTokenCount(usage)
          if (tokenCount != null) {
            bumpTokens(provider.id, tokenCount)
          }
        } catch {
          // 非 JSON body，忽略
        }
      } else {
        if (!res.writableEnded) res.end()
      }
      markResult(provider.id, true)
      return { ok: true }
    } catch (err) {
      const msg = err.name === 'AbortError' ? '上游请求超时' : `网络错误: ${err.message}`
      if (started) {
        applyCooldown(key, 'network')
        if (!res.writableEnded) res.end()
        markResult(provider.id, false)
        return { ok: false, error: msg }
      }
      attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
      applyCooldown(key, 'network')
      bumpFailover()
    }
  }
  markResult(provider.id, false)
  respondJson(res, 502, { error: { message: `所有 Key 均请求失败（已自动切换 ${attempts.length} 次）：${attempts.join('；')}`, type: 'all_keys_failed' } })
  return { ok: false, error: `所有 Key 均请求失败（已自动切换 ${attempts.length} 次）：${attempts.join('；')}` }
}
function respondJson(res, status, payload) {
  if (!res.headersSent) {
    res.status(status).setHeader('Content-Type', 'application/json')
  }
  res.end(JSON.stringify(payload))
}

function readJsonBody(resp, ms, controller) {
  const timer = setTimeout(() => controller.abort(), ms)
  if (timer.unref) timer.unref()
  return resp.text().finally(() => clearTimeout(timer))
}

export async function handleChat(req, res) {
  const { model, providerIdHint, body } = resolveTarget(req.body)
  const provider = matchProvider(model, providerIdHint)
  bumpStats(provider?.id)
  const startTime = Date.now()
  const baseLog = {
    type: 'chat',
    method: 'POST',
    path: '/api/v1/chat/completions',
    model,
    provider_id: provider?.id || null,
    provider_name: provider?.name || null,
    stream: Boolean(body?.stream)
  }
  if (!provider) {
    markResult(null, false)
    addLog({ ...baseLog, status: 404, error: `未找到提供模型 "${model}" 的平台` })
    return respondJson(res, 404, { error: { message: `未找到提供模型 "${model}" 的平台，请先在平台管理中刷新模型列表`, type: 'model_not_found' } })
  }
  if (!provider.base_url) {
    markResult(provider.id, false)
    addLog({ ...baseLog, status: 400, error: '平台缺少 Base URL' })
    return respondJson(res, 400, { error: { message: '平台缺少 Base URL', type: 'bad_config' } })
  }
  const result = await forwardWithFailover(provider, 'chat', body, res)
  addLog({
    ...baseLog,
    status: res.statusCode || (result.ok ? 200 : 502),
    ok: result.ok,
    key: res.getHeader('X-Upstream-Key') || undefined,
    duration_ms: Date.now() - startTime,
    error: result.ok ? undefined : (result.error || '')
  })
}

export function handleModels(req, res) {
  const list = []
  const seen = new Set()
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      list.push({ id: m.id, object: 'model', owned_by: m.owned_by || p.name, provider: p.id, provider_name: p.name })
    }
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ object: 'list', data: list }))
}
