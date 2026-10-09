// 订阅接入方案的回归测试（融合版）
//
// 钉三层：
//  1. 方案本身的形状：接入地址是常量、协议是常量；WorkBuddy 模型一律留空
//     （目录动态抓取），Grok/Codex 没有 /models，必须带 default_models 兜底；
//  2. 订阅方案与「添加平台」的模板彻底分家：/api/templates 不回订阅协议，
//     defaultModelsFor 查两份清单，方案搬家后兜底不能失效；
//  3. 线上形状：真起一次网关，确认订阅方案接口走管理鉴权、按方案建平台一次成功。
import { test, describe } from 'node:test'
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

const { TEMPLATES } = await import('../templates.js')
const { SUBSCRIPTION_PLANS, findPlan } = await import('../subscription-plans.js')
const { defaultModelsFor } = await import('../proxy.js')

const WB_PLANS = SUBSCRIPTION_PLANS.filter((p) => p.protocol === 'workbuddy-oauth')

// ---------------------------------------------------------------------------
// 文件层：方案形状
// ---------------------------------------------------------------------------

describe('订阅接入方案', () => {
  test('WorkBuddy 分成国内版与国际版两条', () => {
    assert.equal(WB_PLANS.length, 2, `应有两条 WorkBuddy 方案，实际 ${WB_PLANS.length}`)
    assert.ok(findPlan('workbuddy-cn'), '国内版方案缺失')
    assert.ok(findPlan('workbuddy-intl'), '国际版方案缺失')
    // 名称要能一眼分开——选择器里靠文字区分，两条同名等于没拆
    const names = WB_PLANS.map((p) => p.name)
    assert.equal(new Set(names).size, names.length, '两条方案名称必须不同')
  })

  test('每条方案都必须写明协议与接入地址', () => {
    for (const p of SUBSCRIPTION_PLANS) {
      assert.ok(p.id, '缺 id')
      assert.ok(p.name, `${p.id} 缺名称`)
      assert.ok(p.protocol, `${p.id} 缺协议`)
      assert.ok(p.base_url, `${p.id} 缺接入地址`)
    }
  })

  test('WorkBuddy 模型一律留空：目录动态抓取，预填必然与上游对不上', () => {
    for (const p of WB_PLANS) {
      assert.deepEqual(p.models, [], `${p.id} 不该预填模型`)
    }
  })

  test('国内版落国内入口，国际版落国际入口，两者不是同一个域', () => {
    const cn = findPlan('workbuddy-cn')
    const intl = findPlan('workbuddy-intl')

    assert.equal(cn.base_url, 'https://copilot.tencent.com')
    assert.equal(cn.region, 'cn')

    assert.equal(intl.base_url, 'https://www.codebuddy.ai')
    assert.equal(intl.region, 'intl')

    assert.notEqual(cn.base_url, intl.base_url, '两条方案的接入地址必须不同')

    // workbuddy.ai 是计费/成长域，谁都不能拿它当对话入口——
    // 对调不会立刻报错，只会在第一次对话时拿到非 JSON 的 401，
    // 报错是 "parse failed: invalid character '<'"，完全反推不出是域名选错了
    for (const p of WB_PLANS) {
      assert.ok(!p.base_url.includes('workbuddy.ai'), `${p.id} 不能填成计费域`)
      assert.equal(p.protocol, 'workbuddy-oauth')
    }
  })

  test('region 与接入域互相印证，别让方案自己跟自己打架', () => {
    for (const p of WB_PLANS) {
      if (p.region === 'cn') assert.ok(p.base_url.includes('tencent.com'), `${p.id} 标了国内却没落国内域`)
      if (p.region === 'intl') assert.ok(p.base_url.includes('codebuddy.ai'), `${p.id} 标了国际却没落国际域`)
    }
  })

  test('方案自带接入提示，别让用户自己去文件里抠字段', () => {
    for (const p of WB_PLANS) {
      assert.ok(p.hint && p.hint.length > 0, `${p.id} 缺 hint`)
    }
    // 国内版额外指明凭据文件路径，导入 Token 的入口靠它找到文件
    assert.ok(findPlan('workbuddy-cn').hint.includes('workbuddy-<uid>.json'), '应指明凭据文件')
  })

  test('未知 id 返回 null', () => {
    assert.equal(findPlan('no-such-plan'), null)
    // 旧的单一方案 id 已废弃，不能再解析到任何一条——
    // 否则老 id 会悄悄落进国内版，把「我建的是国际版」变成静默错误
    assert.equal(findPlan('workbuddy'), null)
  })
})

// ---------------------------------------------------------------------------
// 订阅方案与模板各走各的
// ---------------------------------------------------------------------------

describe('订阅方案与模板各走各的', () => {
  test('添加平台的模板里不再有任何订阅入口', () => {
    const leaked = TEMPLATES.filter(
      (t) => t.group === 'OAuth 订阅' || t.protocol === 'grok-oauth' || t.protocol === 'codex-oauth'
    )
    assert.deepEqual(leaked, [], '订阅方案还留在 TEMPLATES 里，添加平台的下拉框又会冒出订阅')
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
      WEB_DIST: join(dataDir, 'no-such-dist')
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
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-subscription-http-'))
  const child = startGateway(port, dataDir)

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
    assert.ok(Array.isArray(plans) && plans.length >= 5, '订阅方案接口返回的方案太少')
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
    rmSync(dataDir, { recursive: true, force: true })
  }
})
