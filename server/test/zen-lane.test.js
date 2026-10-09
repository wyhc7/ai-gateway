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
const { handleChat, refreshModels, previewModels } = await import('../proxy.js')
const {
  shapeZenBody,
  zenToolNameMap,
  buildZenHeaders,
  createZenStreamTransformer,
  aggregateZenSse,
  isZenProtocol,
  isZenFreeCandidate,
  isDefinitiveZenRejection,
  ZEN_PROBE_TTL_MS,
  ZEN_MAX_PROBES,
  ZEN_FREE_MODELS
} = await import('../zen-lane.js')

after(() => {
  for (const s of openServers) {
    // 先掐掉存量连接，否则 keep-alive 还会把进程再拖一会儿
    s.closeAllConnections?.()
    s.close()
  }
  rmSync(dataDir, { recursive: true, force: true })
})

// 上游要求的会话 ID 格式，任何一条不满足都会被判 403
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const QUARTET = ['bash', 'glob', 'grep', 'read']

// 用例中途断言失败会跳过末尾那句 server.close()，端口一直监听着，node --test 就
// 永远不退出——表现为「测试卡死、一点输出都没有」，极难排查。统一登记、退出时兜底关。
const openServers = []

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
  openServers.push(server)
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

// ---- 免费档自发现：上游新上的型号，点一次刷新就能拿到 ----

test('isZenFreeCandidate 只认 -free 后缀', () => {
  for (const id of ['exo-free', 'ling-3.1-flash-free', 'muse-spark-1.3-contributor-free', 'a_free', 'x.free']) {
    assert.equal(isZenFreeCandidate(id), true, id)
  }
  // big-pickle 虽然免费但名字不含后缀，它靠白名单兜住，不靠探测发现
  for (const id of ['claude-fable-5', 'big-pickle', 'free-tier', 'freeform', 'gpt-5.3-codex-spark', '', null]) {
    assert.equal(isZenFreeCandidate(id), false, String(id))
  }
})

test('isDefinitiveZenRejection 区分「用不了」与「上游抖动」', () => {
  assert.equal(isDefinitiveZenRejection(400), true) // 上游未开放
  assert.equal(isDefinitiveZenRejection(401), true) // 付费档
  assert.equal(isDefinitiveZenRejection(403), true) // 地区限制
  assert.equal(isDefinitiveZenRejection(429), false) // 限流，要重试
  assert.equal(isDefinitiveZenRejection(500), false)
  assert.equal(isDefinitiveZenRejection(0), false) // 超时 / 网络错误
})

// 探测流程的测试用真实本地上游：只有真发一次请求，才能验出「实测」这件事本身
function makeZenProvider(port, extra = {}) {
  return {
    id: 'zen-discover',
    name: 'OpenCode Zen 免费通道',
    base_url: `http://127.0.0.1:${port}/v1`,
    protocol: 'zen-free',
    enabled: true,
    models: [],
    keys: [],
    extra_headers: {},
    ...extra
  }
}

async function withProvider(provider, run) {
  state.providers.push(provider)
  try {
    await run()
  } finally {
    state.providers = state.providers.filter((p) => p !== provider)
  }
}

// 上游 /models 与 /chat/completions 的最小仿真：probeStatus 决定每个型号探测时回什么。
// 值可以是数字，也可以是 (第几次探测) => 状态码 的函数，用来模拟「首轮被限流、补测放行」。
function startZenUpstream(modelIds, probeStatus) {
  const probed = []
  return startUpstream(({ req, res, body }) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, object: 'model', owned_by: 'opencode' })) }))
      return
    }
    const attempt = probed.filter((x) => x === body.model).length
    probed.push(body.model)
    const spec = probeStatus[body.model]
    const status = typeof spec === 'function' ? spec(attempt) : (spec ?? 403)
    res.writeHead(status, { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' })
    res.end(status === 200 ? 'data: [DONE]\n\n' : JSON.stringify({ error: { message: 'FreeTierError' } }))
  }).then((r) => ({ ...r, probed }))
}

test('刷新时实测收编上游新上的免费型号，被判死的记入缓存', async () => {
  const { server, port, probed } = await startZenUpstream(
    // 白名单内的 + 两个新候选 + 一个名字不像免费的付费档
    ['nemotron-3-ultra-free', 'exo-free', 'muse-spark-1.3-free', 'claude-fable-5'],
    { 'exo-free': 200, 'muse-spark-1.3-free': 403 }
  )
  const provider = makeZenProvider(port)

  await withProvider(provider, async () => {
    const r = await refreshModels(provider.id)
    assert.equal(r.ok, true)
    // 新收编的型号要回给前端，「刷新」这类动作才有可见的结果
    assert.deepEqual(r.discovered, ['exo-free'])

    const ids = provider.models.map((m) => m.id)
    assert.ok(ids.includes('nemotron-3-ultra-free'), '白名单内的保留')
    assert.ok(ids.includes('exo-free'), '实测通过的收编')
    assert.ok(!ids.includes('muse-spark-1.3-free'), '403 的不收编')
    assert.ok(!ids.includes('claude-fable-5'), '付费档不在地表里，绝不探测')

    // 只探测「名字像免费档且还没见过」的候选
    assert.deepEqual(probed.sort(), ['exo-free', 'muse-spark-1.3-free'])
    // 外来的型号标记 free，便于前端区分
    assert.equal(provider.models.find((m) => m.id === 'exo-free').free, true)

    // 被判死的记档，放行的也记档
    assert.equal(provider.zen_probe_cache['exo-free'].ok, true)
    assert.equal(provider.zen_probe_cache['muse-spark-1.3-free'].ok, false)
    assert.equal(provider.zen_probe_cache['muse-spark-1.3-free'].status, 403)

    // 再刷新一次：两个都已经有结论，不该再打上游
    const before = probed.length
    await refreshModels(provider.id)
    assert.equal(probed.length, before, '有结论的型号不重复探测')
    assert.ok(provider.models.map((m) => m.id).includes('exo-free'), '已收编的型号不会被刷新冲掉')
  })

  server.close()
})

test('上游 5xx / 超时不算除名依据，同一轮补测一次、下次刷新还会重试', async () => {
  const { server, port, probed } = await startZenUpstream(
    ['flaky-free'],
    { 'flaky-free': 500 }
  )
  const provider = makeZenProvider(port)

  await withProvider(provider, async () => {
    await refreshModels(provider.id)
    // 本轮探测 + 隔一拍补测各一次。上游按并发限流，被挡下的当场补一枪，
    // 用户点一次「刷新」才拿得到完整清单，而不是缺几个留到下次
    assert.equal(probed.length, 2, '首轮一次 + 本轮补测一次')
    // 抖动不记档，否则上游一次 500 就能让一个好型号长期消失
    assert.equal(provider.zen_probe_cache['flaky-free'], undefined)

    const before = probed.length
    await refreshModels(provider.id)
    assert.ok(probed.length > before, '补测也没测出结论的，下次刷新仍然会重试')
  })

  server.close()
})

test('同一轮补测能当场收编被限流挡下的型号，不用让用户再点一次刷新', async () => {
  const { server, port, probed } = await startZenUpstream(
    ['burst-free'],
    // 首轮吃 429（上游按并发限流），补测放行——这正是「第一次刷新拿不全」的成因
    { 'burst-free': (attempt) => (attempt === 0 ? 429 : 200) }
  )
  const provider = makeZenProvider(port)

  await withProvider(provider, async () => {
    const r = await refreshModels(provider.id)
    assert.equal(r.ok, true)
    assert.equal(probed.length, 2, '首轮一次 + 补测一次')
    assert.ok(r.discovered.includes('burst-free'), '被限流挡下的型号补测后应当场收编')
    assert.ok(provider.models.map((m) => m.id).includes('burst-free'))
  })

  server.close()
})

test('拉取列表与刷新同源：同样实测收编，不会比刷新少几个', async () => {
  const { server, port } = await startZenUpstream(
    ['nemotron-3-ultra-free', 'exo-free'],
    { 'exo-free': 200 }
  )
  // 走「添加平台」对话框那条路：只有地址，没有已存在的平台对象
  const r = await previewModels({
    base_url: makeZenProvider(port).base_url,
    protocol: 'zen-free',
    api_key: '',
    extra_headers: {}
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const ids = r.models.map((m) => m.id)
  assert.ok(ids.includes('nemotron-3-ultra-free'), '白名单内的要有')
  assert.ok(ids.includes('exo-free'), '实测通过的也要有——只留白名单的话这里会少一个')

  server.close()
})

test('缓存过期后重测：上游今天 403 的型号明天放开了也能收编', async () => {
  const { server, port, probed } = await startZenUpstream(
    ['late-free'],
    { 'late-free': 200 }
  )
  const provider = makeZenProvider(port, {
    // 模拟 12 小时前判过死缓
    zen_probe_cache: { 'late-free': { ok: false, at: Date.now() - ZEN_PROBE_TTL_MS - 1000, status: 403 } }
  })

  await withProvider(provider, async () => {
    await refreshModels(provider.id)
    assert.deepEqual(probed, ['late-free'], '过了 TTL 就该重测')
    assert.ok(provider.models.map((m) => m.id).includes('late-free'))
  })

  server.close()
})

test('TTL 内的死缓不重测，避免每次刷新都在白测同一批', async () => {
  const { server, port, probed } = await startZenUpstream(
    ['gated-free'],
    { 'gated-free': 200 }
  )
  const provider = makeZenProvider(port, {
    zen_probe_cache: { 'gated-free': { ok: false, at: Date.now() - 1000, status: 403 } }
  })

  await withProvider(provider, async () => {
    await refreshModels(provider.id)
    assert.equal(probed.length, 0, 'TTL 内不重测')
    // 但也不能因为探测被跳过就把型号弄丢：白名单该兜的还兜着
    assert.ok(provider.models.map((m) => m.id).includes('nemotron-3-ultra-free'))
  })

  server.close()
})

test('候选数受上限约束，上游一次放出几十个也不会把刷新拖死', async () => {
  const many = Array.from({ length: ZEN_MAX_PROBES + 5 }, (_, i) => `bulk-${i}-free`)
  const { server, port, probed } = await startZenUpstream(many, {})
  const provider = makeZenProvider(port)

  await withProvider(provider, async () => {
    await refreshModels(provider.id)
    assert.ok(probed.length <= ZEN_MAX_PROBES, `实测 ${probed.length} 次，不得超过 ${ZEN_MAX_PROBES}`)
  })

  server.close()
})

