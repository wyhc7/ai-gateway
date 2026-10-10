import { state, getProvider, bumpStats, bumpFailover, markResult, bumpTokens, persist, persistImmediate } from './store.js'
import { addLog } from './logger.js'
import { modelAllowed, filterModelsForAuth, recordUsage } from './api-keys.js'
import { ensureAccessToken, refreshAccessToken, XAI_OAUTH_BASE_URL } from './oauth.js'
import { ensureAccessToken as ensureCodexToken, refreshAccessToken as refreshCodexToken } from './codex-oauth.js'
import { ensureWorkbuddyToken, refreshWorkbuddyToken } from './workbuddy-oauth.js'
import { toCodexRequest, fromCodexResponse, createCodexStreamTransformer, codexAccountHeader } from './codex-responses.js'
import { TEMPLATES } from './templates.js'
import { isWorkbuddyProtocol, workbuddyHeaders, workbuddyChatBaseFor, shapeWorkbuddyBody, WORKBUDDY_CURATED_MODELS } from './workbuddy-lane.js'
import {
  isZenProtocol,
  buildZenHeaders,
  shapeZenBody,
  createZenStreamTransformer,
  aggregateZenSse,
  zenToolNameMap,
  ZEN_FREE_MODELS,
  isZenFreeCandidate,
  isDefinitiveZenRejection,
  ZEN_PROBE_TTL_MS,
  ZEN_MAX_PROBES,
  ZEN_PROBE_CONCURRENCY,
  ZEN_PROBE_TIMEOUT_MS,
  ZEN_PROBE_RETRY_DELAY_MS
} from './zen-lane.js'

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
// 上游那个 modelsPath 不能按 OpenAI 形态直接调的协议。
// - grok-oauth / codex-oauth：根本没有可用的 GET /models
// - workbuddy-oauth：路径存在，但返回 {code,msg,data} 信封且会漏报隐藏模型
// 名义上是「没有可用列表」，行为上都只能走内置清单兜底，所以归在同一个集合里。
const PROTOCOLS_WITHOUT_MODELS_ENDPOINT = new Set(['grok-oauth', 'codex-oauth', 'workbuddy-oauth'])

// 上游有 /models、但那份列表不可信的协议。
//
// OpenCode Zen 免费档正是如此：/models 会把付费模型一并列出，而付费模型用公共凭据
// 调用一律 401。可用模型清单只能由白名单决定，不能由上游列表决定。
// 判据是"列表不可信"而不是"没有列表"，所以单独一个集合，不要合并到上面那个。
const PROTOCOLS_WITH_CURATED_MODELS = new Set(['zen-free'])

// 订阅类上游（Grok 的 cli-chat-proxy、Codex 的 chatgpt.com/backend-api）没有干净的
// GET /models；免费通道的 /models 不可信。两者都靠下面这份内置列表兜底。
//
// 订阅接入方案已经整体下线，TEMPLATES 里不再有 grok-oauth / codex-oauth 条目，
// 因此这两个协议现在查不到兜底、返回 null——这是预期，不是漏改。
// 只有 zen-free 还命中（它仍在 TEMPLATES 里）。
// 协议自带、且与模板无关的模型清单。
// WorkBuddy 的 19 个模型属于这一类：它们是该协议对上游的事实描述，
// 不随用户怎么建平台而变，挂在模板上反而多一层查不到的风险。
const PROTOCOL_CURATED_MODELS = {
  'workbuddy-oauth': WORKBUDDY_CURATED_MODELS
}

export function defaultModelsFor(protocol) {
  if (PROTOCOL_CURATED_MODELS[protocol]) return PROTOCOL_CURATED_MODELS[protocol].map((m) => ({ ...m }))
  if (!PROTOCOLS_WITHOUT_MODELS_ENDPOINT.has(protocol) && !PROTOCOLS_WITH_CURATED_MODELS.has(protocol)) return null
  for (const t of TEMPLATES) {
    if (t.protocol === protocol && Array.isArray(t.default_models) && t.default_models.length) {
      return t.default_models.map((id) => ({ id, owned_by: t.name }))
    }
  }
  return null
}

function extractTokenCount(usage) {
  if (!usage) return null
  // 优先取 total；但 total 为 0（或缺失）时不能直接返回 0——
  // 0 会被当作「已返回 usage」，既不会走估算兜底，也不会真正累加，等于漏计
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? usage.total)
  if (Number.isFinite(total) && total > 0) return total
  const pairs = [
    [usage.input_tokens, usage.output_tokens],
    [usage.inputTokens, usage.outputTokens],
    [usage.prompt_tokens, usage.completion_tokens]
  ]
  for (const [a, b] of pairs) {
    if (a != null && b != null) {
      const sum = Number(a) + Number(b)
      if (Number.isFinite(sum) && sum > 0) return sum
    }
  }
  return null
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
// CJK 约 0.7 token/字，其余按 4 字符/token 粗略折算。
// 范围补上 CJK 标点（\u3000-\u303F）与全角字符（\uFF00-\uFFEF），
// 避免标点/全角字符被当 4 字符/token 高估。
export function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[㐀-䶿一-鿿぀-ヿ가-힯\u3000-\u303F\uFF00-\uFFEF]/g) || []).length
  const rest = Math.max(text.length - cjk, 0)
  return Math.max(1, Math.round(cjk * 0.7 + rest / 4))
}

// 从 chat/completions 响应体里提取输出文本（含 reasoning）用于估算。
// 与流式路径的估算口径保持一致，避免非流式在无 usage 时静默漏计。
function estimateCompletionTokens(respondText) {
  if (!respondText) return 0
  try {
    const data = JSON.parse(respondText)
    const msg = data.choices?.[0]?.message
    if (!msg) return 0
    return estimateTokens((msg.content || '') + (msg.reasoning_content || ''))
  } catch {
    return 0
  }
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

// 连接与等待响应头的超时。此前为 30 秒，但实测 NVIDIA NIM 的推理请求要排队
// 近 40 秒才吐响应头（同一请求直连 200 / 39760ms），30 秒就 abort 会让所有 Key
// 排着队超时、最终 502——而再等 10 秒其实就成功了。放到 80 秒覆盖这类慢排队。
// 非推理接口（/models 等）仍是几十毫秒，不受影响。
// 导出便于测试锁住下面的约束
export const CONNECT_TIMEOUT_MS = toMs(process.env.CONNECT_TIMEOUT_MS, 80000)
const STREAM_TOTAL_TIMEOUT_MS = toMs(process.env.STREAM_TOTAL_TIMEOUT_MS, 1800000)
const JSON_TOTAL_TIMEOUT_MS = toMs(process.env.JSON_TOTAL_TIMEOUT_MS, 120000)
// 等待响应头阶段的全程预算。单次尝试只受 CONNECT_TIMEOUT_MS 约束，Key 轮换会把
// 这段时间逐个累加：几十个 Key 都拿不到响应头时，客户端要挂几十分钟才等来一个 502
// （线上出现过切换 88 次、耗时 44 分钟的空转）。封顶后在可预期时间内明确失败。
// 预算必须容得下至少两次完整尝试（2 × 80s = 160s），否则慢上游永远轮不到第二个 Key。
// 预算必须容得下至少两次完整尝试（2 × 80s = 160s），否则慢上游永远轮不到第二个 Key。
export const PRE_HEADER_TIMEOUT_MS = toMs(process.env.PRE_HEADER_TIMEOUT_MS, 200000)
// 上游 400 指向 temperature 的特征：OpenAI 风格错误体的 param 字段，
// 或厂商自己的措辞（商汤 kimi-k3：only 1 is allowed for this model）。
const TEMPERATURE_REJECTED_RE = /"param"\s*:\s*"temperature"|temperature\s+(?:value\s+)?invalid|only\s+1\s+is\s+allowed/i
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
  // WorkBuddy / CodeBuddy 订阅账号（腾讯，OAuth 凭据）：接口形态近似 OpenAI 兼容，
  // 但路径带 /v2 前缀，且对请求体挑三拣四（强制流式、tool_choice 只收字符串、
  // 首条必须是 system）。整形见 workbuddy-lane.js。
  // 注意 modelsPath 不是 OpenAI 那个 /models —— 上游是 {code,msg,data} 信封且会漏报
  // 隐藏模型，所以模型清单走内置白名单，刷新失败时由 defaultModelsFor 兜底。
  'workbuddy-oauth': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/console/enterprises/personal/models', chatPath: '/v2/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' },
  // OpenCode Zen 免费通道：上游只认固定的公共凭据（Bearer public）加一整套
  // OpenCode 客户端指纹头，用户没有任何可配置的 Key —— 目前唯一的免凭据协议。
  // 接口形态仍是 OpenAI 兼容，请求/响应整形见 zen-lane.js。
  'zen-free': { auth: 'none', keyless: true, modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' },
  'custom': { auth: 'header', authHeader: 'Authorization', authPrefix: 'Bearer ', modelsPath: '/models', chatPath: '/chat/completions', imagesPath: '/images/generations', modelsMethod: 'GET' }
}

// 走 Responses API 的协议：请求/响应都需要在 chat/completions 与 Responses 之间转换
export function isResponsesProtocol(protocol) {
  return protocol === 'codex-oauth'
}

// 免凭据协议：平台下不需要任何 Key。转发时用一个虚拟 Key 占位，
// 让「选 Key → 冷却 → 故障切换」这套机制原样复用，不必在主流程里到处开分支。
export function isKeylessProtocol(protocol) {
  return protocolInfo(protocol).keyless === true
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
  // 免凭据协议不携带任何用户凭据：它的鉴权头是固定常量，
  // 由 buildHeaders 的协议分支直接写死（没有真实 Key，也不该编一个出来）
  if (plan.auth === 'none') return {}
  const headerName = plan.authHeader || 'Authorization'
  return { [headerName]: `${plan.authPrefix || ''}${apiKey}` }
}

function queryAuth(plan, apiKey) {
  return plan.auth === 'query' ? { [plan.authQueryParam || 'api_key']: apiKey } : null
}

// 免凭据通道的完整指纹头。上游的准入判定全部落在这些头上（见 zen-lane.js 顶部），
// 少任何一个都是 403 FreeTierError，所以整组一起给，不做增量合并。
function zenHeaders(provider) {
  return {
    'Content-Type': 'application/json',
    ...buildZenHeaders(),
    // 平台级 extra_headers 放最后：允许用户覆盖 UA 版本之类的指纹
    // （上游的版本门槛会变，硬编码写死迟早要改），默认值则一定是实测可用的那组
    ...(provider?.extra_headers || {})
  }
}

function buildHeaders(provider, plan, apiKey, key = null) {
  if (isZenProtocol(provider.protocol)) return zenHeaders(provider)
  const headers = { 'Content-Type': 'application/json', ...autoHeaders(provider) }
  // Codex 上游要求每个账号带上自己的 ChatGPT-Account-Id，值随 Key 变化，
  // 因此不能放进平台级的 extra_headers，只能在选定 Key 之后按 Key 注入
  if (isResponsesProtocol(provider.protocol) && key) {
    Object.assign(headers, codexAccountHeader(key))
  }
  // WorkBuddy 同理：uid 与 realm（X-Domain）都是账号级的，多账号轮换时
  // 拿平台级头去配另一个账号的 token，上游会直接按身份不匹配拒绝
  if (isWorkbuddyProtocol(provider.protocol) && key) {
    Object.assign(headers, workbuddyHeaders(key))
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

// 发给上游的请求体。三种改法互斥：
// - Codex：chat/completions 结构 → input[]/instructions
// - 免费通道：强制流式 + 补齐四件套工具 + 工具名小写化
// - 其余：原样透传
// 抽成函数是因为 400 重试时要按可能被收敛过的 max_tokens 重新序列化。
function serializeUpstreamBody(provider, body) {
  if (isZenProtocol(provider.protocol)) {
    return JSON.stringify(shapeZenBody(body))
  }
  // WorkBuddy：强制流式 + tool_choice 收敛成字符串 + developer 角色改写 + 补 system 消息
  if (isWorkbuddyProtocol(provider.protocol)) {
    return JSON.stringify(shapeWorkbuddyBody(body))
  }
  const payload = withUsageOption(provider, body)
  return JSON.stringify(
    isResponsesProtocol(provider.protocol) ? toCodexRequest(payload) : payload
  )
}

function mergeAuthAndCustomHeaders(extraHeaders, plan, apiKey, protocol) {
  // 免凭据通道的预览请求也必须带完整指纹头，否则上游一律 403，
  // 在界面上表现成「拉取模型失败」——用户会以为自己配错了地址
  if (isZenProtocol(protocol)) return zenHeaders({ extra_headers: extraHeaders })
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
// 三家订阅账号（Grok / Codex / WorkBuddy）的 OAuth 端点、参数、响应信封、凭据字段
// 各不相同，按凭据自带的 provider 标记分流（导入/授权时写入）。
// 抽成函数而不是嵌套三元：再加一家订阅源时，多一个 case 就够，不必改三个调用点。
function oauthHandlersFor(key) {
  switch (key?.provider) {
    case 'codex':
      return { ensure: ensureCodexToken, refresh: refreshCodexToken }
    case 'workbuddy':
      return { ensure: ensureWorkbuddyToken, refresh: refreshWorkbuddyToken }
    default:
      return { ensure: ensureAccessToken, refresh: refreshAccessToken }
  }
}

export async function resolveKeyToken(key) {
  if (!key || key.type !== 'oauth') return key?.api_key
  const { credential, refreshed } = await oauthHandlersFor(key).ensure(key)
  if (refreshed) {
    Object.assign(key, credential)
    persistImmediate()
  }
  return key.access_token
}

// 无条件强制续期 OAuth 凭据（不判断是否临近过期），成功返回 true。
// 用于上游 401/403 时的「补刷重试」：请求前那次 ensureAccessToken 只在
// tokenNeedsRefresh 判定为临期时才续期，token 刚过期但尚未触发临期阈值、
// 或上游侧提前失效时，会出现"拿着看似有效的 token 吃 401"的假性失效。
// 一次集体过期若不做补刷，整池 Key 会被 401 冷却打残（线上已两次复现）。
async function forceRefreshToken(key) {
  if (!key || key.type !== 'oauth') return false
  try {
    // key.token_endpoint 允许凭据自带 token 端点（测试注入 / 特殊部署覆盖），
    // 没有时走 oauth.js 的 OIDC discovery（有缓存与兜底）
    const { refresh } = oauthHandlersFor(key)
    const next = await refresh(key, key.token_endpoint)
    Object.assign(key, next)
    persistImmediate()
    return true
  } catch {
    // 续期失败（refresh_token 失效/网络抖动）：交给调用方按 Key 失效处理
    return false
  }
}

// 免凭据通道的占位 Key。上游凭据是公开常量，平台下不需要用户配置任何 Key，
// 但转发主流程处处依赖「先拿到一个 Key」，所以给它一个虚拟的，
// 而不是在选 Key、故障切换、日志这些地方到处开分支。
const ANONYMOUS_KEY = Object.freeze({
  id: '__anonymous__',
  name: '免费通道（免凭据）',
  api_key: 'public',
  enabled: true,
  type: 'anonymous',
  cooldown_until: 0
})

// 请求要发去哪个上游地址。
//
// WorkBuddy 的接入地址不是平台级属性，而是账号级属性：它的三个 realm
// （CN / Global / Intl）网关互不通用，同一枚 Bearer 发到别的 realm 只会拿回
// 非 JSON 的 401 HTML。平台上配的 base_url 只是建平台时的默认值，真发请求时
// 必须以账号自己的 X-Domain 为准——生产上就是这么撞上的：国内账号配着国际
// 地址，聊天 401 进冷却，而同一枚 token 签到却是好的。
//
// 其他协议的 Key 不带 domain，行为完全不变。
function effectiveBaseUrl(provider, key) {
  if (key?.base_url) return key.base_url
  if (key?.domain && isWorkbuddyProtocol(provider?.protocol)) return workbuddyChatBaseFor(key.domain)
  return provider.base_url
}

function usableKeys(provider) {
  if (isKeylessProtocol(provider.protocol)) return [ANONYMOUS_KEY]
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
  // 免凭据通道只有一个共享的占位 Key，给它打冷却等于把整个平台冻住，
  // 而这类请求失败多是上游抖动、几秒后即恢复。健康度交给 markResult 记录。
  if (key?.type === 'anonymous') return
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

// 探测单个候选型号：拿公共凭据真发一个最小请求，只看状态码。
//
// 为什么必须实测：上游 /models 不标注免费与否，付费档和免费档在列表里长得一模一样，
// 区别只在「用公共凭据调用会不会被拒」。所以「能不能用」的唯一可信判据就是真发一次。
async function probeZenModel(provider, modelId) {
  const plan = callPlan(provider)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ZEN_PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(joinUrl(provider.base_url, plan.chatPath), {
      method: 'POST',
      headers: buildHeaders(provider, plan, 'public', usableKeys(provider)[0] || null),
      body: JSON.stringify(shapeZenBody({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        max_tokens: 1
      })),
      signal: controller.signal
    })
    // 拿到状态码就够了，立刻断开：探测本身不该为了读正文去消耗免费额度
    await resp.body?.cancel()
    return { ok: resp.ok, status: resp.status }
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? '探测超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

// 在上游清单里挑出「还没见过、名字像免费档」的型号，逐个实测，通过的收编。
//
// 这样上游新上免费型号时，用户点一次「刷新模型」就能拿到，不必等网关更新白名单——
// 白名单由此退化成「种子 + 已确认可用项」，不再是唯一的准入名单。
// 返回的 cache 由调用方写回平台，用来避免每次刷新都重测同一批已知不可用的型号。
export async function discoverZenFreeModels(provider, upstreamModels) {
  const curated = new Set(ZEN_FREE_MODELS)
  const known = new Set((provider.models || []).map((m) => m.id))
  const now = Date.now()
  const cache = (provider.zen_probe_cache && typeof provider.zen_probe_cache === 'object')
    ? { ...provider.zen_probe_cache }
    : {}

  // 上游已不再列出的型号，缓存留着没有意义，顺手清掉，避免这份缓存无限增长
  const upstreamIds = new Set(upstreamModels.map((m) => m?.id))
  for (const id of Object.keys(cache)) {
    if (!upstreamIds.has(id)) delete cache[id]
  }

  const candidates = []
  for (const m of upstreamModels) {
    if (!m?.id || curated.has(m.id) || known.has(m.id)) continue
    if (!isZenFreeCandidate(m.id)) continue
    const rejected = cache[m.id]
    // 已判定用不了的，TTL 内不再重测；到点后放行重测，因为上游可能已经放开
    if (rejected && rejected.ok === false && now - Number(rejected.at || 0) < ZEN_PROBE_TTL_MS) continue
    candidates.push(m.id)
    if (candidates.length >= ZEN_MAX_PROBES) break
  }

  const adopted = []
  // 本轮没定论的型号（429 限流 / 5xx / 超时）：抖动不记档，但也别直接留到下次刷新——
  // 用户点一次「刷新」就该拿到完整清单，漏掉的会被当成「网关没抓全」。
  let transient = []
  const probeOne = async (id) => {
    const r = await probeZenModel(provider, id)
    if (r.ok) {
      cache[id] = { ok: true, at: Date.now() }
      adopted.push(id)
      return
    }
    if (isDefinitiveZenRejection(r.status)) {
      cache[id] = { ok: false, at: Date.now(), status: r.status }
      return
    }
    // 抖动不记档，下次刷新重试——否则上游一次 500 就能让一个好型号长期消失
    delete cache[id]
    transient.push(id)
  }
  const runWave = async (queue) => {
    let cursor = 0
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor]
        cursor += 1
        await probeOne(id)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(ZEN_PROBE_CONCURRENCY, queue.length) }, worker)
    )
  }

  await runWave(candidates)

  // 上游按并发限流：三个候选同时打过去会吃到 429，被挡下的型号这一轮就漏了。
  // 隔一拍补一轮让「一次刷新」是完整的；补完仍不稳的留给下次刷新，不无限重试。
  if (transient.length) {
    await new Promise((resolve) => setTimeout(resolve, ZEN_PROBE_RETRY_DELAY_MS))
    const retry = transient
    transient = []
    await runWave(retry)
  }

  adopted.sort() // 顺序稳定，便于对比与测试
  return { adopted, probed: candidates.length, cache }
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
    // 模型清单同样按账号 realm 取：国内账号要向 CN 网关要它自己那套模型，
    // 问国际网关只会拿到国际版清单（甚至因 realm 不匹配 401）
    const url = joinUrl(effectiveBaseUrl(provider, key), plan.modelsPath, queryAuth(plan, token))
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
        // OpenAI 形态是 {data:[]}；WorkBuddy 是 {code,msg,data} 信封，且 data
        // 可能是数组、也可能是 {models:[...]}。只认一种形态会把另一些账号的
        // 刷新结果静默成「没模型」。
        const raw = data && data.data !== undefined ? data.data : data
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : []
        const models = list
          .map((m) => ({ id: m.id || m.model_name || m.name, owned_by: m.owned_by || m.display_name || provider.name }))
          .filter((m) => m.id)
        // 信封报了错就别把空列表当成功——否则刷新会静默清空模型
        if (models.length === 0 && Number.isFinite(Number(data?.code)) && Number(data.code) !== 0) {
          throw new Error(String(data.msg || `上游返回 code=${data.code}`))
        }
        // 免费通道：上游列表混着付费模型（公共凭据调用必 401），白名单只负责
        // 兜住已知可用项；名字像免费档的新型号在下面实测收编，因此新模型不必等发版。
        // 用户手工加进来的非白名单模型若上游仍在列，一并保留——刷新不该冲掉人的配置。
        // 既没有白名单命中、探测也没捞到任何型号，才整份退回白名单并标注来源。
        let usable = models
        let curatedOnly = false
        // 本轮新收编的型号，回给前端好让「刷新」这类动作有可见的结果
        let discoveredIds = []
        if (isZenProtocol(provider.protocol)) {
          const curated = new Set(ZEN_FREE_MODELS)
          const live = models.filter((m) => curated.has(m.id))
          const { adopted, probed, cache } = await discoverZenFreeModels(provider, models)
          provider.zen_probe_cache = cache
          discoveredIds = adopted
          if (probed) {
            addLog({
              type: 'system',
              detail: `免费通道探测了 ${probed} 个新候选型号，收编 ${adopted.length} 个` +
                (adopted.length ? `：${adopted.join('、')}` : '')
            })
          }
          const discovered = adopted.map((id) => ({ id, owned_by: provider.name, free: true }))
          if (live.length || discovered.length) {
            const manual = provider.models.filter((m) => !curated.has(m.id) && models.some((x) => x.id === m.id))
            usable = [...live, ...manual, ...discovered]
          } else {
            usable = ZEN_FREE_MODELS.map((id) => ({ id, owned_by: provider.name }))
            curatedOnly = true
          }
        }
        provider.models = usable
        provider.models_updated_at = Date.now()
        if (curatedOnly) provider.models_source = 'default'
        persistImmediate()
        return { ok: true, count: usable.length, discovered: discoveredIds, provider }
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
    // 免费通道要据此找回平台自己的探测缓存与现有模型，否则每次拉取都从零重测
    provider_id,
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
  // 免凭据通道没有 API Token 可填，不能在这里把它拦下来
  if (!target.base_url) return { ok: false, error: '请先填写 API 地址' }
  if (!target.api_key && !isKeylessProtocol(target.protocol)) {
    return { ok: false, error: '请先填写 API 地址与 API Token' }
  }
  const plan = callPlan(target)
  const url = joinUrl(target.base_url, plan.modelsPath, queryAuth(plan, target.api_key))
  const headers = mergeAuthAndCustomHeaders(target.extra_headers, plan, target.api_key, target.protocol)
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
    let models = (data.data || []).map((m) => ({ id: m.id, owned_by: m.owned_by || m.display_name || '' }))
    // 免费通道：上游列表里混着付费模型（公共凭据调用必 401），只保留白名单内的；
    // 若一个都没匹配上（上游改了免费档阵容），整份换成白名单，别让用户去选付费模型。
    //
    // 这里必须跑和「刷新」同一套实测收编。不跑的话同一个平台拉取比刷新少两个，
    // 用户按提示点「拉取列表」拿到的是残缺清单，会以为网关没抓全。
    if (isZenProtocol(target.protocol)) {
      const curated = new Set(ZEN_FREE_MODELS)
      const live = models.filter((m) => curated.has(m.id))
      // 已存在的平台沿用它自己的探测缓存与现有模型；新建的没有落盘的地方，用临时对象
      const host = (target.provider_id && getProvider(target.provider_id)) || {
        id: '__preview__',
        name: '预览',
        base_url: target.base_url,
        protocol: target.protocol,
        extra_headers: target.extra_headers || {},
        models: [],
        keys: []
      }
      const probe = await discoverZenFreeModels(host, models)
      host.zen_probe_cache = probe.cache
      if (host.id !== '__preview__') persistImmediate()
      // 和刷新同源：白名单命中 + 用户手加过且上游仍在列的 + 本轮实测收编的
      const manual = (host.models || []).filter((m) => !curated.has(m.id) && models.some((x) => x.id === m.id))
      const discovered = probe.adopted
        .filter((id) => !curated.has(id))
        .map((id) => ({ id, owned_by: 'OpenCode Zen', free: true }))
      models = [...live, ...manual, ...discovered]
      if (!models.length) models = ZEN_FREE_MODELS.map((id) => ({ id, owned_by: 'OpenCode Zen', free: true }))
    }
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
  // 本轮转发中已强制补刷过凭据的 Key：每个 Key 只补刷一次，
  // 防止 refresh_token 轮换异常时对上游 token 端点死循环重放
  const authRetried = new Set()
  // 记录实际使用的 Key 名称，供日志使用（不再通过响应头暴露给客户端）
  let usedKeyName = null
  // 生图不走对话的时间预算：图片生成动辄几十秒甚至数分钟，
  // 用 token 数推算时长对它毫无意义，直接给独立的固定预算。
  const totalTimeoutMs = kind === 'images' ? IMAGES_TOTAL_TIMEOUT_MS : jsonTotalTimeout(body?.max_tokens, body?.stream)
  // 等响应头的全程截止：单次尝试的 30 秒只是每次的上限，累计不得超过这个预算。
  const preHeaderDeadline = Date.now() + Math.min(totalTimeoutMs, PRE_HEADER_TIMEOUT_MS)
  // 客户端已断开（关页面、中止请求）就停止切换 Key。否则每个 Key 还要白等
  // CONNECT_TIMEOUT_MS，几十个 Key 空转几十分钟，上游也跟着白挨打。
  let clientGone = false
  if (typeof res.on === 'function') res.on('close', () => { clientGone = true })
  // 生图的请求体就是客户端原样发来的 OpenAI 生图参数（prompt / size / n 等），
  // 不需要像对话那样做协议转换（Responses ↔ chat/completions），原样透传即可。
  let upstreamBody = kind === 'chat' ? serializeUpstreamBody(provider, body) : kind === 'images' ? JSON.stringify(body) : undefined
  for (let i = 0; i < keys.length; i += 1) {
    if (clientGone) {
      attempts.push('客户端已断开，停止切换 Key')
      break
    }
    if (Date.now() > preHeaderDeadline) {
      attempts.push(`等待响应头超过 ${Math.round(Math.min(totalTimeoutMs, PRE_HEADER_TIMEOUT_MS) / 1000)} 秒（已尝试 ${i} 个 Key）`)
      break
    }
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
    // 地址按账号 realm 定，不是按平台配置——详见 effectiveBaseUrl
    const upstream = joinUrl(effectiveBaseUrl(provider, key), path, queryAuth(plan, token))
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
        // OAuth 的 401/403 大多是「access_token 过期但未触发临期阈值」的假性失效：
        // 先强制续期一次，让同一 Key 原地重试；仍失败才按 Key 失效冷却。
        // 没有这层补刷时，一次集体过期会把整池 Key 打进 10 分钟冷却，
        // 表现为整平台骤然不可用（线上两次复现）。
        if ((resp.status === 401 || resp.status === 403) && key.type === 'oauth' && !authRetried.has(key.id)) {
          authRetried.add(key.id)
          await resp.body?.cancel()
          if (await forceRefreshToken(key)) {
            // 原地重试同一个 Key：循环体会重新 resolveKeyToken，
            // 此时 tokenNeedsRefresh 已不成立，直接返回刚续期的新 token
            i -= 1
            continue
          }
        }
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
        let droppedTemperature = false
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
          // 有的模型只接受 temperature=1（商汤 kimi-k3 直接 400 拒掉其他取值，
          // 而测试面板默认发 0.7）。剥掉该字段再试一次——省略时上游用自身默认值，
          // 实测 kimi-k3 放行。客户端无感知，不必为了迁就单个模型改自己的参数。
          if (body && typeof body.temperature !== 'undefined' && TEMPERATURE_REJECTED_RE.test(text || '')) {
            delete body.temperature
            droppedTemperature = true
          }
        } catch { /* 读不到错误体则按普通瞬时 400 重试 */ }
        if (clamped != null) {
          console.warn(`[max_tokens 自适应] 模型 ${body?.model} 上限 ${clamped}，按上游报错范围收敛后重试`)
        }
        if (droppedTemperature) {
          console.warn(`[temperature 自适应] 模型 ${body?.model} 上游不接受该参数，剥离后重试`)
        }
        if (clamped != null || droppedTemperature) {
          // upstreamBody 在循环外已序列化，这里要重新生成，否则重试仍带上旧值
          upstreamBody = kind === 'chat' ? serializeUpstreamBody(provider, body) : kind === 'images' ? JSON.stringify(body) : undefined
        }
        const retryReason = clamped != null
          ? '（max_tokens 收敛后重试）'
          : droppedTemperature ? '（剥离 temperature 后重试）' : '（瞬时重试）'
        attempts.push(`${key.name || key.id.slice(0, 8)}: HTTP 400${retryReason}`)
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
      // 免费通道只接受流式请求，因此客户端要非流式时由网关把 SSE 聚合成一次性 JSON。
      // 直接把上游的 text/event-stream 甩给非流式客户端，对方必然解析失败。
      if (isStream && isZenProtocol(provider.protocol) && kind === 'chat' && body?.stream !== true) {
        try {
          const rawSse = await readJsonBody(resp, totalTimeoutMs, controller)
          const payload = aggregateZenSse(rawSse, body?.model || '', body)
          const reported = extractTokenCount(payload.usage)
          const text = typeof payload.choices[0]?.message?.content === 'string' ? payload.choices[0].message.content : ''
          const tokens = reported != null && reported > 0 ? reported : estimateTokens(text)
          res.status(200)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
          markResult(provider.id, true)
          if (tokens > 0) bumpTokens(provider.id, tokens)
          return { ok: true, keyName: usedKeyName, tokens, tokensEstimated: !(reported != null && reported > 0) }
        } catch (err) {
          // 此刻还没向客户端写入任何字节，换出口重试是无损的
          const msg = err.name === 'AbortError' ? '上游响应超时' : `上游读取失败: ${err.message}`
          attempts.push(`${key.name || key.id.slice(0, 8)}: ${msg}`)
          applyCooldown(provider, key, 'network')
          bumpFailover()
          continue
        }
      }
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
        // 免费通道只在「确实改过工具名」时才逐事件重写，否则走原样透传路径：
        // 这是热路径，没必要为每个请求都套一层 JSON 解析。
        const transformer =
          isResponsesProtocol(provider.protocol) && kind === 'chat'
            ? createCodexStreamTransformer(body?.model || '')
            : isZenProtocol(provider.protocol) && kind === 'chat' && zenToolNameMap(body?.tools).size > 0
              ? createZenStreamTransformer(body?.model || '', body)
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
            // Codex 的 usage 只在 completed 事件里，转换器已把它记下；
            // 优先按真实值统计，否则会退回字符估算、把推理内容也漏掉
            if (transformer.usage) lastUsageData = transformer.usage
            if (tail) await writeChunk(tail)
          } else if (sseBuffer) {
            // 最后一行若没有结尾换行，会一直留在 rest 里不被解析，
            // 补一次解析避免丢掉最后一次 usage 或最后几个字
            const parsed = parseSseUsage(sseBuffer + '\n')
            sseBuffer = ''
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
      let tokens = 0
      let tokensEstimated = false
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
          if (tokenCount != null && tokenCount > 0) {
            tokens = tokenCount
          } else {
            // 上游不返回 usage 时，与流式路径一致按输出长度估算（含 reasoning），
            // 否则非流式请求会被静默漏计
            const est = estimateCompletionTokens(respondText)
            tokens = est
            tokensEstimated = est > 0
          }
          if (tokens > 0) bumpTokens(provider.id, tokens)
        } catch {
          // 非 JSON body，忽略
        }
      } else {
        if (!res.writableEnded) res.end()
      }
      markResult(provider.id, true)
      return { ok: true, keyName: usedKeyName, tokens, tokensEstimated }
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

// 调用方 Key 的模型权限校验。
//
// 必须在「匹配平台」之前做：受限 Key 若先去匹配平台，被禁模型与不存在的模型
// 会分别返回 403 / 404，等于免费提供了一个「这个模型在网关里存不存在」的探测器。
// 统一在入口拦掉，顺便让报错信息直接告诉用户自己那把 Key 被授权了什么。
function modelAccessDenial(auth, model) {
  const check = modelAllowed(auth, model)
  if (check.allowed) return null
  // 用「」而不是全角括号：括号后面接中文时必须留个空格才不挤，而「」不需要，
  // 报错文案才能连读。Key 的名字由创建者自定，这里只是把它嵌进去。
  const who = auth?.name ? `API Key「${auth.name}」` : '该 API Key'
  if (check.code === 'model_denied') {
    return { type: 'model_denied', message: `${who}已被明确禁止使用模型 "${model}"` }
  }
  const scope = (auth?.allowed_models || []).slice(0, 8).join('、')
  const more = (auth?.allowed_models || []).length > 8 ? ' 等' : ''
  return {
    type: 'model_forbidden',
    message: `${who}无权使用模型 "${model}"。该 Key 仅被授权：${scope}${more}（如需放开请在「访问密钥」里调整，模型名支持 * 通配）`
  }
}

export async function handleChat(req, res) {
  const { model, providerIdHint, body } = resolveTarget(req.body)
  sanitizeMaxTokens(body)
  const startTime = Date.now()
  const clientKey = req.apiAuth?.name
  const denial = modelAccessDenial(req.apiAuth, model)
  if (denial) {
    markResult(null, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({
      type: 'chat',
      method: 'POST',
      path: '/api/v1/chat/completions',
      model,
      provider_id: null,
      provider_name: null,
      stream: Boolean(body?.stream),
      client_key: clientKey,
      status: 403,
      ok: false,
      error: denial.message
    })
    return respondJson(res, 403, { error: { message: denial.message, type: denial.type } })
  }
  const provider = matchProvider(model, providerIdHint)
  bumpStats(provider?.id)
  const baseLog = {
    type: 'chat',
    method: 'POST',
    path: '/api/v1/chat/completions',
    model,
    provider_id: provider?.id || null,
    provider_name: provider?.name || null,
    client_key: clientKey,
    stream: Boolean(body?.stream)
  }
  if (!provider) {
    markResult(null, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({ ...baseLog, status: 404, error: `未找到提供模型 "${model}" 的平台` })
    return respondJson(res, 404, { error: { message: `未找到提供模型 "${model}" 的平台，请先在平台管理中刷新模型列表`, type: 'model_not_found' } })
  }
  if (!provider.base_url) {
    markResult(provider.id, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({ ...baseLog, status: 400, error: '平台缺少 Base URL' })
    return respondJson(res, 400, { error: { message: '平台缺少 Base URL', type: 'bad_config' } })
  }
  const result = await forwardWithFailover(provider, 'chat', body, res)
  recordUsage(req.apiAuth, { tokens: result.tokens, ok: result.ok })
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
  const startTime = Date.now()
  const clientKey = req.apiAuth?.name
  const denial = modelAccessDenial(req.apiAuth, model)
  if (denial) {
    markResult(null, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({
      type: 'images',
      method: 'POST',
      path: '/api/v1/images/generations',
      model,
      provider_id: null,
      provider_name: null,
      client_key: clientKey,
      status: 403,
      ok: false,
      error: denial.message
    })
    return respondJson(res, 403, { error: { message: denial.message, type: denial.type } })
  }
  const provider = matchProvider(model, providerIdHint)
  bumpStats(provider?.id)
  const baseLog = {
    type: 'images',
    method: 'POST',
    path: '/api/v1/images/generations',
    model,
    provider_id: provider?.id || null,
    provider_name: provider?.name || null,
    client_key: clientKey
  }
  if (!provider) {
    markResult(null, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({ ...baseLog, status: 404, error: `未找到提供模型 "${model}" 的平台` })
    return respondJson(res, 404, { error: { message: `未找到提供模型 "${model}" 的平台，请先在平台管理中刷新模型列表`, type: 'model_not_found' } })
  }
  if (!provider.base_url) {
    markResult(provider.id, false)
    recordUsage(req.apiAuth, { ok: false })
    addLog({ ...baseLog, status: 400, error: '平台缺少 Base URL' })
    return respondJson(res, 400, { error: { message: '平台缺少 Base URL', type: 'bad_config' } })
  }
  const result = await forwardWithFailover(provider, 'images', body, res)
  recordUsage(req.apiAuth, { tokens: result.tokens, ok: result.ok })
  addLog({
    ...baseLog,
    status: res.statusCode || (result.ok ? 200 : 502),
    ok: result.ok,
    key: result.keyName || undefined,
    duration_ms: Date.now() - startTime,
    error: result.ok ? undefined : (result.error || '')
  })
}

// 模型聚合列表。
// 必须按调用方的 Key 权限裁剪：这份列表是客户端挑选模型的唯一依据，
// 若把没授权的模型也列出来，用户只会得到一串必然 403 的名字，
// 而且从调用方视角根本看不出是权限问题还是平台问题。
export function handleModels(req, res) {
  const list = []
  const seen = new Set()
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (seen.has(m.id)) continue
      if (!modelAllowed(req?.apiAuth, m.id).allowed) continue
      seen.add(m.id)
      list.push({ id: m.id, object: 'model', owned_by: m.owned_by || p.name, provider: p.id, provider_name: p.name })
    }
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ object: 'list', data: list }))
}
