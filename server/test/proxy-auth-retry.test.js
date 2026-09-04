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
const { handleChat } = await import('../proxy.js')

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

// 本地 mock 的 OAuth token 端点：refreshAccessToken 补刷时打到这上面，
// 避免测试触碰真实的 auth.x.ai
function startTokenServer(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      await handler({ req, res, body: raw ? Object.fromEntries(new URLSearchParams(raw)) : {} })
    } catch (err) {
      if (!res.writableEnded) res.writeHead(500).end(String(err))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/token` }))
  })
}

// 最小可用的 Express 风格响应对象，只需覆盖 proxy.js 实际调用到的接口
function fakeRes() {
  const chunks = []
  const listeners = {}
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

function makeOauthKey(name, tokenEndpoint) {
  return {
    id: crypto.randomUUID(),
    type: 'oauth',
    provider: 'grok',
    name,
    access_token: 'old-token',
    refresh_token: 'rt-old',
    // 距过期 2 小时：躲开默认 1 小时的预刷新窗口，
    // 保证请求前的 ensureAccessToken 不会自己续期（补刷逻辑由 401 触发）
    expires_at: Date.now() + 2 * 60 * 60 * 1000,
    token_endpoint: tokenEndpoint,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    created_at: Date.now()
  }
}

function makeStaticKey(name) {
  return {
    id: crypto.randomUUID(),
    name,
    api_key: `sk-${name}`,
    enabled: true,
    cooldown_until: 0,
    last_error: null,
    created_at: Date.now()
  }
}

function makeProvider({ port, keys }) {
  const uid = crypto.randomUUID().slice(0, 8)
  const provider = {
    id: `p-${uid}`,
    name: '测试平台',
    base_url: `http://127.0.0.1:${port}`,
    protocol: 'openai-chat',
    enabled: true,
    models: [{ id: `model-${uid}`, owned_by: '测试平台' }],
    keys,
    extra_headers: {},
    created_at: Date.now()
  }
  state.providers.push(provider)
  provider.testModel = provider.models[0].id
  return provider
}

// ---- OAuth 401 补刷重试 ----

test('OAuth key 吃 401 时强制续期并原地重试，成功后不进冷却', async (t) => {
  const seenTokens = []
  const { server, port } = await startUpstream(({ req, res }) => {
    seenTokens.push(req.headers.authorization)
    if (req.headers.authorization === 'Bearer old-token') {
      // token 在网关侧"看似有效"（未到预刷新窗口），但上游拒绝——假性失效
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'expired' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }))
  })
  t.after(() => server.close())

  let refreshed = 0
  const { server: tokenServer, url: tokenUrl } = await startTokenServer(({ res }) => {
    refreshed += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'fresh-token', refresh_token: 'rt-new', expires_in: 21600 }))
  })
  t.after(() => tokenServer.close())

  const key = makeOauthKey('oa1', tokenUrl)
  const provider = makeProvider({ port, keys: [key] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 200, '补刷后重试应成功')
  assert.deepEqual(seenTokens, ['Bearer old-token', 'Bearer fresh-token'], '应先吃 401，再用新 token 原地重试')
  assert.equal(refreshed, 1, 'token 端点只应被调用一次')
  assert.equal(key.access_token, 'fresh-token', '新 token 应写回 Key')
  assert.equal(key.refresh_token, 'rt-new', '轮换的 refresh_token 应写回 Key')
  assert.ok(key.expires_at > Date.now(), 'expires_at 应被续期')
  assert.ok(!key.cooldown_until, '补刷成功后 Key 不应进冷却')
})

test('补刷失败时按 Key 失效处理：冷却并切换下一个 Key', async (t) => {
  const seenKeys = []
  const { server, port } = await startUpstream(({ req, res }) => {
    seenKeys.push(req.headers.authorization)
    if (req.headers.authorization === 'Bearer old-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'expired' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }))
  })
  t.after(() => server.close())

  const { server: tokenServer, url: tokenUrl } = await startTokenServer(({ res }) => {
    // refresh_token 已失效：token 端点拒绝
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_grant' }))
  })
  t.after(() => tokenServer.close())

  const bad = makeOauthKey('oa-dead', tokenUrl)
  const good = makeStaticKey('good')
  const provider = makeProvider({ port, keys: [bad, good] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 200, '应切换到下一个 Key 正常返回')
  assert.deepEqual(seenKeys, ['Bearer old-token', 'Bearer sk-good'], '补刷失败后应切到静态 Key')
  assert.ok(bad.cooldown_until > Date.now(), '补刷失败的 Key 应进冷却')
  assert.match(bad.last_error, /401/, 'last_error 应记录上游 401')
})

test('补刷后仍 401 时不再重复补刷：同一 Key 只打上游两次', async (t) => {
  let upstreamCalls = 0
  const { server, port } = await startUpstream(({ res }) => {
    upstreamCalls += 1
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'still expired' } }))
  })
  t.after(() => server.close())

  let tokenCalls = 0
  const { server: tokenServer, url: tokenUrl } = await startTokenServer(({ res }) => {
    tokenCalls += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ access_token: `fresh-${tokenCalls}`, expires_in: 21600 }))
  })
  t.after(() => tokenServer.close())

  const key = makeOauthKey('oa-once', tokenUrl)
  const provider = makeProvider({ port, keys: [key] })
  const res = fakeRes()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)

  assert.equal(res.statusCode, 502, '所有 Key 失败应返回 502')
  assert.equal(upstreamCalls, 2, '401 → 补刷重试 → 仍 401，之后不应再重试')
  assert.equal(tokenCalls, 1, 'token 端点只应被调用一次，不允许死循环重放')
  assert.ok(key.cooldown_until > Date.now(), '最终失败应进冷却')
})
