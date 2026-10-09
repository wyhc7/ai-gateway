// 订阅与「添加平台」分家之后的两层保证。
//
// 分家的实质是「两份清单各走各的接口」。纯单元测试只能看见文件里的数组，看不见
// 「/api/templates 到底还回不回订阅方案」——而订阅方案只要还留在模板里，添加平台
// 的下拉框就又会冒出订阅入口。所以这里既测文件，也真发一次 HTTP。
//
// 另一层是兜底模型：订阅方案从 templates.js 搬走后，proxy.js 的 defaultModelsFor()
// 如果只查模板，grok-oauth / codex-oauth 就查不到默认列表，订阅平台刚建好就是废的。
// 这个坑搬之前差点踩上，必须钉死。
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-subscription-test'

// store.js 在 import 时就读 DATA_DIR，必须先钉死再 import
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-subscription-'))

let TEMPLATES = null
let SUBSCRIPTION_PLANS = null
let defaultModelsFor = null

before(async () => {
  ;({ TEMPLATES } = await import('../templates.js'))
  ;({ SUBSCRIPTION_PLANS } = await import('../subscription-plans.js'))
  ;({ defaultModelsFor } = await import('../proxy.js'))
})

after(() => {
  rmSync(process.env.DATA_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 文件层
// ---------------------------------------------------------------------------

describe('订阅方案与模板各走各的', () => {
  test('添加平台的模板里不再有任何订阅入口', () => {
    const leaked = TEMPLATES.filter(
      (t) => t.group === 'OAuth 订阅' || t.protocol === 'grok-oauth' || t.protocol === 'codex-oauth'
    )
    assert.deepEqual(leaked, [], '订阅方案还留在 TEMPLATES 里，添加平台的下拉框又会冒出订阅')
  })

  test('订阅方案各自带齐接入点与兜底模型', () => {
    assert.ok(SUBSCRIPTION_PLANS.length >= 3, '至少保留 Grok 两个接入点与 Codex')
    for (const p of SUBSCRIPTION_PLANS) {
      assert.ok(p.id && p.name && p.protocol, `${p.id || '（无 id）'} 缺必填字段`)
      assert.match(p.base_url, /^https?:\/\//, `${p.id} 的接入地址不是 http(s)`)
      assert.ok(Array.isArray(p.default_models) && p.default_models.length > 0, `${p.id} 没有兜底模型`)
    }
  })

  test('兜底模型还在——方案搬家后 defaultModelsFor 不能失效', () => {
    assert.ok(defaultModelsFor('grok-oauth')?.length > 0, 'grok-oauth 查不到兜底模型')
    assert.ok(defaultModelsFor('codex-oauth')?.length > 0, 'codex-oauth 查不到兜底模型')
    // cli-chat-proxy 订阅通道实测只提供 grok-4.6，兜底列表写多了会把手工设置
    // 冲成一批必然 402 的模型名，所以这条钉的是精确内容而不只是「非空」
    assert.deepEqual(defaultModelsFor('grok-oauth').map((m) => m.id), ['grok-4.6'])
  })

  test('Grok 两个接入点分得开，Codex 走的是自己的上游', () => {
    const grok = SUBSCRIPTION_PLANS.filter((p) => p.protocol === 'grok-oauth')
    assert.equal(grok.length, 2)
    assert.notEqual(grok[0].base_url, grok[1].base_url)
    const codex = SUBSCRIPTION_PLANS.find((p) => p.protocol === 'codex-oauth')
    assert.match(codex.base_url, /chatgpt\.com/)
  })
})

// ---------------------------------------------------------------------------
// 线上形状：真发一次 HTTP
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function startGateway(port, dataDir) {
  return spawn(process.execPath, ['index.js'], {
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

test('订阅方案走自己的接口，模板接口里不再有订阅', { timeout: 60000 }, async () => {
  const port = await freePort()
  const child = startGateway(port, process.env.DATA_DIR)

  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')

    // 新接口与 /api/templates 一样受管理鉴权管
    const anon = await fetch(`http://127.0.0.1:${port}/api/subscriptions/plans`)
    assert.equal(anon.status, 401, '订阅方案接口必须走管理鉴权')

    const templates = await (await api(port, '/api/templates')).json()
    assert.deepEqual(
      templates.templates.filter((t) => t.protocol === 'grok-oauth' || t.protocol === 'codex-oauth'),
      [],
      '模板接口还回着订阅方案，添加平台就仍然能建订阅平台'
    )

    const resp = await api(port, '/api/subscriptions/plans')
    assert.equal(resp.status, 200)
    const { plans } = await resp.json()
    assert.ok(Array.isArray(plans) && plans.length >= 3, '订阅方案接口返回的方案太少')
    assert.ok(plans.every((p) => p.id && p.name && p.protocol && p.base_url))

    // 按方案建平台应当一次成功：这是新对话框的实际调用序列。
    // body 只读一次——放断言消息里 await 会把 body 消费掉，后面 .json() 就炸了。
    const codex = plans.find((p) => p.protocol === 'codex-oauth')
    const created = await api(port, '/api/providers', {
      method: 'POST',
      body: { name: '订阅测试', base_url: codex.base_url, protocol: codex.protocol, model_names: [] }
    })
    const createdBody = await created.json()
    assert.equal(created.status, 201, `按订阅方案建平台失败：${JSON.stringify(createdBody)}`)
    assert.equal(createdBody.protocol, 'codex-oauth')
    // 不预填：空着提交就该空着，后端不能背着用户把默认列表塞回去。
    // 兜底（defaultModelsFor）在刷新失败时才生效，那条由 proxy-models.test.js 钉住。
    assert.equal(createdBody.models.length, 0, '创建时不应预填模型')
  } finally {
    child.kill()
  }
})
