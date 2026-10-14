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
let TEMPLATES = null

before(async () => {
  ;({ state } = await import('../store.js'))
  ;({ defaultModelsFor, refreshModels, autoHeaders, handleModels } = await import('../proxy.js'))
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

describe('对外 /v1/models：带上倍率与上下文窗口', () => {
  function fakeRes() {
    let raw = null
    return {
      setHeader() {},
      end(body) { raw = body },
      get raw() { return raw }
    }
  }

  test('有倍率的模型带 rate / rate_discounted，没有的不带字段', () => {
    const p = {
      id: 'p-models-1',
      name: '对外模型测试',
      enabled: true,
      models: [
        { id: 'glm-5.3', owned_by: 'zhipu', rate: 'x0.79', rate_discounted: 'x0.50', context: 200000 },
        { id: 'plain-model', owned_by: 'zhipu' }
      ]
    }
    state.providers.push(p)
    try {
      const res = fakeRes()
      handleModels({}, res)
      const body = JSON.parse(res.raw)
      assert.equal(body.object, 'list')
      const byId = Object.fromEntries(body.data.map((m) => [m.id, m]))
      assert.equal(byId['glm-5.3'].rate, 'x0.79', '对外端点也要能看到倍率')
      assert.equal(byId['glm-5.3'].rate_discounted, 'x0.50')
      assert.equal(byId['glm-5.3'].context, 200000)
      assert.equal(byId['plain-model'].rate, undefined, '上游没给倍率就不带这个字段')
      assert.equal(byId['plain-model'].context, undefined)
    } finally {
      state.providers.length = 0
    }
  })
})
