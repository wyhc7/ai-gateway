// OpenAI Codex OAuth —— 设备码授权与凭据续期
//
// Codex 是 ChatGPT Plus / Pro / Business 订阅附带的编码助手能力。
// 订阅账号没有 API Key，只能靠 OAuth 拿到凭据后走
// https://chatgpt.com/backend-api/codex/responses（Responses API 格式）。
//
// 为什么用设备码而不是 PKCE 回调：
//   市面上多数 Codex 实现（含 AIClient2API）走的是
//   auth.openai.com/oauth/authorize + redirect_uri=http://localhost:1455/auth/callback，
//   靠用户浏览器重定向到本地回环端口拿 code。网关跑在远程服务器上时，
//   浏览器重定向到的是用户本机的 1455，服务端永远收不到回调。
//   设备码流程把顺序倒过来——服务端先申请 user_code，用户在任意设备的
//   浏览器确认，服务端轮询结果，对无人值守的服务器部署是唯一顺畅的方式。
//   （参考 kiro-oauth.js 的 Builder ID 设备码流程，架构与此一致。）
//
// ⚠️ 与标准 RFC 8628（Grok 走的那套）的差异，照抄会全线 404：
//   1. 申请码是 POST JSON（不是表单），且不需要 client_id
//   2. 返回 device_auth_id（不是 device_code），expires_at 是 ISO 时间戳（不是秒数）
//   3. 轮询成功**不直接给 token**，而是给 authorization_code + code_verifier
//   4. 需要第三步拿 code + verifier 去 /oauth/token 换真正的 token
//
// client_id 是 Codex CLI 的公开客户端标识，OSS 生态共用、非机密。
// 已在 openai/codex CLI、AIClient2API 等独立实现中交叉验证一致。

export const CODEX_CLIENT_ID =
  process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ISSUER = 'https://auth.openai.com'

// 设备码授权与换 token 的端点（实测确认，非猜测）
export const CODEX_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`
// 用户在浏览器手动输入 user_code 的页面
export const CODEX_VERIFICATION_URI = `${CODEX_ISSUER}/codex/device`
// 设备码流程专用回调地址，换取 token 时必须原样带回
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`

// 订阅账号的推理端点（Responses API，不是 chat/completions）
export const CODEX_API_BASE_URL =
  process.env.CODEX_API_BASE_URL || 'https://chatgpt.com/backend-api/codex'

// 上游未授权/未完成确认时返回的错误码，与标准 authorization_pending 不同
const PENDING_CODES = new Set([
  'deviceauth_authorization_pending',
  'authorization_pending',
  'slow_down'
])

// access_token 寿命实测约 1 小时（Codex 比 Grok 的 6 小时短很多），
// 提前 5 分钟续期，避免长任务中途 token 失效。
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000

const SESSION_GRACE_MS = 30 * 1000

// 进行中的设备码会话。仅存内存——重启后未完成的授权自然作废，
// 用户重新发起即可，没必要把半成品落盘。
const pendingSessions = new Map()

function now() {
  return Date.now()
}

function sweepSessions() {
  const t = now()
  for (const [id, s] of pendingSessions) {
    if (s.expires_at + SESSION_GRACE_MS < t) pendingSessions.delete(id)
  }
}

// 统一的网络请求：超时、状态码、JSON 解析都在这里兜住，
// 调用方只看 { ok, status, data, text }
async function request(url, { method = 'POST', json = null, form = null, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { Accept: 'application/json' }
    let body
    if (json !== null) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (form !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    const resp = await fetch(url, {
      method,
      headers: { ...headers, 'User-Agent': 'codex_cli_rs/0.1.202' },
      body,
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

function errMsg(r, fallback) {
  const d = r.data
  return (
    d?.error?.message ||
    d?.error_description ||
    d?.error ||
    d?.message ||
    r.text?.slice(0, 200) ||
    fallback ||
    `HTTP ${r.status}`
  )
}

// 解析 JWT 的 payload。仅做 base64url 解码取 claims——
// 验签需要拉取 JWKS，而这里只是要读 chatgpt_account_id，
// 凭据本身是刚从 token 端点换来的，没必要再做一次签名校验。
export function parseIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
  } catch {
    return null
  }
}

// ChatGPT 账号标识，请求上游时必须放在 ChatGPT-Account-Id 头里
export function accountIdFromClaims(claims) {
  if (!claims) return null
  const auth = claims['https://api.openai.com/auth']
  return auth?.chatgpt_account_id || claims.sub || null
}

export function tokenNeedsRefresh(cred, skewMs = DEFAULT_REFRESH_SKEW_MS) {
  if (!cred?.access_token) return true
  if (!cred.expires_at) return false
  return now() + skewMs >= cred.expires_at
}

// 把 token 端点的响应合并回凭据对象。refresh_token 可能轮换，
// 上游不返回新值时保留旧的——实测 Codex 并非每次都下发新的。
export function applyTokenResponse(cred, data) {
  const out = { ...cred }
  if (data.access_token) out.access_token = data.access_token
  if (data.refresh_token) out.refresh_token = data.refresh_token
  if (data.id_token) out.id_token = data.id_token
  if (Number(data.expires_in) > 0) {
    out.expires_at = now() + Number(data.expires_in) * 1000
  }
  out.token_type = data.token_type || out.token_type || 'Bearer'

  const claims = parseIdToken(data.id_token || out.id_token)
  if (claims) {
    const accountId = accountIdFromClaims(claims)
    if (accountId) out.account_id = accountId
    if (claims.email && !out.email) out.email = claims.email
  }
  out.updated_at = now()
  return out
}

// 用 refresh_token 续期。返回新的凭据字段（不落盘，落盘交给调用方）。
export async function refreshAccessToken(cred) {
  if (!cred?.refresh_token) {
    throw new Error('缺少 refresh_token，该账号需要重新授权')
  }
  const r = await request(CODEX_TOKEN_URL, {
    form: {
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: cred.refresh_token
    }
  })
  if (!r.ok || !r.data?.access_token) {
    throw new Error(`刷新凭据失败：${errMsg(r, '未知错误')}`)
  }
  return applyTokenResponse(cred, r.data)
}

// 发起设备码授权。返回 user_code 与验证地址，
// 用户在任意设备的浏览器打开并输入 user_code 完成确认。
//
// 前置条件：ChatGPT → 设置 → 安全 → 「允许设备码登录」需手动开启（默认关闭），
// 未开启时这里可能成功、但用户永远无法通过验证。
export async function startDeviceFlow({ providerId = null, name = '' } = {}) {
  sweepSessions()
  const r = await request(CODEX_USERCODE_URL, { json: {} })
  if (!r.ok) {
    throw new Error(`申请设备码失败：${errMsg(r, '未知错误')}`)
  }
  const d = r.data || {}
  if (!d.device_auth_id || !d.user_code) {
    throw new Error('设备码响应缺少 device_auth_id 或 user_code')
  }

  const sessionId = `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // interval 上游返回的是字符串 "5"，转成数字；仍设 2 秒下限防止打爆上游
  const rawInterval = Number(d.interval)
  const intervalMs = Math.max(Number.isFinite(rawInterval) ? rawInterval : 5, 2) * 1000
  // expires_at 是 ISO 时间戳，不是秒数——照 Grok 那样按 expires_in 处理会立刻过期
  const parsedExpiry = Date.parse(d.expires_at)
  const expiresAt = Number.isFinite(parsedExpiry)
    ? parsedExpiry
    : now() + (Number(d.expires_in) || 900) * 1000

  pendingSessions.set(sessionId, {
    id: sessionId,
    providerId,
    name,
    device_auth_id: d.device_auth_id,
    user_code: d.user_code,
    interval_ms: intervalMs,
    expires_at: expiresAt,
    // 允许立刻轮询一次：用户在页面点了"我已完成授权"后还要干等几秒，
    // 体感很差。退避交给"尚未确认"这条分支处理。
    poll_after: now(),
    created_at: now(),
    last_error: null
  })

  return {
    session_id: sessionId,
    user_code: d.user_code,
    verification_uri: CODEX_VERIFICATION_URI,
    expires_at: expiresAt,
    expires_in: Math.max(Math.ceil((expiresAt - now()) / 1000), 0),
    interval: intervalMs / 1000
  }
}

// 用设备码换回来的 authorization_code + code_verifier 换取真正的 token
async function exchangeAuthorizationCode(authorizationCode, codeVerifier, session) {
  const r = await request(CODEX_TOKEN_URL, {
    form: {
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI
    }
  })
  if (!r.ok || !r.data?.access_token) {
    throw new Error(`换取 token 失败：${errMsg(r, '未知错误')}`)
  }
  return applyTokenResponse(
    {
      type: 'oauth',
      provider: 'codex',
      name: session.name || ''
    },
    r.data
  )
}

// 单次轮询。不阻塞，由调用方按 interval 节奏反复调用，
// 前端因此可以展示"等待确认"的中间态。
//
// 返回 status:
//   pending —— 用户还没确认，retry_after 秒后再来
//   done    —— 已拿到凭据（此时会话一次性消费，二次轮询只会得到 expired）
//   error   —— 授权失败（拒绝、过期、前置开关未开等）
//   expired —— 会话不存在或已超时
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

  const r = await request(CODEX_DEVICE_TOKEN_URL, {
    json: {
      device_auth_id: session.device_auth_id,
      user_code: session.user_code
    }
  })

  // 成功路径：先拿 authorization_code + code_verifier，再去换 token
  if (r.ok && r.data?.authorization_code) {
    const credential = await exchangeAuthorizationCode(
      r.data.authorization_code,
      r.data.code_verifier,
      session
    )
    // 会话是一次性的：删除后重复的轮询只会得到 expired，
    // 避免同一个账号被重复入库两次
    pendingSessions.delete(sessionId)
    return { status: 'done', credential, provider_id: session.providerId }
  }

  const code = r.data?.error?.code || r.data?.error
  session.poll_after = now() + session.interval_ms
  if (PENDING_CODES.has(code)) {
    // 上游用 403 表示"还没确认"，这是它自己的约定，不要当成失败
    if (code === 'slow_down') session.interval_ms += 5000
    session.last_error = null
    return { status: 'pending', retry_after: Math.ceil(session.interval_ms / 1000) }
  }

  const msg = errMsg(r, '未知错误')
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
    user_code: s.user_code,
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
