// Grok 订阅账号模型兜底测试
// 1) defaultModelsFor 按协议返回内置默认模型
// 2) refreshModels 在上游 /models 拉取失败时退回默认列表，保证平台立即可用
import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-models-'))

const realFetch = globalThis.fetch

let state = null
let defaultModelsFor = null
let refreshModels = null
let autoHeaders = null
let handleModels = null
let canonicalModelId = null
let stripRateSuffix = null
let TEMPLATES = null

before(async () => {
  ;({ state } = await import('../store.js'))
  ;({ defaultModelsFor, refreshModels, autoHeaders, handleModels, canonicalModelId, stripRateSuffix } = await import('../proxy.js'))
  ;({ TEMPLATES } = await import('../templates.js'))
})

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('defaultModelsFor', () => {
  test('grok-oauth 协议返回非空默认模型列表，且每项带 id/owned_by', () => {
    const models = defaultModelsFor('grok-oauth')
    assert.ok(Array.isArray(models) && models.length > 0)
    assert.ok(models.every((m) => m.id && m.owned_by))
  })

  test('回归：cli-chat-proxy 订阅通道兜底必须是 grok-4.6（订阅号唯一可用模型）', () => {
    // cli-chat-proxy 订阅通道实测只有 grok-4.6，请求其他模型一律 402。
    // 若兜底列表写成 grok-4/3/2 系列，「刷新模型失败 → 兜底覆盖」会把
    // 手工设置的模型冲成一批必然失败的模型名，表现为平台全部请求报
    // 「未找到提供模型 grok-4.6 的平台」。
    const grok = defaultModelsFor('grok-oauth')
    assert.deepEqual(grok.map((m) => m.id), ['grok-4.6'])
  })

  test('openai-chat 等无默认模型的协议返回 null', () => {
    assert.equal(defaultModelsFor('openai-chat'), null)
  })

  test('未知协议返回 null', () => {
    assert.equal(defaultModelsFor('no-such-protocol'), null)
  })

  test('回归：模板自带的 default_models 不得扩散到同协议的其他平台', () => {
    // 兜底名单必须按「上游有没有 /models」来定，不能按「模板里有没有写默认模型」。
    // chatgpt-web 是 openai-chat 协议且自带 gpt-5 / gpt-image-2 等默认模型；
    // 一旦按协议匹配，DeepSeek / 通义 / Gemini / 硅基流动 / Ollama 等约 20 个
    // openai-chat 平台在拉取模型失败时都会被静默塞进 ChatGPT 的模型列表，
    // 界面显示「拉取成功」，但用户拿 deepseek-chat 请求必然失败且毫无提示。
    const chatgptWeb = TEMPLATES.find((t) => t.id === 'chatgpt-web')
    assert.ok(chatgptWeb, 'chatgpt-web 模板应存在')
    assert.ok(chatgptWeb.default_models?.length > 0, 'chatgpt-web 应自带默认模型，否则这条回归失去意义')
    assert.equal(chatgptWeb.protocol, 'openai-chat')

    assert.equal(defaultModelsFor('openai-chat'), null)

    // 反过来，确实没有 /models 的订阅协议必须继续兜底
    assert.ok(defaultModelsFor('grok-oauth')?.length > 0)
    assert.ok(defaultModelsFor('codex-oauth')?.length > 0)
  })
})

describe('refreshModels 兜底', () => {
  test('上游 /models 网络失败时退回内置默认列表并返回 ok', async () => {
    // 上游统一抛网络错误（模拟 cli-chat-proxy 不可达 / 无 /models）
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }

    const p = {
      id: 'p-grok-1',
      name: 'Grok 测试',
      base_url: 'https://cli-chat-proxy.grok.com/v1',
      protocol: 'grok-oauth',
      enabled: true,
      models: [],
      keys: [{
        id: 'k-1',
        type: 'oauth',
        provider: 'grok',
        name: 'Grok-01',
        enabled: true,
        cooldown_until: 0,
        last_error: null,
        last_error_at: null,
        access_token: 'at-sso',
        refresh_token: ''
      }],
      extra_headers: {}
    }
    state.providers.push(p)
    try {
      const r = await refreshModels(p.id)
      assert.equal(r.ok, true)
      assert.equal(r.fallback, true)
      assert.ok(Array.isArray(p.models) && p.models.length > 0)
      assert.equal(p.models_source, 'default')
    } finally {
      state.providers.length = 0
    }
  })

  test('普通 openai-chat 平台失败时不兜底，返回错误', async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }

    const p = {
      id: 'p-openai-1',
      name: 'OpenAI 测试',
      base_url: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      enabled: true,
      models: [],
      keys: [{
        id: 'k-2',
        name: 'Key 1',
        api_key: 'sk-x',
        enabled: true,
        cooldown_until: 0,
        last_error: null,
        last_error_at: null
      }],
      extra_headers: {}
    }
    state.providers.push(p)
    try {
      const r = await refreshModels(p.id)
      assert.equal(r.ok, false)
      assert.equal(p.models.length, 0)
    } finally {
      state.providers.length = 0
    }
  })
})

describe('autoHeaders（上游自动附加头）', () => {
  test('cli-chat-proxy.grok.com 自动带上 x-grok-client-version 与 x-grok-client-surface', () => {
    const h = autoHeaders({ base_url: 'https://cli-chat-proxy.grok.com/v1' })
    assert.equal(h['x-grok-client-version'], '0.1.202')
    assert.equal(h['x-grok-client-surface'], 'grok-cli')
  })

  test('其他平台（api.x.ai）不带 grok 版本头', () => {
    const h = autoHeaders({ base_url: 'https://api.x.ai/v1' })
    assert.equal(h['x-grok-client-version'], undefined)
    assert.equal(h['x-grok-client-surface'], undefined)
  })
})

describe('handleModels：倍率直接写进模型名', () => {
  // 调用方拿 /v1/models 选模型，倍率是上游（WorkBuddy 系 credits）给的
  // 事实，必须跟在名字后面出现：`GLM-5.3 · x0.79`。上游没给倍率的
  // 平台（标准 OpenAI /models 只有 id）就光名字，不写「未给倍率」——
  // 那是拿网关的判断冒充上游事实。
  function callModels() {
    let body = null
    const res = { setHeader() {}, end(s) { body = JSON.parse(s) } }
    handleModels({}, res)
    return body.data
  }

  function seed(models) {
    state.providers.push({
      id: 'p-pub-1',
      name: '发布测试',
      enabled: true,
      models,
      keys: []
    })
  }

  test('有倍率：name = 名字 · x0.79（剥掉 credits 单位），id 不变', () => {
    seed([
      { id: 'hy4-preview', name: 'Hy4 preview', owned_by: 'wb', rate: 'x0.29 credits' },
      { id: 'glm-5.3', name: 'GLM-5.3', owned_by: 'wb', rate: 'x0.79' }
    ])
    try {
      const list = callModels()
      const byId = Object.fromEntries(list.map((m) => [m.id, m]))
      assert.equal(byId['Hy4 preview · x0.29'].name, 'Hy4 preview · x0.29')
      assert.equal(byId['GLM-5.3 · x0.79'].name, 'GLM-5.3 · x0.79')
      // 路由仍按真实 id 点名（客户端拿这个 id 请求，网关剥后缀找回 glm-5.3）
      assert.equal(byId['GLM-5.3 · x0.79'].id, 'GLM-5.3 · x0.79')
    } finally {
      state.providers.length = 0
    }
  })

  test('无倍率：id 与 name 就是原名，不出现「未给倍率」', () => {
    seed([
      { id: 'gpt-4o', owned_by: 'openai' },
      { id: 'auto', name: 'Auto', owned_by: 'wb' }
    ])
    try {
      const list = callModels()
      const byId = Object.fromEntries(list.map((m) => [m.id, m]))
      assert.equal(byId['gpt-4o'].name, 'gpt-4o', '上游没给 name 时退回 id')
      assert.equal(byId['Auto'].name, 'Auto', '有 name 时 id 就是 name')
      assert.ok(!list.some((m) => String(m.name).includes('未给倍率')))
    } finally {
      state.providers.length = 0
    }
  })

  test('促销价拼成 x0.17→x0.50', () => {
    seed([{ id: 'm-promo', name: 'M', owned_by: 'wb', rate: 'x0.17', rate_discounted: 'x0.50' }])
    try {
      const list = callModels()
      assert.equal(list[0].name, 'M · x0.17→x0.50')
    } finally {
      state.providers.length = 0
    }
  })

  test('停用的平台不出现在列表里', () => {
    state.providers.push({
      id: 'p-off',
      name: '停用平台',
      enabled: false,
      models: [{ id: 'hidden', name: 'Hidden', owned_by: 'x' }],
      keys: []
    })
    try {
      assert.ok(!callModels().some((m) => m.id === 'Hidden'))
    } finally {
      state.providers.length = 0
    }
  })
})

describe('canonicalModelId：调用名归一', () => {
  // 客户端拿 /v1/models 下发的 id（带倍率后缀）点名，网关必须能剥掉后缀、
  // 按显示名找回平台里的真实 id，否则路由全 404。
  test('带倍率后缀的显示名 → 真实 id', () => {
    state.providers.push({
      id: 'p-canon-1',
      name: '归一测试',
      enabled: true,
      models: [
        { id: 'glm-5.3', name: 'GLM-5.3', owned_by: 'wb', rate: 'x0.79' },
        { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', owned_by: 'wb', rate: 'x0.06' }
      ],
      keys: []
    })
    try {
      assert.equal(canonicalModelId('GLM-5.3 · x0.79'), 'glm-5.3')
      assert.equal(canonicalModelId('GLM-5.3-Flash · x0.06'), 'glm-5.3-flash')
      assert.equal(canonicalModelId('GLM-5.3'), 'glm-5.3', '裸显示名（大小写不同）也认')
      assert.equal(canonicalModelId('glm-5.3'), 'glm-5.3', '真实 id 原样返回')
      assert.equal(canonicalModelId('M · x0.17→x0.50'), 'M · x0.17→x0.50', '查不到原样返回，交给下游报 404')
      assert.equal(stripRateSuffix('GLM-5.3 · x0.79'), 'GLM-5.3')
      assert.equal(stripRateSuffix('GLM-5.3'), 'GLM-5.3', '无后缀不动')
    } finally {
      state.providers.length = 0
    }
  })

  test('停用平台里的模型不参与归一', () => {
    state.providers.push({
      id: 'p-canon-off',
      name: '停用平台',
      enabled: false,
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', owned_by: 'wb' }],
      keys: []
    })
    try {
      assert.equal(canonicalModelId('GLM-5.3'), 'GLM-5.3')
    } finally {
      state.providers.length = 0
    }
  })
})

describe('上下文窗口：所有平台都从上游取', () => {
  // 通用协议（openai-chat / anthropic / responses …）以前只取 id 与 owned_by，
  // 其余字段全丢。现在统一走 normalizeUpstreamModel 认字段。
  test('上游给了 context_length 就收下，没给就不带这个字段', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'm-with-ctx', context_length: 128000, owned_by: 'acme' },
          { id: 'm-no-ctx', owned_by: 'acme' }
        ]
      }),
      body: { cancel: async () => {} }
    })
    const p = {
      id: 'p-ctx-1',
      name: '上下文测试',
      base_url: 'https://api.example.com/v1',
      protocol: 'openai-chat',
      enabled: true,
      models: [],
      keys: [{ id: 'k-ctx', api_key: 'sk-ctx', enabled: true, cooldown_until: 0, last_error: null, last_error_at: null }],
      extra_headers: {}
    }
    state.providers.push(p)
    try {
      const r = await refreshModels(p.id)
      assert.equal(r.ok, true)
      const byId = Object.fromEntries(p.models.map((m) => [m.id, m]))
      assert.equal(byId['m-with-ctx'].context, 128000, '上游给了 context_length 就该收下')
      assert.equal(byId['m-no-ctx'].context, undefined, '上游没给就不带这个字段，前端显示「未知」')
    } finally {
      state.providers.length = 0
    }
  })
})
