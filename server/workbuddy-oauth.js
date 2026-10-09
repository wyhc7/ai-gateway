// WorkBuddy / CodeBuddy 订阅账号的凭据管理
//
// 与 Grok / Codex 一样走 OAuth，但端点、参数、响应信封都自成一套：
//   - 端点：/v2/plugin/auth/token/refresh
//   - 响应是 {code,msg,data} 信封，字段是驼峰 accessToken / refreshToken
// 直接复用 oauth.js 会拿到一个永远解析不出来的响应。
//
// 凭据来源：腾讯 CodeBuddy CLI 的登录态文件 workbuddy-<uid>.json。
// 网关支持整份粘贴，解析交给 parseWorkbuddyAuthFile —— 让用户自己去文件里
// 抠 uid / domain / token 五个字段，出错率会高得离谱。
import { WORKBUDDY_CHAT_BASE } from './workbuddy-lane.js'

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
