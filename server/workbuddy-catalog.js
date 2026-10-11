// WorkBuddy 模型目录补充信息：积分倍率
//
// 企业端点 /console/enterprises/personal/models 只回答「有哪些模型」，不带
// 计费倍率；倍率在官方 IDE 配置目录 /v3/config 里，字段名 credits，形如
// "x0.79"。上游自己的描述印证了它的语义——
//   auto: "自动为每个任务匹配最优模型，积分倍率随之浮动"
//         "Automatically selects the best model ... with a variable credit multiplier"
//
// UA 必须自称 CodeBuddyIDE：拿 CLI 的 UA 会得到一份削减表，字段不全。
// （参考实现 models.go 的双路探测就是这么写的，两个 UA 得到的不是同一份数据。）
import { workbuddyRealm } from './workbuddy-lane.js'

export const WORKBUDDY_V3_CONFIG_PATH = '/v3/config'
export const WORKBUDDY_V3_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0'

// 上游把倍率写成带前缀的字符串。原样存、原样显示——自行换算成小数或百分比
// 只是多一层可能算错的地方；这里只在需要判零时去掉前缀。
export function workbuddyRateValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(/^[xX×]/, ''))
  return Number.isFinite(n) ? n : null
}

export async function fetchWorkbuddyModelRates(key) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.rates_base || '').trim() || realm.base
  const headers = {
    Authorization: `Bearer ${key?.access_token || ''}`,
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': key?.domain || 'www.codebuddy.cn',
    'X-Product': 'SaaS',
    'X-CodeBuddy-Request': '1',
    'User-Agent': WORKBUDDY_V3_UA,
    Origin: realm.referer,
    Referer: `${realm.referer}/`
  }
  if (key?.uid) headers['X-User-Id'] = String(key.uid)

  const res = await fetch(`${base}${WORKBUDDY_V3_CONFIG_PATH}`, { headers })
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 跨 realm 时网关回的是 HTML 401 页，把状态码说清楚，别抛 parse failed
    throw new Error(`模型配置返回 HTTP ${res.status}（非 JSON 响应，多为 realm 不匹配或凭据失效）`)
  }
  if (!res.ok) throw new Error(`模型配置返回 HTTP ${res.status}`)
  if (payload && typeof payload === 'object' && Number.isFinite(Number(payload.code)) && Number(payload.code) !== 0) {
    throw new Error(payload.msg ? String(payload.msg) : `模型配置返回 code=${payload.code}`)
  }

  const models = payload?.data?.models
  if (!Array.isArray(models)) throw new Error('模型配置缺少 data.models')

  // 只收有倍率的条目。auto 这类「倍率浮动」的模型上游就不给固定值，
  // 前端对缺失项回落到厂商名，不要硬塞一个 0 进去误导人。
  const rates = {}
  let count = 0
  for (const m of models) {
    const raw = m && m.credits
    if (!m?.id || raw === undefined || raw === null || String(raw).trim() === '') continue
    rates[m.id] = String(raw).trim()
    count += 1
  }
  return { rates, count }
}
