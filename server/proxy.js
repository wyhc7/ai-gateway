import { state, getProvider, bumpStats, bumpFailover, markResult, bumpTokens, persist, persistImmediate } from './store.js'
import { addLog } from './logger.js'
import { ensureAccessToken, XAI_OAUTH_BASE_URL } from './oauth.js'
import { ensureAccessToken as ensureCodexToken } from './codex-oauth.js'
import { toCodexRequest, fromCodexResponse, createCodexStreamTransformer, codexAccountHeader } from './codex-responses.js'
import { TEMPLATES } from './templates.js'

// 允许「协议级默认模型」兜底的协议白名单。
//
// 判据不是"模板里有没有写 default_models"，而是"这个协议的上游到底有没有 /models 端点"：
// 只有协议本身指向单一固定服务（同协议 = 同上游 = 同批模型）时，
// 一份内置列表才对该协议下的所有平台都成立。
//
// openai-chat 绝不能进这个名单：它是通用兼容协议，DeepSeek / 通义 / Gemini / Ollama
// 都挂在这个协议下而模型毫无交集。曾因 chatgpt-web 模板自带 default_models，
// 导致所有 openai-chat 平台在拉模型失败时被静默兜底成 gpt-5 / gpt-image-2
// （表现为「拉取成功」但列表完全不对，用户只会以为是自己的 Key 坏了）。
// 标准协议就该老实报错，不能用别人的模型凑数。
const PROTOCOLS_WITHOUT_MODELS_ENDPOINT = new Set(['grok-oauth', 'codex-oauth'])

// 订阅类上游（Grok 的 cli-chat-proxy、Codex 的 chatgpt.com/backend-api）
// 没有干净的 GET /models，拉取失败时回退到模板内置的默认模型列表，保证平台建完即可用。
export function defaultModelsFor(protocol) {
  if (!PROTOCOLS_WITHOUT_MODELS_ENDPOINT.has(protocol)) return null
  for (const t of TEMPLATES) {
    if (t.protocol === protocol && Array.isArray(t.default_models) && t.default_models.length) {
      return t.default_models.map((id) => ({ id, owned_by: t.name }))
    }
  }
  return null
}

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

// 心跳发送条件：上游空闲超过心跳间隔，并且距离上次心跳也超过心跳间隔。
// 第二个条件防止"每检查一次就发一次"的重复刷心跳——这正是此前日志里
// 30 秒空闲后每 5 秒狂发 keep-alive、白白占用带宽的根因。
export function shouldSendHeartbeat({ idleMs, sinceLastHeartbeatMs, heartbeatIntervalMs }) {
  return idleMs >= heartbeatIntervalMs && sinceLastHeartbeatMs >= heartbeatIntervalMs
}

// 空闲检查的间隔取心跳间隔的一半，否则心跳的实际发出时间会被检查周期拖后；
// 心跳较长时不必过于频繁地唤醒（上限 5 秒一次），配置得很小时也有下限保护（0.5 秒）。
export function heartbeatTickInterval(heartbeatIntervalMs) {
  return Math.min(5000, Math.max(500, Math.floor(heartbeatIntervalMs / 2)))
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
// 读取毫秒配置：非法值（非数字、0、负数）一律回退到默认值
function toMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const CONNECT_TIMEOUT_MS = toMs(process.env.CONNECT_TIMEOUT_MS, 30000)
const STREAM_TOTAL_TIMEOUT_MS = toMs(process.env.STREAM_TOTAL_TIMEOUT_MS, 1800000)
const JSON_TOTAL_TIMEOUT_MS = toMs(process.env.JSON_TOTAL_TIMEOUT_MS, 120000)
// 非流式长任务（大 max_tokens）的时间预算：固定 2 分钟护栏会掐断真正想写长文的请求。
// 按每个 token 预留 40ms（约 25 tok/s，flash 模型保守下限）推算生成时长，
// 上限封顶到流式的 30 分钟。短请求仍受 2 分钟护栏保护，避免挂死的连接久拖不决。
const JSON_LONG_MS_PER_TOKEN = 40

// 生图（/images/generations）与对话不是同一量级：gpt-image-2 这类模型实测要 30~90 秒，
// 叠加排队可能更久。沿用对话侧的 2 分钟护栏会在图片快生成完时把连接掐断，
// 客户端只看到一次毫无信息的 502。单独给 5 分钟预算，并允许环境变量覆盖。
const IMAGES_TOTAL_TIMEOUT_MS = toMs(process.env.IMAGES_TOTAL_TIMEOUT_MS, 300000)

// 计算一次请求的总时长预算；导出便于测试
export function jsonTotalTimeout(maxTokens, stream) {
  if (stream) return STREAM_TOTAL_TIMEOUT_MS
  const byTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens * JSON_LONG_MS_PER_TOKEN : 0
  return Math.min(STREAM_TOTAL_TIMEOUT_MS, Math.max(JSON_TOTAL_TIMEOUT_MS, byTokens))
}
// 心跳间隔必须小于链路上最短空闲超时的一半，否则中间设备会先于网关切断连接。
// Nginx 默认 proxy_read_timeout 为 60 秒，这里取 15 秒留足余量。
const SSE_HEARTBEAT_INTERVAL_MS = toMs(process.env.SSE_HEARTBEAT_INTERVAL_MS, 15000)
// 上游多久没有数据就判定流已死。推理模型的思考阶段可能几分钟不发任何内容，
// 默认放宽到 10 分钟，避免长思考被误杀。
const STREAM_IDLE_TIMEOUT_MS = toMs(process.env.STREAM_IDLE_TIMEOUT_MS, 600000)
// 背压等待上限：客户端长期不消费时不能无限等待，
// 否则上游的发送缓冲一直堵着，最终会被上游主动断开
const BACKPRESSURE_MAX_WAIT_MS = toMs(process.env.BACKPRESSURE_MAX_WAIT_MS, 60000)
// 所有 Key 都在冷却时，最多等这么久再放弃。多数冷却源自 429 限流，几秒内即恢复，
// 直接拒绝会让用户看到请求失败，等一小会儿通常就能拿到可用的 Key。
const COOLDOWN_WAIT_MAX_MS = toMs(process.env.COOLDOWN_WAIT_MAX_MS, 10000)

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
  'openai-chat': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' },
  'openai-responses': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/responses', imagesPath: '/images/generations', modelsMethod: 'GET' },
  // Anthropic 官方的 OpenAI 兼容端点：鉴权仍是 x-api-key，但请求与响应都是 OpenAI 格式，可直接透传
  'anthropic-openai': { auth: 'anthropic', authHeader: 'x-api-key', authPrefix: '', modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' },
  // 原生 Messages 接口：请求体需 max_tokens、system 独立成字段、响应结构也不同，
  // 直接转发 OpenAI 格式必然 400。保留此项仅供自建了转换层的场景使用。
  'anthropic': { auth: 'anthropic', authHeader: 'x-api-key', authPrefix: '', modelsPath: '/models', chatPath: '/messages', imagesPath: '/images/generations', modelsMethod: 'GET' },
  // Grok 订阅账号（OAuth 凭据）：上游是 CLI chat proxy，接口形态仍是 OpenAI 兼容，
  // 与 api.x.ai 的区别只在鉴权来源——一个是订阅，一个是按量 API Key。
  'grok-oauth': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' },
  // Codex 订阅账号（ChatGPT Plus/Pro 的 OAuth 凭据）：上游是 Responses API，
  // 请求体用 input[]、响应体用 output[]，与 chat/completions 不同，需要转换层。
  'codex-oauth': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/responses', imagesPath: '/images/generations', modelsMethod: 'GET' },
  'custom': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' }
}

// 走 Responses API 的协议：请求/响应都需要在 chat/completions 与 Responses 之间转换
export function isResponsesProtocol(protocol) {
  return protocol === 'codex-oauth'
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
    imagesPath: provider.images_path || proto.imagesPath,
    modelsPath: provider.models_path || proto.modelsPath,
    modelsMethod: String(provider.models_method || proto.modelsMethod).toUpperCase()
  }
}

const roundRobin = new Map()

const EXTRA_HEADERS = {
  'x-ai': {},
  'openrouter.ai': { 'HTTP-Referer': 'https://local.ai-gateway.dev', 'X-Title': 'AI Gateway' },
  // cli-chat-proxy.grok.com 校验客户端版本，不带 x-grok-client-version 会拒绝请求
  'cli-chat-proxy.grok.com': { 'x-grok-client-version': '0.1.202', 'x-grok-client-surface': 'grok-cli' }
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

export function autoHeaders(provider) {
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

function buildHeaders(provider, plan, apiKey, key = null) {
  const headers = { 'Content-Type': 'application/json', ...autoHeaders(provider) }
  // Codex 上游要求每个账号带上自己的 ChatGPT-Account-Id，值随 Key 变化，
  // 因此不能放进平台级的 extra_headers，只能在选定 Key 之后按 Key 注入
  if (isResponsesProtocol(provider.protocol) && key) {
    Object.assign(headers, codexAccountHeader(key))
  }
  for (const [k, v] of Object.entries(provider.extra_headers || {})) {
    if (k && v) headers[k] = v
  }
  Object.assign(headers, authHeaders(plan, apiKey))
  if (plan.auth === 'anthropic' && !headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

// 发给上游的请求体。走 Responses 的协议（Codex）需要把 chat/completions
// 结构转成 input[]/instructions，其余协议原样透传。
// 抽成函数是因为 400 重试时要按可能被收敛过的 max_tokens 重新序列化。
function serializeUpstreamBody(provider, body) {
  const payload = withUsageOption(provider, body)
  return JSON.stringify(
    isResponsesProtocol(provider.protocol) ? toCodexRequest(payload) : payload
  )
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

// OAuth 账号的凭据会过期（xAI 的 access_token 寿命约 6 小时），
// 发请求前必须确认它还有效，否则上游只回一个无从分辨的 401。
// 刷新成功立刻落盘——进程重启后拿已失效的 token 去撞墙没有意义。
// 抛错代表这个账号当前不可用，调用方应冷却它并切下一个。
export async function resolveKeyToken(key) {
  if (!key || key.type !== 'oauth') return key?.api_key
  // Grok 与 Codex 的 OAuth 端点、参数、凭据字段都不同，
  // 按凭据自带的 provider 标记分流（导入/授权时写入）
  const ensure = key.provider === 'codex' ? ensureCodexToken : ensureAccessToken
  const { credential, refreshed } = await ensure(key)
  if (refreshed) {
    Object.assign(key, credential)
    persistImmediate()
  }
  return key.access_token
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
    let token
    try {
      token = await resolveKeyToken(key)
    } catch (err) {
      lastError = `凭据刷新失败：${err.message}`
      continue
    }
    const url = joinUrl(provider.base_url, plan.modelsPath, queryAuth(plan, token))
    const controller = new AbortController()
    let timer = null
    try {
      timer = setTimeout(() => controller.abort(), 60000)
      const resp = await fetch(url, {
        method: plan.modelsMethod,
        headers: buildHeaders(provider, plan, token, key),
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
  // 全部 Key 均不可用：若该协议有内置默认模型（Grok 订阅账号常见），
  // 退回默认列表并标注来源，避免平台因为拉不到 /models 而完全不可用。
  const fallback = defaultModelsFor(provider.protocol)
  if (fallback && fallback.length) {
    provider.models = fallback
    provider.models_updated_at = Date.now()
    provider.models_source = 'default'
    persistImmediate()
    return { ok: true, count: fallback.length, provider, fallback: true }
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
      // 上游没有 /models 时回退到内置默认列表（Grok 订阅账号常见这种情况）
      const fallback = defaultModelsFor(target.protocol)
      if (fallback) return { ok: true, models: fallback, fallback: true }
      const hint = previewHint(resp.status)
      return { ok: false, error: `拉取失败：HTTP ${resp.status}${hint}` }
    }
    const data = await resp.json()
    const models = (data.data || []).map((m) => ({ id: m.id, owned_by: m.owned_by || m.display_name || '' }))
    return { ok: true, models }
  } catch (err) {
    if (timer) clearTimeout(timer)
    const fallback = defaultModelsFor(target.protocol)
    if (fallback) return { ok: true, models: fallback, fallback: true }
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

// 距离最早可作半开探测的 Key 还有多久（毫秒）。
// usableKeys 允许冷却过半后放行探测，所以这里算的是"冷却过半"而不是"冷却结束"。
function nextProbeDelay(provider) {
  const now = Date.now()
  let best = Infinity
  for (const k of provider.keys) {
    if (!k.enabled) continue
    const until = k.cooldown_until || 0
    if (until <= now) return 0
    const start = k.cooldown_at || until
    const delay = Math.max(start + (until - start) / 2 - now, 0)
    if (delay < best) best = delay
  }
  return best === Infinity ? 0 : Math.ceil(best)
}

async function forwardWithFailover(provider, kind, body, res) {
  let keys = usableKeys(provider)

  // 所有 Key 都在冷却时，与其立刻返回 503 让用户看到"输出断了"，
  // 不如等最早的那个解锁。线上日志显示这类失败几乎全部来自 429 限流，
  // 而限流通常在几秒内就恢复，直接拒绝非常可惜。
  if (keys.length === 0) {
    const delay = nextProbeDelay(provider)
    if (delay > 0 && delay <= COOLDOWN_WAIT_MAX_MS) {
      await new Promise((r) => setTimeout(r, delay + 50))
      keys = usableKeys(provider)
    }
  }

  if (keys.length === 0) {
    const waitMs = nextProbeDelay(provider)
    const hint = waitMs > 0 ? `，约 ${Math.ceil(waitMs / 1000)} 秒后恢复` : ''
    markResult(provider.id, false)
    respondJson(res, 503, {
      error: {
        message: `该平台没有可用的 Key（全部处于冷却状态${hint}）`,
        type: 'no_keys',
        retry_after_ms: waitMs > 0 ? waitMs : undefined
      }
    })
    return { ok: false, error: `该平台没有可用的 Key（全部处于冷却状态${hint}）` }
  }
  const plan = callPlan(provider)
  const path = kind === 'chat' ? plan.chatPath : kind === 'images' ? plan.imagesPath : plan.modelsPath
  const startIdx = nextRoundRobin(provider.id, keys)
  const attempts = []
  let started = false
  // 记录实际使用的 Key 名称，供日志使用（不再通过响应头暴露给客户端）
  let usedKeyName = null
  // 生图不走对话的时间预算：图片生成动辄几十秒甚至数分钟，
  // 用 token 数推算时长对它毫无意义，直接给独立的固定预算。
  const totalTimeoutMs = kind === 'images' ? IMAGES_TOTAL_TIMEOUT_MS : jsonTotalTimeout(body?.max_tokens, body?.stream)
  // 生图的请求体就是客户端原样发来的 OpenAI 生图参数（prompt / size / n 等），
  // 不需要像对话那样做协议转换（Responses ↔ chat/completions），原样透传即可。
  let upstreamBody = kind === 'chat' ? serializeUpstreamBody(provider, body) : kind === 'images' ? JSON.stringify(body) : undefined
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[(startIdx + i) % keys.length]
    // OAuth 账号：发请求前确认 access_token 有效。刷新失败不算请求失败，
    // 冷却这个账号后换下一个——用户看到的是正常切换，而不是一次凭空的报错。
    let token
    try {
      token = await resolveKeyToken(key)
    } catch (err) {
      attempts.push(`${key.name || key.id.slice(0, 8)}: 凭据刷新失败（${err.message}）`)
      applyCooldown(provider, key, 401)
      bumpFailover()
      continue
    }
    const upstream = joinUrl(provider.base_url, path, queryAuth(plan, token))
    const controller = new AbortController()
    let timer = null
    try {
      // 连接与等待响应头阶段用短超时：上游半开连接时快速失败并切换 Key，
      // 而不是让客户端挂到总时长超时（此前为 30 分钟）
      timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
      const resp = await fetch(upstream, {
        method: kind === 'chat' || kind === 'images' ? 'POST' : plan.modelsMethod,
        headers: buildHeaders(provider, plan, token, key),
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
      // 400 也可能是上游处理中途的瞬时失败：线上日志曾观察到一条 5.7 秒后才返回
      // 400 的请求（若参数错误会在 1 秒内立刻拒绝），周围同一 Key 的请求全部 200。
      // 给一次切换其他 Key 重试的机会，让瞬时抖动无感恢复；真正的坏请求重试后
      // 仍会 400 并以原状态透传，不影响客户端感知。400 不视为 Key 的问题，不冷却。
      //
      // 特殊情形：不同模型的 max_tokens 上限不同（商汤 65536，有的模型更小），
      // 65536 的统一收敛可能仍超个别模型上限。若上游 400 报错里带范围
      // （"should be in [1, N]"），按该范围重新收敛 max_tokens 后再重试一次。
      if (resp.status === 400 && attempts.length < 1) {
        let clamped = null
        try {
          let readTimer
          const text = await Promise.race([
            resp.text(),
            new Promise((_, rej) => { readTimer = setTimeout(() => rej(new Error('读取错误体超时')), 5000) })
          ]).finally(() => clearTimeout(readTimer))
          const m = text?.match(/should be in\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/)
          const cur = body?.max_tokens
          if (m && Number.isFinite(cur)) {
            clamped = Math.min(Math.max(Math.floor(cur), +m[1]), +m[2])
            if (clamped !== cur) body.max_tokens = clamped
          }
        } catch { /* 读不到错误体则按普通瞬时 400 重试 */ }
        if (clamped != null) {
          console.warn(`[max_tokens 自适应] 模型 ${body?.model} 上限 ${clamped}，按上游报错范围收敛后重试`)
          // upstreamBody 在循环外已序列化，这里要重新生成，否则重试仍带上旧值
          upstreamBody = kind === 'chat' ? serializeUpstreamBody(provider, body) : kind === 'images' ? JSON.stringify(body) : undefined
        }
        attempts.push(`${key.name || key.id.slice(0, 8)}: HTTP 400${clamped != null ? '（max_tokens 收敛后重试）' : '（瞬时重试）'}`)
        bumpFailover()
        continue
      }
      started = true
      usedKeyName = key.name || key.id.slice(0, 8)
      // 诊断用：把上游非 2xx 的真实错误体打到日志，便于定位 4xx 透传问题
      if (resp.status < 200 || resp.status >= 300) {
        const _ct = (resp.headers.get('content-type') || '').toLowerCase()
        const _m = body?.model || provider?.id
        if (!_ct.includes('text/event-stream')) {
          resp.clone().text().then((b) => console.error(`[上游错误体] status=${resp.status} model=${_m} body=${b.slice(0, 600)}`)).catch(() => {})
        } else {
          console.error(`[上游错误体] status=${resp.status} model=${_m} (流式，错误体已在响应中透传)`)
        }
      }
      res.status(resp.status)
      const contentType = resp.headers.get('content-type') || ''
      const safeContentType = safeHeaderValue(contentType)
      if (safeContentType) res.setHeader('Content-Type', safeContentType)
      const isStream = resp.body && contentType.toLowerCase().includes('text/event-stream')
      if (isStream) {
        // 关掉中间层的响应缓冲：Nginx 的 proxy_buffering 默认开启，会把流式响应攒在
        // 缓冲区里——短回答能整体送达，长回答则被延迟甚至截断，表现就是"只有长回答会断"。
        // X-Accel-Buffering 是 Nginx 的标准开关，链路上没有 Nginx 时完全无害。
        // no-transform 同时阻止中间设备对响应做压缩等改写。
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        const reader = resp.body.getReader()
        const textDecoder = new TextDecoder()
        let lastUsageData = null
        let sseBuffer = ''
        let streamedText = ''
        let clientClosed = false
        let idleTimedOut = false
        const lastActivity = { t: Date.now() }
        let lastHeartbeat = Date.now()
        // Codex 上游发的是 response.* 事件流，客户端看不懂，必须逐事件转成
        // chat.completion.chunk。非 Responses 协议不走转换，保持原样零开销透传。
        const transformer =
          isResponsesProtocol(provider.protocol) && kind === 'chat'
            ? createCodexStreamTransformer(body?.model || '')
            : null

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
          // 心跳只是为了让中间设备与客户端知道连接还活着，按固定间隔发一次即可。
          // 此前没有间隔判断，一旦闲置超过阈值就会每 5 秒重复发送，白白占用带宽。
          if (!res.writableEnded &&
              shouldSendHeartbeat({
                idleMs: idle,
                sinceLastHeartbeatMs: Date.now() - lastHeartbeat,
                heartbeatIntervalMs: SSE_HEARTBEAT_INTERVAL_MS
              })) {
            lastHeartbeat = Date.now()
            try { res.write(': keep-alive\n\n') } catch { /* socket 已关闭 */ }
          }
          // 检查间隔取心跳间隔的一半，否则心跳的实际发出时间会被检查周期拖后
        }, heartbeatTickInterval(SSE_HEARTBEAT_INTERVAL_MS))
        if (watcher.unref) watcher.unref()

        // 背压处理：缓冲区满时等待 drain，避免慢客户端导致内存无限堆积。
        // 但等待必须有上限——无限等待会让上游的发送缓冲一直堵着，
        // 直到上游判定超时主动断开，这正是长回答中途断流的成因之一。
        const writeChunk = async (chunk) => {
          if (res.write(chunk)) return
          await new Promise((resolve) => {
            let settled = false
            const guard = setTimeout(finish, BACKPRESSURE_MAX_WAIT_MS)
            function finish() {
              if (settled) return
              settled = true
              clearTimeout(guard)
              res.removeListener('drain', finish)
              res.removeListener('close', finish)
              resolve()
            }
            res.once('drain', finish)
            res.once('close', finish)
          })
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (transformer) {
              // Responses 事件 → chat.completion.chunk。chunk 与事件边界不对齐，
              // 转换器内部按空行切分，没凑齐时返回空串，这里自然跳过写出。
              const converted = transformer.push(textDecoder.decode(value, { stream: true }))
              if (converted) {
                lastActivity.t = Date.now()
                await writeChunk(converted)
              }
              continue
            }
            if (value && value.byteLength > 0) {
              lastActivity.t = Date.now()
              await writeChunk(value)
            }
            sseBuffer += textDecoder.decode(value, { stream: true })
            // 防御：单行超长（>1MB 无换行）时丢弃，避免缓冲区无限增长
            if (sseBuffer.length > 1024 * 1024) sseBuffer = ''
            const parsed = parseSseUsage(sseBuffer)
            sseBuffer = parsed.rest
            if (parsed.lastUsageData) lastUsageData = parsed.lastUsageData
            if (parsed.deltaText) streamedText += parsed.deltaText
          }
          // 上游结束时把缓冲里最后一个事件吐出来，并补上 [DONE]，
          // 否则客户端会一直挂着等终止标记
          if (transformer) {
            const tail = transformer.flush()
            streamedText = transformer.streamedText
            if (tail) await writeChunk(tail)
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
          // 用本次请求的总预算读取响应体：对话的非流式分支两者本就相等，
          // 而生图必须用自己的 5 分钟预算，否则会被对话的 2 分钟护栏截断。
          text = await readJsonBody(resp, totalTimeoutMs, controller)
        } catch (err) {
          const msg = err.name === 'AbortError' ? '上游响应超时' : `上游读取失败: ${err.message}`
          attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
          applyCooldown(provider, key, 'network')
          bumpFailover()
          continue
        }
        // Responses 协议的响应体是 output[]，客户端按 chat/completions 解析会拿不到内容，
        // 这里转一次。转换失败（比如上游返回的是错误体）就原样透传，别把报错吞掉。
        let respondText = text
        if (isResponsesProtocol(provider.protocol) && kind === 'chat') {
          try {
            respondText = JSON.stringify(fromCodexResponse(JSON.parse(text), body?.model || ''))
          } catch { /* 非预期结构，原样透传 */ }
        }
        if (!res.writableEnded) res.end(respondText)
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

// 商汤等上游的 max_tokens 有硬性上限（实测报错：should be in [1, 65536]）。
// 客户端可能发送 0（表示"不限"）、负数、非整数或远大于上限的值（例如想要超长输出），
// 上游会直接 400 拒绝整次调用。网关在转发前收敛到合法范围：
// - 非法（<1 / 非数字）→ 删除，交给上游用默认值
// - 超上限 → 压到 65536，保留"想要长输出"的意图
function sanitizeMaxTokens(body) {
  const v = body?.max_tokens
  if (v == null) return
  if (!Number.isFinite(v) || v < 1) {
    delete body.max_tokens
    console.warn(`[max_tokens 收敛] 非法值 ${v} 已移除，交由上游使用默认值`)
    return
  }
  const clamped = Math.min(Math.floor(v), 65536)
  if (clamped !== v) {
    body.max_tokens = clamped
    console.warn(`[max_tokens 收敛] ${v} -> ${clamped}（上游上限 65536）`)
  }
}

export async function handleChat(req, res) {
  const { model, providerIdHint, body } = resolveTarget(req.body)
  sanitizeMaxTokens(body)
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

// 生图接口：与 handleChat 同构——按 model 找平台、挑 Key、透传 OpenAI 生图协议。
// 差异只有三点：走 imagesPath、请求体原样透传、时间预算更长（见 forwardWithFailover）。
// 之所以单独开一个入口而不是复用 chat，是因为生图的鉴权/冷却/故障切换规则完全一致，
// 但协议转换（Responses ↔ chat/completions）对它不适用，参数一个字都不该改。
export async function handleImages(req, res) {
  const { model, providerIdHint, body } = resolveTarget(req.body)
  const provider = matchProvider(model, providerIdHint)
  bumpStats(provider?.id)
  const startTime = Date.now()
  const baseLog = {
    type: 'images',
    method: 'POST',
    path: '/api/v1/images/generations',
    model,
    provider_id: provider?.id || null,
    provider_name: provider?.name || null
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
  const result = await forwardWithFailover(provider, 'images', body, res)
  addLog({
    ...baseLog,
    status: res.statusCode || (result.ok ? 200 : 502),
    ok: result.ok,
    key: result.keyName || undefined,
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
