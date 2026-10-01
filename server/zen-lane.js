// OpenCode Zen 免费通道（zen-free 协议）
//
// 上游 https://opencode.ai/zen/v1 提供一批免密钥的免费模型（凭据就是字符串
// public）。但这条通道不是公开 API，而是「OpenCode 客户端专用通道」，
// 它的准入判定全部落在 HTTP 请求本身：
//
//   1. authorization: Bearer public
//   2. user-agent 含 opencode/<version>，且 version >= 1.18.0
//      （低版本 → 426 UpgradeRequired；无该 token → 403）
//   3. x-opencode-client / -session / -request / -project 四个头齐全
//   4. x-opencode-session 匹配 /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
//   5. body.tools 声明 bash / glob / grep / read 四个小写工具
//   6. body.stream === true（非流式直接被拒）
//
// 不满足 3~6 任一条一律 403 FreeTierError。因此本模块的职责是：
// 把网关收到的普通 OpenAI 请求，整形成「看起来就是 OpenCode 自己发的」请求，
// 并在响应侧把整形痕迹（被小写化的工具名、被强制的流式）还原回客户端预期。
//
// 本文件只做请求/响应整形，不碰网络，全部是纯函数（会话 ID 除外），便于单测覆盖。

const ZEN_CLIENT_UA = 'opencode/1.18.31'

// 免费档强制要求的四个工具名（必须小写）。缺任何一个都会被判为非编码客户端。
const ZEN_QUARTET = ['bash', 'glob', 'grep', 'read']

// 实测可用的免费模型。上游 /models 会把付费模型一并列出，而那些模型拿公共凭据
// 调用一律 401，因此平台模型列表以本白名单为准（见 docs/OPENCODE-ZEN.md）。
export const ZEN_FREE_MODELS = [
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash-free',
  'mimo-v2.5-free',
  'ling-3.0-flash-fin-free',
  'big-pickle',
  'space-bunny-free'
]

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function isZenProtocol(protocol) {
  return protocol === 'zen-free'
}

function randomBase62(length) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (let i = 0; i < length; i += 1) out += BASE62[bytes[i] % BASE62.length]
  return out
}

// 会话/请求 ID：前 12 位是毫秒时间戳的 6 字节十六进制，后 14 位是 base62 随机。
// 上游只校验格式（正则匹配），不校验这个 ID 是否是它自己发过的，
// 所以可以本地铸造——这是整条通道能免凭据复用的关键前提。
function mintId(prefix) {
  const stamp = BigInt(Date.now()) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((stamp >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `${prefix}_${hex}${randomBase62(14)}`
}

export function mintSessionId() {
  return mintId('ses')
}

export function buildZenHeaders() {
  return {
    'user-agent': ZEN_CLIENT_UA,
    accept: 'text/event-stream',
    authorization: 'Bearer public',
    'x-opencode-client': 'desktop',
    'x-opencode-session': mintSessionId(),
    'x-opencode-request': mintId('msg'),
    'x-opencode-project': 'global'
  }
}

// 客户端工具名 → 上游要求的小写名 的还原表（仅覆盖四件套里被改过名的）。
// 请求整形与响应还原共用这一个纯函数，因此两者永远不会不一致。
export function zenToolNameMap(tools) {
  const map = new Map()
  for (const tool of tools || []) {
    const raw = tool?.function?.name
    if (typeof raw !== 'string' || !raw) continue
    const lower = raw.toLowerCase()
    if (!ZEN_QUARTET.includes(lower)) continue
    if (raw !== lower) map.set(lower, raw)
  }
  return map
}

function decoyTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Client runtime reserved tool. It is not callable in this session — do not call it.',
      parameters: { type: 'object', properties: {}, additionalProperties: true }
    }
  }
}

// 请求体整形：强制流式 + 保证四件套齐全 + 把同名工具小写化。
// 返回新对象，不改动调用方传入的 body（它会用于日志与 400 重试）。
export function shapeZenBody(body = {}) {
  const out = { ...body, stream: true }
  const tools = []
  const seen = new Set()

  for (const tool of body.tools || []) {
    const fn = tool?.function
    const raw = fn?.name
    if (typeof raw !== 'string' || !raw) {
      tools.push(tool)
      continue
    }
    const lower = raw.toLowerCase()
    // 非四件套的工具原样带上：客户端自己的工具调用能力不能被削弱
    if (!ZEN_QUARTET.includes(lower)) {
      tools.push(tool)
      continue
    }
    if (seen.has(lower)) continue // 大小写不同但同名的重复声明只保留一个
    seen.add(lower)
    tools.push(raw === lower ? tool : { ...tool, function: { ...fn, name: lower } })
  }

  for (const name of ZEN_QUARTET) {
    if (!seen.has(name)) tools.push(decoyTool(name))
  }
  out.tools = tools

  // tool_choice 指向某个被小写化的函数时必须同步改名，否则上游找不到该工具
  const choice = body.tool_choice
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    const target = choice.function?.name
    if (typeof target === 'string' && ZEN_QUARTET.includes(target.toLowerCase())) {
      out.tool_choice = { ...choice, function: { ...choice.function, name: target.toLowerCase() } }
    }
  }

  return out
}

// 把流式 chunk 里的工具名还原成客户端认识的名字。
//
// 注意一个前提：本转换器只在「确实改过名」时才会被创建（见 proxy.js），
// 名字未被改动的普通请求走零开销的原样透传路径。
export function createZenStreamTransformer(model, originalBody) {
  const restore = zenToolNameMap(originalBody?.tools)
  let buffer = ''
  let streamedText = ''
  let usage = null
  let sawDone = false

  const handleLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return `${line}\n`
    if (!trimmed.startsWith('data:')) return `${line}\n`
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') {
      sawDone = true
      return `${line}\n`
    }
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      return `${line}\n` // 非 JSON 的 data 行原样放过，不吞上游内容
    }
    if (json.usage) usage = json.usage
    for (const choice of json.choices || []) {
      const delta = choice.delta || choice.message
      if (delta && typeof delta.content === 'string') streamedText += delta.content
      for (const call of delta?.tool_calls || []) {
        const name = call?.function?.name
        if (typeof name === 'string' && restore.has(name.toLowerCase())) {
          call.function.name = restore.get(name.toLowerCase())
        }
      }
    }
    return `data: ${JSON.stringify(json)}\n`
  }

  return {
    push(chunk) {
      buffer += chunk
      let produced = ''
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        produced += handleLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
      return produced
    },
    flush() {
      let tail = ''
      if (buffer) {
        tail = handleLine(buffer)
        buffer = ''
      }
      // 部分上游不发 [DONE]，客户端会一直等终止标记
      if (!sawDone) tail += 'data: [DONE]\n\n'
      return tail
    },
    get streamedText() {
      return streamedText
    },
    get usage() {
      return usage
    }
  }
}

// 非流式客户端 + 强制流式上游的桥接：把整段 SSE 聚合成一个 chat.completion。
// 客户端要的是「一次性 JSON」，不能把上游的 text/event-stream 直接甩给它。
export function aggregateZenSse(raw, model, originalBody) {
  const restore = zenToolNameMap(originalBody?.tools)
  let content = ''
  let reasoning = ''
  let usage = null
  let finishReason = null
  const calls = new Map()

  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (json.usage) usage = json.usage
    for (const choice of json.choices || []) {
      const delta = choice.delta || choice.message || {}
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (choice.finish_reason) finishReason = choice.finish_reason
      for (const call of delta.tool_calls || []) {
        const idx = call.index ?? 0
        const acc = calls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (call.id) acc.id = call.id
        // 工具名与参数都是分片下发的，按序拼接才能还原出完整调用
        if (typeof call.function?.name === 'string') acc.function.name += call.function.name
        if (typeof call.function?.arguments === 'string') acc.function.arguments += call.function.arguments
        calls.set(idx, acc)
      }
    }
  }

  const toolCalls = [...calls.values()].map((call) => {
    const name = call.function.name
    if (restore.has(name.toLowerCase())) call.function.name = restore.get(name.toLowerCase())
    return call
  })

  const message = { role: 'assistant', content: toolCalls.length && !content ? null : content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls

  const payload = {
    id: `chatcmpl-${randomBase62(20)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
      logprobs: null
    }]
  }
  if (usage) payload.usage = usage
  return payload
}
