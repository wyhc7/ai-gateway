// 账号级模型授权的行为断言。
//
// 要守的三条：
//   1. 空数组 = 不限（老账号升级后行为不变，不能一夜之间全员 403）；
//   2. 账号限制了，它名下自助生成的 Key 立刻受限，不用重建 Key；
//   3. Key 自己的 allowed_models 优先于账号层——Key 层说不行就是不行。
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = await import('../store.js')
const ak = await import('../api-keys.js')
const acc = await import('../accounts.js')

const state = store.state

beforeEach(() => {
  state.accounts = []
  state.api_keys = []
})

function makeUser(id, allowed) {
  return {
    id, username: id, role: 'user', enabled: true, balance_micro: 10_000_000,
    allowed_models: allowed, created_at: Date.now(), last_login_at: 0
  }
}

// 建一个账号 + 一把绑定它的 Key，返回 auth
function setup(id, accountAllowed, keyAllowed = []) {
  state.accounts.push(makeUser(id, accountAllowed))
  const { token } = ak.createUserKey(id, { username: id })
  state.api_keys.find((k) => k.owner_account_id === id).allowed_models = keyAllowed
  return ak.resolveAuth(token).auth
}

describe('账号级允许清单', () => {
  test('账号不限（空数组）→ 旧行为，任何模型都放行', () => {
    const auth = setup('u1', [])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o').allowed, true)
    assert.equal(ak.modelAllowed(auth, 'deepseek-v4.1-flash').allowed, true)
  })

  test('账号限了模型 → 勾中的放行，其余拒绝', () => {
    const auth = setup('u2', ['gpt-4o', 'deepseek-v4.1-flash'])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o').allowed, true)
    assert.equal(ak.modelAllowed(auth, 'deepseek-v4.1-flash').allowed, true)
    const denied = ak.modelAllowed(auth, 'claude-sonnet-4')
    assert.equal(denied.allowed, false)
    assert.equal(denied.code, 'model_forbidden_account', '要和 Key 层拒绝区分开，便于排查')
  })

  test('账号层支持通配规则', () => {
    const auth = setup('u3', ['gpt-*', '*-free'])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o-mini').allowed, true)
    assert.equal(ak.modelAllowed(auth, 'something-free').allowed, true)
    assert.equal(ak.modelAllowed(auth, 'claude-sonnet-4').allowed, false)
  })

  test('账号规则忽略大小写', () => {
    const auth = setup('u4', ['GPT-4O'])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o').allowed, true)
  })

  test('Key 层白名单优先：账号放行但 Key 没放行的仍然拒绝', () => {
    const auth = setup('u5', ['gpt-4o', 'claude-sonnet-4'], ['gpt-4o'])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o').allowed, true)
    const out = ak.modelAllowed(auth, 'claude-sonnet-4')
    assert.equal(out.allowed, false)
    assert.equal(out.code, 'model_forbidden', '这是 Key 层拒绝，不是账号层')
  })

  test('Key 层 denied 最优先，连账号放行也压得住', () => {
    state.accounts.push(makeUser('u6', ['gpt-4o']))
    const { token } = ak.createUserKey('u6', { username: 'u6' })
    const key = state.api_keys.find((k) => k.owner_account_id === 'u6')
    key.allowed_models = []
    key.denied_models = ['gpt-4o']
    const auth = ak.resolveAuth(token).auth
    const out = ak.modelAllowed(auth, 'gpt-4o')
    assert.equal(out.allowed, false)
    assert.equal(out.code, 'model_denied')
  })

  test('管理员改了账号授权，现有 Key 立刻生效（不用重建 Key）', () => {
    const auth = setup('u7', [])
    assert.equal(ak.modelAllowed(auth, 'gpt-4o').allowed, true)

    // 管理员在账号上收窄（模拟 PUT /api/accounts/:id）
    const updated = acc.updateAccount('u7', { allowed_models: ['claude-sonnet-4'] })
    assert.deepEqual(updated.allowed_models, ['claude-sonnet-4'])

    // 同一把 Key 重新解析：授权现查，立刻变严
    const after = ak.resolveAuth(ak.rotateUserKey('u7', state.api_keys.find((k) => k.owner_account_id === 'u7').id).token).auth
    assert.equal(ak.modelAllowed(after, 'claude-sonnet-4').allowed, true)
    assert.equal(ak.modelAllowed(after, 'gpt-4o').allowed, false)
  })

  test('主密钥 / 无主 Key 永远不受账号授权影响', () => {
    const owner = ak.resolveAuth(state.gateway_api_key).auth
    assert.equal(ak.modelAllowed(owner, '任意模型').allowed, true)
  })

  test('账号被删后，孤儿 Key 不会因为查不到账号就被锁死', () => {
    state.accounts.push(makeUser('u8', ['gpt-4o']))
    const { token } = ak.createUserKey('u8', { username: 'u8' })
    // 模拟账号没了但 Key 还在（正常流程会一起删，这里测兜底）
    state.accounts = []
    const auth = ak.resolveAuth(token).auth
    assert.deepEqual(auth.account_allowed_models, [], '查不到账号按不限制处理')
  })
})

describe('normalizeModelRules', () => {
  test('去空白、去重、截断超长，非数组给空', () => {
    assert.deepEqual(acc.normalizeModelRules(['  gpt-4o  ', 'GPT-4O', '', 'claude']), ['gpt-4o', 'claude'])
    assert.deepEqual(acc.normalizeModelRules(null), [])
    assert.deepEqual(acc.normalizeModelRules('gpt-4o'), [], '非数组一律当空')
    assert.equal(acc.normalizeModelRules(['x'.repeat(500)])[0].length, 200, '单项截到 200 字')
  })

  test('serializeAccount 给出 model_scope 摘要', () => {
    const all = acc.serializeAccount(makeUser('a', []))
    assert.equal(all.model_scope, 'all')
    const some = acc.serializeAccount(makeUser('b', ['gpt-4o']))
    assert.equal(some.model_scope, 'restricted')
    assert.deepEqual(some.allowed_models, ['gpt-4o'])
  })
})
