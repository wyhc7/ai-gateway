import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

// store.js 在模块加载时就会按 DATA_DIR 初始化配置文件，
// 因此必须在动态 import 之前把环境变量指向临时目录，避免污染真实数据
const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-test-'))
process.env.DATA_DIR = dataDir

const { state } = await import('../store.js')
const { handleChat, withUsageOption, estimateTokens, shouldSendHeartbeat, heartbeatTickInterval } = await import('../proxy.js')

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---- 测试辅助 ----

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

// 最小可用的 Express 风格响应对象，只需覆盖 proxy.js 实际调用到的接口
function fakeRes({ onFirstWrite } = {}) {
  const chunks = []
  const listeners = {}
  let wrote = false
  const res = {
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
      if (onFirstWrite && !wrote) {
        wrote = true
        onFirstWrite(res)
      }
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
    emit(evt) {
      listeners[evt]?.()
      return true
    },
    text() {
      return Buffer.concat(chunks).toString('utf-8')
    },
    json() {
      return JSON.parse(this.text())
    }
  }
  return res
}

function makeKey(name) {
  return {
    id: crypto.randomUUID(),
    name,
    api_key: `sk-${name}`,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    created_at: Date.now()
  }
}

// 每个用例使用独立的模型名：provider 会一直留在 state 里，
// 若共用同一个模型名，后续用例的请求会被轮询到指向已关闭端口的旧 provider
function makeProvider({ port, keys, models }) {
  const uid = crypto.randomUUID().slice(0, 8)
  const provider = {
    id: `p-${uid}`,
    name: '测试平台',
    base_url: `http://127.0.0.1:${port}`,
    protocol: 'openai-chat',
    enabled: true,
    models: (models || [`model-${uid}`]).map((id) => ({ id, owned_by: '测试平台' })),
    keys,
    extra_headers: {},
    created_at: Date.now()
  }
  state.providers.push(provider)
  provider.testModel = provider.models[0].id
  return provider
}

function tokenDelta(before) {
  return (state.stats.totalTokens || 0) - before
}

function resetProvider(p) {
  for (const k of p.keys) {
    k.cooldown_until = 0
    k.cooldown_at = 0
    k.last_error = null
  }
}

// ---- 故障切换 ----

test('401 时自动切换到下一个 Key，请求不中断', async (t) => {
  const seenKeys = []
  const { server, port } = await startUpstream(({ req, res, body }) => {
    seenKeys.push(req.headers.authorization)
    if (req.headers.authorization === 'Bearer sk-bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'invalid key' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 11 } }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('bad'), makeKey('good')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 200, '应成功返回 200')
  assert.deepEqual(seenKeys, ['Bearer sk-bad', 'Bearer sk-good'], '应先用坏 Key 再切到好 Key')
  assert.equal(res.json().choices[0].message.content, 'ok')

  const badKey = provider.keys.find((k) => k.name === 'bad')
  assert.ok(badKey.cooldown_until > Date.now(), '失效 Key 应进入冷却')
  assert.match(badKey.last_error, /401/)
})

test('上游瞬时 400 会切换其他 Key 重试，重试成功则正常返回', async (t) => {
  let calls = 0
  const { server, port } = await startUpstream(({ res }) => {
    calls++
    if (calls === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'transient' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k1'), makeKey('k2')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(calls, 2, '应切换到第二个 Key 重试一次')
  assert.equal(res.statusCode, 200, '重试成功后应返回 200')
  assert.equal(res.json().choices[0].message.content, 'ok')
  assert.ok(provider.keys.every((k) => !k.cooldown_until), '400 不应给 Key 施加冷却')
})

test('持续 400 时最多重试一次，并把上游 400 透传给客户端', async (t) => {
  let calls = 0
  const { server, port } = await startUpstream(({ res }) => {
    calls++
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad request body' } }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k1'), makeKey('k2'), makeKey('k3')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(calls, 2, '400 只重试一次，不应无限切换')
  assert.equal(res.statusCode, 400, '重试后仍 400 应透传上游状态')
  assert.equal(res.json().error.message, 'bad request body', '上游错误体应透传')
})

test('429 限流切换 Key，且不会把多个 Key 一次性全冻住', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limited' } }))
  })
  t.after(() => server.close())

  // 4 个 Key 全部 429：前两个正常冷却，后两个因已有半数 Key 在冷却而被压缩冷却时间
  const provider = makeProvider({ port, keys: [makeKey('k1'), makeKey('k2'), makeKey('k3'), makeKey('k4')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 502, '全部失败应返回 502')
  assert.equal(res.json().error.type, 'all_keys_failed')

  const now = Date.now()
  const durations = provider.keys.map((k) => k.cooldown_until - now)
  assert.ok(durations[0] > 20000, '首个 Key 应为完整 30 秒冷却')
  assert.ok(durations[3] <= 5000 + 1000, '后续 Key 冷却应被压缩到 5 秒，避免整站被冻死')
})

test('所有 Key 均失败时返回 502 并说明切换次数', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid' } }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('a'), makeKey('b')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 502)
  assert.match(res.json().error.message, /已自动切换 2 次/)
})

test('所有 Key 处于冷却时返回 503，并保留半开探测的机会', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('only')] })
  const key = provider.keys[0]
  // 模拟刚被冷却 10 分钟：冷却进度未过半，应直接 503
  key.cooldown_at = Date.now()
  key.cooldown_until = Date.now() + 600000

  const res1 = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res1)
  assert.equal(res1.statusCode, 503, '冷却未过半时应返回 503')
  assert.equal(res1.json().error.type, 'no_keys')

  // 冷却进度过半后应放行一次半开探测，而不是继续 503
  key.cooldown_at = Date.now() - 400000
  key.cooldown_until = Date.now() + 200000
  const res2 = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res2)
  assert.equal(res2.statusCode, 200, '冷却过半后应放行半开探测请求')
})

test('Key 只是短暂冷却时等待恢复，而不是直接 503', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const key = provider.keys[0]
  // 冷却 2 秒，半开探测点在 1 秒后，短于等待上限，应当等到并成功返回
  key.cooldown_at = Date.now()
  key.cooldown_until = Date.now() + 2000

  const res = fakeRes()
  const startedAt = Date.now()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 200, '短暂冷却应等待后成功，而不是把请求直接打回')
  assert.ok(Date.now() - startedAt >= 900, '确实等待到了冷却过半')
})

// ---- 模型归属与越权 ----

test('provider 前缀不能绕过模型白名单', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '不应被调用' } }] }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes()
  await handleChat(
    { body: { model: `provider:${provider.id}/不在白名单的模型`, messages: [{ role: 'user', content: 'hi' }] } },
    res
  )

  assert.equal(res.statusCode, 404, '模型不属于该平台时应拒绝，避免定向消耗任意 Key')
  assert.equal(res.json().error.type, 'model_not_found')
})

test('未配置的模型返回 404', async (t) => {
  const res = fakeRes()
  await handleChat({ body: { model: '完全不存在的模型', messages: [{ role: 'user', content: 'hi' }] } }, res)
  assert.equal(res.statusCode, 404)
})

// ---- 流式转发与 Token 统计 ----

test('SSE 流式响应完整透传并统计 usage', async (t) => {
  const before = state.stats.totalTokens || 0
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n')
    res.write('data: {"usage":{"total_tokens":137}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, stream: true, messages: [{ role: 'user', content: 'hi' }] } }, res)

  const text = res.text()
  assert.match(text, /"content":"你好"/, '流式分片应原样透传')
  assert.match(text, /"content":"，世界"/)
  assert.match(text, /\[DONE\]/, '终止符应透传')
  assert.equal(tokenDelta(before), 137, '应按上游返回的 usage 精确统计')
})

test('流式响应关闭中间层缓冲，避免长回答被反代截断', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, stream: true, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.headers['X-Accel-Buffering'], 'no', 'Nginx 默认缓冲响应，长回答会被攒住甚至截断')
  assert.match(res.headers['Cache-Control'], /no-cache/, '流式响应不应被任何中间层缓存')
  assert.match(res.headers['Cache-Control'], /no-transform/, '阻止中间设备对响应做压缩等改写')
})

test('流式响应缺少 usage 时按输出长度估算，不静默漏计', async (t) => {
  const before = state.stats.totalTokens || 0
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"这是一段没有 usage 的回复内容"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, stream: true, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 200)
  assert.ok(tokenDelta(before) > 0, '上游不返回 usage 时也必须计入估算值，否则仪表盘会系统性偏低')
})

test('思考内容（reasoning_content）一并计入估算', async (t) => {
  const before = state.stats.totalTokens || 0
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"reasoning_content":"让我想想这个问题该怎么回答"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"答案是"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, stream: true, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.ok(tokenDelta(before) > 0, '思考链同样消耗 token，应计入统计')
})

test('客户端断开连接不会误判为 Key 故障', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const { server, port } = await startUpstream(async ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n')
    await gate
    if (!res.writableEnded) res.end()
  })
  t.after(() => {
    release()
    server.close()
  })

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  const res = fakeRes({
    // 收到第一片数据后立刻模拟客户端断开
    onFirstWrite: (r) => r.emit('close')
  })

  await handleChat({ body: { model: provider.testModel, stream: true, messages: [{ role: 'user', content: 'hi' }] } }, res)

  const key = provider.keys[0]
  assert.equal(key.cooldown_until, 0, '客户端主动断开不应把 Key 打进冷却')
  assert.equal(key.last_error, null)
})

// ---- 纯函数 ----

test('withUsageOption 只对已知支持的上游注入 include_usage', () => {
  const body = { model: 'm', stream: true, messages: [] }

  const injected = withUsageOption({ base_url: 'https://api.deepseek.com/v1' }, body)
  assert.equal(injected.stream_options.include_usage, true, '已知平台应注入')

  const untouched = withUsageOption({ base_url: 'http://127.0.0.1:1234/v1' }, body)
  assert.equal(untouched.stream_options, undefined, '未知平台不应注入，避免上游报未知字段')

  const nonStream = withUsageOption({ base_url: 'https://api.deepseek.com/v1' }, { model: 'm', messages: [] })
  assert.equal(nonStream.stream_options, undefined, '非流式请求不需要注入')

  const preset = withUsageOption({ base_url: 'https://api.deepseek.com/v1' }, { ...body, stream_options: { include_usage: false } })
  assert.equal(preset.stream_options.include_usage, false, '调用方显式指定时应尊重其设置')
})

test('estimateTokens 对中英文分别折算', () => {
  assert.ok(estimateTokens('') === 0, '空文本应为 0')
  assert.ok(estimateTokens('你好世界') >= 2 && estimateTokens('你好世界') <= 4, 'CJK 约 0.7 token/字')
  const english = estimateTokens('a'.repeat(400))
  assert.ok(english >= 90 && english <= 110, '英文约 4 字符 1 token')
  assert.ok(estimateTokens('中文abc') > estimateTokens('abc'), '中文应比等长英文计更多 token')
})

test('心跳只在空闲超过阈值后补发一次，不随检查周期重复刷', () => {
  const interval = 15000
  // 空闲未达阈值：不发
  assert.equal(shouldSendHeartbeat({ idleMs: 5000, sinceLastHeartbeatMs: 15000, heartbeatIntervalMs: interval }), false, '空闲未达心跳间隔时不应发送')
  // 空闲达标但距上次心跳不足一个周期：不发（防止每检查一次就发一次）
  assert.equal(shouldSendHeartbeat({ idleMs: 20000, sinceLastHeartbeatMs: 5000, heartbeatIntervalMs: interval }), false, '距上次心跳不足一个周期时不应重复发送')
  // 两者都达标：发送
  assert.equal(shouldSendHeartbeat({ idleMs: 20000, sinceLastHeartbeatMs: 15000, heartbeatIntervalMs: interval }), true, '空闲与距上次心跳都达标时才发送')
})

test('心跳检查间隔随配置缩放且设上下限', () => {
  assert.equal(heartbeatTickInterval(15000), 5000, '默认 15 秒心跳对应 5 秒一次的检查（上限 5 秒）')
  assert.equal(heartbeatTickInterval(60000), 5000, '更长的心跳也不必超过 5 秒检查一次')
  assert.equal(heartbeatTickInterval(2000), 1000, '短心跳时检查间隔取一半')
  assert.equal(heartbeatTickInterval(100), 500, '极短配置下有 0.5 秒下限保护')
})

test('冷却后的 Key 在冷却结束后恢复可用', async (t) => {
  const { server, port } = await startUpstream(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  t.after(() => server.close())

  const provider = makeProvider({ port, keys: [makeKey('k')] })
  provider.keys[0].cooldown_until = Date.now() - 1 // 冷却已过期
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)
  assert.equal(res.statusCode, 200, '冷却过期的 Key 应重新投入使用')
  resetProvider(provider)
})
