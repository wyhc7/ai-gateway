// 等待响应头的整体预算（PRE_HEADER_TIMEOUT_MS）。
// 单次尝试只受 CONNECT_TIMEOUT_MS 约束，Key 轮换会把这段时间逐个累加：
// 几十个 Key 都拿不到响应头时，客户端要挂几十分钟才等来一个 502
// （线上出现过切换 88 次、耗时 44 分钟的空转）。
// 这里把两个超时都调成毫秒级，验证"预算到点就停，不把所有 Key 挨个试完"。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

// 必须在动态 import 之前设置：常量在 proxy.js 模块加载时读取
const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-preheader-'))
process.env.DATA_DIR = dataDir
process.env.CONNECT_TIMEOUT_MS = '400'
process.env.PRE_HEADER_TIMEOUT_MS = '1000'

const { state } = await import('../store.js')
const { handleChat } = await import('../proxy.js')

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// 挂住不响应的上游：连接能建立，但永远不给响应头
function startHangUpstream(onCall) {
  const server = http.createServer((req) => {
    onCall()
    req.resume()
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

function makeProvider(port, keyCount) {
  const uid = crypto.randomUUID().slice(0, 8)
  const provider = {
    id: `p-${uid}`,
    name: '测试平台',
    base_url: `http://127.0.0.1:${port}`,
    protocol: 'openai-chat',
    enabled: true,
    models: [{ id: `model-${uid}`, owned_by: '测试平台' }],
    keys: Array.from({ length: keyCount }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `k${i + 1}`,
      api_key: `sk-k${i + 1}`,
      enabled: true,
      cooldown_until: 0,
      last_error: null,
      last_error_at: null,
      created_at: Date.now()
    })),
    extra_headers: {},
    created_at: Date.now()
  }
  state.providers.push(provider)
  provider.testModel = provider.models[0].id
  return provider
}

test('上游一直不给响应头时，预算到点就失败，不逐个 Key 空转', async (t) => {
  let calls = 0
  const { server, port } = await startHangUpstream(() => { calls += 1 })
  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections()
    server.close()
  })

  const provider = makeProvider(port, 8)
  const res = fakeRes()
  const started = Date.now()
  await handleChat({ body: { model: provider.testModel, messages: [{ role: 'user', content: 'hi' }] } }, res)
  const elapsed = Date.now() - started

  assert.ok(calls >= 1, '应至少尝试过一个 Key')
  assert.ok(calls < 8, `预算到点应停止切换，不应把 8 个 Key 挨个试完（实际尝试 ${calls} 次）`)
  assert.ok(elapsed >= 800, `应撑到接近 1 秒预算（实际 ${elapsed}ms）`)
  assert.ok(elapsed < 3000, `失败应发生在预算附近，而不是逐 Key 累加到 3 秒以上（实际 ${elapsed}ms）`)
  assert.equal(res.statusCode, 502, '预算耗尽应返回 502')
  assert.match(res.json().error.message, /等待响应头超过/, '错误信息应说明是整体预算耗尽')
  assert.match(res.json().error.message, /上游请求超时/, '单次尝试的超时原因也应保留')
})
