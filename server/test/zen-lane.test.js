import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// store.js 在模块加载时按 DATA_DIR 初始化配置文件，必须在动态 import 之前指向临时目录
const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-zen-test-'))
process.env.DATA_DIR = dataDir

const { state } = await import('../store.js')
const { handleChat } = await import('../proxy.js')
const {
  shapeZenBody,
  zenToolNameMap,
  buildZenHeaders,
  createZenStreamTransformer,
  aggregateZenSse,
  isZenProtocol,
  ZEN_FREE_MODELS
} = await import('../zen-lane.js')

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// 上游要求的会话 ID 格式，任何一条不满足都会被判 403
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const QUARTET = ['bash', 'glob', 'grep', 'read']

function startUpstream(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      await handler({ req, res, body: raw ? JSON.parse(raw) : null })
    } catch (err) {
      if (!res.writableEnded) res.writeHead(500).end(String(err))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function fakeRes() {
  const chunks = []
  const listeners = {}
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
      return this
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(body) {
      if (body) chunks.push(Buffer.from(body))
      this.writableEnded = true
      return this
    },
    on(evt, fn) {
      listeners[evt] = fn
      return this
    },
    once(evt, fn) {
      listeners[evt] = fn
      return this
    },
    removeListener(evt) {
      delete listeners[evt]
      return this
    },
    text() {
      return Promise.resolve(Buffer.concat(chunks).toString('utf8'))
    }
  }
}

function sseLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

// ---- 请求体整形 ----

test('shapeZenBody 在客户端未提供工具时补齐四件套并强制流式', () => {
  const shaped = shapeZenBody({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(shaped.stream, true)
  const names = shaped.tools.map((t) => t.function.name)
  for (const name of QUARTET) assert.ok(names.includes(name), `缺少 ${name}`)
  assert.equal(names.length, QUARTET.length)
})

test('shapeZenBody 把小写的同名工具改名后去重，非四件套工具原样保留', () => {
  const shaped = shapeZenBody({
    tools: [
      { type: 'function', function: { name: 'Bash', description: 'run', parameters: {} } },
      { type: 'function', function: { name: 'bash', description: 'dup', parameters: {} } },
      { type: 'function', function: { name: 'my_custom_tool', parameters: {} } }
    ]
  })
  const names = shaped.tools.map((t) => t.function.name)
  assert.equal(names.filter((n) => n === 'bash').length, 1)
  assert.ok(names.includes('my_custom_tool'))
  assert.ok(names.includes('glob') && names.includes('grep') && names.includes('read'))
  // 客户端工具的定义不能被改写，只改名字
  const bash = shaped.tools.find((t) => t.function.name === 'bash')
  assert.equal(bash.function.description, 'run')
})

test('shapeZenBody 不改动调用方传入的 body', () => {
  const body = { stream: false, tools: [{ type: 'function', function: { name: 'Read' } }] }
  shapeZenBody(body)
  assert.equal(body.stream, false)
  assert.equal(body.tools[0].function.name, 'Read')
})

test('tool_choice 指向被改名的工具时同步小写化', () => {
  const shaped = shapeZenBody({ tool_choice: { type: 'function', function: { name: 'Read' } } })
  assert.equal(shaped.tool_choice.function.name, 'read')
})

test('zenToolNameMap 只记录确实被改过名的四件套成员', () => {
  const map = zenToolNameMap([
    { function: { name: 'Bash' } },
    { function: { name: 'grep' } },
    { function: { name: 'other_tool' } }
  ])
  assert.equal(map.size, 1)
  assert.equal(map.get('bash'), 'Bash')
})

// ---- 指纹头 ----

test('buildZenHeaders 覆盖上游全部准入条件', () => {
  const headers = buildZenHeaders()
  assert.match(headers['user-agent'], /opencode\/1\.18\./)
  const version = Number(headers['user-agent'].match(/opencode\/(\d+\.\d+\.\d+)/)[1].split('.').map(Number)[1])
  assert.ok(version >= 18, '版本号必须 >= 1.18.0，否则上游返回 426')
  assert.equal(headers.authorization, 'Bearer public')
  for (const name of ['x-opencode-client', 'x-opencode-session', 'x-opencode-request', 'x-opencode-project']) {
    assert.ok(headers[name], `缺少 ${name}`)
  }
  assert.match(headers['x-opencode-session'], SESSION_RE)
})

test('每次铸造的会话 ID 都满足格式且不重复', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const session = buildZenHeaders()['x-opencode-session']
    assert.match(session, SESSION_RE)
    seen.add(session)
  }
  assert.equal(seen.size, 200)
})

// ---- 响应侧还原 ----

test('流式转换器把工具名还原并补上终止标记', () => {
  const transformer = createZenStreamTransformer('m', { tools: [{ function: { name: 'Bash' } }] })
  let out = transformer.push(sseLine({ choices: [{ delta: { content: '好' } }] }))
  out += transformer.push(sseLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] } }] }))
  // flush 前上游没发 [DONE]，转换器要替客户端补上
  out += transformer.flush()
  assert.match(out, /"name":"Bash"/)
  assert.ok(!out.includes('"name":"bash"'), '小写名不应泄漏给客户端')
  assert.match(out, /data: \[DONE\]/)
  assert.equal(transformer.streamedText, '好')
})

test('非流式聚合把 SSE 还原成 chat.completion', () => {
  const raw = [
    sseLine({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    sseLine({ choices: [{ index: 0, delta: { content: '你好' } }] }),
    sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":' } }] } }] }),
    sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] }, finish_reason: 'tool_calls' }] }),
    sseLine({ usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }),
    'data: [DONE]\n\n'
  ].join('')
  const payload = aggregateZenSse(raw, 'nemotron-3-ultra-free', { tools: [{ function: { name: 'Bash' } }] })
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'Bash')
  // 参数是分片下发的，必须拼完整
  assert.equal(payload.choices[0].message.tool_calls[0].function.arguments, '{"command":"echo hi"}')
  // 正文与工具调用可以同时存在：这时必须保留正文，
  // 按 OpenAI 惯例一律置 null 会把模型真说过的话丢掉
  assert.equal(payload.choices[0].message.content, '你好')
  assert.equal(payload.usage.total_tokens, 12)
})

test('只有工具调用、没有正文时 content 为 null', () => {
  const raw = [
    sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'glob', arguments: '{}' } }] } }] }),
    'data: [DONE]\n\n'
  ].join('')
  const payload = aggregateZenSse(raw, 'm', {})
  assert.equal(payload.choices[0].message.content, null)
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
})

// ---- 端到端：整形后的请求真的长成上游要的样子 ----

async function withZenProvider(port, run) {
  const provider = {
    id: 'zen-test',
    name: 'OpenCode Zen 免费通道',
    base_url: `http://127.0.0.1:${port}/v1`,
    protocol: 'zen-free',
    enabled: true,
    models: [{ id: 'nemotron-3-ultra-free', owned_by: 'zen' }],
    // 免凭据通道刻意不带任何 Key：能跑通才说明占位 Key 机制生效
    keys: [],
    extra_headers: {}
  }
  state.providers.push(provider)
  try {
    await run()
  } finally {
    state.providers = state.providers.filter((p) => p.id !== 'zen-test')
  }
}

test('非流式请求：上游收到的仍是合规流式请求，客户端收到一次性 JSON', async () => {
  let seen = null
  const { server, port } = await startUpstream(({ req, res, body }) => {
    seen = { headers: req.headers, body }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(sseLine({ choices: [{ index: 0, delta: { content: '嗨' } }] }))
    res.write(sseLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    res.write('data: [DONE]\n\n')
    res.end()
  })

  await withZenProvider(port, async () => {
    const res = fakeRes()
    await handleChat({
      body: {
        model: 'nemotron-3-ultra-free',
        messages: [{ role: 'user', content: '你好' }],
        tools: [{ type: 'function', function: { name: 'Bash', parameters: {} } }],
        stream: false
      }
    }, res)
    assert.equal(res.statusCode, 200)
    const payload = JSON.parse(await res.text())
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, '嗨')
  })

  // 上游侧断言：这正是「反代」成立的全部依据
  assert.match(seen.headers['user-agent'], /opencode\/1\.18\./)
  assert.equal(seen.headers.authorization, 'Bearer public')
  assert.match(seen.headers['x-opencode-session'], SESSION_RE)
  for (const name of ['x-opencode-client', 'x-opencode-request', 'x-opencode-project']) {
    assert.ok(seen.headers[name], `缺少 ${name}`)
  }
  assert.equal(seen.body.stream, true, '客户端要非流式，但发给上游的必须是流式')
  const names = seen.body.tools.map((t) => t.function.name)
  for (const name of QUARTET) assert.ok(names.includes(name), `缺少 ${name}`)
  assert.ok(names.includes('bash'), '客户端的大写工具名应被小写化发给上游')

  server.close()
})

test('流式请求：工具名在客户端侧被还原', async () => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(sseLine({ choices: [{ index: 0, delta: { content: 'ok' } }] }))
    res.write(sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] } }] }))
    res.write('data: [DONE]\n\n')
    res.end()
  })

  await withZenProvider(port, async () => {
    const res = fakeRes()
    await handleChat({
      body: {
        model: 'nemotron-3-ultra-free',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }],
        stream: true
      }
    }, res)
    assert.equal(res.statusCode, 200)
    const out = await res.text()
    assert.match(out, /"name":"Read"/)
    assert.match(out, /data: \[DONE\]/)
  })

  server.close()
})

test('白名单里的模型都能查到平台归属', () => {
  assert.ok(ZEN_FREE_MODELS.length >= 8)
  assert.ok(isZenProtocol('zen-free'))
  assert.ok(!isZenProtocol('openai-chat'))
})
