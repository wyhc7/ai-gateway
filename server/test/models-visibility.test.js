// /v1/models 的输出形态。
//
// 两套口径必须分清楚，这是用户明确要求的：
//   · 管理员/主密钥 —— id 带倍率后缀（`GLM-5.3 · x0.79`），管理端要看报价
//   · 普通用户     —— id 是干净的模型 id（`GLM-5.3`），不该看到内部倍率账
//
// 这里只测 handleModels 的纯逻辑：起一个假的 req/res，不碰网络。
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = await import('../store.js')
const ak = await import('../api-keys.js')
const { handleModels } = await import('../proxy.js')

const state = store.state

function seed() {
  state.providers = [
    {
      id: 'p1', name: '国内平台', enabled: true,
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4 Flash', rate: 'x0.11' },
        { id: 'GLM-5.3', name: 'GLM-5.3', rate: 'x0.79' }
      ]
    },
    {
      id: 'p2', name: '国际平台', enabled: true,
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4 Flash', rate: 'x0.00' },
        { id: 'gpt-4o', name: 'GPT-4o', rate: 'x2.20 credits' }
      ]
    }
  ]
}

// 每个用例都从同一份种子数据开始：state 是模块级单例，不重置会互相污染。
beforeEach(() => {
  seed()
  state.api_keys = []
  state.accounts = []
})

// 跑一次 handleModels，把结果 JSON 解回来
function callModels(auth) {
  let body = ''
  const res = {
    setHeader() {},
    end(chunk) { body = chunk }
  }
  handleModels({ apiAuth: auth }, res)
  return JSON.parse(body).data
}

describe('管理视角：id 带倍率', () => {
  beforeEach(seed)

  test('主密钥看到的 id 形如「名称 · x倍率」', () => {
    const list = callModels(ak.resolveAuth(state.gateway_api_key).auth)
    const ids = list.map((m) => m.id)
    assert.ok(ids.some((id) => id.includes('· x')), '管理视角保留倍率后缀')
    // publicModelName 优先用 m.name（有别名就用别名），所以断言的是「名称 + 倍率」
    assert.ok(ids.includes('GLM-5.3 · x0.79'))
    assert.ok(ids.includes('GPT-4o · x2.20'), 'credits 单位被剥掉')
  })

  test('同名不同倍率保留为两条（管理端要能分别点名）', () => {
    const list = callModels(ak.resolveAuth(state.gateway_api_key).auth)
    const deepseek = list.filter((m) => m.id.startsWith('DeepSeek V4 Flash'))
    assert.equal(deepseek.length, 2, 'x0.00 与 x0.11 是两个可选项')
  })
})

describe('用户视角：id 是干净的模型 id', () => {
  beforeEach(() => {
    seed()
    state.accounts = [{
      id: 'u1', username: 'u1', role: 'user', enabled: true,
      balance_micro: 10_000_000, allowed_models: [], created_at: Date.now()
    }]
    state.api_keys = []
  })

  function userAuth() {
    const { token } = ak.createUserKey('u1', { username: 'u1' })
    return ak.resolveAuth(token).auth
  }

  test('id 里不含「· x」，就是纯模型 id', () => {
    const list = callModels(userAuth())
    for (const m of list) {
      assert.equal(/·\s*x/i.test(m.id), false, `用户不该看到倍率：${m.id}`)
      assert.equal(m.name, m.id, 'name 与 id 一致，客户端显示什么就是调什么')
    }
  })

  test('纯 id 能在列表里找到', () => {
    const ids = callModels(userAuth()).map((m) => m.id)
    assert.ok(ids.includes('GLM-5.3'))
    assert.ok(ids.includes('gpt-4o'))
    assert.ok(ids.includes('deepseek-v4.1-flash'))
  })

  test('同一 id 的多个来源合并成一条', () => {
    const list = callModels(userAuth())
    const deepseek = list.filter((m) => m.id === 'deepseek-v4.1-flash')
    assert.equal(deepseek.length, 1, '用户手里只有一个名字，露两条只会更乱')
  })

  test('账号被限制后，列表里只剩放行的模型', () => {
    const auth = userAuth()
    state.accounts.find((a) => a.id === 'u1').allowed_models = ['GLM-5.3']
    const again = ak.resolveAuth(
      ak.rotateUserKey('u1', state.api_keys.find((k) => k.owner_account_id === 'u1').id).token
    ).auth
    const ids = callModels(again).map((m) => m.id)
    assert.deepEqual(ids, ['GLM-5.3'], '列表要跟真实放行范围一致')
  })

  test('列表项仍是标准 OpenAI 结构', () => {
    const list = callModels(userAuth())
    for (const m of list) {
      assert.equal(m.object, 'model')
      assert.equal(typeof m.owned_by, 'string')
      assert.equal(typeof m.provider, 'string')
      assert.equal(typeof m.provider_name, 'string')
    }
  })
})

describe('禁用的平台不出现在任何一个视角', () => {
  test('enabled=false 的平台整条跳过', () => {
    seed()
    state.providers[0].enabled = false
    const list = callModels(ak.resolveAuth(state.gateway_api_key).auth)
    assert.equal(list.some((m) => m.provider === 'p1'), false)
  })
})
