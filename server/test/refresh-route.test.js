// 刷新路由的线上形状测试。
//
// 为什么需要这一层：refreshModels 的单元测试直接调函数，覆盖不到「HTTP 响应里到底
// 有没有这个字段」。曾经就因为路由把响应逐字段列举了一遍，discovered 在函数里返回了、
// 客户端却拿不到——功能看着生效（模型确实多了），提示却是空的。这类「服务层对了、
// 线上形状错了」的问题只有真发一次 HTTP 才验得出来，所以这里拉起真实网关进程。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-route-test'

// 种子模型：平台创建时就带着，模拟模板预置的 8 个
const SEED = ['nemotron-3-ultra-free', 'mimo-v2.6-flash-free']
// 上游新上、白名单里没有的免费型号——刷新时应当被实测收编
const NEWCOMER = 'brand-new-free'
const PROBED_IDS = []

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// 假 Zen 上游：/models 列出种子 + 新型号，/chat/completions 对新型号放行、其它一律 403
function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [...SEED, NEWCOMER, 'paid-model'].map((id) => ({ id, object: 'model' })) }))
      return
    }
    let raw = ''
    for await (const c of req) raw += c
    const model = raw ? JSON.parse(raw).model : ''
    PROBED_IDS.push(model)
    if (model === NEWCOMER) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'FreeTierError' } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function startGateway(port, dataDir) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      WEB_DIST: join(dataDir, 'no-such-dist'),
      ZEN_AUTOSEED: '0'
    },
    stdio: 'ignore'
  })
  return child
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function api(port, path, { method = 'GET', body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
}

test('刷新接口把新收编的免费型号透传到 HTTP 响应里', { timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-route-test-'))
  const upstream = await startMockUpstream()
  const port = await freePort()
  const child = startGateway(port, dataDir)

  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')

    // 按模板的初始状态建平台：只有种子模型，探测缓存为空
    const created = await api(port, '/api/providers', {
      method: 'POST',
      body: {
        name: 'OpenCode Zen 免费通道',
        base_url: `http://127.0.0.1:${upstream.port}/v1`,
        protocol: 'zen-free',
        model_names: SEED
      }
    })
    assert.equal(created.status, 201)
    const provider = await created.json()

    const resp = await api(port, `/api/providers/${provider.id}/models/refresh`, { method: 'POST' })
    assert.equal(resp.status, 200)
    const result = await resp.json()

    // 这一条就是曾经漏掉的：函数返回了、路由没透传
    assert.ok('discovered' in result, 'HTTP 响应必须带上 discovered 字段')
    assert.deepEqual(result.discovered, [NEWCOMER])
    assert.equal(result.count, SEED.length + 1)

    // 收编的型号真的进了平台模型列表，并带上 free 标记
    const list = await (await api(port, '/api/providers')).json()
    const zen = list.find((p) => p.protocol === 'zen-free')
    const ids = zen.models.map((m) => m.id)
    assert.ok(ids.includes(NEWCOMER), '新型号应进入模型列表')
    assert.ok(!ids.includes('paid-model'), '名字不像免费档的不该被探测')
    assert.equal(zen.models.find((m) => m.id === NEWCOMER).free, true)

    // 只探测了「名字像免费档」的那一个
    assert.deepEqual(PROBED_IDS, [NEWCOMER])

    // 再刷新一次：已有结论，不该重复探测，也不该再报「新收编」
    const again = await (await api(port, `/api/providers/${provider.id}/models/refresh`, { method: 'POST' })).json()
    assert.deepEqual(again.discovered, [])
    assert.deepEqual(PROBED_IDS, [NEWCOMER])
  } finally {
    child.kill()
    upstream.server.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
