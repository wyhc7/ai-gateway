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

// 多数上游的流式响应默认不带 usage，只有显式声明 include_usage 才会在末尾补发。
// 只对已知支持的平台注入该字段，避免把不认识的字段丢给上游换来一个 400。
export function withUsageOption(provider, body) {
  if (!body || !body.stream) return body
  let host = ''
  try {
    host = new URL(provider.base_url).host
  } catch {
    return body
  }
  if (!USAGE_STREAM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return body
  if (body.stream_options?.include_usage !== undefined) return body
  return { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } }
}

// 上游始终不返回 usage 时的兜底估算
// CJK 约 0.7 token/字，其余按 4 字符/token 粗略折算
export function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[㐀-䶿一-鿿぀-ヿ가-힯]/g) || []).length
  const rest = Math.max(text.length - cjk, 0)
  return Math.max(1, Math.round(cjk * 0.7 + rest / 4))
}

// Key 级错误：凭证本身有问题（无效/无权限），需要长时间冷却
const KEY_LEVEL_STATUS = new Set([401, 403])
// 上游级错误：平台侧抖动或限流，与 Key 好坏无关，短冷却且限制同时冷却的 Key 数量
const UPSTREAM_LEVEL_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_STATUS = new Set([...KEY_LEVEL_STATUS, ...UPSTREAM_LEVEL_STATUS])
const COOLDOWN_MS = {
  401: 10 * 60 * 1000,
  403: 10 * 60 * 1000,
  429: 30 * 1000,
  network: 30 * 1000
}
// 上游抖动时若已有一半以上 Key 在冷却，剩余冷却时间压到很短，避免整站被一次性冻死
const UPSTREAM_CROWD_COOLDOWN_MS = 5000

// 超时分两段：连接阶段（含等待响应头）用短超时快速失败，
// 拿到响应后切换为长超时。此前连接与总时长共用一个 30 分钟超时，
// 上游半开连接时客户端会一直挂到超时，期间该 Key 也不会被冷却。
const CONNECT_TIMEOUT_MS = 30000
const STREAM_TOTAL_TIMEOUT_MS = 1800000
const JSON_TOTAL_TIMEOUT_MS = 120000
const SSE_HEARTBEAT_INTERVAL_MS = 30000
const STREAM_IDLE_TIMEOUT_MS = 300000

// 部分上游的流式响应默认不返回 usage，需显式声明 include_usage 才会带上
const USAGE_STREAM_HOSTS = [
  'api.openai.com',
  'api.deepseek.com',
  'api.moonshot.cn',
  'dashscope.aliyuncs.com',
  'open.bigmodel.cn',
  'api.siliconflow.cn',
  'ark.cn-beijing.volces.com',
  'qianfan.baidubce.com',
  'api.hunyuan.cloud.tencent.com',
  'api.minimax.chat',
  'api.stepfun.com',
  'spark-api-open.xf-yun.com',
  'api.groq.com',
  'api.x.ai',
  'api.openrouter.ai',
  'openrouter.ai',
  'integrate.api.nvidia.com',
  'generativelanguage.googleapis.com'
]

export const DEFAULT_PROTOCOL = 'openai-chat'

const PROTOCOLS = {
  'openai-chat': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', modelsMethod: 'GET' },
  'openai-responses': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/responses', modelsMethod: 'GET' },
  // Anthropic 官方的 OpenAI 兼容端点：鉴权仍是 x-api-key，但请求与响应都是 OpenAI 格式，可直接透传
  'anthropic-openai': { auth: 'anthropic', authHeader: 'x-api-key', authPrefix: '', modelsPath: '/models', chatPath: '/chat/completions', modelsMethod: 'GET' },
  // 原生 Messages 接口：请求体需 max_tokens、system 独立成字段、响应结构也不同，
  // 直接转发 OpenAI 格式必然 400。保留此项仅供自建了转换层的场景使用。
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
    // 必须校验模型归属，否则 provider:xxx/任意model 可绕过模型白名单定向消耗 Key
    if (p && p.enabled && p.models.some((m) => m.id === model)) return p
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
  const enabled = provider.keys.filter((k) => k.enabled)
  const fresh = enabled.filter((k) => !k.cooldown_until || k.cooldown_until <= now)
  if (fresh.length > 0) return fresh

  // 全部处于冷却：放行冷却进度过半的一个 Key 做半开探测。
  // 没有这个机制时，一次上游抖动把所有 Key 冻住后，
  // 必须等满冷却时间才可能恢复，哪怕上游早就好了。
  const probing = enabled
    .filter((k) => {
      const start = k.cooldown_at || k.cooldown_until
      return now >= start + (k.cooldown_until - start) / 2
    })
    .sort((a, b) => a.cooldown_until - b.cooldown_until)
  return probing.slice(0, 1)
}

function applyCooldown(provider, key, status) {
  const now = Date.now()
  let ms = COOLDOWN_MS[status] || COOLDOWN_MS.network

  // 5xx/429 通常是平台抖动而不是 Key 失效：
  // 若已有半数以上 Key 处于冷却，把冷却压到 5 秒，保证始终有 Key 可用
  if (UPSTREAM_LEVEL_STATUS.has(status) && provider?.keys?.length > 1) {
    const cooling = provider.keys.filter((k) => k.enabled && k.cooldown_until && k.cooldown_until > now).length
    if (cooling >= Math.ceil(provider.keys.length / 2)) ms = Math.min(ms, UPSTREAM_CROWD_COOLDOWN_MS)
  }

  key.cooldown_at = now
  key.cooldown_ms = ms
  key.cooldown_until = now + ms
  key.last_error = status === 'network' ? '网络错误' : `HTTP ${status}`
  key.last_error_at = now
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
    const controller = new AbortController()
    let timer = null
    try {
      timer = setTimeout(() => controller.abort(), 60000)
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
        applyCooldown(provider, key, resp.status)
      }
    } catch (err) {
      if (timer) clearTimeout(timer)
      lastError = err.name === 'AbortError' ? '请求超时' : `网络错误: ${err.message}`
      applyCooldown(provider, key, 'network')
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
  const controller = new AbortController()
  let timer = null
  try {
    timer = setTimeout(() => controller.abort(), 30000)
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
    if (timer) clearTimeout(timer)
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
  let deltaText = ''
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
      // 累积输出文本，供上游不返回 usage 时估算 token
      const delta = json.choices?.[0]?.delta
      if (delta) {
        if (typeof delta.content === 'string') deltaText += delta.content
        if (typeof delta.reasoning_content === 'string') deltaText += delta.reasoning_content
      }
      if (json.type === 'content_block_delta' && typeof json.delta?.text === 'string') {
        deltaText += json.delta.text
      }
    } catch { /* skip partial */ }
  }
  return { rest, lastUsageData, sawTerminator, deltaText }
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
  // 记录实际使用的 Key 名称，供日志使用（不再通过响应头暴露给客户端）
  let usedKeyName = null
  const totalTimeoutMs = body?.stream ? STREAM_TOTAL_TIMEOUT_MS : JSON_TOTAL_TIMEOUT_MS
  const upstreamBody = kind === 'chat' ? JSON.stringify(withUsageOption(provider, body)) : undefined
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[(startIdx + i) % keys.length]
    const upstream = joinUrl(provider.base_url, path, queryAuth(plan, key.api_key))
    const controller = new AbortController()
    let timer = null
    try {
      // 连接与等待响应头阶段用短超时：上游半开连接时快速失败并切换 Key，
      // 而不是让客户端挂到总时长超时（此前为 30 分钟）
      timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
      const resp = await fetch(upstream, {
        method: kind === 'chat' ? 'POST' : plan.modelsMethod,
        headers: buildHeaders(provider, plan, key.api_key),
        body: upstreamBody,
        signal: controller.signal
      })
      // 已收到响应头，改为总时长超时，长推理模型的持续输出不受影响
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), totalTimeoutMs)
      if (RETRYABLE_STATUS.has(resp.status)) {
        attempts.push(`${key.name || key.id.slice(0, 8)}: HTTP ${resp.status}`)
        applyCooldown(provider, key, resp.status)
        bumpFailover()
        await resp.body?.cancel()
        // 429 限流时稍作等待再切换，避免瞬时打爆上游、放大限流
        if (resp.status === 429) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      started = true
      usedKeyName = key.name || key.id.slice(0, 8)
      res.status(resp.status)
      const contentType = resp.headers.get('content-type') || ''
      const safeContentType = safeHeaderValue(contentType)
      if (safeContentType) res.setHeader('Content-Type', safeContentType)
      const isStream = resp.body && contentType.toLowerCase().includes('text/event-stream')
      if (isStream) {
        const reader = resp.body.getReader()
        const textDecoder = new TextDecoder()
        let lastUsageData = null
        let sseBuffer = ''
        let streamedText = ''
        let clientClosed = false
        let idleTimedOut = false
        const lastActivity = { t: Date.now() }

        const onClientClose = () => {
          clientClosed = true
          controller.abort()
        }
        res.on('close', onClientClose)

        const watcher = setInterval(() => {
          const idle = Date.now() - lastActivity.t
          if (idle >= STREAM_IDLE_TIMEOUT_MS) {
            idleTimedOut = true
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
              lastActivity.t = Date.now()
              // 背压处理：缓冲区满时等待 drain，避免慢客户端导致内存无限堆积
              if (!res.write(value)) {
                await new Promise((resolve) => {
                  const onDrain = () => { cleanup(); resolve() }
                  const onClose = () => { cleanup(); resolve() }
                  const cleanup = () => {
                    res.removeListener('drain', onDrain)
                    res.removeListener('close', onClose)
                  }
                  res.once('drain', onDrain)
                  res.once('close', onClose)
                })
              }
            }
            sseBuffer += textDecoder.decode(value, { stream: true })
            // 防御：单行超长（>1MB 无换行）时丢弃，避免缓冲区无限增长
            if (sseBuffer.length > 1024 * 1024) sseBuffer = ''
            const parsed = parseSseUsage(sseBuffer)
            sseBuffer = parsed.rest
            if (parsed.lastUsageData) lastUsageData = parsed.lastUsageData
            if (parsed.deltaText) streamedText += parsed.deltaText
          }
        } catch (err) {
          const isClientAbort =
            clientClosed ||
            err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            err.code === 'ERR_STREAM_DESTROYED'
          // 空闲超时是主动 abort，不算 Key 的网络错误，不应触发冷却
          if (!isClientAbort && !idleTimedOut) {
            applyCooldown(provider, key, 'network')
            markResult(provider.id, false)
          }
          if (!res.writableEnded) res.end()
          return {
            ok: false,
            keyName: usedKeyName,
            error: idleTimedOut
              ? '上游长时间无数据（空闲超时，已断开）'
              : err.name === 'AbortError' ? '上游请求超时或长时间无响应' : `流式转发中断: ${err.message}`
          }
        } finally {
          clearInterval(watcher)
          res.removeListener('close', onClientClose)
          reader.cancel().catch(() => {})
        }
        if (!res.writableEnded) res.end()
        // 流式数据完整读完即视为成功（部分上游不发送 [DONE]/message_stop 终止符）
        markResult(provider.id, true)
        const reported = lastUsageData ? extractTokenCount(lastUsageData) : null
        if (reported != null && reported > 0) {
          bumpTokens(provider.id, reported)
          return { ok: true, keyName: usedKeyName, tokens: reported, tokensEstimated: false }
        }
        // 上游不返回 usage 时按输出长度估算，避免仪表盘 Token 统计系统性偏低
        const estimated = estimateTokens(streamedText)
        if (estimated > 0) bumpTokens(provider.id, estimated)
        return { ok: true, keyName: usedKeyName, tokens: estimated, tokensEstimated: estimated > 0 }
      }
      if (resp.body) {
        let text
        try {
          text = await readJsonBody(resp, JSON_TOTAL_TIMEOUT_MS, controller)
        } catch (err) {
          const msg = err.name === 'AbortError' ? '上游响应超时' : `上游读取失败: ${err.message}`
          attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
          applyCooldown(provider, key, 'network')
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
      return { ok: true, keyName: usedKeyName }
    } catch (err) {
      const msg = err.name === 'AbortError' ? '上游请求超时' : `网络错误: ${err.message}`
      if (started) {
        applyCooldown(provider, key, 'network')
        if (!res.writableEnded) res.end()
        markResult(provider.id, false)
        return { ok: false, keyName: usedKeyName, error: msg }
      }
      attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
      applyCooldown(provider, key, 'network')
      bumpFailover()
    } finally {
      // 所有退出路径（含流式成功返回）都要清理超时定时器。
      // 此前流式成功时不会走到 catch，定时器会一直挂到 30 分钟超时为止。
      if (timer) clearTimeout(timer)
    }
  }
  markResult(provider.id, false)
  respondJson(res, 502, { error: { message: `所有 Key 均请求失败（已自动切换 ${attempts.length} 次）：${attempts.join('；')}`, type: 'all_keys_failed' } })
  return { ok: false, error: `所有 Key 均请求失败（已自动切换 ${attempts.length} 次）：${attempts.join('；')}` }
}
// HTTP 响应头值只允许 ASCII 可见字符（不含 CR/LF），过滤中文等非法字符避免 ERR_INVALID_CHAR
function safeHeaderValue(value) {
  if (value == null) return ''
  return String(value).replace(/[^\x20-\x7E]/g, '')
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
    key: result.keyName || undefined,
    duration_ms: Date.now() - startTime,
    tokens: result.tokens || undefined,
    tokens_estimated: result.tokensEstimated ? true : undefined,
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
