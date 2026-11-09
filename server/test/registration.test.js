// 自助注册的行为断言。
//
// 这个功能的危险点只有三个，测试就盯着这三个：
//   1. 注册出来的账号绝不能是 admin（参数里塞 role 也没用）；
//   2. 开关关闭时必须 403，不能因为「有端点」就等于「开放」；
//   3. 同 IP 每小时的配额要真的生效，否则放开注册就是一个建号机。
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = await import('../store.js')
const acc = await import('../accounts.js')

const state = store.state

beforeEach(() => {
  state.accounts = []
  state.registration = { enabled: false }
})

const IP = () => `10.0.0.${Math.floor(Math.random() * 250) + 1}`

describe('registerAccount：注册出来的永远是普通用户', () => {
  test('正常注册：角色 user、余额 0、直接拿到会话令牌', () => {
    const ip = IP()
    const out = acc.registerAccount({ username: 'Alice', password: 'alice-password' }, ip)
    assert.equal(out.account.role, 'user')
    assert.equal(out.account.username, 'alice', '用户名统一小写')
    assert.equal(out.token.startsWith('gwst_'), true, '注册即签发会话')
    assert.ok(out.session_ttl_hours > 0)

    const raw = state.accounts.find((a) => a.username === 'alice')
    assert.equal(raw.role, 'user')
    assert.equal(raw.balance_micro, 0, '初始余额必须是 0')
    assert.equal(raw.enabled, true)
    assert.equal(raw.password_hash.length > 0, true)
    assert.equal(JSON.stringify(out.account).includes(raw.password_hash), false, '摘要不能进响应')
  })

  test('参数里塞 role: admin 也不会变成管理员', () => {
    const ip = IP()
    const out = acc.registerAccount({ username: 'bob', password: 'bob-password', role: 'admin' }, ip)
    assert.equal(out.account.role, 'user', 'role 参数被忽略，永远写死 user')
    assert.equal(state.accounts.find((a) => a.username === 'bob').role, 'user')
  })

  test('注册后能立刻用密码登录', () => {
    const ip = IP()
    acc.registerAccount({ username: 'carol', password: 'carol-password' }, ip)
    const out = acc.login({ username: 'carol', password: 'carol-password' }, ip)
    assert.equal(out.account.username, 'carol')
  })

  test('重名返回 409，且不消耗 IP 配额', () => {
    const ip = IP()
    acc.registerAccount({ username: 'dave', password: 'dave-password' }, ip)
    assert.throws(
      () => acc.registerAccount({ username: 'dave', password: 'dave-password' }, ip),
      (e) => e.status === 409
    )
    // 重名已经把配额退回去了，还能继续注册 4 个
    for (let i = 0; i < 4; i++) {
      acc.registerAccount({ username: `dave${i}`, password: 'dave-password' }, ip)
    }
  })

  test('密码太短返回 400', () => {
    assert.throws(
      () => acc.registerAccount({ username: 'eve', password: '123' }, IP()),
      (e) => e.status === 400
    )
  })

  test('用户名非法返回 400', () => {
    assert.throws(
      () => acc.registerAccount({ username: 'a', password: 'long-enough-pw' }, IP()),
      (e) => e.status === 400
    )
  })
})

describe('注册开关', () => {
  test('默认关闭', () => {
    assert.equal(acc.registrationEnabled(), false)
  })

  test('config.registration.enabled = true 才算开', () => {
    state.registration = { enabled: true }
    assert.equal(acc.registrationEnabled(), true)
    state.registration = { enabled: 'yes' }
    assert.equal(acc.registrationEnabled(), false, '非布尔 true 一律当关闭')
    state.registration = undefined
    assert.equal(acc.registrationEnabled(), false, '缺字段当关闭')
  })
})

describe('每 IP 每小时配额', () => {
  test('同一 IP 第 6 个就 429', () => {
    const ip = IP()
    for (let i = 0; i < 5; i++) {
      acc.registerAccount({ username: `u${i}`, password: 'long-enough-pw' }, ip)
    }
    assert.throws(
      () => acc.registerAccount({ username: 'u5', password: 'long-enough-pw' }, ip),
      (e) => e.status === 429
    )
  })

  test('不同 IP 各自独立计数', () => {
    const ipA = IP()
    for (let i = 0; i < 5; i++) {
      acc.registerAccount({ username: `a${i}`, password: 'long-enough-pw' }, ipA)
    }
    // ipA 满了，换一个 IP 照样能注册
    const ipB = IP()
    assert.doesNotThrow(() => acc.registerAccount({ username: 'b0', password: 'long-enough-pw' }, ipB))
  })
})
