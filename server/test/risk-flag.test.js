// 账号风控标记：上游回「账号存在异常行为」时，把标记写到 Key 上，
// 网页据此在账号行显示红色「风控」。这个号重新跑通一次请求后自动解除。
//
// 为什么值得单独测：
//  - 判据必须是**文案**而不是状态码。403 也用于 token 失效，11140 也用于
//    参数非法；只看 code 会把「参数写错」标成「号废了」，人就会去申诉一个
//    根本没问题的账号。
//  - 标记是持久的（不像冷却会自己过期），所以清除时机也要锁住：
//    跑通即解除，否则标记留久了就没人再信它。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-risk-'))
process.env.DATA_DIR = dataDir
// 毫秒级的超时，避免失败用例把测试拖住
process.env.CONNECT_TIMEOUT_MS = '2000'
process.env.PRE_HEADER_TIMEOUT_MS = '3000'

const { state } = await import('../store.js')
const { handleChat } = await import('../proxy.js')

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// 上游固定回同一个响应
function startUpstream(handler) {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(req, res))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function fakeRes() {
  const listeners = {}
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    status(code) { this.statusCode = code; return this },
    setHeader(k, v) { this.headers[k] = v; return this },
    write() { return true },
    end(body) { if (body) this._body = body; this.writableEnded = true; return this },
    on(evt, fn) { listeners[evt] = fn; return this },
    once(evt, fn) { listeners[evt] = fn; return this },
    removeListener(evt) { delete listeners[evt]; return this },
    emit(evt) { listeners[evt]?.(); return true },
    text() { return this._body || '' },
    json() { return JSON.parse(this.text()) }
  }
}

function makeProvider(port, keyExtra = {}) {
  const uid = crypto.randomUUID().slice(0, 8)
  const provider = {
    id: `p-${uid}`,
    name: '测试平台',
    base_url: `http://127.0.0.1:${port}`,
    protocol: 'openai-chat',
    enabled: true,
    models: [{ id: `model-${uid}`, owned_by: '测试平台' }],
    keys: [{
      id: crypto.randomUUID(),
      name: 'k1',
      api_key: 'sk-k1',
      enabled: true,
      cooldown_until: 0,
      last_error: null,
      last_error_at: null,
      created_at: Date.now(),
      ...keyExtra
    }],
    extra_headers: {},
    created_at: Date.now()
  }
  state.providers.push(provider)
  provider.testModel = provider.models[0].id
  return provider
}

// 上游真实返回的风控体（2026-11-16 抓包）
const RISK_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  requestId: 'test-request-id',
  displayMsg: {
    en: 'Your account has been restricted due to unusual activity',
    zh: '账号存在异常行为，已被限制使用'
  },
  displayTips: { zh: '系统检测到该账号存在异常使用行为，如需申诉请提交反馈' },
  actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK']
})

test('403 + 风控文案 → Key 上出现 risk_flag，网页可据此标记', async (t) => {
  const { server, port } = await startUpstream((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(RISK_BODY)
  })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port)
  const key = provider.keys[0]
  assert.equal(key.risk_flag, undefined, '初始不应有标记')

  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, fakeRes())

  assert.ok(key.risk_flag, '应打上风控标记')
  assert.equal(key.risk_flag.code, 11140)
  assert.match(key.risk_flag.message, /账号存在异常行为/, '要保留上游原话，便于申诉时填写')
  assert.ok(key.risk_flag.at > 0, '要记录被限制的时间')
  assert.match(key.last_error, /风控/, 'last_error 也要点明是风控，而不是干巴巴的 HTTP 403')
})

// 这条是防误报的核心：403 与 11140 都不足以判定风控
test('403 但不是风控（token 失效）→ 不打标记', async (t) => {
  const { server, port } = await startUpstream((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid_token' } }))
  })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port)
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, fakeRes())
  assert.equal(provider.keys[0].risk_flag, undefined, 'token 失效不该被标成风控')
})

test('11140 但只是参数非法 → 不打标记', async (t) => {
  const { server, port } = await startUpstream((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 11140, msg: 'request illegal', displayMsg: {} }))
  })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port)
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, fakeRes())
  assert.equal(provider.keys[0].risk_flag, undefined, '11140 也用于参数非法，不能算风控')
})

test('这个号重新跑通一次请求 → 标记自动解除', async (t) => {
  const { server, port } = await startUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }))
  })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port, {
    risk_flag: { at: Date.now() - 60000, code: 11140, message: '账号存在异常行为，已被限制使用' },
    risk_flag_at: Date.now() - 60000
  })
  const key = provider.keys[0]
  assert.ok(key.risk_flag, '前置条件：已有标记')

  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, fakeRes())

  assert.equal(key.risk_flag, undefined, '跑通之后标记必须自动消失')
  assert.equal(key.risk_flag_at, undefined, '时间戳一并清掉，不要留悬空字段')
})

// 标记只增不减会变成噪音：连续两次被限，时间戳要停在第一次
test('连续命中风控时，保留第一次被限制的时间', async (t) => {
  const { server, port } = await startUpstream((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(RISK_BODY)
  })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port)
  const key = provider.keys[0]

  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, fakeRes())
  const firstAt = key.risk_flag.at

  // 抹掉冷却，让它再次被尝试
  key.cooldown_until = 0
  await new Promise((r) => setTimeout(r, 20))
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi again' }] } }, fakeRes())

  assert.equal(key.risk_flag.at, firstAt, '时间戳应停在第一次被限制的时刻')
})
