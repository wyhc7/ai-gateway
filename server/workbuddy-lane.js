// WorkBuddy / CodeBuddy（腾讯）订阅通道
//
// 上游是「长得像 OpenAI、但每条规矩都自己定」的接口：形态可以透传，前提条件不行。
// 这个文件收拢所有与形态有关的整形，别让它们散落到 proxy.js 的主流程里。
//
// 事实来源：腾讯 CodeBuddy 的 CLI 接入端点。参考实现见
// https://github.com/zidanefaqih/codebuddy-intl-cpa（MIT，其 workbuddy/ 插件）
// —— 下面每条约束都对应那边 live-verified 过的实测记录，不是照着文档猜的。
//
// 一句话概括这套上游：**可以照 OpenAI 发，但必须先抹掉所有「不像它家客户端」的痕迹**。

// Global 账号的对话/鉴权网关。
// 注意与计费网关是两个域：计费与成长中心在 workbuddy.ai，对话必须走 codebuddy.ai。
// 把 Global 凭据发到 CN 网关（copilot.tencent.com）会拿到非 JSON 的 401，
// 在网关里表现成 "parse failed: invalid character '<'" —— 极难从报错反推是域名选错了。
export const WORKBUDDY_CHAT_BASE = 'https://www.codebuddy.ai'
export const WORKBUDDY_BILLING_BASE = 'https://www.workbuddy.ai'

// 上游要求客户端自称是 CodeBuddy CLI。缺了这个头会被认成外部渠道，
// 与 role:developer 那条 11128 是同一类拦截。
export const WORKBUDDY_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

// 官方模型清单。
//
// 为什么不完全依赖上游 /models：
//  1. 上游返回的是 {code,msg,data} 信封，不是 OpenAI 的 {data:[]}；
//  2. 更关键的是它会漏报 —— 下面 8 个「隐藏模型」上游其实照收不误，
//     只是自己的客户端界面不展示。少了这批就等于白接了半个通道。
// 其中 gpt-6-astra 是 2026-09-29 在 Global 账号上实测 200 的（按 gpt-6-astra 计费 0.04 分）。
export const WORKBUDDY_CURATED_MODELS = [
  { id: 'glm-5.2', owned_by: 'workbuddy' },
  { id: 'glm-5.1', owned_by: 'workbuddy' },
  { id: 'glm-5v-turbo', owned_by: 'workbuddy' },
  { id: 'kimi-k2.7', owned_by: 'workbuddy' },
  { id: 'kimi-k3', owned_by: 'workbuddy' },
  { id: 'minimax-m3', owned_by: 'workbuddy' },
  { id: 'hy3', owned_by: 'workbuddy' },
  { id: 'hy3-preview', owned_by: 'workbuddy' },
  { id: 'hy3-preview-agent', owned_by: 'workbuddy' },
  { id: 'deepseek-v4-pro', owned_by: 'workbuddy' },
  { id: 'deepseek-v4-flash', owned_by: 'workbuddy' },
  // —— 以下为上游漏报的隐藏模型 ——
  { id: 'gpt-5.6-luna', owned_by: 'workbuddy' },
  { id: 'claude-opus-5', owned_by: 'workbuddy' },
  { id: 'gpt-5.6-sol', owned_by: 'workbuddy' },
  { id: 'glm-5.3', owned_by: 'workbuddy' },
  { id: 'gpt-5.6-terra', owned_by: 'workbuddy' },
  { id: 'deepseek-v4.1-flash', owned_by: 'workbuddy' },
  { id: 'glm-5.3-flash', owned_by: 'workbuddy' },
  { id: 'gpt-6-astra', owned_by: 'workbuddy' }
]

export function isWorkbuddyProtocol(protocol) {
  return protocol === 'workbuddy-oauth'
}

// X-Domain 必须是账号所属的 realm。国际账号是 workbuddy.ai 或 codebuddy.ai，
// 国内账号是 codebuddy.cn。选错 realm 的下文见文件头注释。
export function normalizeWorkbuddyDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return d || 'workbuddy.ai'
}

// 按 Key 注入的请求头。三个值都随账号变化，不能收进平台级 extra_headers：
// 换一个 Key 就换一个 uid 与 realm，放平台级会让多账号轮换时用错身份。
export function workbuddyHeaders(key = {}) {
  return {
    'X-User-Id': String(key.uid || ''),
    'X-Domain': normalizeWorkbuddyDomain(key.domain),
    'User-Agent': WORKBUDDY_UA,
    Referer: `${WORKBUDDY_CHAT_BASE}/`
  }
}

// ---------------------------------------------------------------------------
// 请求体整形
// ---------------------------------------------------------------------------

// tool_choice 只在上游是 string 类型。OpenAI 的对象形态
// {"type":"function","function":{"name":"x"}} 会报 400 code 11101。
// 另外 "none" 上游虽然接受，但只要 tools 非空模型照样吐 tool_calls ——
// 想真正抑制工具只能整份删掉 tools。
export function normalizeWorkbuddyTools(obj) {
  const drop = () => {
    delete obj.tools
    delete obj.functions
  }
  if (!('tool_choice' in obj)) return false
  const tc = obj.tool_choice

  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      drop()
      return true
    }
    return false // auto / required / 具体函数名，原样放行
  }
  if (tc && typeof tc === 'object') {
    const typ = String(tc.type || '').trim().toLowerCase()
    if (typ === 'auto' || typ === 'required') {
      obj.tool_choice = typ
      return true
    }
    if (typ === 'function') {
      const name = String(tc.function?.name || tc.name || '').trim()
      obj.tool_choice = name || 'auto'
      return true
    }
    if (typ === 'none') {
      delete obj.tool_choice
      drop()
      return true
    }
    // 认不出的对象形态：丢掉而不是转发出去换一个 400
    delete obj.tool_choice
    return true
  }
  // null / 数组 / 数字
  delete obj.tool_choice
  return true
}

// role: "developer" 会被上游以 code 11128 拒掉（"Illegal API invocation from an
// unapproved channel"）。首条消息只认 system，其余一律改成 system 保平安。
export function normalizeWorkbuddyRoles(obj) {
  let changed = false
  for (const m of Array.isArray(obj.messages) ? obj.messages : []) {
    if (m && typeof m === 'object' && String(m.role || '').trim().toLowerCase() === 'developer') {
      m.role = 'system'
      changed = true
    }
  }
  return changed
}

// Global 账号收到纯 user 消息会报 11101 "Parse message failed"。补一条无害的
// system 消息把两边路径统一 —— CN 不要求但容忍，所以无脑补不会踩雷。
export function ensureWorkbuddySystemMessage(obj) {
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return false
  if (msgs.some((m) => m && String(m.role || '').toLowerCase() === 'system')) return false
  msgs.unshift({ role: 'system', content: 'You are a helpful assistant.' })
  return true
}

// hy3 系模型只在 reasoning_effort === "high" 时才真的深度思考，
// medium/low/max/xhigh/ultra 一律退化成不思考。上游只认这一个值，别让客户端设置。
export function forceWorkbuddyMaxThinking(obj) {
  const model = String(obj.model || '')
  if (!model.startsWith('hy3')) return false
  if (obj.reasoning_effort === 'high') return false
  obj.reasoning_effort = 'high'
  return true
}

// 单次 unmarshal/marshal 完成全部整形。上游拒绝非流式请求，所以 stream 一律强制打开。
export function shapeWorkbuddyBody(body = {}) {
  const obj = { ...body }
  obj.stream = true
  normalizeWorkbuddyTools(obj)
  normalizeWorkbuddyRoles(obj)
  ensureWorkbuddySystemMessage(obj)
  forceWorkbuddyMaxThinking(obj)
  return obj
}
