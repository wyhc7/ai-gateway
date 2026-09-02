// Codex Responses API 转换层测试
// 纯函数测试：chat/completions ↔ Responses 的请求/响应/流式转换
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  toCodexRequest,
  fromCodexResponse,
  createCodexStreamTransformer,
  codexAccountHeader
} from '../codex-responses.js'

describe('toCodexRequest（chat/completions → Responses）', () => {
  test('system 消息拆到 instructions，其余转 input', () => {
    const out = toCodexRequest({
      model: 'gpt-5-codex',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
        { role: 'user', content: '再说一次' }
      ],
      stream: true
    })
    assert.equal(out.model, 'gpt-5-codex')
    assert.equal(out.instructions, '你是助手')
    assert.deepEqual(out.input, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
      { role: 'user', content: '再说一次' }
    ])
    assert.equal(out.stream, true)
    assert.equal(out.store, false)
  })

  test('多段 system 合并保留语义', () => {
    const out = toCodexRequest({
      messages: [
        { role: 'system', content: '第一段' },
        { role: 'system', content: '第二段' },
        { role: 'user', content: 'hi' }
      ]
    })
    assert.equal(out.instructions, '第一段\n\n第二段')
    assert.equal(out.input.length, 1)
  })

  test('developer 消息当 system 处理', () => {
    const out = toCodexRequest({
      messages: [
        { role: 'developer', content: '开发指南' },
        { role: 'user', content: '跑起来' }
      ]
    })
    assert.equal(out.instructions, '开发指南')
  })

  test('max_tokens → max_output_tokens', () => {
    const out = toCodexRequest({ messages: [{ role: 'user', content: 'x' }], max_tokens: 512 })
    assert.equal(out.max_output_tokens, 512)
    assert.equal(out.max_tokens, undefined)
  })

  test('max_completion_tokens 优先于 max_tokens', () => {
    const out = toCodexRequest({
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 512,
      max_completion_tokens: 1024
    })
    assert.equal(out.max_output_tokens, 1024)
  })

  test('采样参数与工具调用被剔除（上游会 400）', () => {
    const out = toCodexRequest({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.1,
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'auto',
      response_format: { type: 'json_object' }
    })
    assert.equal(out.temperature, undefined)
    assert.equal(out.top_p, undefined)
    assert.equal(out.presence_penalty, undefined)
    assert.equal(out.tools, undefined)
    assert.equal(out.tool_choice, undefined)
    assert.equal(out.response_format, undefined)
  })

  test('既有字段透传（user/id 等）', () => {
    const out = toCodexRequest({
      messages: [{ role: 'user', content: 'x' }],
      user: 'u-1'
    })
    assert.equal(out.user, 'u-1')
  })

  test('多模态 content 数组转 Responses parts', () => {
    const out = toCodexRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image_url', image_url: { url: 'https://x.com/a.png' } }
          ]
        }
      ]
    })
    assert.deepEqual(out.input[0].content, [
      { type: 'input_text', text: '看这张图' },
      { type: 'input_image', image_url: 'https://x.com/a.png' }
    ])
  })

  test('空消息兜底占位，避免上游 400', () => {
    const out = toCodexRequest({})
    assert.equal(out.input.length, 1)
    assert.equal(out.input[0].role, 'user')
  })
})

describe('fromCodexResponse（Responses → chat/completions 非流式）', () => {
  const resp = {
    id: 'resp_abc123',
    created_at: 1000,
    model: 'gpt-5-codex',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '你好世界', annotations: [] }]
      }
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
  }

  test('基本结构转换', () => {
    const out = fromCodexResponse(resp, 'fallback')
    assert.equal(out.object, 'chat.completion')
    assert.equal(out.model, 'gpt-5-codex')
    assert.equal(out.choices[0].message.content, '你好世界')
    assert.equal(out.choices[0].message.role, 'assistant')
    assert.equal(out.choices[0].finish_reason, 'stop')
    assert.match(out.id, /^chatcmpl-/)
  })

  test('usage 映射为 prompt/completion/total', () => {
    const out = fromCodexResponse(resp)
    assert.deepEqual(out.usage, {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30
    })
  })

  test('reasoning 输出映射到 reasoning_content', () => {
    const out = fromCodexResponse({
      ...resp,
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '先想一下' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: '结论'
        }
      ]
    })
    assert.equal(out.choices[0].message.content, '结论')
    assert.equal(out.choices[0].message.reasoning_content, '先想一下')
  })

  test('incomplete 状态映射为 length 终止', () => {
    const out = fromCodexResponse({ ...resp, status: 'incomplete' })
    assert.equal(out.choices[0].finish_reason, 'length')
  })

  test('无 usage 时不带 usage 字段', () => {
    const out = fromCodexResponse({ ...resp, usage: undefined })
    assert.equal(out.usage, undefined)
  })

  test('无 model 时用 fallback', () => {
    const out = fromCodexResponse({ id: 'resp_x' }, 'gpt-5.4')
    assert.equal(out.model, 'gpt-5.4')
  })
})

describe('createCodexStreamTransformer（流式转换）', () => {
  test('delta 事件转成 chat.completion.chunk', () => {
    const t = createCodexStreamTransformer('gpt-5-codex')
    const out = t.push(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n'
    )
    assert.match(out, /"object":"chat\.completion\.chunk"/)
    assert.match(out, /"delta":\{"content":"你"\}/)
    assert.match(out, /"delta":\{"content":"好"\}/)
    // 首个 chunk 带 role: assistant
    assert.match(out, /"delta":\{"role":"assistant"\}/)
  })

  test('chunk 边界与事件边界不对齐时也能正确拼接', () => {
    const t = createCodexStreamTransformer('m')
    // 一个事件被拆成两半推入
    const half = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta"'
    assert.equal(t.push(half), '')
    const rest = ',"delta":"拼"}\n\n'
    const out = t.push(rest)
    assert.match(out, /"content":"拼"/)
  })

  test('completed 时补 finish_reason 与 [DONE] 终止符', () => {
    const t = createCodexStreamTransformer('m')
    t.push('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    const out = t.push(
      'data: {"type":"response.completed","response":{"id":"resp_x","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n'
    )
    assert.match(out, /"finish_reason":"stop"/)
    assert.match(out, /\[DONE\]/)
    assert.match(out, /"completion_tokens":2/)
  })

  test('没有收到 completed 时 flush 也能补 [DONE]', () => {
    const t = createCodexStreamTransformer('m')
    t.push('data: {"type":"response.output_text.delta","delta":"断线前"}\n\n')
    const tail = t.flush()
    assert.match(tail, /\[DONE\]/)
  })

  test('统计累积文本供 token 估算', () => {
    const t = createCodexStreamTransformer('m')
    t.push('data: {"type":"response.output_text.delta","delta":"一二"}\n\n')
    t.push('data: {"type":"response.output_text.delta","delta":"三四"}\n\n')
    assert.equal(t.streamedText, '一二三四')
  })

  test('response.created 事件设置 id 与 model', () => {
    const t = createCodexStreamTransformer('')
    const out = t.push(
      'data: {"type":"response.created","response":{"id":"resp_xyz","model":"gpt-5.4","created_at":1234}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"a"}\n\n'
    )
    assert.match(out, /"id":"chatcmpl-xyz"/)
    assert.match(out, /"model":"gpt-5\.4"/)
  })

  test('reasoning delta 转成 reasoning_content（思考中）', () => {
    const t = createCodexStreamTransformer('m')
    const out = t.push(
      'data: {"type":"response.reasoning_summary_text.delta","delta":"推导中"}\n\n'
    )
    assert.match(out, /"reasoning_content":"推导中"/)
  })

  test('单事件解析失败不影响后续事件', () => {
    const t = createCodexStreamTransformer('m')
    const out = t.push(
      'data: {broken json}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"恢复"}\n\n'
    )
    assert.match(out, /"content":"恢复"/)
  })
})

describe('codexAccountHeader', () => {
  test('有 account_id 时注入 ChatGPT-Account-Id', () => {
    assert.deepEqual(codexAccountHeader({ account_id: 'acct-1' }), {
      'ChatGPT-Account-Id': 'acct-1'
    })
  })

  test('没有 account_id 时不注入', () => {
    assert.deepEqual(codexAccountHeader({}), {})
    assert.deepEqual(codexAccountHeader(null), {})
  })
})