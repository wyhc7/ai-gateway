// 访问密钥（客户端 Key）与模型权限测试
//
// 覆盖三层：
// 1) 纯函数层：规则通配匹配、模型放行判定、模型列表裁剪
// 2) 存储层：明文只落摘要、生命周期（创建/更新/轮换/删除/停用/过期）
// 3) 请求层：受限 Key 调 chat 被 403 拦下（且不产生任何上游请求）、
//    /v1/models 列表按权限裁剪
import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-apikeys-'))

const realFetch = globalThis.fetch

let state = null
let ak = null
let proxy = null
let CONFIG_PATH = ''

before(async () => {
  ;({ state } = await import('../store.js'))
  ak = await import('../api-keys.js')
  proxy = await import('../proxy.js')
  CONFIG_PATH = join(process.env.DATA_DIR, 'config.json')
})

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => {
  globalThis.fetch = realFetch
  state.api_keys = []
})

// 假响应对象：只需要 respondJson 用到的那几个方法
function mockRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: '',
    status(code) { this.statusCode = code; return this },
    setHeader() {},
    end(body) { if (body !== undefined) this.body = String(body); this.writableEnded = true },
    on() {}
  }
}

describe('ruleMatches：模型名规则匹配', () => {
  test('精确名只匹配它自己', () => {
    assert.equal(ak.ruleMatches('gpt-4o', 'gpt-4o'), true)
    assert.equal(ak.ruleMatches('gpt-4o', 'gpt-4o-mini'), false)
  })

  test('通配符覆盖前缀/后缀/中间/全匹配', () => {
    assert.equal(ak.ruleMatches('*', 'anything-at-all'), true)
    assert.equal(ak.ruleMatches('gpt-*', 'gpt-4o'), true)
    assert.equal(ak.ruleMatches('*-free', 'nemotron-3-ultra-free'), true)
    assert.equal(ak.ruleMatches('claude-*-latest', 'claude-3-5-latest'), true)
    assert.equal(ak.ruleMatches('gpt-*', 'claude-4'), false)
  })

  test('大小写不敏感（客户端常把模型名写乱大小写）', () => {
    assert.equal(ak.ruleMatches('GPT-4O', 'gpt-4o'), true)
    assert.equal(ak.ruleMatches('gpt-4o', 'GPT-4O'), true)
  })

  test('规则里的正则元字符不被当成正则解释', () => {
    // 模型名里出现 . 和 + 是常态（如 deepseek.v3、qwen+）；若不转义，
    // 'deepseek.v3' 的 . 会变成「任意字符」，把 deepseek-v3 也放进来
    assert.equal(ak.ruleMatches('deepseek.v3', 'deepseek.v3'), true)
    assert.equal(ak.ruleMatches('deepseek.v3', 'deepseek-v3'), false)
    assert.equal(ak.ruleMatches('a+b', 'a+b'), true)
    assert.equal(ak.ruleMatches('a+b', 'aab'), false)
    // 括号不闭合也不能把进程搞崩
    assert.equal(ak.ruleMatches('((', 'x'), false)
  })

  test('空规则与空模型名一律不匹配', () => {
    assert.equal(ak.ruleMatches('', 'gpt-4o'), false)
    assert.equal(ak.ruleMatches('   ', 'gpt-4o'), false)
    assert.equal(ak.ruleMatches('gpt-*', ''), false)
  })
})

describe('modelAllowed：模型放行判定', () => {
  const keyAuth = (allowed, denied = []) => ({ kind: 'key', unrestricted: false, allowed_models: allowed, denied_models: denied })

  test('主密钥（unrestricted）不校验模型', () => {
    assert.equal(ak.modelAllowed({ kind: 'owner', unrestricted: true }, 'whatever').allowed, true)
  })

  test('allowed 为空数组表示不限制', () => {
    assert.equal(ak.modelAllowed(keyAuth([]), 'any-model').allowed, true)
  })

  test('不在白名单内 → model_forbidden', () => {
    const r = ak.modelAllowed(keyAuth(['gpt-4o']), 'claude-4')
    assert.equal(r.allowed, false)
    assert.equal(r.code, 'model_forbidden')
  })

  test('白名单命中 → 放行', () => {
    assert.equal(ak.modelAllowed(keyAuth(['gpt-*']), 'gpt-4o-mini').allowed, true)
  })

  test('denied 优先于 allowed', () => {
    // 放开 gpt-* 但单独禁掉贵的那个，是最常见的用法
    const r = ak.modelAllowed(keyAuth(['gpt-*'], ['gpt-4o']), 'gpt-4o')
    assert.equal(r.allowed, false)
    assert.equal(r.code, 'model_denied')
    assert.equal(r.rule, 'gpt-4o')
    // 同一批规则里没被排除的仍然可用
    assert.equal(ak.modelAllowed(keyAuth(['gpt-*'], ['gpt-4o']), 'gpt-4o-mini').allowed, true)
  })

  test('空模型名不在这里拦（交给下游返回更准确的 404）', () => {
    assert.equal(ak.modelAllowed(keyAuth(['gpt-4o']), '').allowed, true)
  })
})

describe('filterModelsForAuth：模型列表裁剪', () => {
  const models = [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'claude-4' }]

  test('主密钥看到全部', () => {
    assert.equal(ak.filterModelsForAuth(models, { unrestricted: true }).length, 3)
  })

  test('受限 Key 只看到被放行的', () => {
    const out = ak.filterModelsForAuth(models, { unrestricted: false, allowed_models: ['gpt-*'], denied_models: [] })
    assert.deepEqual(out.map((m) => m.id), ['gpt-4o', 'gpt-4o-mini'])
  })
})

describe('密钥生命周期与存储', () => {
  test('创建返回明文，但库里只留摘要（明文不落盘）', () => {
    const { key, token } = ak.createApiKey({ name: '给小王', allowed_models: ['gpt-*'] })
    assert.ok(token.startsWith('sk-'))
    assert.ok(token.length > 20)
    // 序列化结果里绝不能出现明文或摘要
    const json = JSON.stringify(key)
    assert.ok(!json.includes(token), '序列化结果泄露了明文密钥')
    assert.equal(key.key_hash, undefined)
    // 原始记录里只应该有 key_hash
    const raw = state.api_keys.find((k) => k.id === key.id)
    assert.ok(raw.key_hash)
    assert.ok(!JSON.stringify(raw).includes(token), '落盘记录里出现了明文')
    assert.equal(raw.allowed_models[0], 'gpt-*')
  })

  test('落盘文件里同样不含明文', () => {
    const { token } = ak.createApiKey({ name: '落盘检查' })
    // persistImmediate 是同步写，读回来直接查
    const text = readFileSync(CONFIG_PATH, 'utf-8')
    assert.ok(!text.includes(token), 'config.json 里出现了明文密钥')
  })

  test('key_preview 可辨识但不等于明文', () => {
    const { key, token } = ak.createApiKey({ name: '预览' })
    assert.notEqual(key.key_preview, token)
    assert.ok(token.startsWith(key.key_preview.slice(0, 8)))
    assert.ok(key.key_preview.includes('…'))
  })

  test('更新名称/规则/到期时间/备注', () => {
    const { key } = ak.createApiKey({ name: 'A', allowed_models: ['gpt-4o'] })
    const next = ak.updateApiKey(key.id, {
      name: 'B',
      allowed_models: ['claude-*', 'claude-*', ' '],
      denied_models: ['claude-4-opus'],
      expires_at: 1893456000000,
      note: '备注'
    })
    assert.equal(next.name, 'B')
    // 去重 + 去空白
    assert.deepEqual(next.allowed_models, ['claude-*'])
    assert.deepEqual(next.denied_models, ['claude-4-opus'])
    assert.equal(next.expires_at, 1893456000000)
    assert.equal(next.model_scope, 'restricted')
  })

  test('allowed_models 清空后回到「全部模型」', () => {
    const { key } = ak.createApiKey({ name: 'C', allowed_models: ['gpt-4o'] })
    const next = ak.updateApiKey(key.id, { allowed_models: [] })
    assert.equal(next.model_scope, 'all')
    assert.deepEqual(next.allowed_models, [])
  })

  test('轮换换掉密钥但保留权限与用量', () => {
    const { key, token: oldToken } = ak.createApiKey({ name: 'D', allowed_models: ['gpt-*'] })
    const raw = state.api_keys.find((k) => k.id === key.id)
    raw.usage.requests = 7
    const out = ak.rotateApiKey(key.id)
    assert.notEqual(out.token, oldToken)
    assert.deepEqual(out.key.allowed_models, ['gpt-*'])
    assert.equal(out.key.usage.requests, 7)
    // 旧钥匙立即失效
    assert.equal(ak.resolveAuth(oldToken).ok, false)
    assert.equal(ak.resolveAuth(out.token).ok, true)
  })

  test('删除后密钥失效', () => {
    const { key, token } = ak.createApiKey({ name: 'E' })
    assert.equal(ak.deleteApiKey(key.id), true)
    assert.equal(ak.resolveAuth(token).ok, false)
    assert.equal(ak.deleteApiKey(key.id), false)
  })

  test('重置用量不动密钥本身', () => {
    const { key, token } = ak.createApiKey({ name: 'F' })
    ak.recordUsage(ak.resolveAuth(token).auth, { tokens: 120 })
    assert.equal(ak.getApiKey(key.id).usage.tokens, 120)
    const out = ak.resetApiKeyUsage(key.id)
    assert.equal(out.usage.tokens, 0)
    assert.equal(ak.resolveAuth(token).ok, true)
  })
})

describe('resolveAuth：请求携带的 Key 如何被识别', () => {
  test('主密钥不受限，且与子密钥区分开', () => {
    const r = ak.resolveAuth(state.gateway_api_key)
    assert.equal(r.ok, true)
    assert.equal(r.auth.kind, 'owner')
    assert.equal(r.auth.unrestricted, true)
  })

  test('子密钥带上自己的模型白名单', () => {
    const { token } = ak.createApiKey({ name: '受限', allowed_models: ['gpt-*'] })
    const r = ak.resolveAuth(token)
    assert.equal(r.ok, true)
    assert.equal(r.auth.kind, 'key')
    assert.equal(r.auth.unrestricted, false)
    assert.deepEqual(r.auth.allowed_models, ['gpt-*'])
  })

  test('空 Key → 401 且提示怎么带 Key', () => {
    const r = ak.resolveAuth('')
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
    assert.match(r.message, /Authorization/)
  })

  test('不存在的 Key → 401', () => {
    const r = ak.resolveAuth('sk-not-a-real-key')
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
  })

  test('停用的 Key → 403 并说明原因（而不是笼统的「无效」）', () => {
    const { key, token } = ak.createApiKey({ name: '停用中' })
    ak.updateApiKey(key.id, { enabled: false })
    const r = ak.resolveAuth(token)
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
    assert.match(r.message, /已被停用/)
    assert.match(r.message, /停用中/)
  })

  test('过期的 Key → 403', () => {
    const { key, token } = ak.createApiKey({ name: '过期了', expires_at: Date.now() - 1000 })
    assert.equal(ak.getApiKey(key.id).expires_at > 0, true)
    const r = ak.resolveAuth(token)
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
    assert.match(r.message, /已过期/)
  })

  test('鉴权成功会刷新 last_used_at', () => {
    const { key, token } = ak.createApiKey({ name: '用一下' })
    assert.equal(ak.getApiKey(key.id).last_used_at, 0)
    ak.resolveAuth(token)
    assert.ok(ak.getApiKey(key.id).last_used_at > 0)
  })
})

describe('请求层：模型权限真正生效', () => {
  before(() => {
    state.providers = [{
      id: 'p1',
      name: '平台甲',
      base_url: 'https://upstream.example/v1',
      protocol: 'openai-chat',
      enabled: true,
      models: [{ id: 'gpt-4o', owned_by: '平台甲' }, { id: 'cheap-model', owned_by: '平台甲' }],
      keys: [{ id: 'k1', name: '上游 Key', api_key: 'up-1', enabled: true, cooldown_until: 0 }],
      extra_headers: {}
    }]
  })

  test('受限 Key 调被禁模型 → 403，且没有发出任何上游请求', async () => {
    let called = 0
    globalThis.fetch = async () => { called += 1; throw new Error('不该走到上游') }
    const { auth } = ak.resolveAuth((() => {
      const { token } = ak.createApiKey({ name: '只用便宜货', allowed_models: ['cheap-model'] })
      return token
    })())
    const req = { body: { model: 'gpt-4o', messages: [] }, apiAuth: auth }
    const res = mockRes()
    await proxy.handleChat(req, res)
    assert.equal(res.statusCode, 403)
    const payload = JSON.parse(res.body)
    assert.equal(payload.error.type, 'model_forbidden')
    assert.match(payload.error.message, /无权使用模型/)
    assert.equal(called, 0, '被拒绝的请求不应触达上游')
  })

  test('403 文案形如 API Key「名字」无权使用模型，且不留多余空格', async () => {
    const { token } = ak.createApiKey({ name: '给小王', allowed_models: ['cheap-model'] })
    const { auth } = ak.resolveAuth(token)
    globalThis.fetch = async () => { throw new Error('不该走到上游') }
    const res = mockRes()
    await proxy.handleChat({ body: { model: 'gpt-4o', messages: [] }, apiAuth: auth }, res)
    const message = JSON.parse(res.body).error.message
    // 允许列表用的是「」而不是全角括号：括号后接中文得补一个空格才不挤，
    // 一旦有人改回括号，这条断言会立刻失败
    assert.match(message, /^API Key「给小王」无权使用模型 "gpt-4o"。/)
    assert.ok(!/）\s/.test(message), `全角括号后出现了多余空格: ${message}`)
    // 报错要把这把 Key 的实际授权范围说清楚，否则用户不知道该改成什么
    assert.match(message, /仅被授权：cheap-model/)
    assert.match(message, /访问密钥/)
  })

  test('provider:xxx/model 前缀写法绕不过白名单', async () => {
    // resolveTarget 会把 provider:p1/gpt-4o 拆成 model=gpt-4o，
    // 校验必须发生在拆分之后，否则这道前缀就是个免费的绕过口子
    globalThis.fetch = async () => { throw new Error('不该走到上游') }
    const { token } = ak.createApiKey({ name: '前缀绕过测试', allowed_models: ['cheap-model'] })
    const { auth } = ak.resolveAuth(token)
    const req = { body: { model: 'provider:p1/gpt-4o', messages: [] }, apiAuth: auth }
    const res = mockRes()
    await proxy.handleChat(req, res)
    assert.equal(res.statusCode, 403)
  })

  test('白名单放行的模型不会被拦（走到上游才可能失败）', async () => {
    const { token } = ak.createApiKey({ name: '放行', allowed_models: ['cheap-model'] })
    const { auth } = ak.resolveAuth(token)
    globalThis.fetch = async () => { throw new Error('网络层故意失败') }
    const req = { body: { model: 'cheap-model', messages: [] }, apiAuth: auth }
    const res = mockRes()
    await proxy.handleChat(req, res)
    // 不再是 403，说明确实放行进入转发流程了
    assert.notEqual(res.statusCode, 403)
  })

  test('/v1/models 只返回该 Key 被授权的模型', () => {
    const { token } = ak.createApiKey({ name: '列表裁剪', allowed_models: ['cheap-model'] })
    const { auth } = ak.resolveAuth(token)
    const res = mockRes()
    proxy.handleModels({ apiAuth: auth }, res)
    const data = JSON.parse(res.body).data
    assert.deepEqual(data.map((m) => m.id), ['cheap-model'])
  })

  test('主密钥的 /v1/models 仍是全量', () => {
    const { auth } = ak.resolveAuth(state.gateway_api_key)
    const res = mockRes()
    proxy.handleModels({ apiAuth: auth }, res)
    const data = JSON.parse(res.body).data
    assert.deepEqual(data.map((m) => m.id).sort(), ['cheap-model', 'gpt-4o'])
  })

  test('用量按 Key 分别累计', async () => {
    const { key, token } = ak.createApiKey({ name: '计费用' })
    const { auth } = ak.resolveAuth(token)
    globalThis.fetch = async () => { throw new Error('失败') }
    const req = { body: { model: 'cheap-model', messages: [] }, apiAuth: auth }
    await proxy.handleChat(req, mockRes())
    const raw = ak.getApiKey(key.id)
    assert.equal(raw.usage.requests, 1)
    assert.equal(raw.usage.failed, 1)
  })
})
