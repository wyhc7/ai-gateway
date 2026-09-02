// OAuth 凭据接入转发链路的集成测试
//
// 注意：store.js 在模块加载时就会按 DATA_DIR 初始化配置，
// 静态 import 会早于赋值生效。必须先设好 DATA_DIR 再动态 import。
import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-oauth-'))

const realFetch = globalThis.fetch
const HOUR = 60 * 60 * 1000
let resolveKeyToken = null

before(async () => {
  ;({ resolveKeyToken } = await import('../proxy.js'))
})

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  }
}

function mockXai(tokenHandler) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('openid-configuration')) {
      return jsonResponse(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' })
    }
    if (u.includes('/oauth2/token')) {
      return tokenHandler(Object.fromEntries(new URLSearchParams(opts.body)))
    }
    throw new Error(`未预期的请求: ${u}`)
  }
}

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('resolveKeyToken', () => {
  test('普通 API Key 原样透传，不走刷新', async () => {
    const token = await resolveKeyToken({ api_key: 'sk-static' })
    assert.equal(token, 'sk-static')
  })

  test('有效的 OAuth 凭据直接返回 access_token，不发刷新请求', async () => {
    mockXai(() => {
      throw new Error('不该发起刷新请求')
    })
    const token = await resolveKeyToken({
      type: 'oauth',
      access_token: 'at-valid',
      refresh_token: 'rt',
      expires_at: Date.now() + 3 * HOUR
    })
    assert.equal(token, 'at-valid')
  })

  test('临近过期的凭据先刷新，并把新 token 写回账号对象', async () => {
    mockXai(() => jsonResponse(200, {
      access_token: 'at-renewed',
      refresh_token: 'rt-new',
      expires_in: 21600
    }))
    const key = {
      type: 'oauth',
      access_token: 'at-stale',
      refresh_token: 'rt-old',
      expires_at: Date.now() + 10 * 60 * 1000
    }
    const token = await resolveKeyToken(key)
    assert.equal(token, 'at-renewed')
    // 写回很关键：不落盘的话进程重启后又会拿失效的 token 去撞上游
    assert.equal(key.access_token, 'at-renewed')
    assert.equal(key.refresh_token, 'rt-new')
  })

  test('refresh_token 未轮换时保留原值', async () => {
    mockXai(() => jsonResponse(200, { access_token: 'at-2', expires_in: 21600 }))
    const key = {
      type: 'oauth',
      access_token: 'at-1',
      refresh_token: 'rt-keep',
      expires_at: Date.now() - 1000
    }
    await resolveKeyToken(key)
    assert.equal(key.access_token, 'at-2')
    assert.equal(key.refresh_token, 'rt-keep')
  })

  test('刷新失败时抛出错误，让上层冷却该账号并切换', async () => {
    mockXai(() => jsonResponse(400, { error: 'invalid_grant', error_description: '授权已撤销' }))
    const key = {
      type: 'oauth',
      access_token: 'at',
      refresh_token: 'rt-revoked',
      expires_at: Date.now() - 1000
    }
    await assert.rejects(() => resolveKeyToken(key), /授权已撤销/)
  })

  test('缺少 refresh_token 的过期账号明确报错，提示重新授权', async () => {
    const key = { type: 'oauth', access_token: 'at', expires_at: Date.now() - 1000 }
    await assert.rejects(() => resolveKeyToken(key), /refresh_token/)
  })
})
