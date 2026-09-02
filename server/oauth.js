// xAI Grok OAuth —— 设备码授权与凭据续期
//
// Grok 有两种凭据形态，走的是两个完全不同的上游：
//   1. API Key  —— console.x.ai 签发，上游 https://api.x.ai/v1，按量付费
//   2. OAuth    —— SuperGrok / X Premium 订阅账号，上游 https://cli-chat-proxy.grok.com/v1
// 本文件只处理第 2 种。
//
// 为什么用设备码（RFC 8628）而不是 PKCE 回调：
//   网关通常跑在远程服务器上，PKCE 的 redirect_uri 是 127.0.0.1 的回环地址，
//   授权回调发生在用户的浏览器机器上，服务端收不到，只能让用户手动复制回调 URL。
//   设备码流程反过来——服务端先拿到 user_code，用户在任意设备浏览器确认，
//   服务端自己轮询结果。对无人值守的服务器部署是唯一顺畅的方式。
//
// client_id 是 xAI Grok CLI 的公开 OAuth 客户端标识，OSS 生态共用、非机密，
// 已在多个独立实现（Go / Rust / Python）中交叉验证一致。可用环境变量覆盖。

export const XAI_CLIENT_ID =
  process.env.XAI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const XAI_ISSUER = 'https://auth.x.ai'
export const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`

// OAuth 订阅账号的推理端点。API Key 账号用的是 api.x.ai，别混用。
export const XAI_OAUTH_BASE_URL =
  process.env.XAI_OAUTH_BASE_URL || 'https://cli-chat-proxy.grok.com/v1'

// 设备码授权的默认端点（discovery 失败时的兜底）
const FALLBACK_DEVICE_CODE_URL = `${XAI_ISSUER}/oauth2/device/code`
const FALLBACK_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`
const FALLBACK_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

// access_token 实际寿命约 6 小时。默认提前 1 小时续期：
// 网关类负载可能半小时才碰一次上游，2 分钟的续期窗口很容易被整个错过，
// 等到真正请求时 token 已经过期。
const DEFAULT_REFRESH_SKEW_MS = 60 * 60 * 1000

let _discovery = null
let _discoveryAt = 0

// 进行中的设备码会话。仅存内存——重启后未完成的授权自然作废，
// 用户重新发起即可，没必要把半成品落盘。
const pendingSessions = new Map()

function now() {
  return Date.now()
}

function sweepSessions() {
  const t = now()
  for (const [id, s] of pendingSessions) {
    if (s.expires_at < t) pendingSessions.delete(id)
  }
}

async function postForm(url, params, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    })
    const text = await resp.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    return { status: resp.status, ok: resp.ok, data, text }
  } finally {
    clearTimeout(timer)
  }
}

// OIDC discovery：端点地址以 xAI 实际公告为准，避免硬编码过期后整体失效
export async function discover(force = false) {
  if (!force && _discovery && now() - _discoveryAt < DISCOVERY_TTL_MS) {
    return _discovery
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const resp = await fetch(XAI_DISCOVERY_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (resp.ok) {
      const data = await resp.json()
      const discovered = {
        authorization_endpoint: data.authorization_endpoint || FALLBACK_AUTHORIZE_URL,
        token_endpoint: data.token_endpoint || FALLBACK_TOKEN_URL,
        device_authorization_endpoint:
          data.device_authorization_endpoint || FALLBACK_DEVICE_CODE_URL
      }
      _discovery = discovered
      _discoveryAt = now()
      return discovered
    }
  } catch {
    // discovery 失败不致命，用兜底端点继续
  }
  const fallback = {
    authorization_endpoint: FALLBACK_AUTHORIZE_URL,
    token_endpoint: FALLBACK_TOKEN_URL,
    device_authorization_endpoint: FALLBACK_DEVICE_CODE_URL
  }
  _discovery = fallback
  _discoveryAt = now()
  return fallback
}

// 判断凭据是否临近过期。没有 expires_at 时当作长期有效（由上游报错来兜底）。
export function tokenNeedsRefresh(cred, skewMs = DEFAULT_REFRESH_SKEW_MS) {
  if (!cred?.access_token) return true
  if (!cred.expires_at) return false
  return now() + skewMs >= cred.expires_at
}

// 用 refresh_token 续期。返回新的凭据字段（不落盘，落盘交给调用方）。
export async function refreshAccessToken(cred, tokenEndpoint) {
  if (!cred?.refresh_token) {
    throw new Error('缺少 refresh_token，该账号需要重新授权')
  }
  const endpoint = tokenEndpoint || (await discover()).token_endpoint
  const r = await postForm(endpoint, {
    grant_type: 'refresh_token',
    client_id: XAI_CLIENT_ID,
    refresh_token: cred.refresh_token
  })
  if (!r.ok) {
    const msg = r.data?.error_description || r.data?.error || r.text?.slice(0, 200) || `HTTP ${r.status}`
    throw new Error(`刷新凭据失败：${msg}`)
  }
  return applyTokenResponse(cred, r.data)
}

// 把 token 端点的响应合并回凭据对象。refresh_token 可能轮换，
// 上游不返回新值时保留旧的——有些实现只在首次下发。
export function applyTokenResponse(cred, data) {
  const out = { ...cred }
  if (data.access_token) out.access_token = data.access_token
  if (data.refresh_token) out.refresh_token = data.refresh_token
  if (data.id_token) out.id_token = data.id_token
  if (Number(data.expires_in) > 0) {
    out.expires_at = now() + Number(data.expires_in) * 1000
  }
  out.token_type = data.token_type || out.token_type || 'Bearer'
  out.updated_at = now()
  if (data.email) out.email = data.email
  return out
}

// 发起设备码授权。返回给前端的是 user_code 和验证地址，
// 用户拿它在任意设备的浏览器里完成确认。
export async function startDeviceFlow({ providerId = null, name = '' } = {}) {
  sweepSessions()
  const endpoints = await discover()
  const r = await postForm(endpoints.device_authorization_endpoint, {
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE
  })
  if (!r.ok) {
    const msg = r.data?.error_description || r.data?.error || r.text?.slice(0, 200) || `HTTP ${r.status}`
    throw new Error(`申请设备码失败：${msg}`)
  }
  const d = r.data || {}
  if (!d.device_code || !d.user_code) {
    throw new Error('设备码响应缺少 device_code 或 user_code')
  }
  const sessionId = `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // interval 为 0 是合法的（表示尽快轮询），不能因为 0 是 falsy 就回退成默认值；
  // 但仍设 2 秒下限，避免前端异常时把上游打爆
  const rawInterval = Number(d.interval)
  const intervalMs = Math.max(Number.isFinite(rawInterval) ? rawInterval : 5, 2) * 1000
  pendingSessions.set(sessionId, {
    id: sessionId,
    providerId,
    name,
    device_code: d.device_code,
    interval_ms: intervalMs,
    token_endpoint: endpoints.token_endpoint,
    expires_at: now() + (Number(d.expires_in) || 1800) * 1000,
    // 允许立刻轮询一次。规范建议先等一个 interval，但用户在页面点了
    // "我已完成授权"之后还要干等几秒才去问一次，体感很差——
    // 这里把退避的重担交给"尚未确认"这条分支，确认过的情况下能秒级返回。
    poll_after: now(),
    created_at: now(),
    last_error: null
  })
  return {
    session_id: sessionId,
    user_code: d.user_code,
    verification_uri: d.verification_uri || `${XAI_ISSUER}/device`,
    verification_uri_complete: d.verification_uri_complete || null,
    expires_in: Number(d.expires_in) || 1800,
    interval: intervalMs / 1000
  }
}

// 单次轮询。不阻塞，由调用方按 interval 节奏反复调用，
// 这样前端可以展示"等待确认"的中间态。
export async function pollDeviceFlow(sessionId) {
  const session = pendingSessions.get(sessionId)
  if (!session) return { status: 'expired', error: '授权会话不存在或已过期' }
  if (now() > session.expires_at) {
    pendingSessions.delete(sessionId)
    return { status: 'expired', error: '授权已超时，请重新发起' }
  }
  if (now() < session.poll_after) {
    return { status: 'pending', retry_after: Math.ceil((session.poll_after - now()) / 1000) }
  }

  const r = await postForm(session.token_endpoint, {
    grant_type: DEVICE_GRANT_TYPE,
    device_code: session.device_code,
    client_id: XAI_CLIENT_ID
  })

  if (r.ok && r.data?.access_token) {
    pendingSessions.delete(sessionId)
    const cred = applyTokenResponse(
      {
        type: 'oauth',
        name: session.name || '',
        provider: 'grok'
      },
      r.data
    )
    return { status: 'done', credential: cred, provider_id: session.providerId }
  }

  const err = r.data?.error
  session.poll_after = now() + session.interval_ms
  if (err === 'authorization_pending' || err === 'slow_down') {
    if (err === 'slow_down') session.interval_ms += 5000
    session.last_error = null
    return { status: 'pending', retry_after: Math.ceil(session.interval_ms / 1000) }
  }
  const msg = r.data?.error_description || err || r.text?.slice(0, 200) || `HTTP ${r.status}`
  session.last_error = msg
  return { status: 'error', error: `授权失败：${msg}` }
}

export function cancelDeviceFlow(sessionId) {
  return pendingSessions.delete(sessionId)
}

export function listPendingSessions() {
  sweepSessions()
  return [...pendingSessions.values()].map((s) => ({
    id: s.id,
    provider_id: s.providerId,
    name: s.name,
    expires_at: s.expires_at,
    last_error: s.last_error
  }))
}

// 请求前确保 access_token 可用。调用方负责把返回的凭据写回。
// 没有 expires_at 的凭据不主动刷新（上游 401 时会走冷却与切换）。
export async function ensureAccessToken(cred) {
  if (!cred || cred.type !== 'oauth') return { credential: cred, refreshed: false }
  if (!tokenNeedsRefresh(cred)) return { credential: cred, refreshed: false }
  if (!cred.refresh_token) {
    throw new Error('OAuth 凭据已过期且缺少 refresh_token，需要重新授权')
  }
  const next = await refreshAccessToken(cred)
  return { credential: next, refreshed: true }
}
