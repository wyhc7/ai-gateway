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
import { WORKBUDDY_CHAT_BASE, WORKBUDDY_UA } from './workbuddy-lane.js'

export const WORKBUDDY_REFRESH_PATH = '/v2/plugin/auth/token/refresh'

// 登录态文件里的字段是驼峰，网关内部统一用下划线（与 Grok / Codex 的 Key 一致）。
// 支持嵌套（CLI 实际写盘的形状）与扁平两种，避免用户手工改过文件就认不出来。
export function parseWorkbuddyAuthFile(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  const auth = obj.auth || obj
  const account = obj.account || obj

  const access_token = auth.accessToken || auth.access_token || ''
  const refresh_token = auth.refreshToken || auth.refresh_token || ''
  const uid = account.uid || account.UID || auth.uid || ''
  const domain = auth.domain || account.domain || ''
  const expires_at = auth.expiresAt || auth.expires_at || 0

  // 少了 uid 或 token 就没法调上游，与其存一个半残的 Key，不如当场说清楚
  if (!access_token || !uid) return null
  return { access_token, refresh_token, uid, domain, expires_at }
}

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
  const base = String(key.chat_base || '').trim() || WORKBUDDY_CHAT_BASE
  const res = await fetch(`${base}${WORKBUDDY_REFRESH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 续期同样要自称是 CLI，且带上当前 realm —— 换了域名去刷会 401
      Authorization: `Bearer ${key.refresh_token}`,
      'X-User-Id': String(key.uid || ''),
      'X-Domain': String(key.domain || 'workbuddy.ai'),
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2'
    },
    body: JSON.stringify({ refreshToken: key.refresh_token })
  })
  if (!res.ok) {
    throw new Error(`WorkBuddy 续期失败：HTTP ${res.status}`)
  }
  const payload = await res.json()
  // 信封：{code,msg,data}。code 非 0 视为业务失败
  const body = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  if (!body || typeof body !== 'object') {
    throw new Error(`WorkBuddy 续期失败：响应无法解析${payload?.msg ? `（${payload.msg}）` : ''}`)
  }
  return { payload, body }
}

// 把续期响应合并回凭据对象。refreshToken 可能轮换，轮换后必须写回，
// 否则下次续期会拿一个已经作废的 token 去刷。
export function applyWorkbuddyRefresh(key, body) {
  const out = { ...key }
  if (body.accessToken) out.access_token = body.accessToken
  if (body.refreshToken) out.refresh_token = body.refreshToken
  if (body.domain) out.domain = body.domain
  if (body.expiresIn) out.expires_at = Date.now() + Number(body.expiresIn) * 1000
  return out
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
// 端点固定走 CN 域（copilot.tencent.com）：auth/state 是登录入口，Global 与 CN
// 共用这一套。
// ---------------------------------------------------------------------------
const WORKBUDDY_CN_BASE = 'https://copilot.tencent.com'
const WORKBUDDY_LOGIN_TTL_MS = 5 * 60 * 1000

// 与参考实现的 commonHeaders 对齐：这几项少一个，上游可能直接把请求当爬虫拦掉
function loginHeaders(jar) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
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

export async function startWorkbuddyLogin({ providerId = null, name = '', base = WORKBUDDY_CN_BASE } = {}) {
  sweepLoginStates()
  const jar = new Map()
  const res = await fetch(`${base}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: loginHeaders(jar),
    body: '{}'
  })
  absorbCookies(jar, res)
  if (!res.ok) throw new Error(`auth/state 返回 HTTP ${res.status}`)
  const payload = await res.json().catch(() => null)
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  if (!data?.state || !data?.authUrl) {
    throw new Error(`auth/state 缺少 state 或 authUrl${payload?.msg ? `（${payload.msg}）` : ''}`)
  }
  const expires = Date.now() + WORKBUDDY_LOGIN_TTL_MS
  loginStates.set(data.state, { jar, base, expires, providerId, name })
  return { state: data.state, auth_url: data.authUrl, expires_at: expires }
}

export async function pollWorkbuddyLogin(state) {
  const entry = loginStates.get(state)
  if (!entry) return { status: 'error', message: '登录会话已丢失，请重新发起授权' }
  if (Date.now() > entry.expires) {
    loginStates.delete(state)
    return { status: 'expired', message: '登录已超时（5 分钟），请重新发起授权' }
  }

  let res
  try {
    res = await fetch(`${entry.base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: loginHeaders(entry.jar)
    })
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
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  // 「还没登录完」的三种形态：4xx（含未登录时的 401）、信封里业务码非 0
  //（上游会回 code!=0 的 login ing）、信封结构对但没有 accessToken。
  // 一律等，只有拿到 accessToken 才算成功。
  if (res.status >= 400 || !data?.accessToken) {
    return { status: 'pending', message: 'waiting for login' }
  }

  // token 到手后再取账号信息（login/account 在 openresty 后面，登录完成前一律 401）
  const acctRes = await fetch(`${entry.base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    headers: { ...loginHeaders(entry.jar), Authorization: `Bearer ${data.accessToken}` }
  }).catch(() => null)
  const acctPayload = acctRes && acctRes.ok ? await acctRes.json().catch(() => null) : null
  const acct = acctPayload && typeof acctPayload === 'object' && 'data' in acctPayload ? acctPayload.data : null
  const uid = acct?.uid || ''
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
      expires_at: Date.now() + Number(data.expiresIn || 0) * 1000,
      domain: data.domain || '',
      uid
    }
  }
}

export function cancelWorkbuddyLogin(state) {
  const had = loginStates.delete(state)
  sweepLoginStates()
  return had
}
