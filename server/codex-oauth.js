// OpenAI / Codex 订阅账号 OAuth —— 设备码授权与凭据续期
//
// 与 Grok 一样，Codex 也有两种凭据形态，走的是两个完全不同的上游：
//   1. API Key  —— platform.openai.com 签发，上游 https://api.openai.com/v1，按量付费
// 本文件处理的是第 2 种：用 ChatGPT / Codex 订阅账号反代，上游是 chatgpt.com 的
//   backend-api（Responses 形态），凭据来自 OpenAI 账号 OAuth（订阅账号额度）。
//
// 为什么用设备码（RFC 8628）：与 Grok 同样的原因——网关常跑在远程服务器，
// PKCE 的回环回调服务端收不到，设备码由服务端轮询、用户在任意设备浏览器确认。
//
// client_id 是 OpenAI Codex CLI 的公开 OAuth 客户端标识（Auth0 租户），
// OSS 生态共用、非机密，与 new-api / sub2api 等实现的取值一致。可用环境变量覆盖。

export const CODEX_CLIENT_ID =
  process.env.OPENAI_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_SCOPE = 'openid profile email offline_access'
export const CODEX_ISSUER = 'https://auth.openai.com'
export const CODEX_DISCOVERY_URL = `${CODEX_ISSUER}/.well-known/openid-configuration`

// Codex 订阅账号的反代上游（chatgpt.com backend-api，Responses 形态）。
// API Key 账号用的是 api.openai.com，别混用。
export const CODEX_OAUTH_BASE_URL =
  process.env.CODEX_OAUTH_BASE_URL || 'https://chatgpt.com'

const FALLBACK_DEVICE_CODE_URL = `${CODEX_ISSUER}/oauth2/device/code`
const FALLBACK_TOKEN_URL = `${CODEX_ISSUER}/oauth2/token`
const FALLBACK_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth2/authorize`

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

// access_token 实际寿命约数小时。默认提前 1 小时续期：网关类负载可能半小时才碰
// 一次上游，2 分钟的续期窗口很容易被整个错过，等到真正请求时 token 已经过期。
const DEFAULT_REFRESH_SKEW_MS = 60 * 60 * 1000

let _discovery = null
let _discoveryAt = 0

// 进行中的设备码会话。仅存内存——重启后未完成的授权自然作废，用户重新发起即可。
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

// OIDC discovery：端点地址以 OpenAI 实际公告为准，避免硬编码过期后整体失效
export async function discover(force = false) {
  if (!force && _discovery && now() - _discoveryAt < DISCOVERY_TTL_MS) {
    return _discovery
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const resp = await fetch(CODEX_DISCOVERY_URL, { signal: controller.signal })
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

// 从 JWT（access_token 或 id_token）解析 chatgpt-account-id。
// OpenAI 把账号标识放在自定义 claim 下（顶层 chatgpt_account_id 或
// https://api.openai.com/auth.chatgpt_account_id / .auth.chatgpt_account_id）。
function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(b64, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function extractAccountId(cred) {
  const claims = decodeJwtClaims(cred?.id_token) || decodeJwtClaims(cred?.access_token)
  if (!claims) return null
  if (claims.chatgpt_account_id) return claims.chatgpt_account_id
  const auth = claims['https://api.openai.com/auth']
  if (auth && auth.chatgpt_account_id) return auth.chatgpt_account_id
  const auth2 = claims['https://api.openai.com/auth.chatgpt_account_id']
  if (auth2) return auth2
  return null
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
    client_id: CODEX_CLIENT_ID,
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
  // 账号标识用于 chatgpt-account-id 请求头，反代必须的字段
  const accountId = extractAccountId(out)
  if (accountId) out.account_id = accountId
  return out
}

// 发起设备码授权。返回给前端的是 user_code 和验证地址，
// 用户拿它在任意设备的浏览器里完成确认。
export async function startDeviceFlow({ providerId = null, name = '' } = {}) {
  sweepSessions()
  const endpoints = await discover()
  const r = await postForm(endpoints.device_authorization_endpoint, {
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_SCOPE
  })
  if (!r.ok) {
    const msg = r.data?.error_description || r.data?.error || r.text?.slice(0, 200) || `HTTP ${r.status}`
    throw new Error(`申请设备码失败：${msg}`)
  }
  const d = r.data || {}
  if (!d.device_code || !d.user_code) {
    throw new Error('设备码响应缺少 device_code 或 user_code')
  }
  const sessionId = `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
    poll_after: now(),
    created_at: now(),
    last_error: null
  })
  return {
    session_id: sessionId,
    user_code: d.user_code,
    verification_uri: d.verification_uri || `${CODEX_ISSUER}/device`,
    verification_uri_complete: d.verification_uri_complete || null,
    expires_in: Number(d.expires_in) || 1800,
    interval: intervalMs / 1000
  }
}

// 单次轮询。不阻塞，由调用方按 interval 节奏反复调用。
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
    client_id: CODEX_CLIENT_ID
  })

  if (r.ok && r.data?.access_token) {
    pendingSessions.delete(sessionId)
    const cred = applyTokenResponse(
      {
        type: 'oauth',
        name: session.name || '',
        provider: 'codex'
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
export async function ensureAccessToken(cred) {
  if (!cred || cred.type !== 'oauth') return { credential: cred, refreshed: false }
  if (!tokenNeedsRefresh(cred)) return { credential: cred, refreshed: false }
  if (!cred.refresh_token) {
    throw new Error('OAuth 凭据已过期且缺少 refresh_token，需要重新授权')
  }
  const next = await refreshAccessToken(cred)
  return { credential: next, refreshed: true }
}
