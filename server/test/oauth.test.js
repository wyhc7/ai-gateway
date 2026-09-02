// Grok OAuth 凭据逻辑测试
// 用 mock 替换 fetch，只验证状态机与凭据处理，不碰真实网络
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenNeedsRefresh,
  applyTokenResponse,
  ensureAccessToken,
  refreshAccessToken,
  startDeviceFlow,
  pollDeviceFlow,
  cancelDeviceFlow,
  listPendingSessions
} from '../oauth.js'

const realFetch = globalThis.fetch
const HOUR = 60 * 60 * 1000

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  }
}

function parseBody(opts) {
  return Object.fromEntries(new URLSearchParams(opts.body))
}

// 只 mock xAI 的两个端点，其余请求直接抛错，避免测试悄悄打到真实网络
function mockXai({ onDevice, onToken }) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('openid-configuration')) {
      return jsonResponse(200, {
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: 'https://auth.x.ai/oauth2/token',
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code'
      })
    }
    if (u.includes('/device/code')) return onDevice(parseBody(opts))
    if (u.includes('/oauth2/token')) return onToken(parseBody(opts))
    throw new Error(`未预期的请求: ${u}`)
  }
}

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('tokenNeedsRefresh', () => {
  test('没有 access_token 时必须刷新', () => {
    assert.equal(tokenNeedsRefresh({}), true)
    assert.equal(tokenNeedsRefresh({ access_token: '' }), true)
  })

  test('有 token 但没有过期时间时不主动刷新', () => {
    assert.equal(tokenNeedsRefresh({ access_token: 'a' }), false)
  })

  test('距离过期不足 1 小时就刷新', () => {
    const soon = Date.now() + 30 * 60 * 1000
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: soon }), true)
  })

  test('还很充裕时不刷新', () => {
    const later = Date.now() + 5 * HOUR
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: later }), false)
  })

  test('已过期必须刷新', () => {
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: Date.now() - 1000 }), true)
  })
})

describe('applyTokenResponse', () => {
  test('写入 access_token 与过期时间', () => {
    const out = applyTokenResponse(
      { access_token: 'old' },
      { access_token: 'new', expires_in: 21600 }
    )
    assert.equal(out.access_token, 'new')
    assert.ok(out.expires_at > Date.now() + 21590 * 1000)
  })

  test('refresh_token 轮换时用新值', () => {
    const out = applyTokenResponse(
      { refresh_token: 'r1' },
      { access_token: 'a', refresh_token: 'r2' }
    )
    assert.equal(out.refresh_token, 'r2')
  })

  test('上游不返回 refresh_token 时保留旧的', () => {
    const out = applyTokenResponse({ refresh_token: 'r1' }, { access_token: 'a' })
    assert.equal(out.refresh_token, 'r1')
  })
})

describe('ensureAccessToken', () => {
  test('非 OAuth 凭据原样返回', async () => {
    const cred = { api_key: 'sk-x' }
    const r = await ensureAccessToken(cred)
    assert.equal(r.refreshed, false)
    assert.equal(r.credential, cred)
  })

  test('有效凭据不触发刷新', async () => {
    const r = await ensureAccessToken({
      type: 'oauth',
      access_token: 'a',
      expires_at: Date.now() + 5 * HOUR
    })
    assert.equal(r.refreshed, false)
  })

  test('临近过期触发刷新并带上 refresh_token', async () => {
    let sent = null
    mockXai({
      onDevice: () => jsonResponse(200, {}),
      onToken: (body) => {
        sent = body
        return jsonResponse(200, { access_token: 'fresh', expires_in: 21600 })
      }
    })
    const r = await ensureAccessToken({
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'rt-1',
      expires_at: Date.now() + 10 * 60 * 1000
    })
    assert.equal(r.refreshed, true)
    assert.equal(r.credential.access_token, 'fresh')
    assert.equal(sent.grant_type, 'refresh_token')
    assert.equal(sent.refresh_token, 'rt-1')
  })

  test('过期且没有 refresh_token 时报错而不是静默失败', async () => {
    await assert.rejects(
      () => ensureAccessToken({ type: 'oauth', access_token: 'a', expires_at: Date.now() - 1 }),
      /refresh_token/
    )
  })
})

describe('refreshAccessToken', () => {
  test('上游返回错误时抛出可读信息', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, {}),
      onToken: () => jsonResponse(400, { error: 'invalid_grant', error_description: '令牌已失效' })
    })
    await assert.rejects(
      () => refreshAccessToken({ refresh_token: 'bad' }),
      /令牌已失效/
    )
  })
})

describe('设备码授权流程', () => {
  test('start 返回 user_code 与验证地址', async () => {
    mockXai({
      onDevice: (body) => {
        assert.equal(body.client_id, 'b1a00492-073a-47ea-816f-4c329264a828')
        assert.match(body.scope, /offline_access/)
        return jsonResponse(200, {
          device_code: 'dc-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.x.ai/device',
          expires_in: 1800,
          interval: 5
        })
      },
      onToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({ name: '测试账号' })
    assert.equal(flow.user_code, 'ABCD-1234')
    assert.equal(flow.verification_uri, 'https://auth.x.ai/device')
    assert.ok(flow.session_id)
  })

  test('未确认时轮询返回 pending', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-2', user_code: 'X', interval: 0, expires_in: 600 }),
      onToken: () => jsonResponse(400, { error: 'authorization_pending' })
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'pending')
  })

  test('确认成功后返回凭据并清除会话', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-3', user_code: 'Y', interval: 0, expires_in: 600 }),
      onToken: () => jsonResponse(200, {
        access_token: 'at-final',
        refresh_token: 'rt-final',
        expires_in: 21600
      })
    })
    const flow = await startDeviceFlow({ name: '主号' })
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'done')
    assert.equal(r.credential.access_token, 'at-final')
    assert.equal(r.credential.type, 'oauth')
    assert.equal(r.credential.name, '主号')
    // 完成后会话应被清理，重复轮询不能再次兑换
    assert.equal((await pollDeviceFlow(flow.session_id)).status, 'expired')
  })

  test('slow_down 会拉长轮询间隔', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-4', user_code: 'Z', interval: 1, expires_in: 600 }),
      onToken: () => jsonResponse(400, { error: 'slow_down' })
    })
    const flow = await startDeviceFlow({})
    const first = await pollDeviceFlow(flow.session_id)
    assert.equal(first.status, 'pending')
    assert.ok(first.retry_after >= 6, `间隔应被拉长，实际 ${first.retry_after}`)
  })

  test('用户拒绝时返回 error 而不是继续等', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-5', user_code: 'W', interval: 0, expires_in: 600 }),
      onToken: () => jsonResponse(400, { error: 'access_denied', error_description: '用户拒绝了授权' })
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'error')
    assert.match(r.error, /用户拒绝了授权/)
  })

  test('会话过期后无法继续轮询', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-6', user_code: 'V', interval: 0, expires_in: -1 }),
      onToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'expired')
  })

  test('可以主动取消会话', async () => {
    mockXai({
      onDevice: () => jsonResponse(200, { device_code: 'dc-7', user_code: 'U', interval: 5, expires_in: 600 }),
      onToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    assert.equal(listPendingSessions().some((s) => s.id === flow.session_id), true)
    assert.equal(cancelDeviceFlow(flow.session_id), true)
    assert.equal(listPendingSessions().some((s) => s.id === flow.session_id), false)
  })
})
