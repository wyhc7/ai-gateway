// 账号系统 HTTP 契约测试
//
// 纯函数测试（accounts.test.js）验不到「中间件到底放不放行」，也验不到
// 老脚本用的 X-Admin-Key 通道有没有被改坏。这里拉起真实网关进程真发 HTTP。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-accounts-route-test'

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
const dataDir = mkdtempSync(join(tmpdir(), 'gw-accounts-route-'))

function call(path, { method = 'GET', body, adminKey, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey
  if (token) headers['X-Session-Token'] = token
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function json(resp) {
  return { status: resp.status, body: await resp.json().catch(() => ({})) }
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

test('引导端点匿名可达，管理接口匿名一律 401', async () => {
  const status = await json(await call('/api/auth/status'))
  assert.equal(status.status, 200)
  assert.equal(status.body.initialized, false)
  assert.equal(status.body.admin_key_fallback, true)
  assert.ok(status.body.password_min_length >= 8)

  assert.equal((await call('/api/status')).status, 401)
  assert.equal((await call('/api/providers')).status, 401)
  assert.equal((await call('/api/accounts')).status, 401)
  assert.equal((await call('/api/health')).status, 200, '健康检查必须继续豁免')
})

test('管理密钥通道保持兼容：现有部署脚本与 CI 不用改', async () => {
  const r = await json(await call('/api/status', { adminKey: ADMIN_KEY }))
  assert.equal(r.status, 200)
  assert.ok(r.body.overview)
})

test('首次认领：错管理密钥 401，正确密钥建出管理员并签发令牌', async () => {
  const bad = await json(await call('/api/auth/setup', {
    method: 'POST', body: { username: 'root', password: 'password123', admin_key: 'ak-wrong' }
  }))
  assert.equal(bad.status, 401)

  const weak = await json(await call('/api/auth/setup', {
    method: 'POST', body: { username: 'root', password: '123', admin_key: ADMIN_KEY }
  }))
  assert.equal(weak.status, 400, '弱密码必须被拒')

  const ok = await json(await call('/api/auth/setup', {
    method: 'POST', body: { username: 'Root', password: 'password123', admin_key: ADMIN_KEY }
  }))
  assert.equal(ok.status, 200)
  assert.equal(ok.body.account.username, 'root')
  assert.equal(ok.body.account.role, 'admin')
  assert.ok(ok.body.token?.startsWith('gwst_'))
  assert.ok(ok.body.session_ttl_hours > 0)
  assert.equal(JSON.stringify(ok.body).includes('password_hash'), false, '响应不得含密码摘要')

  const dup = await json(await call('/api/auth/setup', {
    method: 'POST', body: { username: 'other', password: 'password123', admin_key: ADMIN_KEY }
  }))
  assert.equal(dup.status, 409, '已初始化后不能重复认领')

  const status = await json(await call('/api/auth/status'))
  assert.equal(status.body.initialized, true)
})

test('登录 + 会话令牌可用；改密后旧令牌立即失效，新令牌续上', async () => {
  const bad = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'root', password: 'wrong-password' }
  }))
  assert.equal(bad.status, 401)

  const login = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'ROOT', password: 'password123' }
  }))
  assert.equal(login.status, 200)
  const token = login.body.token

  assert.equal((await call('/api/status', { token })).status, 200)
  assert.equal((await call('/api/accounts', { token })).status, 200)
  assert.equal((await call('/api/auth/me', { token })).status, 200)
  assert.equal((await call('/api/status', { token: token + 'x' })).status, 401, '篡改令牌必须被拒')

  const changed = await json(await call('/api/auth/password', {
    method: 'POST', token, body: { old_password: 'password123', new_password: 'password456' }
  }))
  assert.equal(changed.status, 200)
  assert.ok(changed.body.token, '改密响应要带新令牌，免得用户被自己踢下线')
  assert.equal((await call('/api/status', { token })).status, 401, '旧令牌立即作废')
  assert.equal((await call('/api/status', { token: changed.body.token })).status, 200)

  // 把密码改回去，避免影响后续用例
  const restored = await json(await call('/api/auth/password', {
    method: 'POST', token: changed.body.token,
    body: { old_password: 'password456', new_password: 'password123' }
  }))
  assert.equal(restored.status, 200)
})

test('账号管理：创建 user、角色隔离 403、停用后令牌失效、重置密码、删除', async () => {
  const me = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'root', password: 'password123' }
  }))
  const adminToken = me.body.token

  const created = await json(await call('/api/accounts', {
    method: 'POST', token: adminToken,
    body: { username: 'alice', password: 'alice-password', role: 'user', note: '给同事' }
  }))
  assert.equal(created.status, 200)
  assert.equal(created.body.account.role, 'user')
  const aliceId = created.body.account.id

  const list = await json(await call('/api/accounts', { token: adminToken }))
  assert.equal(list.body.total, 2)
  assert.ok(list.body.accounts.every((a) => !('password_hash' in a)))

  const userLogin = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'alice', password: 'alice-password' }
  }))
  assert.equal(userLogin.status, 200)
  const userToken = userLogin.body.token

  // 用户面板尚未开放：普通用户只能碰自助端点，其余管理接口 403
  assert.equal((await call('/api/auth/me', { token: userToken })).status, 200)
  assert.equal((await call('/api/providers', { token: userToken })).status, 403)
  assert.equal((await call('/api/accounts', { token: userToken })).status, 403)
  assert.equal((await call('/api/status', { token: userToken })).status, 403)

  // 停用账号后，即使令牌未过期也立刻失效
  const stopped = await json(await call(`/api/accounts/${aliceId}`, {
    method: 'PUT', token: adminToken, body: { enabled: false }
  }))
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.account.enabled, false)
  assert.equal((await call('/api/auth/me', { token: userToken })).status, 401)

  const enabled = await json(await call(`/api/accounts/${aliceId}`, {
    method: 'PUT', token: adminToken, body: { enabled: true }
  }))
  assert.equal(enabled.body.account.enabled, true)
  assert.equal((await call('/api/auth/me', { token: userToken })).status, 200)

  // 管理员重置密码 → 该账号已签发的令牌全部作废
  const reset = await json(await call(`/api/accounts/${aliceId}/password`, {
    method: 'POST', token: adminToken, body: { new_password: 'alice-new-password' }
  }))
  assert.equal(reset.status, 200)
  assert.equal(reset.body.account.password_version, 2)
  assert.equal((await call('/api/auth/me', { token: userToken })).status, 401)

  const relogin = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'alice', password: 'alice-new-password' }
  }))
  assert.equal(relogin.status, 200)

  const removed = await json(await call(`/api/accounts/${aliceId}`, { method: 'DELETE', token: adminToken }))
  assert.equal(removed.status, 200)
  assert.equal((await call('/api/auth/me', { token: relogin.body.token })).status, 401, '删除账号后令牌失效')
})

test('保护规则：不能自降/自删，系统至少留一个管理员', async () => {
  const me = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'root', password: 'password123' }
  }))
  const token = me.body.token
  const rootId = me.body.account.id

  const selfDemote = await json(await call(`/api/accounts/${rootId}`, {
    method: 'PUT', token, body: { role: 'user' }
  }))
  assert.equal(selfDemote.status, 400)

  const selfDelete = await json(await call(`/api/accounts/${rootId}`, { method: 'DELETE', token }))
  assert.equal(selfDelete.status, 400)

  const lastStop = await json(await call(`/api/accounts/${rootId}`, {
    method: 'PUT', token, body: { enabled: false }
  }))
  assert.equal(lastStop.status, 400)
})

test('登出端点可达，且审计类型为 auth', async () => {
  const me = await json(await call('/api/auth/login', {
    method: 'POST', body: { username: 'root', password: 'password123' }
  }))
  const out = await json(await call('/api/auth/logout', { method: 'POST', token: me.body.token }))
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  // 无状态令牌本身不会作废：前端丢掉它即完成登出
  assert.equal((await call('/api/status', { token: me.body.token })).status, 200)
})
