// 账号核心单元测试
//
// 分三层：
// 1) 密码学：scrypt 摘要、校验、用户名/密码校验
// 2) 会话：签名令牌往返、篡改、停用/改密/重置后立刻失效
// 3) 账号生命周期：首次引导、登录、增删改、保护规则
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-accounts-'))

let state = null
let acc = null

before(async () => {
  ;({ state } = await import('../store.js'))
  acc = await import('../accounts.js')
})

beforeEach(() => {
  state.accounts = []
  state.session_secret = 'fixed-test-session-secret'
  state.admin_api_key = 'ak-unit-test-key'
})

describe('密码与字段校验', () => {
  test('同一密码两次哈希得到不同 salt 与摘要，且都能校验通过', () => {
    const a = acc.hashPassword('correct-horse-battery')
    const b = acc.hashPassword('correct-horse-battery')
    assert.notEqual(a.salt, b.salt)
    assert.notEqual(a.hash, b.hash)
    assert.equal(acc.verifyPassword('correct-horse-battery', a.salt, a.hash), true)
    assert.equal(acc.verifyPassword('correct-horse-battery', b.salt, b.hash), true)
    assert.equal(acc.verifyPassword('wrong-password', a.salt, a.hash), false)
  })

  test('摘要被截断/损坏时校验返回 false 而不是抛异常', () => {
    assert.equal(acc.verifyPassword('x', 'somesalt', ''), false)
    assert.equal(acc.verifyPassword('x', 'somesalt', 'deadbeef'), false)
  })

  test('用户名归一化：去空白 + 转小写，中文可用', () => {
    assert.equal(acc.normalizeUsername('  Admin.One '), 'admin.one')
    assert.equal(acc.validateUsername('运维老王'), '运维老王')
    assert.equal(acc.validateUsername('  User_01 '), 'user_01')
  })

  test('非法用户名与密码抛 400', () => {
    assert.throws(() => acc.validateUsername('a'), (e) => e.status === 400)
    assert.throws(() => acc.validateUsername('has space'), (e) => e.status === 400)
    assert.throws(() => acc.validateUsername('a'.repeat(33)), (e) => e.status === 400)
    assert.throws(() => acc.validatePassword('short'), (e) => e.status === 400)
    assert.throws(() => acc.validatePassword('x'.repeat(129)), (e) => e.status === 400)
  })
})

describe('首次引导', () => {
  test('未初始化时 authStatus 回 initialized=false，并暴露密码规则与会话时长', () => {
    const s = acc.authStatus()
    assert.equal(s.initialized, false)
    assert.equal(s.password_min_length, 8)
    assert.ok(s.session_ttl_hours > 0)
    assert.ok(s.roles.includes('admin') && s.roles.includes('user'))
  })

  test('认领必须带正确的管理密钥，错密钥 401', () => {
    assert.throws(
      () => acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-wrong' }),
      (e) => e.status === 401
    )
    assert.equal(state.accounts.length, 0)
  })

  test('认领成功后成为 admin，序列化结果不含任何密码字段', () => {
    const out = acc.setupAdmin({ username: 'Root', password: 'password123', adminKey: 'ak-unit-test-key' })
    assert.equal(out.account.username, 'root')
    assert.equal(out.account.role, 'admin')
    assert.equal(out.account.enabled, true)
    // password_version 是公开元数据（用于让前端判断旧会话是否作废），
    // 真正要挡的是摘要与盐本身，别用宽泛的 'password' 前缀把公开字段也误判了。
    const serialized = JSON.stringify(out.account)
    for (const field of ['password_hash', 'password_salt', '"hash"', '"salt"']) {
      assert.equal(serialized.includes(field), false, `响应里不该出现 ${field}`)
    }
    assert.equal(out.account.password_version, 1, '密码版本可以公开')
    assert.equal(acc.authStatus().initialized, true)
  })

  test('已初始化后重复认领回 409', () => {
    acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    assert.throws(
      () => acc.setupAdmin({ username: 'other', password: 'password123', adminKey: 'ak-unit-test-key' }),
      (e) => e.status === 409
    )
  })
})

describe('会话令牌', () => {
  test('签发的令牌能验回账号；签名或载荷被改动一律拒绝', () => {
    const { account } = acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    const raw = state.accounts[0]
    const token = acc.createSession(raw)
    assert.ok(token.startsWith('gwst_'))
    assert.equal(acc.verifySession(token).account.id, account.id)

    assert.equal(acc.verifySession(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null)
    assert.equal(acc.verifySession('gwst_tampered.payload.sig'), null)
    assert.equal(acc.verifySession(''), null)
    assert.equal(acc.verifySession(null), null)
  })

  test('账号被停用后即使令牌没过期也立即失效', () => {
    const { token, account } = acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    state.accounts.find((a) => a.id === account.id).enabled = false
    assert.equal(acc.verifySession(token), null)
    state.accounts.find((a) => a.id === account.id).enabled = true
    assert.ok(acc.verifySession(token))
  })

  test('改密 / 重置密码递增 password_version，旧令牌全部作废', () => {
    const { token, account } = acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    const changed = acc.changeOwnPassword(account.id, { oldPassword: 'password123', newPassword: 'new-password-456' })
    assert.equal(acc.verifySession(token), null, '改密后旧令牌必须失效')
    assert.ok(acc.verifySession(changed.token), '改密接口回的新令牌要能直接用')
    assert.equal(changed.account.password_version, 2)

    const reset = acc.resetAccountPassword(account.id, 'another-password-789')
    assert.equal(acc.verifySession(changed.token), null, '管理员重置后旧令牌同样失效')
    assert.equal(reset.password_version, 3)
  })

  test('旧密码改密回 401，且不改动任何凭据', () => {
    const { account } = acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    const before = { ...state.accounts[0] }
    assert.throws(
      () => acc.changeOwnPassword(account.id, { oldPassword: 'not-the-password', newPassword: 'new-password-456' }),
      (e) => e.status === 401
    )
    assert.deepEqual(state.accounts[0], before)
  })
})

describe('登录', () => {
  test('正确密码登录返回令牌与账号，错误密码 401', () => {
    acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    const out = acc.login({ username: 'ROOT', password: 'password123' }, '10.0.0.1')
    assert.ok(out.token)
    assert.equal(out.account.username, 'root')
    assert.ok(out.account.last_login_at > 0)
    assert.throws(
      () => acc.login({ username: 'root', password: 'oops-wrong' }, '10.0.0.2'),
      (e) => e.status === 401
    )
  })

  test('连续失败 5 次后同 IP+用户名被限流 429', () => {
    acc.setupAdmin({ username: 'root', password: 'password123', adminKey: 'ak-unit-test-key' })
    for (let i = 0; i < 5; i++) {
      assert.throws(() => acc.login({ username: 'root', password: 'bad' }, '10.0.0.9'), (e) => e.status === 401)
    }
    assert.throws(
      () => acc.login({ username: 'root', password: 'password123' }, '10.0.0.9'),
      (e) => e.status === 429
    )
    // 换 IP 不受影响，说明限流键确实是 IP+用户名
    assert.ok(acc.login({ username: 'root', password: 'password123' }, '10.0.0.10').token)
  })
})

describe('账号增删改与保护规则', () => {
  test('创建 user 账号：默认启用，重名 409，非法角色 400', () => {
    const created = acc.createAccount({ username: 'Alice', password: 'alice-password', role: 'user', note: '给同事' })
    assert.equal(created.username, 'alice')
    assert.equal(created.role, 'user')
    assert.equal(created.enabled, true)
    assert.equal(created.note, '给同事')
    assert.equal(acc.listAccounts().length, 1)
    assert.throws(() => acc.createAccount({ username: 'alice', password: 'whatever-pass' }), (e) => e.status === 409)
    assert.throws(() => acc.createAccount({ username: 'bob', password: 'whatever-pass', role: 'superadmin' }), (e) => e.status === 400)
  })

  test('不能把自己降级，也不能删自己', () => {
    const admin = acc.createAccount({ username: 'root', password: 'password123', role: 'admin' })
    assert.throws(() => acc.updateAccount(admin.id, { role: 'user' }, admin.id), (e) => e.status === 400)
    assert.throws(() => acc.deleteAccount(admin.id, admin.id), (e) => e.status === 400)
  })

  test('至少保留一个启用中的管理员：降级/停用/删除都被拦', () => {
    const admin = acc.createAccount({ username: 'root', password: 'password123', role: 'admin' })
    const user = acc.createAccount({ username: 'alice', password: 'alice-password', role: 'user' })
    assert.throws(() => acc.updateAccount(admin.id, { role: 'user' }, user.id), (e) => e.status === 400)
    assert.throws(() => acc.updateAccount(admin.id, { enabled: false }, user.id), (e) => e.status === 400)
    assert.throws(() => acc.deleteAccount(admin.id, user.id), (e) => e.status === 400)

    // 有了第二个管理员后就能正常停用了
    acc.createAccount({ username: 'root2', password: 'password123', role: 'admin' })
    const stopped = acc.updateAccount(admin.id, { enabled: false }, user.id)
    assert.equal(stopped.enabled, false)
  })

  test('更新备注与删除都按预期生效', () => {
    const user = acc.createAccount({ username: 'alice', password: 'alice-password', role: 'user' })
    const updated = acc.updateAccount(user.id, { note: '交接给二组' }, 'someone-else')
    assert.equal(updated.note, '交接给二组')
    acc.deleteAccount(user.id, 'someone-else')
    assert.equal(acc.listAccounts().length, 0)
    assert.throws(() => acc.updateAccount(user.id, { note: 'x' }, 'someone-else'), (e) => e.status === 404)
  })
})
