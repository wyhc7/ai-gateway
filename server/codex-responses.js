// Codex（ChatGPT 订阅账号）的 Responses API 与 OpenAI chat/completions 互转
//
// 网关对外暴露的是 chat/completions（客户端生态全在这边），
// 而 Codex 订阅账号的上游是 https://chatgpt.com/backend-api/codex/responses，
// 走的是 Responses API——请求体是 input[] 而不是 messages[]，
// 响应体是 output[] 而不是 choices[]，流式事件名也完全不同。
// 不转换的话客户端拿到的是一堆看不懂的 response.* 事件。
//
// 本文件只做格式转换，不碰网络，全部是纯函数，方便单测覆盖。

const FINISH_REASON_MAP = {
  completed: 'stop',
  incomplete: 'length',
  failed: 'stop',
  cancelled: 'stop'
}

// Responses 上游明确拒绝的参数（Codex 兼容层不支持采样参数与工具调用）。
// 带过去会直接 400，这里统一丢掉。
const UNSUPPORTED_PARAMS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'n',
  'seed',
  'stop',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'logit_bias'
])

function textFromContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
          return part.text || ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

// OpenAI 的多模态 content 数组 → Responses 的 content parts
function toResponsesContent(content, role) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content

  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'input_text', text: part })
      continue
    }
    if (part?.type === 'text') {
      parts.push({ type: 'input_text', text: part.text || '' })
      continue
    }
    if (part?.type === 'image_url') {
      // OpenAI 是 image_url: { url }，Responses 平铺成 image_url 字符串
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (url) parts.push({ type: 'input_image', image_url: url })
    }
  }
  return parts.length ? parts : ''
}

/**
 * chat/completions 请求体 → Responses 请求体
 *
 * - system 消息拆到 instructions（Responses 里 system 不是 input 的一项）
 * - messages → input
 * - max_tokens / max_completion_tokens → max_output_tokens
 * - 采样参数与工具调用被上游拒绝，直接丢弃
 */
export function toCodexRequest(body = {}) {
  const { messages, ...rest } = body
  const list = Array.isArray(messages) ? messages : []

  let instructions = ''
  const input = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'system' || m.role === 'developer') {
      // 多段 system 合并，用空行分隔，保持语义不丢
      instructions = instructions ? `${instructions}\n\n${textFromContent(m.content)}` : textFromContent(m.content)
      continue
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const item = { role, content: toResponsesContent(m.content, role) }
    if (m.name) item.name = m.name
    if (role === 'assistant' && m.tool_calls) {
      // Codex 上游不支持工具，但保留字段无副作用——有实现会忽略未知字段
      item.tool_calls = m.tool_calls
    }
    input.push(item)
  }

  const out = {
    model: body.model,
    input,
    // 订阅账号的对话没必要在 OpenAI 侧留存，显式关掉 store
    store: false,
    stream: Boolean(body.stream)
  }
  if (instructions) out.instructions = instructions

  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_output_tokens = Math.floor(maxTokens)

  // 其余字段照带（model/stream 已在 out 里，messages 已消费），但剔除上游不支持的
  for (const [k, v] of Object.entries(rest)) {
    if (UNSUPPORTED_PARAMS.has(k)) continue
    if (k === 'model' || k === 'stream') continue
    if (k === 'max_tokens' || k === 'max_completion_tokens') continue
    out[k] = v
  }

  // 空 input 会让上游直接 400，兜一个占位，至少返回明确错误而不是连接层异常
  if (out.input.length === 0) {
    out.input = [{ role: 'user', content: ' ' }]
  }
  return out
}

function extractTextAndReasoning(output) {
  let text = ''
  let reasoning = ''
  for (const item of Array.isArray(output) ? output : []) {
    if (!item) continue
    if (item.type === 'message') {
      text += textFromContent(item.content)
    } else if (item.type === 'reasoning') {
      // reasoning 的正文在 summary 里，是 {type:'summary_text', text} 的结构
      for (const s of item.summary || []) {
        if (typeof s === 'string') reasoning += s
        else if (s?.text) reasoning += s.text
      }
    }
  }
  return { text, reasoning }
}

function mapUsage(usage) {
  if (!usage) return null
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.total_tokens ?? input + output
  }
}

/**
 * Responses 响应体 → chat/completions 响应体（非流式）
 */
export function fromCodexResponse(data = {}, fallbackModel = '') {
  const { text, reasoning } = extractTextAndReasoning(data.output)
  const id = data.id || ''
  // Responses 的 id 是 resp_ 前缀，换成 chatcmpl_ 让客户端更好识别
  const chatId = id.startsWith('resp_') ? `chatcmpl-${id.slice(5)}` : id || `chatcmpl-${Date.now()}`
  const created = data.created_at || Math.floor(Date.now() / 1000)
  const status = data.status || 'completed'

  const message = { role: 'assistant', content: text }
  if (reasoning) message.reasoning_content = reasoning

  const usage = mapUsage(data.usage)
  return {
    id: chatId,
    object: 'chat.completion',
    created,
    model: data.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: FINISH_REASON_MAP[status] || 'stop'
      }
    ],
    ...(usage ? { usage } : {})
  }
}

// —— 流式转换 ——
//
// 上游发的是 Responses 事件流：
//   event: response.output_text.delta
//   data: {"type":"response.output_text.delta","delta":"你好"}
//   event: response.completed
//   data: {"type":"response.completed","response":{...}}
// 客户端要的是 chat.completion.chunk：
//   data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你好"}}]}
//
// chunk 边界和事件边界不对齐，所以这里做行缓冲：只有凑出完整事件才输出。

function chunkEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 创建一个流式转换器。
 * push(textChunk) 返回应当写给客户端的字符串（可能为空）。
 */
export function createCodexStreamTransformer(model = '') {
  let buffer = ''
  let started = false
  let id = ''
  let created = Math.floor(Date.now() / 1000)
  let finished = false
  let streamedText = ''
  const out = []

  function emitRole() {
    if (started) return
    started = true
    out.push(
      chunkEvent({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })
    )
  }

  function emitDelta(text, reasoning) {
    if (!text && !reasoning) return
    emitRole()
    if (text) streamedText += text
    const delta = {}
    if (text) delta.content = text
    if (reasoning) delta.reasoning_content = reasoning
    out.push(
      chunkEvent({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }]
      })
    )
  }

  function emitFinish(finishReason, usage) {
    if (finished) return
    finished = true
    emitRole()
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    }
    if (usage) payload.usage = usage
    out.push(chunkEvent(payload))
    out.push('data: [DONE]\n\n')
  }

  function handleEvent(json) {
    const type = json?.type
    if (type === 'response.created' || type === 'response.in_progress') {
      if (json.response?.id) id = json.response.id.startsWith('resp_')
        ? `chatcmpl-${json.response.id.slice(5)}`
        : json.response.id
      if (json.response?.created_at) created = json.response.created_at
      if (json.response?.model) model = json.response.model
      return
    }
    if (type === 'response.output_text.delta') {
      emitDelta(json.delta || '', null)
      return
    }
    // reasoning 模型的思考过程：部分客户端显示为「思考中」
    if (type === 'response.reasoning_summary_text.delta') {
      emitDelta(null, json.delta || '')
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = json.response || {}
      if (resp.id) {
        id = resp.id.startsWith('resp_') ? `chatcmpl-${resp.id.slice(5)}` : resp.id
      }
      const usage = mapUsage(resp.usage)
      // 少数实现只在 completed 里带完整文本且中途没发 delta，这里补一次避免丢内容
      const { text, reasoning } = extractTextAndReasoning(resp.output)
      if (text) {
        // 已经通过 delta 累积过的内容不重复发送：只在从未发过 delta 时兜底
        if (!started) emitDelta(text, reasoning || null)
      }
      emitFinish(type === 'response.incomplete' ? 'length' : 'stop', usage)
      return
    }
    if (type === 'response.failed' || type === 'error') {
      const msg = json.response?.error?.message || json.error?.message || json.message || '上游响应失败'
      emitFinish('stop', null)
      out.push(
        chunkEvent({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          error: { message: msg, type: 'upstream_error' }
        })
      )
      return
    }
  }

  return {
    push(textChunk) {
      buffer += textChunk || ''
      // 防御：单行超长时丢弃，避免异常上游把内存打满
      if (buffer.length > 1024 * 1024) buffer = ''
      let idx
      // SSE 事件以空行分隔，只有遇到空行才算攒够一个完整事件
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            handleEvent(JSON.parse(data))
          } catch {
            // 单条事件解析失败不影响后续事件
          }
        }
      }
      return out.splice(0, out.length).join('')
    },
    // 上游结束时调用：补发终止标记，防止客户端一直挂着等 [DONE]
    flush() {
      const pending = buffer.trim()
      if (pending) {
        for (const line of pending.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            handleEvent(JSON.parse(data))
          } catch { /* ignore */ }
        }
        buffer = ''
      }
      emitFinish('stop', null)
      return out.splice(0, out.length).join('')
    },
    // 供统计 token 用
    get id() {
      return id
    },
    // 上游不返回 usage 时，网关按输出长度估算 token，这里把累积的文本交出去
    get streamedText() {
      return streamedText
    }
  }
}

// —— 请求头 ——
//
// Codex 上游要求带 ChatGPT-Account-Id，值来自 id_token 的 chatgpt_account_id，
// 每个账号都不一样，因此不能写死在平台的 extra_headers 里，只能按 Key 注入。
export function codexAccountHeader(key) {
  const accountId = key?.account_id
  return accountId ? { 'ChatGPT-Account-Id': String(accountId) } : {}
}
