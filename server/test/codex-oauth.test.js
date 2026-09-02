// Codex OAuth 凭据逻辑测试
// 用 mock 替换 fetch，验证设备码状态机与凭据处理，不碰真实网络
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
  listPendingSessions,
  parseIdToken,
  accountIdFromClaims,
  CODEX_CLIENT_ID
} from '../codex-oauth.js'

const realFetch = globalThis.fetch
const HOUR = 60 * 60 * 1000

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  }
}

function b64url(s) {
  return Buffer.from(s).toString('base64url')
}

// 构造一个能解析出 chatgpt_account_id 的假 id_token（三段 JWT 结构即可，
// 本模块只 base64 解码 payload，不验签）
function makeIdToken(payload) {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.${b64url('sig')}`
}

function makeAuthIdToken(accountId, email) {
  return makeIdToken({
    sub: 'sub-openai-1',
    email,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId }
  })
}

// 解析 request() 里的请求体：能当 JSON 解析就返回对象，否则按表单解析
function parseRequestBody(body) {
  const raw = String(body || '')
  try {
    return JSON.parse(raw)
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

// 只 mock Codex 的三个端点，其余请求直接抛错
function mockCodex({ onUsercode, onDeviceToken, onOauthToken }) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    const parsed = parseRequestBody(opts?.body)
    if (u.includes('/api/accounts/deviceauth/usercode')) return onUsercode(parsed)
    if (u.includes('/api/accounts/deviceauth/token')) return onDeviceToken(parsed)
    if (u.includes('/oauth/token')) return onOauthToken(parsed)
    throw new Error(`未预期的请求: ${u}`)
  }
}

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('parseIdToken / accountIdFromClaims', () => {
  test('能解析出 chatgpt_account_id', () => {
    const claims = parseIdToken(makeAuthIdToken('acct-abc', 'a@b.com'))
    assert.equal(accountIdFromClaims(claims), 'acct-abc')
    assert.equal(claims.email, 'a@b.com')
  })

  test('没有 chatgpt_account_id 时回退到 sub', () => {
    const claims = parseIdToken(makeIdToken({ sub: 'sub-only' }))
    assert.equal(accountIdFromClaims(claims), 'sub-only')
  })

  test('非法 JWT 返回 null', () => {
    assert.equal(parseIdToken('not-a-jwt'), null)
    assert.equal(parseIdToken('a.b'), null)
    assert.equal(parseIdToken(''), null)
    assert.equal(parseIdToken(null), null)
  })
})

describe('tokenNeedsRefresh', () => {
  test('没有 access_token 时必须刷新', () => {
    assert.equal(tokenNeedsRefresh({}), true)
    assert.equal(tokenNeedsRefresh({ access_token: '' }), true)
  })

  test('有 token 但没有过期时间时不主动刷新', () => {
    assert.equal(tokenNeedsRefresh({ access_token: 'a' }), false)
  })

  test('临近过期（Codex 提前 5 分钟）就刷新', () => {
    const soon = Date.now() + 2 * 60 * 1000
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: soon }), true)
  })

  test('还很充裕时不刷新', () => {
    const later = Date.now() + 2 * HOUR
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: later }), false)
  })

  test('已过期必须刷新', () => {
    assert.equal(tokenNeedsRefresh({ access_token: 'a', expires_at: Date.now() - 1000 }), true)
  })
})

describe('applyTokenResponse', () => {
  test('写入 access_token 与过期时间', () => {
    const out = applyTokenResponse(
      { access_token: 'old', provider: 'codex' },
      { access_token: 'new', expires_in: 3600 }
    )
    assert.equal(out.access_token, 'new')
    assert.ok(out.expires_at > Date.now() + 3590 * 1000)
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

  test('带 id_token 时自动解析并写入 account_id', () => {
    const out = applyTokenResponse(
      { provider: 'codex' },
      { access_token: 'a', id_token: makeAuthIdToken('acct-x', 'x@y.z') }
    )
    assert.equal(out.account_id, 'acct-x')
    assert.equal(out.email, 'x@y.z')
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
    mockCodex({
      onUsercode: () => jsonResponse(200, {}),
      onDeviceToken: () => jsonResponse(403, {}),
      onOauthToken: (body) => {
        sent = body
        return jsonResponse(200, { access_token: 'fresh', expires_in: 3600 })
      }
    })
    const r = await ensureAccessToken({
      type: 'oauth',
      provider: 'codex',
      access_token: 'stale',
      refresh_token: 'rt-1',
      expires_at: Date.now() + 2 * 60 * 1000
    })
    assert.equal(r.refreshed, true)
    assert.equal(r.credential.access_token, 'fresh')
    assert.equal(sent.grant_type, 'refresh_token')
    assert.equal(sent.refresh_token, 'rt-1')
    assert.equal(sent.client_id, CODEX_CLIENT_ID)
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
    mockCodex({
      onUsercode: () => jsonResponse(200, {}),
      onDeviceToken: () => jsonResponse(403, {}),
      onOauthToken: () => jsonResponse(400, {
        error: 'invalid_grant',
        error_description: '令牌已失效'
      })
    })
    await assert.rejects(
      () => refreshAccessToken({ refresh_token: 'bad' }),
      /令牌已失效/
    )
  })
})

describe('Codex 设备码授权流程', () => {
  test('start 用 JSON 申请设备码并返回验证地址', async () => {
    let sentBody = null
    mockCodex({
      onUsercode: (body) => {
        sentBody = body
        return jsonResponse(200, {
          device_auth_id: 'deviceauth_aaa',
          user_code: 'QAEF-ZGIFE',
          interval: '5',
          expires_at: '2099-01-01T00:00:00.000000+00:00'
        })
      },
      onDeviceToken: () => jsonResponse(403, {}),
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({ name: '测试账号' })
    // 关键差异：Codex 的 usercode 端点是 JSON 且不需要 client_id
    assert.deepEqual(sentBody, {})
    assert.equal(flow.user_code, 'QAEF-ZGIFE')
    assert.match(flow.verification_uri, /codex\/device/)
    assert.ok(flow.session_id)
    assert.ok(flow.expires_in > 0)
  })

  test('未确认时轮询返回 pending（403 deviceauth_authorization_pending）', async () => {
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd1', user_code: 'A', interval: 5,
        expires_at: '2099-01-01T00:00:00.000000+00:00'
      }),
      onDeviceToken: (body) => {
        assert.deepEqual(body, { device_auth_id: 'd1', user_code: 'A' })
        return jsonResponse(403, {
          error: { message: 'Device authorization is pending.', code: 'deviceauth_authorization_pending' }
        })
      },
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'pending')
  })

  test('确认成功后先拿 code 再换 token，返回凭据并清除会话', async () => {
    const tokenCalls = []
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd2', user_code: 'B', interval: 0,
        expires_at: '2099-01-01T00:00:00.000000+00:00'
      }),
      onDeviceToken: () => jsonResponse(200, {
        authorization_code: 'ac-1',
        code_verifier: 'verifier-1'
      }),
      onOauthToken: (body) => {
        tokenCalls.push(body)
        return jsonResponse(200, {
          access_token: 'at-final',
          refresh_token: 'rt-final',
          expires_in: 3600,
          id_token: makeAuthIdToken('acct-123', 'u@x.com')
        })
      }
    })
    const flow = await startDeviceFlow({ name: '主号' })
    const r = await pollDeviceFlow(flow.session_id)

    assert.equal(r.status, 'done')
    assert.equal(r.credential.access_token, 'at-final')
    assert.equal(r.credential.type, 'oauth')
    assert.equal(r.credential.provider, 'codex')
    assert.equal(r.credential.name, '主号')
    // account_id 应从 id_token 里自动解析出来，供上游 ChatGPT-Account-Id 头用
    assert.equal(r.credential.account_id, 'acct-123')

    // 两步：先用 authorization_code 换 token
    assert.equal(tokenCalls.length, 1)
    assert.equal(tokenCalls[0].grant_type, 'authorization_code')
    assert.equal(tokenCalls[0].code, 'ac-1')
    assert.equal(tokenCalls[0].code_verifier, 'verifier-1')
    assert.equal(tokenCalls[0].client_id, CODEX_CLIENT_ID)

    // 完成后会话应被清理，重复轮询不能再次兑换
    assert.equal((await pollDeviceFlow(flow.session_id)).status, 'expired')
  })

  test('slow_down 会拉长轮询间隔', async () => {
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd3', user_code: 'C', interval: 1,
        expires_at: '2099-01-01T00:00:00.000000+00:00'
      }),
      onDeviceToken: () => jsonResponse(403, {
        error: { message: 'slow down', code: 'slow_down' }
      }),
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    const first = await pollDeviceFlow(flow.session_id)
    assert.equal(first.status, 'pending')
    assert.ok(first.retry_after >= 6, `间隔应被拉长，实际 ${first.retry_after}`)
  })

  test('用户拒绝时返回 error 而不是继续等', async () => {
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd4', user_code: 'D', interval: 0,
        expires_at: '2099-01-01T00:00:00.000000+00:00'
      }),
      onDeviceToken: () => jsonResponse(403, {
        error: { message: 'The user denied the request.', code: 'access_denied' }
      }),
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'error')
    assert.match(r.error, /denied|拒绝/i)
  })

  test('会话过期后无法继续轮询', async () => {
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd5', user_code: 'E', interval: 0,
        expires_at: '2000-01-01T00:00:00.000000+00:00' // 已过期
      }),
      onDeviceToken: () => jsonResponse(403, {}),
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    const r = await pollDeviceFlow(flow.session_id)
    assert.equal(r.status, 'expired')
  })

  test('可以主动取消会话', async () => {
    mockCodex({
      onUsercode: () => jsonResponse(200, {
        device_auth_id: 'd6', user_code: 'F', interval: 5,
        expires_at: '2099-01-01T00:00:00.000000+00:00'
      }),
      onDeviceToken: () => jsonResponse(403, {}),
      onOauthToken: () => jsonResponse(200, {})
    })
    const flow = await startDeviceFlow({})
    assert.equal(listPendingSessions().some((s) => s.id === flow.session_id), true)
    assert.equal(cancelDeviceFlow(flow.session_id), true)
    assert.equal(listPendingSessions().some((s) => s.id === flow.session_id), false)
  })
})
