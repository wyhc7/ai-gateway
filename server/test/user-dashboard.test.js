// 用户仪表盘 HTTP 契约测试
//
// 纯函数测不到「中间件到底放不放行 /api/user/*」「实时扣费有没有串到别的用户」
// 「余额为 0 时调用是不是真被 402 拦下」。这里拉起真实网关进程真发 HTTP。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-user-dashboard-test'

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

let child = null
let port = 0
const dataDir = mkdtempSync(join(tmpdir(), 'gw-user-dashboard-'))

function call(path, { method = 'GET', body, adminKey, token, gatewayKey } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey
  if (token) headers['X-Session-Token'] = token
  if (gatewayKey) headers['Authorization'] = `Bearer ${gatewayKey}`
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function json(resp) {
  return { status: resp.status, body: await resp.json().catch(() => ({})) }
}

async function login(username, password) {
  const r = await json(await call('/api/auth/login', { method: 'POST', body: { username, password } }))
  assert.equal(r.status, 200, `${username} 登录失败：${JSON.stringify(r.body)}`)
  return r.body.token
}

before(async () => {
  port = await freePort()
  child = spawn(process.execPath, ['index.js'], {
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
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('网关未在超时内就绪')
})

after(() => {
  if (child && !child.killed) child.kill()
})

test('初始化管理员 + 建两个 user；老配置字段迁移后余额/计费段齐全', async () => {
  const setup = await json(await call('/api/auth/setup', {
    method: 'POST', body: { username: 'root', password: 'password123', admin_key: ADMIN_KEY }
  }))
  assert.equal(setup.status, 200)

  const adminToken = setup.body.token
  for (const [name, pw] of [['alice', 'alice-password'], ['bob', 'bob-password']]) {
    const r = await json(await call('/api/accounts', {
      method: 'POST', token: adminToken, body: { username: name, password: pw, role: 'user' }
    }))
    assert.equal(r.status, 200)
    assert.equal(r.body.account.balance_micro, 0, '新账号初始余额为 0')
  }

  const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'))
  assert.equal(cfg.billing.micros_per_unit, 1_000_000)
  assert.equal(cfg.billing.price_per_1k_tokens_micro, 1_000_000)
  assert.ok(Array.isArray(cfg.billing_ledger))
  for (const a of cfg.accounts) {
    assert.equal(a.balance_micro, 0)
    assert.ok(!('password_salt' in a) || typeof a.password_salt === 'string')
  }
})

test('用户仪表盘：最初无密钥、0 余额、空流水、对接信息齐全', async () => {
  const token = await login('alice', 'alice-password')
  const r = await json(await call('/api/user/dashboard', { token }))
  assert.equal(r.status, 200)
  const d = r.body
  assert.equal(d.account.username, 'alice')
  assert.equal(d.account.role, 'user')
  assert.equal(d.balance.micro, 0)
  assert.equal(d.balance.value, 0)
  assert.equal(d.balance.unit, '点')
  assert.equal(d.key, null)
  assert.equal(d.key_state, 'empty', '「最初无密钥」必须是明确的空态')
  assert.deepEqual(d.usage, { requests: 0, failed: 0, tokens: 0 })
  assert.deepEqual(d.ledger, [])
  assert.ok(d.base_url.endsWith('/v1'))
  assert.ok(d.api_v1_url.endsWith('/api/v1'))
  assert.match(d.protocol, /OpenAI/)
  assert.equal(d.pricing.price_per_1k_tokens_display, '1 点 / 1K tokens')
  assert.equal(JSON.stringify(d).includes('sk-'), false, '空态不该泄露任何密钥')
  assert.equal(JSON.stringify(d).includes('password_hash'), false)

  const ledger = await json(await call('/api/user/ledger', { token }))
  assert.equal(ledger.status, 200)
  assert.deepEqual(ledger.body.ledger, [])
})

test('角色隔离：user 能进 /api/user/* 与自助端点，其余管理接口仍 403', async () => {
  const token = await login('alice', 'alice-password')
  assert.equal((await call('/api/user/dashboard', { token })).status, 200)
  assert.equal((await call('/api/user/ledger', { token })).status, 200)
  assert.equal((await call('/api/auth/me', { token })).status, 200)
  for (const p of ['/api/status', '/api/providers', '/api/accounts', '/api/keys', '/api/logs']) {
    const resp = await call(p, { token })
    assert.equal(resp.status, 403, `${p} 必须继续对普通用户关闭`)
  }
  // 管理密钥通道没有账号身份，不能用来取用户面板
  const viaKey = await json(await call('/api/user/dashboard', { adminKey: ADMIN_KEY }))
  assert.equal(viaKey.status, 400)
})

test('管理员充值 → 余额与流水正确；非法金额 400；扣减夹到 0', async () => {
  const adminToken = await login('root', 'password123')
  const list = await json(await call('/api/accounts', { token: adminToken }))
  const alice = list.body.accounts.find((a) => a.username === 'alice')
  assert.equal(list.body.pricing.unit, '点')

  const bad = await json(await call(`/api/accounts/${alice.id}/balance`, {
    method: 'POST', token: adminToken, body: { amount: 0 }
  }))
  assert.equal(bad.status, 400)

  const topup = await json(await call(`/api/accounts/${alice.id}/balance`, {
    method: 'POST', token: adminToken, body: { amount: 10, note: '10 月配额' }
  }))
  assert.equal(topup.status, 200)
  assert.equal(topup.body.balance.micro, 10_000_000)
  assert.equal(topup.body.balance.display, '10 点')
  assert.equal(topup.body.account.balance_micro, 10_000_000)

  const userToken = await login('alice', 'alice-password')
  const dash = await json(await call('/api/user/dashboard', { token: userToken }))
  assert.equal(dash.body.balance.micro, 10_000_000)
  assert.equal(dash.body.ledger.length, 1)
  assert.equal(dash.body.ledger[0].type, 'topup')
  assert.equal(dash.body.ledger[0].note, '10 月配额')
  assert.equal(dash.body.ledger[0].actor, 'root')

  const overflow = await json(await call(`/api/accounts/${alice.id}/balance`, {
    method: 'POST', token: adminToken, body: { amount: 1e12 }
  }))
  assert.equal(overflow.status, 400, '超过整数安全边界的金额被后端挡住')

  const clamp = await json(await call(`/api/accounts/${alice.id}/balance`, {
    method: 'POST', token: adminToken, body: { amount: -100 }
  }))
  assert.equal(clamp.status, 200)
  assert.equal(clamp.body.balance.micro, 0, '余额夹到 0，不成负数')
  const rows = (await json(await call('/api/user/ledger', { token: userToken }))).body.ledger
  assert.equal(rows[0].delta_micro, -10_000_000, '流水记实际扣减')

  // 恢复 10 点给后续调用测试
  await call(`/api/accounts/${alice.id}/balance`, {
    method: 'POST', token: adminToken, body: { amount: 10 }
  })
})

test('用户自助密钥：生成一次明文、归属隔离、轮换、删除回到空态', async () => {
  const token = await login('alice', 'alice-password')
  const own = await json(await call('/api/user/key', { method: 'POST', token, body: {} }))
  assert.equal(own.status, 201)
  assert.ok(own.body.token.startsWith('sk-'))
  assert.equal(own.body.key.owner_account_id, own.body.dashboard.account.id)
  assert.equal(own.body.dashboard.key_state, 'active')
  const keyId = own.body.key.id
  const plain = own.body.token

  const dup = await json(await call('/api/user/key', { method: 'POST', token, body: {} }))
  assert.equal(dup.status, 409, '一个账号最多一把自助密钥')

  const dash = await json(await call('/api/user/dashboard', { token }))
  assert.equal(dash.body.key.key_preview, own.body.key.key_preview)
  assert.equal(JSON.stringify(dash.body).includes(plain), false, '仪表盘不回传明文')

  // 归属隔离：bob 不能轮换/删除 alice 的密钥
  const bobToken = await login('bob', 'bob-password')
  assert.equal((await call(`/api/user/key/${keyId}/rotate`, { method: 'POST', token: bobToken })).status, 404)
  assert.equal((await call(`/api/user/key/${keyId}`, { method: 'DELETE', token: bobToken })).status, 404)
  assert.equal((await json(await call('/api/user/dashboard', { token: bobToken }))).body.key, null, 'bob 仍是最初无密钥')

  const rotated = await json(await call(`/api/user/key/${keyId}/rotate`, { method: 'POST', token }))
  assert.equal(rotated.status, 200)
  assert.notEqual(rotated.body.token, plain)
  assert.equal(rotated.body.key.id, keyId)
  assert.equal(rotated.body.key.owner_account_id, own.body.dashboard.account.id)

  const removed = await json(await call(`/api/user/key/${keyId}`, { method: 'DELETE', token }))
  assert.equal(removed.status, 200)
  assert.equal(removed.body.dashboard.key, null)
  assert.equal(removed.body.dashboard.key_state, 'empty')
})

test('余额门禁：0 余额 402；充值后放行；主密钥与老 Key 不受影响', async () => {
  const token = await login('bob', 'bob-password')
  const created = await json(await call('/api/user/key', { method: 'POST', token, body: {} }))
  assert.equal(created.status, 201)
  const bobKey = created.body.token

  // bob 余额 0：消耗型调用被门禁拦下
  const blocked = await json(await call('/v1/chat/completions', {
    method: 'POST', gatewayKey: bobKey,
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }
  }))
  assert.equal(blocked.status, 402)
  assert.equal(blocked.body.error.type, 'insufficient_balance')
  assert.equal(blocked.body.balance.micro, 0)

  // /v1/models 永远放行，哪怕余额为 0
  const models = await call('/v1/models', { gatewayKey: bobKey })
  assert.equal(models.status, 200)

  // 主密钥没有 owner，不受门禁约束（没有配上游平台时会走到 404 model_not_found）
  const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'))
  const owner = await call('/v1/chat/completions', {
    method: 'POST', gatewayKey: cfg.gateway_api_key,
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }
  })
  assert.notEqual(owner.status, 402, '主密钥不产生 402 余额门禁')

  // 充值后门禁放行：不再 402（没有上游平台时会是 404 model_not_found）
  const adminToken = await login('root', 'password123')
  const list = await json(await call('/api/accounts', { token: adminToken }))
  const bob = list.body.accounts.find((a) => a.username === 'bob')
  await call(`/api/accounts/${bob.id}/balance`, { method: 'POST', token: adminToken, body: { amount: 5 } })

  const allowed = await call('/v1/chat/completions', {
    method: 'POST', gatewayKey: bobKey,
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }
  })
  assert.notEqual(allowed.status, 402, '充值后余额门禁必须放行')
})

test('删除账号时自助密钥一并清理，不留孤儿免费 Key', async () => {
  const adminToken = await login('root', 'password123')
  const temp = await json(await call('/api/accounts', {
    method: 'POST', token: adminToken, body: { username: 'temp', password: 'temp-password', role: 'user' }
  }))
  assert.equal(temp.status, 200)
  const tempToken = await login('temp', 'temp-password')
  const made = await json(await call('/api/user/key', { method: 'POST', token: tempToken, body: {} }))
  assert.equal(made.status, 201)
  const orphanToken = made.body.token

  const del = await call(`/api/accounts/${temp.body.account.id}`, { method: 'DELETE', token: adminToken })
  assert.equal(del.status, 200)

  // 用一次真实调用验证：孤儿 Key 已随账号删除，网关鉴权直接 401
  const resp = await call('/v1/models', { gatewayKey: orphanToken })
  assert.equal(resp.status, 401, '账号删除后它的自助密钥必须失效')
})
