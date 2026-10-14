// WorkBuddy / CodeBuddy 订阅账号的凭据管理
//
// 与 Grok / Codex 一样走 OAuth，但端点、参数、响应信封都自成一套：
//   - 端点：/v2/plugin/auth/token/refresh
//   - 响应是 {code,msg,data} 信封，字段是驼峰 accessToken / refreshToken
// 直接复用 oauth.js 会拿到一个永远解析不出来的响应。
//
// 凭据来源有两条：扫码授权（网关侧轮询 auth/token 自动拿到 uid/domain/token），
// 或整份粘贴 CodeBuddy CLI 的登录态文件 workbuddy-<uid>.json，解析交给
// parseWorkbuddyAuthFile——让用户自己去文件里抠五个字段，出错率会高得离谱。
//
// 纯解析（含 JWT 兜底）在 workbuddy-core.js，本文件只做网络流程。
import {
  AUTH_REFRESH_PATH,
  AUTH_REFRESH_SOURCE,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_REFRESH_TOKEN,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  WORKBUDDY_UA,
  applyWorkbuddyTokenData,
  jwtExpiresAtMs,
  jwtNickname,
  parseWorkbuddyAuthFile,
  workbuddyRealm,
  workbuddyRealmFor,
  WORKBUDDY_REALMS
} from './workbuddy-core.js'

export { parseWorkbuddyAuthFile }

// ---------------------------------------------------------------------------
// 凭据续期
// ---------------------------------------------------------------------------

// 续期窗口：留出余量，别等真正 401 了才刷。上游没给 expiresAt 时按长期有效处理，
// 不主动刷 —— 无谓的刷新只会消耗 refresh_token 的寿命。
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

export function workbuddyTokenNeedsRefresh(key, now = Date.now()) {
  if (!key?.expires_at) return false
  return now >= Number(key.expires_at) - REFRESH_LEEWAY_MS
}

async function postRefresh(key) {
  if (!key?.refresh_token) {
    throw new Error('缺少 refresh_token，该账号需要重新登录')
  }
  // 续期必须发回账号自己的 realm 网关：跨 realm 会被 APISIX 按身份不匹配拒绝，
  // 且返回非 JSON 的 401 HTML（表现成 parse failed: invalid character）。
  const realm = workbuddyRealm(key.domain)
  const base = String(key.chat_base || '').trim() || realm.base
  const res = await fetch(`${base}${AUTH_REFRESH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key.refresh_token}`,
      'X-User-Id': String(key.uid || ''),
      'X-Domain': String(key.domain || 'www.codebuddy.cn'),
      'User-Agent': WORKBUDDY_UA,
      Referer: `${realm.referer}/`,
      // 上游认这两个头来区分「IDE 主动续期」与其他来源
      [HTTP_HEADER_REFRESH_TOKEN]: key.refresh_token,
      [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE
    },
    body: JSON.stringify({ refreshToken: key.refresh_token })
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(`WorkBuddy 续期被拒（HTTP ${res.status}）：refresh_token 已失效，请重新登录`)
  }
  if (!res.ok) {
    throw new Error(`WorkBuddy 续期失败：HTTP ${res.status}`)
  }
  const payload = await res.json().catch(() => null)
  // 信封：{code,msg,data}。code 非 0 视为业务失败
  const body = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  if (!body || typeof body !== 'object') {
    throw new Error(`WorkBuddy 续期失败：响应无法解析${payload?.msg ? `（${payload.msg}）` : ''}`)
  }
  return { payload, body }
}

/**
 * 把续期响应合并回凭据对象。
 *
 * refreshToken 可能轮换，轮换后必须写回，否则下次续期会拿一个已经作废的 token
 * 去刷。上游只给相对 expiresIn（实测不返回绝对 expiresAt），所以换算基准取
 * 新 access_token 的 JWT iat，缺失时才用当前时刻。
 */
export function applyWorkbuddyRefresh(key, body) {
  return applyWorkbuddyTokenData(key, body)
}

// 临近过期才刷，符合 proxy.resolveKeyToken 的调用约定（返回 {credential, refreshed}）
export async function ensureWorkbuddyToken(key) {
  if (!workbuddyTokenNeedsRefresh(key)) return { credential: key, refreshed: false }
  const { body } = await postRefresh(key)
  return { credential: applyWorkbuddyRefresh(key, body), refreshed: true }
}

// 无条件续期，用于上游 401/403 时的「补刷重试」
export async function refreshWorkbuddyToken(key) {
  const { body } = await postRefresh(key)
  return applyWorkbuddyRefresh(key, body)
}

// ---------------------------------------------------------------------------
// 扫码登录
//
// 与设备码流程同构（start → 前端轮询 → 成功即绑 Key），但上游形态完全不同：
// auth/state 返回的是登录页地址（打开后扫码或网页登录），凭据由网关侧轮询
// auth/token 拿到。
//
// 关键差异是 **cookie 会话**：上游把「浏览器登录」和 auth/state 签发的 state
// 绑在一起，轮询必须带上发 state 时那个 HTTP 客户端的 cookie。所以每次登录
// 都要一个隔离的 cookie 罐，随 state 存在服务端；多账号并行登录时互不串台，
// 5 分钟过期后整条会话一起丢弃。
//
// 登录起点按 realm 走：CN 与 Global 都从 copilot.tencent.com 起（platform=CLI），
// 国际版（codebuddy.ai）只认 IDE 客户端，起点是自己的网关 + platform=ide。
// 哪个 realm 由用户在发起时指定，落地后由 token 的 domain 决定后续路由。
// ---------------------------------------------------------------------------
const WORKBUDDY_LOGIN_TTL_MS = LOGIN_TIMEOUT_MS

// 与参考实现的 commonHeaders 对齐：这几项少一个，上游可能直接把请求当爬虫拦掉。
// Origin / Referer 跟着 realm 走——跨 realm 引用会被当成外部渠道。
function loginHeaders(jar, realm) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: realm.referer,
    Referer: `${realm.referer}/`,
    'User-Agent': WORKBUDDY_UA
  }
  if (jar.size > 0) {
    headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  return headers
}

function absorbCookies(jar, res) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    // 空值 = 上游在清 cookie（Max-Age=0 / 已过期），照单执行，否则会话会残留脏状态
    if (!value) jar.delete(name)
    else jar.set(name, value)
  }
}

// state -> { jar, base, expires, providerId, name }。只存内存：这是 5 分钟的临时
// 会话，落盘反而把登录中的半成品凭据暴露给任何能读 DATA_DIR 的进程。
// base 随 state 存，测试可注入本地上游；轮询与后续取账号用的必须是同一个 host，
// 换 host 会让上游认不出这条 cookie 会话。
const loginStates = new Map()

function sweepLoginStates() {
  const now = Date.now()
  for (const [state, entry] of loginStates) {
    if (now > entry.expires) loginStates.delete(state)
  }
}

/** 带超时的 fetch：auth/state 实测可能耗时 5.8–7.5 秒，超时值必须够宽。 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 从信封里取 data（null/undefined 视为缺失）。 */
function envelopeData(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  const data = payload.data
  return data === null ? undefined : data
}

/** 从响应体读业务码。 */
function responseCode(payload) {
  if (!payload || typeof payload !== 'object') return 0
  const code = payload.code
  return Number.isFinite(Number(code)) ? Number(code) : 0
}

export async function startWorkbuddyLogin({ providerId = null, name = '', region = 'cn', base = null } = {}) {
  sweepLoginStates()
  const realm = WORKBUDDY_REALMS[region] || WORKBUDDY_REALMS.cn
  const jar = new Map()
  // base 可注入本地上游（测试用）；不传时按 realm 选真实网关
  const origin = base || realm.base
  const res = await fetchWithTimeout(
    `${origin}${AUTH_STATE_PATH}?platform=${realm.platform}`,
    { method: 'POST', headers: loginHeaders(jar, realm), body: '{}' },
    STATE_REQUEST_TIMEOUT_MS
  )
  absorbCookies(jar, res)
  if (!res.ok) throw new Error(`auth/state 返回 HTTP ${res.status}`)
  const payload = await res.json().catch(() => null)
  const data = envelopeData(payload)
  if (!data?.state || !data?.authUrl) {
    throw new Error(`auth/state 缺少 state 或 authUrl${payload?.msg ? `（${payload.msg}）` : ''}`)
  }
  const expires = Date.now() + WORKBUDDY_LOGIN_TTL_MS
  loginStates.set(data.state, { jar, base: origin, region, expires, providerId, name })
  return { state: data.state, auth_url: data.authUrl, expires_at: expires, region }
}

export async function pollWorkbuddyLogin(state) {
  const entry = loginStates.get(state)
  if (!entry) return { status: 'error', message: '登录会话已丢失，请重新发起授权' }
  if (Date.now() > entry.expires) {
    loginStates.delete(state)
    return { status: 'expired', message: '登录已超时（5 分钟），请重新发起授权' }
  }
  const realm = WORKBUDDY_REALMS[entry.region] || WORKBUDDY_REALMS.cn

  let res
  try {
    res = await fetchWithTimeout(
      `${entry.base}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`,
      { headers: loginHeaders(entry.jar, realm) },
      REQUEST_TIMEOUT_MS
    )
  } catch (err) {
    // 传输层失败是真错误，不是「还在登录中」——继续轮询只会空转到超时
    loginStates.delete(state)
    return { status: 'error', message: `登录轮询失败：${err.message}` }
  }
  absorbCookies(entry.jar, res)
  if (res.status >= 500) {
    loginStates.delete(state)
    return { status: 'error', message: `登录端点异常：HTTP ${res.status}` }
  }

  const payload = await res.json().catch(() => null)
  const data = envelopeData(payload)
  // 「还没登录完」的四种形态，一律继续等：
  //  1. 4xx（含未登录时的 401）；
  //  2. 上游明示「token 未就绪」的业务码 11217（参考实现 loopGetToken 据此 continue）；
  //  3. 信封里其它非 0 业务码（上游会回 code!=0 的 login ing）；
  //  4. 信封结构对但没有 accessToken。
  // 只有真正拿到 accessToken 才算成功 —— 提前判成功会存一个空凭据。
  if (res.status >= 400 || !data?.accessToken) {
    return { status: 'pending', message: 'waiting for login' }
  }

  // token 到手后再取账号信息（login/account 在 openresty 后面，登录完成前一律 401）。
  // 账号信息也可能「尚未就绪」（业务码 12151），所以这里同样要能容忍重试。
  const uid = await resolveAccountUid(entry, realm, data.accessToken, state)
  if (!uid) {
    // 手里已有 token 却取不到 uid —— 网关的 X-User-Id 头离不开它，
    // 存一个空 uid 的 Key 等于把一个必定 401 的凭据入库
    loginStates.delete(state)
    return { status: 'error', message: '登录成功但没拿到账号 uid，请重试或改用「导入 Token」' }
  }

  loginStates.delete(state)
  return {
    status: 'done',
    provider_id: entry.providerId,
    credential: {
      name: entry.name,
      access_token: data.accessToken,
      refresh_token: data.refreshToken || '',
      // expiresIn 是相对秒数（实测上游不返回绝对 expiresAt），换算基准优先取
      // 新 token 的 JWT iat，缺失时用当前时刻。
      expires_at: expiryFromTokenData(data),
      domain: data.domain || '',
      uid,
      // 昵称在 login/account 里常为空，真值在 access_token 的 JWT 声明里
      nickname: (await resolveAccountNickname(entry, realm, data.accessToken, state)) || jwtNickname(data.accessToken) || ''
    }
  }
}

/** 由 token 数据算绝对过期毫秒时间戳（优先绝对字段，缺失时按 expiresIn 换算）。 */
function expiryFromTokenData(data) {
  const absolute = data?.expiresAt
  if (absolute !== undefined && absolute !== null && String(absolute).trim() !== '') {
    const raw = String(absolute)
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      return n > 1e12 ? n : n * 1000
    }
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  const expiresIn = Number(data?.expiresIn)
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000
  // 最后回落到 JWT 的 exp —— 它同样是权威的过期时刻
  return jwtExpiresAtMs(data?.accessToken) || 0
}

/** 取账号 uid。失败（含「尚未就绪」）返回空串，由调用方决定是否放弃。 */
async function resolveAccountUid(entry, realm, accessToken, state) {
  const acct = await fetchAccount(entry, realm, accessToken, state)
  return acct?.uid || ''
}

/** 取账号昵称（可能为空）。 */
async function resolveAccountNickname(entry, realm, accessToken, state) {
  const acct = await fetchAccount(entry, realm, accessToken, state)
  return acct?.nickname || ''
}

// 账号信息只在成功时缓存一次，避免 uid 与 nickname 各打一次上游。
const accountCache = new Map()

async function fetchAccount(entry, realm, accessToken, state) {
  const cacheKey = `${state}:account`
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey)
  const res = await fetchWithTimeout(
    `${entry.base}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
    {
      headers: {
        ...loginHeaders(entry.jar, realm),
        Authorization: `Bearer ${accessToken}`
      }
    },
    REQUEST_TIMEOUT_MS
  ).catch(() => null)
  if (!res || !res.ok) return null
  const payload = await res.json().catch(() => null)
  const code = responseCode(payload)
  // 12151 = 账户信息尚未完成。不把它当错误，只是这次没取到。
  if (code !== 0 && code !== CODE_ACCOUNT_NOT_READY) return null
  const data = envelopeData(payload)
  if (!data || typeof data !== 'object') return null
  const out = {
    uid: data.uid ? String(data.uid) : '',
    nickname: data.nickname ? String(data.nickname) : ''
  }
  accountCache.set(cacheKey, out)
  return out
}

export function cancelWorkbuddyLogin(state) {
  const had = loginStates.delete(state)
  accountCache.delete(`${state}:account`)
  sweepLoginStates()
  return had
}
