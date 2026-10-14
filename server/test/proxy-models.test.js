// 协议级模型兜底测试
// 1) defaultModelsFor 按协议返回内置默认模型
// 2) refreshModels 在上游 /models 拉取失败时退回默认列表，保证平台立即可用
//
// 订阅接入方案（subscription-plans.js）已整体下线，TEMPLATES 里也不再有
// grok-oauth / codex-oauth 条目，所以这两个协议现在没有兜底、返回 null。
// OpenCode Zen 免费通道（zen-free）也已移除：它的准入判定落在出口 IP 上，
// 数据中心 ASN 一律 403，服务器部署下这条通道无法工作。
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
let TEMPLATES = null

before(async () => {
  ;({ state } = await import('../store.js'))
  ;({ defaultModelsFor, refreshModels, autoHeaders } = await import('../proxy.js'))
  ;({ TEMPLATES } = await import('../templates.js'))
})

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('defaultModelsFor', () => {
  test('订阅接入方案下线后，grok/codex 不再有兜底列表', () => {
    // 这是预期而不是漏改：方案重新配好之前，订阅平台拉不到模型就该老实报错，
    // 而不是塞一份陈旧的、可能与当前订阅号可用模型对不上的名单。
    assert.equal(defaultModelsFor('grok-oauth'), null)
    assert.equal(defaultModelsFor('codex-oauth'), null)
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
  })
})

describe('refreshModels 兜底', () => {
  test('订阅协议失败时不兜底：方案下线后没有可回退的名单，老实报错', async () => {
    // 兜底名单随订阅接入方案一起删掉了。此时若仍假装「拉取成功」，
    // 用户会以为模型是新的，实际一个都调不通，排查方向全错。
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
      assert.equal(r.ok, false, '没有兜底名单就该报错，不能返回一个空的成功')
      assert.ok(!p.models.length, '不该留下任何占位模型')
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
