// 平台导入导出的线上形状测试。
//
// 三条契约都在 HTTP 层钉住：
// 1. 导出脱敏：凭据只留前后 4 位，last_error / last_error_at 不进备份
// 2. 订阅平台完整还原：模型倍率、平台倍率表、Key 的额度/签到状态不能丢
//    （旧实现只挑固定字段重建 + normalizeModels 压成裸 id，导入后订阅平台残废）
// 3. 脱敏文件再导入：打码凭据置空并在 masked_keys 里点名，不静默变空 Key

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-provider-io-test'

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
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function api(port, path, { method = 'GET', body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function withGateway(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-provider-io-'))
  const port = await freePort()
  const child = startGateway(port, dataDir)
  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')
    await fn(port)
  } finally {
    child.kill()
  }
}

/** 一份带订阅平台（OAuth + 倍率 + 额度/签到）的导入数据 */
function subscriptionFixture() {
  return [{
    name: 'WorkBuddy 国际版',
    base_url: 'https://www.codebuddy.ai',
    protocol: 'workbuddy',
    enabled: true,
    models: [
      { id: 'fast-model', name: 'Fast', owned_by: 'wb', rate: 'x0.34 credits', context: 200000, realm: 'global' },
      { id: 'glm-5.3', name: 'GLM-5.3', owned_by: 'wb', rate: 'x0.79', context: 256000, realm: 'global' }
    ],
    keys: [{
      name: '国际-1',
      type: 'oauth',
      provider: 'workbuddy',
      api_key: 'sk-plain-secret-value-1234',
      access_token: 'at-plain-secret-value-5678',
      refresh_token: 'rt-plain-secret-value-9012',
      expires_at: 1792040000000,
      credits_size: 1000,
      credits_remain: 320,
      credits_used: 680,
      credits_unit: 'credits',
      checkin_date: '2026-10-19',
      last_error: '上一次的 403 错误',
      last_error_at: 1792030000000
    }],
    model_rates: { global: { 'fast-model': 'x0.34 credits' } },
    model_rates_at: 1792036606158,
    models_source: 'workbuddy',
    models_updated_at: 1792036606158
  }]
}

test('导出脱敏：凭据只留前后 4 位，last_error 不进备份', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    const r = await api(port, '/api/providers/import', { method: 'POST', body: subscriptionFixture() })
    assert.equal(r.status, 200)

    const exp = await api(port, '/api/providers/export')
    assert.equal(exp.status, 200)
    const data = await exp.json()
    // 导出已经从「裸数组」变成「带账号池的对象」，平台在 providers 里。
    // 结构变化的原因见 index.js 导出路由上的注释：账号池得一起走。
    assert.equal(data.format, 'ai-gateway-backup')
    assert.ok(Array.isArray(data.providers), 'providers 必须是数组')
    const p = data.providers[0]
    const k = p.keys[0]

    assert.ok(k.api_key.startsWith('sk-p') && k.api_key.endsWith('1234'), `api_key 应保留前后 4 位：${k.api_key}`)
    assert.ok(k.api_key.includes('*'), 'api_key 中间必须打码')
    assert.ok(!k.api_key.includes('plain-secret'), '不能泄露完整 Key')
    assert.ok(k.access_token.includes('*') && k.refresh_token.includes('*'), 'OAuth 凭据同样脱敏')
    assert.equal(k.last_error, undefined, '导出不带 last_error')
    assert.equal(k.last_error_at, undefined, '导出不带 last_error_at')

    // 账号池是完整凭证，这一点必须在文件里写明 —— 否则有人会把它当普通备份传群
    assert.match(data.secret_warning, /等同账号密码/)
  })
})

test('订阅平台完整还原：倍率、倍率表、额度、签到状态都在', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    await api(port, '/api/providers/import', { method: 'POST', body: subscriptionFixture() })

    const list = await (await api(port, '/api/providers')).json()
    const p = list[0]
    assert.equal(p.name, 'WorkBuddy 国际版')

    // 模型倍率不能丢（旧 normalizeModels 只留 id/owned_by）
    const byId = Object.fromEntries(p.models.map((m) => [m.id, m]))
    assert.equal(byId['fast-model'].rate, 'x0.34 credits')
    assert.equal(byId['fast-model'].name, 'Fast')
    assert.equal(byId['fast-model'].context, 200000)
    assert.equal(byId['glm-5.3'].rate, 'x0.79')

    // 平台级倍率表
    assert.deepEqual(p.model_rates, { global: { 'fast-model': 'x0.34 credits' } })
    assert.equal(p.model_rates_at, 1792036606158)
    assert.equal(p.models_source, 'workbuddy')

    // 订阅 Key 的额度与签到状态
    const k = p.keys[0]
    assert.equal(k.type, 'oauth')
    assert.equal(k.provider, 'workbuddy')
    assert.equal(k.credits_remain, 320)
    assert.equal(k.credits_size, 1000)
    assert.equal(k.checkin_date, '2026-10-19')
  })
})

test('脱敏文件再导入：打码凭据置空并在 masked_keys 点名', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    const r = await api(port, '/api/providers/import', { method: 'POST', body: subscriptionFixture() })
    assert.equal(r.status, 200)
    const exp = await (await api(port, '/api/providers/export')).json()

    const r2 = await api(port, '/api/providers/import', { method: 'POST', body: exp })
    const body = await r2.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.masked_keys, ['WorkBuddy 国际版 / 国际-1'], '打码的 Key 必须被点名，提醒重新填')

    const list = await (await api(port, '/api/providers')).json()
    // 导入是追加不是替换：同名平台有两个，取第二次（导入了脱敏文件的）那个
    const dup = list.filter((p) => p.name === 'WorkBuddy 国际版')
    assert.equal(dup.length, 2)
    const k = dup[1].keys[0]
    assert.equal(k.api_key, '', '脱敏值不能当真实凭据落库')
    assert.equal(k.access_token, '')
  })
})

test('老格式（裸平台数组）仍能导入：升级不该让历史备份失效', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    // 导出改成对象之后，用户手里上一版下载的文件还是裸数组。
    // 这条用例守着那个兼容分支 —— 它一旦被删，老文件就导不进去了。
    const r = await api(port, '/api/providers/import', {
      method: 'POST',
      body: [{ name: '老备份', base_url: 'https://api.example.com/v1', keys: [] }]
    })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.imported, 1)
    // 老格式没有账号池，accounts 应为 null，而不是报错
    assert.equal(body.accounts, null)
  })
})

test('备份对象缺 providers：明确报格式错误，不静默吞掉', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    const r = await api(port, '/api/providers/import', { method: 'POST', body: { foo: 1 } })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.match(body.error.message, /providers/)
  })
})

test('模型字符串形态与无 id 脏数据兼容', { timeout: 60000 }, async () => {
  await withGateway(async (port) => {
    const r = await api(port, '/api/providers/import', {
      method: 'POST',
      body: [{
        name: '旧格式',
        base_url: 'https://api.example.com/v1',
        models: ['gpt-4o', { owned_by: 'no-id' }, { id: 'ok-1', rate: 'x0.5' }]
      }]
    })
    assert.equal(r.status, 200)
    const list = await (await api(port, '/api/providers')).json()
    const models = list[0].models
    assert.deepEqual(models.map((m) => m.id), ['gpt-4o', 'ok-1'], '字符串转对象、无 id 记录丢弃')
    assert.equal(models[1].rate, 'x0.5', '对象形态保留倍率')
    assert.equal(models[0].owned_by, '旧格式')
  })
})
