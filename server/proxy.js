import { state, getProvider, bumpStats, bumpFailover, markResult, bumpTokens, persist, persistImmediate } from './store.js'
import { addLog } from './logger.js'
import { modelAllowed, filterModelsForAuth, recordUsage } from './api-keys.js'
import { ensureAccessToken, refreshAccessToken, XAI_OAUTH_BASE_URL } from './oauth.js'
import { ensureAccessToken as ensureCodexToken, refreshAccessToken as refreshCodexToken } from './codex-oauth.js'
import { ensureWorkbuddyToken, refreshWorkbuddyToken } from './workbuddy-oauth.js'
import { toCodexRequest, fromCodexResponse, createCodexStreamTransformer, codexAccountHeader } from './codex-responses.js'
import { TEMPLATES } from './templates.js'
import { isWorkbuddyProtocol, workbuddyHeaders, workbuddyChatBaseFor, shapeWorkbuddyBody, workbuddyRealmFor, neutralizeWorkbuddySystem, collectWorkbuddySystemText } from './workbuddy-lane.js'
import { fetchWorkbuddyCatalog, mergeWorkbuddyCatalogs } from './workbuddy-catalog.js'
import { SUBSCRIPTION_PLANS } from './subscription-plans.js'
import { filterModelsForProvider, IMAGE_ONLY_FALLBACK_MODELS } from './providers-image-only.js'

// ---------------------------------------------------------------------------
// 出站代理（出口 IP 控制）
//
// 为什么需要：上游按**出口 IP** 做风控。这台机器在洛杉矶，而 WorkBuddy 国内版
// 是腾讯的国内服务 —— 一个美国 IP 高频调用它，在风控眼里就是「非官方客户端」，
// 表现为 400 / code 11128（实测 05:17 全 200、05:19 连 4 次全 400、05:20 又全 200，
// 按 IP 计的秒级窗口）。换 Key 没用，因为拦的是 IP。
//
// 三种配法，优先级从高到低：
//   1. key.proxy          单个账号走自己的出口（最贴近真实多用户）
//   2. provider.proxy     整个平台走同一个出口
//   3. AI_GATEWAY_OUTBOUND_PROXY  环境变量兜底
// 都不配就直连，行为与之前完全一致。
//
// 注意：Node 的 fetch **不读** HTTPS_PROXY 环境变量（实测），必须显式传 dispatcher，
// 所以下面用 undici 的 ProxyAgent。undici 缺失时退化为直连，不影响主流程。
let ProxyAgentCtor = null
try {
  ({ ProxyAgent: ProxyAgentCtor } = await import('undici'))
} catch {
  /* undici 不可用：代理功能关闭，其余照常 */
}

const proxyAgentCache = new Map()

/** 解析该请求应使用的出口代理 URL（空串 = 直连）。 */
export function outboundProxyFor(provider, key) {
  return String(key?.proxy || provider?.proxy || process.env.AI_GATEWAY_OUTBOUND_PROXY || '').trim()
}

/**
 * 取（并缓存）该代理对应的 undici dispatcher。
 * 缓存是必须的：ProxyAgent 内部带连接池，每次新建会漏 socket。
 */
function dispatcherFor(provider, key) {
  const url = outboundProxyFor(provider, key)
  if (!url || !ProxyAgentCtor) return undefined
  let agent = proxyAgentCache.get(url)
  if (!agent) {
    try {
      agent = new ProxyAgentCtor(url)
      proxyAgentCache.set(url, agent)
    } catch (err) {
      // 代理地址写错不该让整个请求 500：退回直连并留下痕迹
      console.warn(`[出站代理] 无法创建 ProxyAgent（${url}）：${err.message}；本次直连`)
      return undefined
    }
  }
  return agent
}


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
// （曾经 OpenCode Zen 免费档属于这一类：/models 把付费模型一并列出，而付费模型用
// 公共凭据调用一律 401。该通道已整体移除，原因见 git 历史与 README。）
const PROTOCOLS_WITH_CURATED_MODELS = new Set()

// 订阅类上游（Grok 的 cli-chat-proxy、Codex 的 chatgpt.com/backend-api）没有干净的
// GET /models，两者在拉取不可用时回退到方案内置的默认模型列表，保证平台建完即可用。
//
// 订阅方案独立在 subscription-plans.js，所以兜底要同时查 TEMPLATES 与 SUBSCRIPTION_PLANS：
// 只查模板的话，grok-oauth / codex-oauth 查不到兜底，订阅平台刚建好就是废的。
//
// WorkBuddy 不走这条兜底路径：它的模型清单只有一个来源——上游接口
// （refreshWorkbuddyCatalog）。取不到就是取不到，界面如实显示。
// 这里曾经挂着 WORKBUDDY_CURATED_MODELS（写死的 18 个模型），已删除：
// 那份清单既漏掉了上游新增的型号，又留着上游已下线的，拿它兜底等于用
// 过期数据覆盖上游的真实数据。
export function defaultModelsFor(protocol) {
  if (!PROTOCOLS_WITHOUT_MODELS_ENDPOINT.has(protocol) && !PROTOCOLS_WITH_CURATED_MODELS.has(protocol)) return null
  for (const t of [...TEMPLATES, ...SUBSCRIPTION_PLANS]) {
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

// 上游「账号级拒绝」错误码（HTTP 400 信封里的 code）：
//   11128 渠道校验没通过（「可能不是官方客户端发出的」）
//   11140 账号被风控（「账号存在异常行为，已被限制使用」）
// 2026-10-21 实测：国内版（copilot.tencent.com）也开始放 11128 闸门，灰度
// 命中时单个请求会连续撞上多个账号（线上复现：连撞后把 400 透传给了客户端）。
// 这类错换 Key 大概率就好——闸门/风控是按账号挑的，不换就只能干等透传。
const UPSTREAM_ACCOUNT_REJECT_CODES = new Set([11128, 11140])
// 账号级拒绝最多换几个 Key：灰度按批次挑账号，3 个足够跨过一批；
// 撞满还失败说明是全线闸门，换了也白换，直接透传让客户端看到真实错误。
const ACCOUNT_REJECT_RETRY_MAX = 3

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

// 发给上游的请求体。两种改法互斥：
// - Codex：chat/completions 结构 → input[]/instructions
// - WorkBuddy：强制流式 + tool_choice 收敛成字符串 + developer 角色改写 + 补 system 消息
// - 其余：原样透传
// 抽成函数是因为 400 重试时要按可能被收敛过的 max_tokens 重新序列化。
// 同一个模型 id 在两个 realm 里倍率不同时，非主 realm 的那个对外是带后缀的
// 别名（如 glm-5.3-intl）——否则调用方点名时根本不知道网关会拿哪一个去扣费。
// 别名只是对外的名字，转发前要换回上游认得的原始 id。
export function workbuddyUpstreamBody(provider, body) {
  const alias = body?.model
  const map = provider?.model_upstream_id
  if (!alias || !map || !map[alias]) return body
  return { ...body, model: map[alias] }
}

// 取某个模型在平台目录里的元数据。整形的最后一步要用它下发 max_tokens：
// 上游对每个模型有各自的单次输出上限，不下发就用网关默认值，长回答会被
// 截断成 finish_reason: 'length'（实测各端点上限不一，128000–131072）。
function workbuddyModelMeta(provider, model) {
  const list = Array.isArray(provider?.models) ? provider.models : []
  return list.find((m) => m && m.id === model) || null
}

function serializeUpstreamBody(provider, body) {
  // WorkBuddy：强制流式 + tool_choice 收敛成字符串 + developer 角色改写 +
  // 补 system 消息 + system 内容指纹改写 + 按模型上限下发 max_tokens
  if (isWorkbuddyProtocol(provider.protocol)) {
    const upstream = workbuddyUpstreamBody(provider, body)
    // 元数据要按**上游 id** 找：别名（glm-5.3-intl）在目录里是一条独立记录，
    // 但它的 max_output 与原始 id 一致，用上游 id 查更稳
    const meta = workbuddyModelMeta(provider, upstream?.model) || workbuddyModelMeta(provider, body?.model)
    // realm 决定要不要做零宽打散（CN 版整段 prompt 匹配闸门专属），按
    // 平台 base_url 判定；账号级 domain 与平台不同属的错配是配置错误，不在此兜
    return JSON.stringify(shapeWorkbuddyBody(upstream, meta, workbuddyRealmFor(provider.base_url)))
  }
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
    }
  }
  // 客户端按 /v1/models 下发的 id 点名，而那个 id 形如「GLM-5.3 · x0.79」
  // （倍率拼在 id 里，因为客户端一律拿 id 当显示名）。这里归一成平台真实
  // id——路由、权限、日志全部按真实 id 走，客户端传什么样子它都认。
  // 完整 label（含倍率）命中时还带上平台，同名不同倍率精确路由。
  const target = lookupModel(model)
  if (target.id !== model) model = target.id
  if (target.providerId && !providerIdHint) providerIdHint = target.providerId
  if (body && body.model !== model) body = { ...body, model }
  return { model, providerIdHint, body }
}

// /v1/models 下发的 id 里倍率后缀的写法：` · x0.79`、` · x0.17→x0.50`。
// 只剥这一种——别把模型名里本来就带 ` · ` 的上游名误伤。
const RATE_SUFFIX_RE = /\s*·\s*x\d+(?:\.\d+)?(?:→x\d+(?:\.\d+)?)?\s*$/

export function stripRateSuffix(name) {
  return String(name ?? '').replace(RATE_SUFFIX_RE, '')
}

/**
 * 把客户端传来的模型名归一成平台里的真实 id（带平台定位）。
 *
 * 客户端可能传：真实 id（glm-5.3）、显示名（GLM-5.3，大小写不同）、
 * 或带倍率后缀的显示名（GLM-5.3 · x0.79）。先按完整 label 精确反查
 * ——国内外平台同名 id 不同倍率时（国际版 deepseek-v4.1-flash 是 x0.00、
 * 国内版同名是 x0.11），用户点名哪条倍率就路由到哪条，此时带上平台 id
 * 做精确定位；完整 label 查不到再剥后缀按 id/name 找（此时多个平台都在
 * 候选里，由 matchProvider 轮询，不带平台）。都找不到原样返回，不猜。
 */
export function lookupModel(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return { id: raw, providerId: null }
  const lower = raw.toLowerCase()
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (publicModelName(m).toLowerCase() === lower) return { id: m.id, providerId: p.id }
    }
  }
  const stripped = stripRateSuffix(raw).toLowerCase()
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (String(m.id).toLowerCase() === stripped) return { id: m.id, providerId: null }
    }
  }
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (String(m.name || '').toLowerCase() === stripped) return { id: m.id, providerId: null }
    }
  }
  return { id: raw, providerId: null }
}

/** 只要归一后的真实 id；平台定位用 lookupModel。 */
export function canonicalModelId(name) {
  return lookupModel(name).id
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

// WorkBuddy 的目录按 realm 分别取，再合并成一份。
//
// 两个 realm 不对称，这是实测出来的：国内版企业端点 200 且给得最全（含上游
// 界面不展示的隐藏型号），国际版企业端点直接 500，它的模型清单只能来自
// /v3/config。两边的模型名也是两套——国际版是 fast-model 这种抽象别名，
// 与国内的 glm-5.3 一个都不重叠，所以必须分别取再合并，只用第一个可用 Key
// 会把另一个 realm 整份漏掉。
export async function refreshWorkbuddyCatalog(provider) {
  const byRealm = new Map()
  for (const key of provider.keys || []) {
    if (!key.enabled || key.type !== 'oauth' || !key.access_token) continue
    const realm = workbuddyRealmFor(key.domain)
    // 一个 realm 一个 Key 就够：同 realm 的账号拿到的目录是同一份
    if (!byRealm.has(realm)) byRealm.set(realm, key)
  }
  if (byRealm.size === 0) return null

  const entries = []
  const notes = []
  for (const [realm, key] of byRealm) {
    let catalog
    try {
      // 一次取齐：企业端点（清单，给得最全）+ /v3/config（倍率与促销）。
      // 两个端点下发的 id 集合不同，取并集在 catalog 层完成。
      catalog = await fetchWorkbuddyCatalog(key, provider)
    } catch (err) {
      // 凭据失效是硬失败：这个账号不该再被当成数据来源，
      // 如实记下来让用户去处理，不能降级成「这个 realm 没数据」后装作无事发生
      if (err.auth_failed) {
        notes.push(`${realm}：账号「${key.name || '未命名'}」凭据失效（${err.message}），该 realm 的目录未更新`)
        provider.model_rates_error = `${realm} 账号凭据失效：${err.message}`
        continue
      }
      notes.push(`${realm}：模型配置不可用（${err.message}）`)
      continue
    }
    for (const note of catalog.notes) notes.push(`${realm}：${note}`)
    entries.push({ realm, ids: catalog.ids, models: catalog.models, rates: catalog.rates })
  }
  if (entries.length === 0) return null

  const { models, rates, upstream, realmById } = mergeWorkbuddyCatalogs(entries)
  provider.models = models
  provider.model_rates = rates
  provider.model_rates_at = Date.now()
  provider.model_upstream_id = upstream
  provider.model_realm = realmById
  provider.models_updated_at = Date.now()
  provider.models_source = 'workbuddy'
  // 只有这一轮真的取到了倍率才算成功；否则把上一轮的取数时间留着，
  // 好让界面显示的「取数时间」不会被一次失败刷新成现在（骗人说刚取过）
  const gotRates = Object.values(rates).some((t) => t && Object.keys(t).length)
  if (gotRates) delete provider.model_rates_error
  persistImmediate()
  for (const note of notes) addLog({ type: 'system', detail: `WorkBuddy 模型目录：${note}` })
  return { ok: true, count: provider.models.length, provider }
}

/**
 * 上下文字段名候选：通用协议的上游各写各的，按顺序取第一个有效值。
 *
 * ⚠️ 实测上游**普遍不给**上下文字段：标准 OpenAI 的 /v1/models 只有
 * id/object/owned_by/created；WorkBuddy 的 contextWindow 也几乎不下发
 * （实测国内 0/33 条有），真正给的是 maxInputTokens（国内 31/33）。
 * 所以取不到是常态，交由前端如实显示「未知」，不回落到网关编的默认值。
 */
const CONTEXT_WINDOW_KEYS = [
  'context_length',      // OpenRouter 及一批中转
  'context_window',      // 部分代理
  'max_context_tokens',
  'max_model_len',       // vLLM / 本地后端
  'contextWindow',       // WorkBuddy（可能是对象）
  'contextWindowTokens',
  'maxInputTokens',      // WorkBuddy 实际下发的那个
  'max_input_tokens'
]

/** 从上游一条模型记录取上下文窗口长度（tokens）；取不到返回 null。 */
export function pickContextWindow(raw) {
  const m = raw && typeof raw === 'object' ? raw : {}
  for (const key of CONTEXT_WINDOW_KEYS) {
    const v = m[key]
    if (v === null || v === undefined || v === '') continue
    // WorkBuddy 给的是对象：contextWindow: { defaultLength, ... }
    if (typeof v === 'object') {
      const d = v.defaultLength ?? v.maxLength ?? v.length
      const n = Number(d)
      if (Number.isFinite(n) && n > 0) return Math.floor(n)
      continue
    }
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

/**
 * 上游一条模型记录里的倍率写法。
 *
 * ⚠️ 只认 WorkBuddy 系那套 `credits`（"x0.79" / "x0.71 credits"）——倍率是它家
 * 特有概念。通用 OpenAI /models 标准形态只有 id/object/created/owned_by，不含倍率；
 * 其他中转站的 price/rate 字段语义各异且多为**价格**，误认成倍率会把价格当倍数
 * 显示，比不显示更糟。所以宁缺勿滥：取不到就不带这个字段。
 */
function pickRate(raw) {
  const v = raw?.credits
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s || null
}

/**
 * 把通用协议上游的一条模型记录压成网关内部形状。
 *
 * 只做「认字段」，不做推断：id 有的上游叫 model_name、有的只给 name；
 * 上下文窗口写法更是五花八门（见上面的候选表）。上游没给的一律留空，
 * 前端显示「未知」——不能拿默认值假装上游说过这句话。
 */
function normalizeUpstreamModel(raw, provider) {
  const m = raw && typeof raw === 'object' ? raw : {}
  const id = m.id || m.model_name || m.name
  const out = {
    id: id ? String(id) : '',
    owned_by: m.owned_by || m.display_name || provider?.name || ''
  }
  const ctx = pickContextWindow(m)
  if (ctx !== null) out.context = ctx
  // 倍率：只有上游按 WorkBuddy 那套 credits 写法给了才收，不给就不带这个字段
  const rate = pickRate(m)
  if (rate !== null) out.rate = rate
  return out
}

export async function refreshModels(providerId) {
  const provider = getProvider(providerId)
  if (!provider) return { ok: false, error: '平台不存在' }
  const keys = usableKeys(provider)
  if (keys.length === 0) return { ok: false, error: '该平台尚未配置可用的 Key' }
  const plan = callPlan(provider)

  // WorkBuddy 走独立的目录路径；全部 realm 都取不到时才落到下面的通用逻辑，
  // 让内置清单兜底
  if (isWorkbuddyProtocol(provider.protocol)) {
    const merged = await refreshWorkbuddyCatalog(provider)
    if (merged) return merged
  }

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
      const md = dispatcherFor(provider, key)
      const resp = await fetch(url, {
        method: plan.modelsMethod,
        headers: buildHeaders(provider, plan, token, key),
        signal: controller.signal,
        ...(md ? { dispatcher: md } : {})
      })
      clearTimeout(timer)
      if (resp.ok) {
        const data = await resp.json()
        // OpenAI 形态是 {data:[]}；WorkBuddy 是 {code,msg,data} 信封，且 data
        // 可能是数组、也可能是 {models:[...]}。只认一种形态会把另一些账号的
        // 刷新结果静默成「没模型」。
        const raw = data && data.data !== undefined ? data.data : data
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : []
        // 只生图平台：上游 /v1/models 会把 gpt-5 系一起吐出来，
        // 在这里就剔干净——文本模型一旦进了清单，客户端就能把图片请求
        // 误发到 chat 通道，或者反过来把对话请求打到生图上。
        const models = filterModelsForProvider(provider, list
          .map((m) => normalizeUpstreamModel(m, provider))
          .filter((m) => m.id))
        // 信封报了错就别把空列表当成功——否则刷新会静默清空模型
        if (models.length === 0 && Number.isFinite(Number(data?.code)) && Number(data.code) !== 0) {
          throw new Error(String(data.msg || `上游返回 code=${data.code}`))
        }
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
  // 全部 Key 均不可用：若该协议有内置默认模型，退回默认列表并标注来源，
  // 避免平台因为拉不到 /models 而完全不可用。
  // 只生图平台用自己那份兜底（只有 gpt-image-2），不走 defaultModelsFor——
  // 后者按协议查表，可能给出别的方案的对话模型清单。
  const fallback = provider.image_only
    ? IMAGE_ONLY_FALLBACK_MODELS.map((id) => ({ id, owned_by: provider.name }))
    : defaultModelsFor(provider.protocol)
  if (fallback && fallback.length) {
    provider.models = fallback
    provider.models_updated_at = Date.now()
    provider.models_source = 'default'
    persistImmediate()
    return { ok: true, count: fallback.length, provider, fallback: true }
  }
  // 没有可兜底的清单：如实把清单清空并标注「取不到」。
  // 保留上一轮的清单看起来更友好，但那是拿过期数据冒充现状——
  // 上游已经全挂了，界面上继续显示旧型号会让人以为还能用。
  provider.models = []
  provider.models_updated_at = Date.now()
  provider.models_source = 'unavailable'
  persistImmediate()
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
  if (!target.base_url) return { ok: false, error: '请先填写 API 地址' }
  if (!target.api_key) {
    return { ok: false, error: '请先填写 API 地址与 API Token' }
  }
  const plan = callPlan(target)
  const url = joinUrl(target.base_url, plan.modelsPath, queryAuth(plan, target.api_key))
  const headers = mergeAuthAndCustomHeaders(target.extra_headers, plan, target.api_key)
  const controller = new AbortController()
  let timer = null
  try {
    timer = setTimeout(() => controller.abort(), 30000)
    // previewModels 拿不到具体 Key（只拿到平台配置），所以只按平台级代理走
    const pd = dispatcherFor(target, null)
    const resp = await fetch(url, {
      method: plan.modelsMethod,
      headers,
      signal: controller.signal,
      ...(pd ? { dispatcher: pd } : {})
    })
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
    const models = (data.data || []).map((m) => normalizeUpstreamModel(m, null))
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

// 混载平台里模型可能只属于某个 realm，拿别的 realm 的账号发过去只会拿到
// 跨域的非 JSON 401。这里只按 realm 挑 Key，不负责冷却判断——该 realm 的
// Key 全在冷却时原样返回，交给上层的冷却逻辑处理，别把请求直接判死。
export function workbuddyKeysForModel(provider, model, keys) {
  const want = provider?.model_realm?.[String(model || '')]
  if (!want) return keys
  const same = keys.filter((k) => workbuddyRealmFor(k.domain) === want)
  return same.length > 0 ? same : keys
}

async function forwardWithFailover(provider, kind, body, res) {
  let keys = usableKeys(provider)

  if (isWorkbuddyProtocol(provider.protocol) && provider.model_realm) {
    keys = workbuddyKeysForModel(provider, body?.model, keys)
  }

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
  // 账号级拒绝（11128/11140）的 code/msg：本轮第一次读到后存到这里，
  // 后续轮不再读上游错误体（要保住透传路径的响应流），沿用这组值
  let rejectCode = null
  let rejectMsg = ''
  // 11128 的内容级兜底只做一次：中性化 system 之后若仍是 11128，那就是真的
  // 账号闸门或别的原因，再改内容也没意义，直接走原有失败路径。
  let contentNeutralRetried = false
  // 11128 风控窗口的原地重试计数（按 Key）。窗口是秒级的，等一下就过，
  // 所以换 Key / 冷却都不对——只在同一个 Key 上等一小会儿再试。
  const reject11128Retries = new Map()
  const REJECT_11128_RETRY_MAX = 3
  const REJECT_11128_RETRY_DELAY_MS = 900

  /**
   * 11128 的内容级兜底：把 system 换成中性文本，重新序列化请求体。
   * 返回 true 表示确实改过，调用方应 `i -= 1; continue` 重试同一个 Key。
   *
   * **默认关闭**，因为线上证据表明它多数时候救不了场：2026-10-29 12:46~12:50
   * 连续 8 次兜底（每次都换成中性 system 重试）全部仍然 11128；4 分钟后同一批
   * Key 用原始 persona 直接 200 —— 那段时间拦的是出口 IP / 通道，不是内容。
   * 这种情形下静默改写 system 是纯损失：用户的 persona 被悄悄换掉，请求照样失败。
   *
   * 需要时用 WORKBUDDY_NEUTRALIZE_ON_11128=1 打开（内容确属敏感时才有用）。
   * 打开后仍只做一次，原文进日志。
   */
  function neutralizeForRetry() {
    if (process.env.WORKBUDDY_NEUTRALIZE_ON_11128 !== '1') return false
    if (contentNeutralRetried) return false
    if (rejectCode !== 11128) return false
    if (kind !== 'chat' || !isWorkbuddyProtocol(provider.protocol)) return false
    if (!Array.isArray(body?.messages)) return false
    const sysText = collectWorkbuddySystemText(body)
    if (!neutralizeWorkbuddySystem(body)) return false
    contentNeutralRetried = true
    console.warn(
      '[11128 内容级] 已按开关把 system 换成中性文本重试（WORKBUDDY_NEUTRALIZE_ON_11128=1）。' +
      `原 system 前 200 字：${sysText.slice(0, 200)}`
    )
    upstreamBody = serializeUpstreamBody(provider, body)
    return true
  }
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
      const dispatcher = dispatcherFor(provider, key)
      const resp = await fetch(upstream, {
        method: kind === 'chat' || kind === 'images' ? 'POST' : plan.modelsMethod,
        headers: buildHeaders(provider, plan, token, key),
        body: upstreamBody,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      })
      // 诊断开关：只在上游回 400 时把「我方真实发出的请求」打出来。
      // 11128 反复排查时，靠猜请求体与请求头一直对不上线上现象——只有把实际
      // 发出去的那一份留证才能定位。Authorization 与 token 一律脱敏。
      // 用 WORKBUDDY_DEBUG_DUMP=1 打开，排查完关掉。
      if (process.env.WORKBUDDY_DEBUG_DUMP === '1' && isWorkbuddyProtocol(provider.protocol) && kind === 'chat') {
        try {
          const b = typeof upstreamBody === 'string' ? JSON.parse(upstreamBody) : (upstreamBody || {})
          const msgs = Array.isArray(b.messages) ? b.messages : []
          const hasImage = msgs.some((m) => Array.isArray(m?.content))
          const sysLen = msgs
            .filter((m) => String(m?.role || '').toLowerCase() === 'system')
            .reduce((n, m) => n + String(m?.content || '').length, 0)
          // 摘要行：成功与失败都记，靠 status 对比才能看出「哪种请求会被拦」
          console.warn(
            `[wb-dump] status=${resp.status} model=${b.model} msgs=${msgs.length} sysLen=${sysLen}` +
            ` tools=${(b.tools || []).length} multi=${hasImage} bytes=${String(upstreamBody).length}` +
            ` stream=${b.stream} max_tokens=${b.max_tokens ?? '-'}`
          )
          if (resp.status === 400) {
            const sent = buildHeaders(provider, plan, token, key)
            const shown = Object.fromEntries(Object.entries(sent).map(([k2, v]) => [
              k2,
              /authorization|token|api-key|cookie/i.test(k2) ? '***masked***' : String(v).slice(0, 120)
            ]))
            console.warn(`[wb-dump] 400 url=${upstream}`)
            console.warn(`[wb-dump] 400 headers=${JSON.stringify(shown)}`)
            console.warn(`[wb-dump] 400 body=${String(upstreamBody).slice(0, 3000)}`)
          }
        } catch { /* 诊断失败不影响主流程 */ }
      }
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
      //
      // 账号级拒绝（11128/11140）例外：换 Key 大概率就好，重试预算放宽到
      // ACCOUNT_REJECT_RETRY_MAX 次，并把上游 code/msg 写进每个被拒 Key 的
      // last_error（不冷却）——只记「HTTP 400」的话 11128 与 11140 在界面上
      // 无法区分，排查时无从下手。错误体只在本轮第一次读（判断 + 记录 + 自适应
      // 都用它），读到的 code/msg 存到循环外供后续轮沿用：同一批闸门/风控
      // 拒绝的 code 相同，不必每轮再读。后续轮不读 body，预算用尽那次、
      // 以及普通 400 的第二次，响应流都没被消费过，下面 started=true 的
      // 透传路径（流式/非流式）行为与原逻辑完全一致。
      const sawAccountReject = attempts.some((a) => a.includes('账号级拒绝'))
      const rejectTried = attempts.filter((a) => a.includes('账号级拒绝')).length
      const rejectBudgetLeft = rejectTried < ACCOUNT_REJECT_RETRY_MAX
      // 同一个 Key 正在做 11128 原地重试：这条路径不往 attempts 里写「账号级拒绝」
      // （否则会白白吃掉换 Key 的预算），所以必须单独放行，否则第二轮进不了下面
      // 读 body 的分支 → accountReject 判不出来 → 直接把 400 透传给客户端。
      const retrying11128 = rejectCode === 11128 && (reject11128Retries.get(key.id) || 0) > 0

      // —— 11128 的第二种成因：内容级指纹 ——
      //
      // 11128 有两个来源，换 Key 只对第一个有效：
      //   1. 账号级灰度闸门：按账号挑，换号能跨过一批（ACCOUNT_REJECT_RETRY_MAX 就是为它设的）；
      //   2. **system 里的内容**：腾讯按字面量/敏感内容拦，换哪个号都拦——换个号只是
      //      把整个池子按顺序打穿一遍，最后仍然把 400 透传给客户端。
      //
      // 实测（2026-10-29，同一账号 / 同一套头 / 同一模型，只换 system 一句话）：
      //   'You are a helpful assistant.'                        → 200
      //   'Main branch (you will usually use this for PRs)'      → 400 code=11128
      //   'Main branch (PRs usually go here)'                    → 200
      //   'Main branch (you will normally use this for PRs)'     → 200  ← 只差一个词就放行
      // 后两条同时说明：这是逐字符字面量匹配，不是关键词；改对了就通。
      //
      // 线上真实样本（2026-10-29）：某客户端把一整段「永不服软」式的 persona 塞进
      // system，同样被 11128 拦下——这类内容与渠道校验无关，但只要出现在 system 里
      // 就会被判非法调用。所以不能只盯着「模板句」名单，必须留一条不改名单也能放行的路。
      //
      // 换到第 2 个 Key 仍然 11128 时不再继续烧账号，改用中性 system 重试一次。
      // 丢掉 system 是有损的，但比「客户端彻底失败」强，原文会打进日志。
      if (resp.status === 400 && rejectTried >= 1 && neutralizeForRetry()) {
        attempts.push(`${key.name || key.id.slice(0, 8)}: 11128 疑似内容级（system 中性化后重试）`)
        i -= 1 // 重试同一个 Key：账号不该为一句 system 背锅
        continue
      }

      if (resp.status === 400 && (attempts.length < 1 || retrying11128 || (sawAccountReject && rejectBudgetLeft))) {
        const firstRead = !sawAccountReject
        let errText = ''
        if (firstRead) {
          try {
            let readTimer
            errText = await Promise.race([
              resp.text(),
              new Promise((_, rej) => { readTimer = setTimeout(() => rej(new Error('读取错误体超时')), 5000) })
            ]).finally(() => clearTimeout(readTimer))
            try {
              const ej = JSON.parse(errText)
              const code = Number(ej?.code) || null
              if (UPSTREAM_ACCOUNT_REJECT_CODES.has(code)) {
                rejectCode = code
                rejectMsg = String(ej?.msg || ej?.displayMsg?.zh || '')
              }
            } catch { /* 非 JSON 错误体，按普通 400 处理 */ }
          } catch { /* 读不到错误体则按普通瞬时 400 重试 */ }
        }
        const accountReject = firstRead
          ? rejectCode !== null
          : true // 上一轮已确认是账号级拒绝，本轮沿用同样策略继续换 Key
        if (accountReject) {
          // 11128 可能是 system 内容指纹，而内容指纹只能靠「原句」加进
          // CONTENT_FINGERPRINTS 才能无损修掉。兜底分支只在连撞两个 Key 时
          // 记录原文，只撞一次就换号放过的那句会被永久漏掉——所以这里在
          // 第一次读到 11128 时就把 system 留证，与兜底是否触发无关。
          if (firstRead && rejectCode === 11128 && isWorkbuddyProtocol(provider.protocol) && Array.isArray(body?.messages)) {
            const sysText = collectWorkbuddySystemText(body)
            if (sysText) console.warn(`[11128 指纹留证] system 前 200 字：${sysText.slice(0, 200)}`)
          }

          // —— 11128 的真实成因：出口 IP 的秒级风控窗口 ——
          //
          // 2026-10-29 线上证据（同一台机器、同一批 Key）：
          //   05:17:22~05:17:59  15 个请求全 200
          //   05:19:02~05:19:11   连续 4 次全 400 / 11128
          //   05:20 之后          各种规模的请求（含 350 KB、154 消息、77 工具）全 200
          //
          // 把「消息数 2~154 / tools 0~77 / 体积 318B~350KB / 敏感内容 27KB /
          // 多模态 / role:tool / 并发 8 路」逐维复刻，全部 200 —— 说明拦的不是
          // 请求形态，而是一个按 IP 计的、几秒到几十秒的风控窗口。
          //
          // 所以窗口内换 Key 毫无意义（拦的是 IP，不是账号），冷却更是反效果
          // （窗口几秒就过，冷却 30 秒等于自己把平台多冻了一会儿）。
          // 正确做法：原地等一小会儿再试同一个 Key，窗口一过就通。
          const tried = reject11128Retries.get(key.id) || 0
          if (rejectCode === 11128 && tried < REJECT_11128_RETRY_MAX) {
            reject11128Retries.set(key.id, tried + 1)
            key.last_error = `HTTP 400 code=11128（风控窗口，第 ${tried + 1} 次原地重试）`.slice(0, 200)
            key.last_error_at = Date.now()
            addLog({
              type: 'system', method: 'POST', path: '/upstream',
              status: 400,
              detail: `11128 风控窗口：${key.name || key.id.slice(0, 8)} 等待 ${REJECT_11128_RETRY_DELAY_MS}ms 后原地重试（${tried + 1}/${REJECT_11128_RETRY_MAX}）`
            })
            await new Promise((r) => setTimeout(r, REJECT_11128_RETRY_DELAY_MS))
            attempts.push(`${key.name || key.id.slice(0, 8)}: 11128 风控窗口，原地重试`)
            i -= 1
            continue
          }

          // 真实原因落到这个 Key 上（不冷却：400 不是凭据失效，下一轮还会轮到它，
          // 持续命中时界面上能看到，而不是每次都被覆盖成干巴巴的「HTTP 400」）
          key.last_error = `HTTP 400 code=${rejectCode} ${rejectMsg}`.slice(0, 200)
          key.last_error_at = Date.now()
          persist()
          const codeHint = firstRead ? ` code=${rejectCode}` : ''
          attempts.push(`${key.name || key.id.slice(0, 8)}: HTTP 400（账号级拒绝${codeHint}，换 Key 重试）`)
          bumpFailover()
          continue
        }
        let clamped = null
        let droppedTemperature = false
        const m = errText?.match(/should be in\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/)
        const cur = body?.max_tokens
        if (m && Number.isFinite(cur)) {
          clamped = Math.min(Math.max(Math.floor(cur), +m[1]), +m[2])
          if (clamped !== cur) body.max_tokens = clamped
        }
        // 有的模型只接受 temperature=1（商汤 kimi-k3 直接 400 拒掉其他取值，
        // 而测试面板默认发 0.7）。剥掉该字段再试一次——省略时上游用自身默认值，
        // 实测 kimi-k3 放行。客户端无感知，不必为了迁就单个模型改自己的参数。
        if (body && typeof body.temperature !== 'undefined' && TEMPERATURE_REJECTED_RE.test(errText || '')) {
          delete body.temperature
          droppedTemperature = true
        }
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
      // 账号级拒绝撞满预算：透传给客户端前，把真实原因也记到这个 Key 上
      // （code/msg 沿用之前轮次读到的值，不再读本次 body——透传路径的响应流要保住）
      if (resp.status === 400 && sawAccountReject && rejectCode !== null) {
        // 最后一班车：只有 1 个 Key 可用、或前面已经用光换号预算时，上面那个
        // rejectTried >= 1 的分支根本没机会执行，内容级请求就会直接透传 400。
        // 走到这里已经确定「换号救不了」，所以无条件试一次中性化。
        if (neutralizeForRetry()) {
          attempts.push(`${key.name || key.id.slice(0, 8)}: 11128 疑似内容级（中性化后末次重试）`)
          i -= 1
          continue
        }
        key.last_error = `HTTP 400 code=${rejectCode} ${rejectMsg}`.slice(0, 200)
        key.last_error_at = Date.now()
        persist()
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

/**
 * 对外模型名：`GLM-5.3 · x0.79`。
 *
 * 倍率是上游（WorkBuddy 系 credits）给的事实，直接拼进名字文本——
 * 不是独立字段。名字只取一个：优先上游给的 name，没有才退回 id。
 * 上游没给倍率（多数 OpenAI 兼容 /models 只有 id/owned_by）就光名字，
 * 不写「未给倍率」——那是拿网关的判断冒充上游事实。
 */
function publicModelName(m) {
  const base = String(m?.name || m?.id || '').trim()
  const rate = publicRateText(m?.rate, m?.rate_discounted)
  return rate ? `${base} · ${rate}` : base
}

/** 倍率展示文本：剥掉 credits 单位只留数值（"x2.20 credits" → "x2.20"），
 *  有促销价时用箭头标出（x0.17→x0.50）。取不到返回空串。 */
function publicRateText(rate, discounted) {
  const label = (v) => {
    const raw = String(v ?? '').trim()
    const mm = raw.match(/^[xX×]?(\d+(?:\.\d+)?)/)
    return mm ? `x${mm[1]}` : raw
  }
  const base = rate === null || rate === undefined || rate === '' ? '' : label(rate)
  if (!base) return ''
  if (discounted === null || discounted === undefined || discounted === '') return base
  const shown = /^\d|^[xX×]/.test(String(discounted)) ? label(discounted) : String(discounted)
  return `${base}→${shown}`
}

// 一条模型输出的信息完整度：同名 label 重复时（极少见），保留信息最全的。
function modelEntryScore(m, label) {
  let s = 0
  if (publicRateText(m?.rate, m?.rate_discounted)) s += 2
  if (m?.name && m.name !== m.id) s += 1
  return s
}

// 模型聚合列表。
// 必须按调用方的 Key 权限裁剪：这份列表是客户端挑选模型的唯一依据，
// 若把没授权的模型也列出来，用户只会得到一串必然 403 的名字，
// 而且从调用方视角根本看不出是权限问题还是平台问题。
export function handleModels(req, res) {
  // 按**输出 label**（`GLM-5.3 · x0.79`）去重，不按真实 id：国内外平台
  // 常有同名 id 不同倍率的模型（国际版 deepseek-v4.1-flash 是 x0.00，
  // 国内版同名是 x0.11），按真实 id 去重会把其中一条整条吞掉，
  // 用户直接拉不到。倍率不同就是两个可选项，都该出现在列表里。
  const best = new Map()
  for (const p of state.providers) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (!modelAllowed(req?.apiAuth, m.id).allowed) continue
      // id 直接带倍率（`GLM-5.3 · x0.79`）：客户端拉清单一律拿 id 当
      // 显示名，倍率写在 name 里它们根本不看。调用时 resolveTarget 会
      // 把后缀剥掉、按显示名找回真实 id，路由不受影响。
      const label = publicModelName(m)
      const entry = { id: label, object: 'model', owned_by: m.owned_by || p.name, provider: p.id, provider_name: p.name, name: label }
      const prev = best.get(label)
      if (!prev || modelEntryScore(m, label) > prev.score) best.set(label, { ...entry, score: modelEntryScore(m, label) })
    }
  }
  const list = [...best.values()].map(({ score, ...e }) => e)
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ object: 'list', data: list }))
}
