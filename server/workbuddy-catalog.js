// WorkBuddy 模型目录：模型清单 + 积分倍率
//
// 两个来源，各管一件事：
//   企业端点 /console/enterprises/personal/models —— 「有哪些模型」，国内版给得最全
//     （31 个，含上游界面不展示但直调可用的隐藏型号）。
//   IDE 配置目录 /v3/config —— 「每个模型扣多少积分」，字段名 credits，形如 "x0.79"。
//     上游自己的描述印证语义：auto 的 description 写着「积分倍率随之浮动」。
//
// 两个 realm 不对称，这是实测出来的，不是设计：
//   国内  企业端点 200 / v3/config 200，模型名 glm-5.3、kimi-k3-1 这一套
//   国际  企业端点 500（openresty 直接回 500 页）/ v3/config 200，
//         模型名是抽象别名 fast-model、primary-model、balanced-model
// 所以国际版的模型清单只能来自 v3/config——企业端点那条路对它是死的。
//
// UA 必须按端点自称：v3/config 自称 CLI 只会拿到削减表；企业端点反过来，
// 拿 IDE 的 UA 会 404。参考实现的双路探测就是这么写的。
import { workbuddyRealm } from './workbuddy-lane.js'

export const WORKBUDDY_V3_CONFIG_PATH = '/v3/config'
export const WORKBUDDY_ENTERPRISE_MODELS_PATH = '/console/enterprises/personal/models'
export const WORKBUDDY_V3_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0'
export const WORKBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

// 上游把倍率写成带前缀的字符串。原样存、原样显示——自行换算成小数或百分比
// 只是多一层可能算错的地方；这里只在需要判零时去掉前缀。
export function workbuddyRateValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(/^[xX×]/, ''))
  return Number.isFinite(n) ? n : null
}

function rateHeaders(key, base) {
  const headers = {
    Authorization: `Bearer ${key?.access_token || ''}`,
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': key?.domain || 'www.codebuddy.cn',
    'X-Product': 'SaaS',
    'X-CodeBuddy-Request': '1',
    'User-Agent': WORKBUDDY_V3_UA,
    Origin: workbuddyRealm(key?.domain).referer,
    Referer: `${workbuddyRealm(key?.domain).referer}/`
  }
  if (key?.uid) headers['X-User-Id'] = String(key.uid)
  return headers
}

async function readEnvelope(res, what) {
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 跨 realm 时网关回的是 HTML 401 页，把状态码说清楚，别抛 parse failed
    throw new Error(`${what}返回 HTTP ${res.status}（非 JSON 响应，多为 realm 不匹配或凭据失效）`)
  }
  if (!res.ok) throw new Error(`${what}返回 HTTP ${res.status}`)
  if (payload && typeof payload === 'object' && Number.isFinite(Number(payload.code)) && Number(payload.code) !== 0) {
    throw new Error(payload.msg ? String(payload.msg) : `${what}返回 code=${payload.code}`)
  }
  return payload
}

// /v3/config：既是倍率的唯一来源，也是国际版模型清单的唯一来源。
// 返回 v3 侧的模型 id——调用方要用它当国际版的清单，也要用它匹配倍率。
export async function fetchWorkbuddyModelRates(key) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.rates_base || '').trim() || realm.base
  const res = await fetch(`${base}${WORKBUDDY_V3_CONFIG_PATH}`, { headers: rateHeaders(key, base) })
  const payload = await readEnvelope(res, '模型配置')

  const models = payload?.data?.models
  if (!Array.isArray(models)) throw new Error('模型配置缺少 data.models')

  const rates = {}
  const ids = []
  for (const m of models) {
    if (!m?.id) continue
    ids.push(m.id)
    // auto 这类「倍率浮动」的模型上游不给固定值，缺失就缺失，
    // 不塞 0 进去（0 是「免费」的语义，塞 0 等于把会扣费的模型标成免费）
    const raw = m.credits
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    rates[m.id] = String(raw).trim()
  }
  return { rates, ids }
}

// 企业端点：国内版的完整清单。国际版这条路是 500，调用方要能接住这个失败。
export async function fetchWorkbuddyEnterpriseModels(key) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.models_base || '').trim() || realm.base
  const headers = {
    Authorization: `Bearer ${key?.access_token || ''}`,
    'Content-Type': 'application/json',
    'User-Agent': WORKBUDDY_CLI_UA,
    'X-Domain': key?.domain || 'www.codebuddy.cn',
    Origin: realm.referer,
    Referer: `${realm.referer}/`,
    Accept: 'application/json, text/plain, */*'
  }
  if (key?.uid) headers['X-User-Id'] = String(key.uid)

  const res = await fetch(`${base}${WORKBUDDY_ENTERPRISE_MODELS_PATH}`, { headers })
  const payload = await readEnvelope(res, '企业模型端点')

  // 信封里模型挂在 data.models（小写）；大小写都试一遍，别因为一处键名
  // 对不上就把一份好数据判成空
  const data = payload?.data
  const list = data?.models || data?.Models || payload?.data?.Data?.Models
  if (!Array.isArray(list)) throw new Error('企业模型端点缺少 data.models')

  const ids = []
  for (const m of list) {
    const id = m && (m.ModelName || m.model_name || m.id || m.name)
    if (id && !ids.includes(String(id))) ids.push(String(id))
  }
  if (ids.length === 0) throw new Error('企业模型端点返回空清单')
  return { ids }
}

// 合并多个 realm 的模型清单与倍率。
//
// 同一个 id 出现在两个 realm 时，只有倍率也相同才算同一个模型——倍率不同
// 说明扣费口径不同，必须当成两个模型，否则调用方点名 glm-5.3 时根本不知道
// 网关会拿哪一个去扣费。倍率不同的那个给非主 realm 的加 realm 后缀，
// 并记下别名到上游 id 的映射，转发时再换回去。
export function mergeWorkbuddyCatalogs(entries) {
  // 主 realm 取模型最多的那个；并列时国内优先（国内版是默认方案）。
  // 先过滤再排序：坏条目混进来时，排序比较器里就会先炸
  const order = [...(entries || [])]
    .filter((e) => e && Array.isArray(e.ids))
    .sort((a, b) => (b.ids.length - a.ids.length) || (a.realm === 'cn' ? -1 : 1))

  const rates = {}
  const models = []
  const upstream = {}
  const realmById = {} // 对外 id -> realm，转发时用来挑对账号
  const taken = new Map() // id -> realm

  for (const entry of order) {
    rates[entry.realm] = entry.rates || {}
    const realmRates = entry.rates || {}

    for (const id of entry.ids) {
      if (taken.has(id)) {
        // 已被别的 realm 占用：倍率一致就并成同一个模型
        const prev = models.find((m) => m.id === id)
        if ((prev?.rate || null) === (realmRates[id] || null)) continue
        // 倍率不同就是两回事，调用方必须能分别点名
        const alias = `${id}-${entry.realm}`
        taken.set(alias, entry.realm)
        realmById[alias] = entry.realm
        models.push({ id: alias, realm: entry.realm, rate: realmRates[id] || null, upstream_id: id })
        upstream[alias] = id
        continue
      }
      taken.set(id, entry.realm)
      realmById[id] = entry.realm
      models.push({ id, realm: entry.realm, rate: realmRates[id] || null, upstream_id: id })
    }
  }
  return { models, rates, upstream, realmById }
}
