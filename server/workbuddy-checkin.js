// WorkBuddy / CodeBuddy 每日签到
//
// 契约来自 cpa-multi-plugins 的 workbuddy 插件（docs/PROTOCOL.md 与 billing.go）：
//   状态 POST /v2/billing/meter/checkin-activity-status
//   领取 POST /v2/billing/meter/daily-checkin   body {}
//
// 两个必须记住的坑：
//  1. 计费域与对话域不是同一个站。CN 账号对话走 copilot.tencent.com，签到却要去
//     www.codebuddy.cn；跨 realm 发过去 APISIX 会回 401 的 HTML 页，报错表现成
//     "parse failed: invalid character '<'"，看不出是域名选错了。
//  2. 字段命名两代并存（todayCheckedIn / today_checked_in），上游混着发。
//     只认一种会在某些账号上永远显示「未签到」。
import { WORKBUDDY_UA, workbuddyBillingBaseFor, workbuddyRealm, workbuddyRealmFor } from './workbuddy-lane.js'

export const WORKBUDDY_CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const WORKBUDDY_CHECKIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin'

// 计费面的头与对话面不同：UA 是简短的 "CodeBuddy"，还要带上企业/租户头。
// 国际版（codebuddy.ai）网关只认 IDE 客户端头集且不要 X-Requested-With，
// 少这几项请求会被当浏览器调用弹回 401。
export function workbuddyBillingHeaders(key = {}) {
  const realm = workbuddyRealm(key.domain)
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${key.access_token || ''}`,
    'X-Domain': key.domain || 'www.codebuddy.cn',
    'User-Agent': 'CodeBuddy'
  }
  if (key.uid) headers['X-User-Id'] = String(key.uid)
  if (key.enterprise_id) {
    headers['X-Enterprise-Id'] = String(key.enterprise_id)
    headers['X-Tenant-Id'] = String(key.enterprise_id)
  }
  if (workbuddyRealmFor(key.domain) === 'intl') {
    delete headers['X-Requested-With']
    headers['X-IDE-Type'] = 'IDE'
    headers['X-IDE-Name'] = 'CodeBuddy'
    headers['X-IDE-Version'] = '1.100.0'
    headers['X-Product-Version'] = '1.100.0'
  }
  return headers
}

// 首字母大写 / 下划线两种命名都认，取第一个存在的值
function pick(obj, ...names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n]
  }
  return undefined
}

export function parseCheckinStatus(payload) {
  const body = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  const m = typeof body === 'object' && body !== null ? body : {}
  const bool = (v) => v === true || v === 1 || v === 'true' || v === '1'
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    // active:false = 该账号当前没有可签到的活动（国际版账号尤其常见）
    active: bool(pick(m, 'active', 'enabled')) || m.active === undefined,
    checked_in: bool(pick(m, 'todayCheckedIn', 'today_checked_in', 'checkedIn', 'checked_in')),
    streak_days: num(pick(m, 'streakDays', 'streak_days', 'weekCheckinDays', 'week_checkin_days')),
    daily_credit: num(pick(m, 'dailyCredit', 'daily_credit')),
    today_credit: num(pick(m, 'todayCredit', 'today_credit')),
    // 日期串只用于展示与诊断，不作为签到判据：上游两代字段名都在发，
    // 拿它当判据会在某些账号上永远判成「未签到」
    dates: Array.isArray(pick(m, 'checkinDates', 'checkin_dates')) ? pick(m, 'checkinDates', 'checkin_dates') : []
  }
}

async function billingCall(key, path, body) {
  const base = String(key.billing_base || '').trim() || workbuddyBillingBaseFor(key.domain)
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: workbuddyBillingHeaders(key),
    body: JSON.stringify(body ?? {})
  })
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 上游 401 时回的是 HTML 页，不是 JSON —— 把状态码说清楚，
    // 别让上层报出一个看不出所以然的 "parse failed: invalid character"
    throw new Error(`签到接口返回 HTTP ${res.status}（非 JSON 响应，多为 realm 不匹配或凭据失效）`)
  }
  if (!res.ok) throw new Error(`签到接口返回 HTTP ${res.status}`)
  return payload
}

export async function fetchWorkbuddyCheckinStatus(key) {
  const payload = await billingCall(key, WORKBUDDY_CHECKIN_STATUS_PATH)
  return parseCheckinStatus(payload)
}

// 领取当日签到奖励。上游已签到时会以业务码拒绝，这里如实抛出，让调用方按
// 「今日已签到」处理，而不是把失败当成功记一笔。
export async function performWorkbuddyCheckin(key) {
  const payload = await billingCall(key, WORKBUDDY_CHECKIN_CLAIM_PATH, {})
  const body = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  const code = payload && typeof payload === 'object' ? Number(payload.code) : 0
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(payload.msg ? String(payload.msg) : `签到被拒绝（code=${code}）`)
  }
  return body && typeof body === 'object' ? body : {}
}

// 北京时间的自然日。签到按自然日重置，宿主机时区不能作为判据——
// 网关可能跑在 UTC 机器上，用本地时间会在凌晨误判成昨天。
export function beijingDayKey(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
