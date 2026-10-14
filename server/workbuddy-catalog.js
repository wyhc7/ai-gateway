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
//
// 注意两个端点的写法并不一致：/v3/config 给 "x0.79"，
// 企业端点会给 "x0.71 credits"（带单位后缀）。只剥前缀的话后者会解析成
// NaN → null，被误判成「上游没给倍率」，等于把一条真实倍率当成缺失。
export function workbuddyRateValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(/^[xX×]/, '').replace(/\s*credits\s*$/i, ''))
  return Number.isFinite(n) ? n : null
}

// 倍率缺失与「倍率为零」是两件事，绝不能混。
// 上游对 auto 这类「按模型浮动」的型号干脆不给 credits 字段，缺失就如实缺失——
// 塞 0 等于把一个会扣费的模型标成免费。
function normalizeRate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  // 只把「能确定解析成数字」的值当倍率收下。解析不出来（比如上游改成了别的
  // 措辞）就当没给——存一个下游读不懂的字符串，只会让界面显示得莫名其妙。
  return workbuddyRateValue(raw) === null ? null : String(raw).trim()
}

// 把上游一条模型记录压成网关内部使用的形状。
//
// 上游这两个端点给的信息很全（实测每条 20+ 字段），全丢掉只留 id 是浪费：
// name 是人看的名字、vendor 是厂商、maxInputTokens/maxOutputTokens 与
// contextWindow 决定调用方要不要开 1M、supportsImages/Reasoning/ToolCall 决定
// 能不能用多模态和工具、descriptionZh 是模型的真实说明。这些都直接来自上游，
// 展示出来即可，不需要网关自己编。
function normalizeModel(raw, provider) {
  const id = raw && (raw.id || raw.ModelName || raw.model_name || raw.name)
  if (!id) return null
  const ctx = raw.contextWindow || {}
  const out = {
    id: String(id),
    owned_by: raw.vendor || provider,
    rate: normalizeRate(raw.credits)
  }
  // 下面每个字段都只在「上游确实给了」时才写。给不了就不写，
  // 前端按缺字段渲染——不能拿默认值假装上游说过这句话。
  if (raw.name) out.name = String(raw.name)
  if (raw.descriptionZh) out.description = String(raw.descriptionZh)
  else if (raw.descriptionEn) out.description = String(raw.descriptionEn)
  if (raw.vendor) out.vendor = String(raw.vendor)
  if (raw.iconUrl) out.icon = String(raw.iconUrl)
  else if (raw.iconUrl_en) out.icon = String(raw.iconUrl_en)
  if (Number.isFinite(Number(raw.maxInputTokens))) out.max_input = Number(raw.maxInputTokens)
  if (Number.isFinite(Number(raw.maxOutputTokens))) out.max_output = Number(raw.maxOutputTokens)
  if (Number.isFinite(Number(ctx.defaultLength))) out.context = Number(ctx.defaultLength)
  if (raw.supportsImages !== undefined) out.images = Boolean(raw.supportsImages)
  if (raw.supportsReasoning !== undefined) out.reasoning = Boolean(raw.supportsReasoning)
  if (raw.supportsToolCall !== undefined) out.tools = Boolean(raw.supportsToolCall)
  if (raw.onlyReasoning !== undefined) out.thinking_only = Boolean(raw.onlyReasoning)
  if (raw.isDefault) out.is_default = true
  if (Array.isArray(raw.tags) && raw.tags.length) out.tags = raw.tags.map(String)
  return out
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

// 凭据失效类错误：这类失败不该被当成「这个端点本来就没有」而静默降级。
// 把它单独标出来，调用方才能把失效的账号摘掉、并如实告诉用户哪个账号掉了。
export class WorkbuddyAuthError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'WorkbuddyAuthError'
    this.status = status
    this.auth_failed = true
  }
}

async function readEnvelope(res, what) {
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 跨 realm 时网关回的是 HTML 401 页，把状态码说清楚，别抛 parse failed
    const err = new Error(`${what}返回 HTTP ${res.status}（非 JSON 响应，多为 realm 不匹配或凭据失效）`)
    if (res.status === 401 || res.status === 403) {
      err.name = 'WorkbuddyAuthError'
      err.status = res.status
      err.auth_failed = true
    }
    throw err
  }
  if (!res.ok) {
    const msg = `${what}返回 HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) throw new WorkbuddyAuthError(msg, res.status)
    throw new Error(msg)
  }
  if (payload && typeof payload === 'object' && Number.isFinite(Number(payload.code)) && Number(payload.code) !== 0) {
    throw new Error(payload.msg ? String(payload.msg) : `${what}返回 code=${payload.code}`)
  }
  return payload
}

// /v3/config：倍率的权威来源，也是国际版模型清单的来源。
// 返回完整模型对象（含倍率、显示名、token 上限、能力开关）——上游给的信息
// 都是事实，直接带回去给调用方展示，不要在中间层削成只剩一个 id。
export async function fetchWorkbuddyModelRates(key, provider) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.rates_base || '').trim() || realm.base
  const res = await fetch(`${base}${WORKBUDDY_V3_CONFIG_PATH}`, { headers: rateHeaders(key, base) })
  const payload = await readEnvelope(res, '模型配置')

  const models = payload?.data?.models
  if (!Array.isArray(models)) throw new Error('模型配置缺少 data.models')

  const rates = {}
  const list = []
  for (const m of models) {
    const model = normalizeModel(m, provider?.name)
    if (!model) continue
    list.push(model)
    // auto 这类「倍率浮动」的模型上游不给固定值，缺失就是缺失，
    // 不塞 0 进去（0 是「免费」的语义，塞 0 等于把会扣费的模型标成免费）
    if (model.rate) rates[model.id] = model.rate
  }
  return { rates, models: list, ids: list.map((m) => m.id) }
}

// 企业端点：国内版的完整清单。国际版这条路是 500，调用方要能接住这个失败。
//
// 它同样带 credits（实测 32 条里绝大多数有值），所以这里也收倍率——
// 只取 id 把倍率丢掉，等于把上游已经给了的答案扔了再让前端显示「未知」。
export async function fetchWorkbuddyEnterpriseModels(key, provider) {
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
  const raw = data?.models || data?.Models || payload?.data?.Data?.Models
  if (!Array.isArray(raw)) throw new Error('企业模型端点缺少 data.models')

  const seen = new Set()
  const list = []
  for (const m of raw) {
    const model = normalizeModel(m, provider?.name)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    list.push(model)
  }
  if (list.length === 0) throw new Error('企业模型端点返回空清单')
  const rates = {}
  for (const m of list) if (m.rate) rates[m.id] = m.rate
  return { rates, models: list, ids: list.map((m) => m.id) }
}

// 合并多个 realm 的模型清单与倍率。
//
// 同一个 id 出现在两个 realm 时，只有倍率也相同才算同一个模型——倍率不同
// 说明扣费口径不同，必须当成两个模型，否则调用方点名 glm-5.3 时根本不知道
// 网关会拿哪一个去扣费。倍率不同的那个给非主 realm 的加 realm 后缀，
// 并记下别名到上游 id 的映射，转发时再换回去。
//
// 元数据按「先到先得，后来者只补空缺」合并：清单以企业端点为准（它给得最全），
// 倍率与能力以 v3/config 为准。谁先来由 order 决定（模型最多的 realm 优先）。
export function mergeWorkbuddyCatalogs(entries) {
  // 主 realm 取模型最多的那个；并列时国内优先（国内版是默认方案）。
  // 先过滤再排序：坏条目混进来时，排序比较器里就会先炸。
  // 注意只丢「结构不对」的条目，空清单要留下——它说明这个 realm 查过了、
  // 确实没有模型，与「没查过」不是一回事。
  const order = [...(entries || [])]
    .filter((e) => e && Array.isArray(e.ids))
    .sort((a, b) => (b.ids.length - a.ids.length) || (a.realm === 'cn' ? -1 : 1))

  const rates = {}
  const models = []
  const upstream = {}
  const realmById = {} // 对外 id -> realm，转发时用来挑对账号
  const byId = new Map() // 对外 id -> 已落盘的模型对象

  // 只补空缺，不覆盖：先来的（清单更全的那个 realm）是权威
  function fill(target, extra) {
    if (!extra) return
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined) continue
      if (target[k] === null || target[k] === undefined || target[k] === '') target[k] = v
    }
    // 倍率单独判一次：x0.00 是有效值，空串才是缺失
    if (!target.rate && extra.rate) target.rate = extra.rate
  }

  for (const entry of order) {
    rates[entry.realm] = entry.rates || {}
    const realmRates = entry.rates || {}
    const detail = new Map()
    for (const m of entry.models || []) if (m && m.id) detail.set(m.id, m)

    for (const id of entry.ids) {
      const meta = detail.get(id) || {}
      const rate = realmRates[id] || meta.rate || null
      const existing = byId.get(id)

      if (existing) {
        // 已被别的 realm 占用：倍率一致就并成同一个模型，只是把缺的元数据补上
        if ((existing.rate || null) === (rate || null)) {
          fill(existing, meta)
          if (!existing.rate && rate) existing.rate = rate
          continue
        }
        // 倍率不同就是两回事，调用方必须能分别点名
        const alias = `${id}-${entry.realm}`
        const forked = { ...meta, id: alias, realm: entry.realm, rate, upstream_id: id }
        byId.set(alias, forked)
        models.push(forked)
        realmById[alias] = entry.realm
        upstream[alias] = id
        continue
      }

      const model = { ...meta, id, realm: entry.realm, rate, upstream_id: id }
      byId.set(id, model)
      models.push(model)
      realmById[id] = entry.realm
    }
  }
  return { models, rates, upstream, realmById }
}
