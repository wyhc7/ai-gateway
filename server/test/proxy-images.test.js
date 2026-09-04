// 生图接口（/api/v1/images/generations）转发测试
// 覆盖：生图走独立路径、请求体原样透传、鉴权与 Key 透传、模型不存在时 404
import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-images-'))

const realFetch = globalThis.fetch

let state = null
let handleImages = null
let callPlan = null

before(async () => {
  ;({ state } = await import('../store.js'))
  ;({ handleImages, callPlan } = await import('../proxy.js'))
})

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => {
  globalThis.fetch = realFetch
  state.providers.length = 0
})

// 极简 res：handleImages 只用到 status / setHeader / end / writableEnded
function fakeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    _body: '',
    status(code) { this.statusCode = code; return this },
    setHeader() { return this },
    end(text) { this.writableEnded = true; this._body = text; return this }
  }
}

function makeProvider(overrides = {}) {
  return {
    id: 'p-img-1',
    name: '自建GPT生图',
    base_url: 'http://10.0.0.5:3000/v1',
    protocol: 'openai-chat',
    enabled: true,
    models: [{ id: 'gpt-image-2', owned_by: '自建GPT生图' }],
    keys: [{
      id: 'k-img-1',
      name: 'Key 1',
      api_key: 'sk-image-service',
      enabled: true,
      cooldown_until: 0,
      last_error: null,
      last_error_at: null
    }],
    extra_headers: {},
    ...overrides
  }
}

describe('callPlan 生图路径', () => {
  test('openai-chat 默认走 /images/generations', () => {
    const plan = callPlan(makeProvider())
    assert.equal(plan.imagesPath, '/images/generations')
  })

  test('平台可用 images_path 覆盖默认路径', () => {
    const plan = callPlan(makeProvider({ images_path: '/custom/draw' }))
    assert.equal(plan.imagesPath, '/custom/draw')
  })
})

describe('handleImages', () => {
  test('转发到上游 /images/generations，请求体原样透传，响应整体回传', async () => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers })
      return {
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
        body: {},
        text: async () => JSON.stringify({ created: 123, data: [{ b64_json: 'QUJD' }] })
      }
    }
    state.providers.push(makeProvider())

    const req = { body: { model: 'gpt-image-2', prompt: '一只橘猫', size: '1024x1024', n: 1 } }
    const res = fakeRes()
    await handleImages(req, res)

    assert.equal(calls.length, 1, '应只请求上游一次')
    const call = calls[0]
    // 关键：生图必须打到 /images/generations，而不是对话的 /chat/completions
    assert.equal(call.url, 'http://10.0.0.5:3000/v1/images/generations')
    assert.equal(call.method, 'POST')
    // 请求体是序列化后的原样参数，不能被协议转换改写
    assert.deepEqual(JSON.parse(call.body), { model: 'gpt-image-2', prompt: '一只橘猫', size: '1024x1024', n: 1 })
    // 平台 Key 必须带上去
    assert.equal(call.headers.Authorization, 'Bearer sk-image-service')

    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res._body), { created: 123, data: [{ b64_json: 'QUJD' }] })
  })

  test('模型没有对应平台时返回 404 model_not_found', async () => {
    let called = 0
    globalThis.fetch = async () => { called += 1; throw new Error('不应发起请求') }
    state.providers.push(makeProvider())

    const req = { body: { model: '不存在的模型', prompt: 'x' } }
    const res = fakeRes()
    await handleImages(req, res)

    assert.equal(called, 0, '找不到平台时不应请求上游')
    assert.equal(res.statusCode, 404)
    assert.match(res._body, /model_not_found/)
  })
})
