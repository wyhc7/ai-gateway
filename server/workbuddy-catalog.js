// WorkBuddy 模型目录：模型清单 + 积分倍率 + 促销
//
// 两个来源，各管一件事：
//   企业端点 /console/enterprises/personal/models —— 「有哪些模型」，国内版给得最全
//     （实测 31–32 个，含上游界面不展示但直调可用的隐藏型号）。
//   IDE 配置目录 /v3/config —— 「每个模型扣多少积分」+ 促销活动。
//
// 两个 realm 不对称，这是实测出来的，不是设计：
//   国内  企业端点 200 / v3/config 200，模型名 glm-5.3、kimi-k3-1 这一套
//   国际  企业端点 500（openresty 直接回 500 页）/ v3/config 200，
//         模型名是抽象别名 fast-model、primary-model、balanced-model
// 所以国际版的模型清单只能来自 v3/config —— 企业端点那条路对它是死的。
//
// ⚠️ 两个端点下发的 **id 集合不同，必须取并集**（实测 2026-09-21）：
//   scoped     → hy4-preview、hy4-preview-x（30 个）
//   /v3/config → hy4-preview-f（22 个）
// 而「限时免费」促销的 modelIds 只写着 ["hy4-preview-f"] —— 挂在只由
// /v3/config 下发的那个 id 上。只取 scoped 会让该促销永远对不上。
//
// UA 必须按端点自称：企业端点拿 IDE 的 UA 会 404。
// /v3/config 则更麻烦：上游按 UA 下发两份**互有独有**的清单，必须两种 UA
// 各取一次再并集（实测数据与结论见 workbuddy-core.js 的 UA 注释）。
//
// 本文件只做网络与信封处理，解析与常量在 workbuddy-core.js（可被单测直接钉住）。
import {
  CONFIG_PATH,
  ENTERPRISE_MODELS_PATH,
  WORKBUDDY_CLI_UA,
  WORKBUDDY_V3_UA,
  parseModelsFromConfig,
  parsePromotions,
  workbuddyRealm
} from './workbuddy-core.js'

export const WORKBUDDY_V3_CONFIG_PATH = CONFIG_PATH
export const WORKBUDDY_ENTERPRISE_MODELS_PATH = ENTERPRISE_MODELS_PATH
export { WORKBUDDY_V3_UA, WORKBUDDY_CLI_UA }

// 兼容旧导出名：调用方与测试都在用 workbuddyRateValue 判零。
export { workbuddyRateValue, normalizeRateText } from './workbuddy-core.js'

// 合并逻辑住在 core（纯函数，可被单测直接钉住）。这里转出，
// 让「目录」这个入口对调用方是完整的：取数 + 合并一站式。
export { mergeWorkbuddyCatalogs, parseModelsFromConfig } from './workbuddy-core.js'

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

function rateHeaders(key, ua = WORKBUDDY_V3_UA) {
  const headers = {
    Authorization: `Bearer ${key?.access_token || ''}`,
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': key?.domain || 'www.codebuddy.cn',
    'X-Product': 'SaaS',
    'X-CodeBuddy-Request': '1',
    'User-Agent': ua,
    Origin: workbuddyRealm(key?.domain).referer,
    Referer: `${workbuddyRealm(key?.domain).referer}/`
  }
  if (key?.uid) headers['X-User-Id'] = String(key.uid)
  return headers
}

function enterpriseHeaders(key) {
  const realm = workbuddyRealm(key?.domain)
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
  return headers
}

/**
 * 取 /v3/config 的模型与促销表。
 *
 * 这是倍率的权威来源，也是国际版模型清单的唯一来源（企业端点对它 500）。
 * 返回完整模型对象（含倍率、显示名、token 上限、能力开关）—— 上游给的信息
 * 都是事实，直接带回去给调用方展示，不要在中间层削成只剩一个 id。
 *
 * ⚠️ 必须用**两种 UA 各取一次再并集**：上游按 UA 下发两份互有独有的清单
 * （CLI 那份更全，IDE 那份另有 auto-chat / o4-mini 等），只取一份就少一大半。
 * 这是「国际版只有 14 个模型」的根因 —— 详见 core 的 UA 注释。
 *
 * 其中一个 UA 失败不算致命：另一个的清单照样可用，只有两个都失败才抛错。
 * 但**凭据失效是硬失败**，必须立刻上抛（那是账号问题，不是「这个 UA 取不到」）。
 */
export async function fetchWorkbuddyModelRates(key, provider) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.rates_base || '').trim() || realm.base
  const url = `${base}${CONFIG_PATH}`

  const collected = []
  let lastErr = null
  for (const ua of [WORKBUDDY_CLI_UA, WORKBUDDY_V3_UA]) {
    try {
      const res = await fetch(url, { headers: rateHeaders(key, ua) })
      const payload = await readEnvelope(res, '模型配置')

      const data = payload?.data
      if (!data || typeof data !== 'object') throw new Error('模型配置缺少 data')
      if (!Array.isArray(data.models)) throw new Error('模型配置缺少 data.models')

      // 走与目录同一套解析（含对话模型标注），免得两处口径漂移
      const models = parseModelsFromConfig(payload, provider?.name)
      if (models.length === 0) throw new Error('模型配置里没有可用的对话模型')

      const rates = {}
      for (const m of models) if (m.rate) rates[m.id] = m.rate
      collected.push({ models, rates })
    } catch (err) {
      if (err?.auth_failed) throw err
      lastErr = err
    }
  }
  if (collected.length === 0) throw lastErr || new Error('模型配置不可用')

  // 并集：先到的（CLI 那份，清单更全）为主，其余只补它没有的 id 与空倍率
  let models = collected[0].models
  const rates = { ...collected[0].rates }
  for (const extra of collected.slice(1)) {
    models = mergeRemoteModels(models, extra.models)
    for (const [id, v] of Object.entries(extra.rates)) if (!rates[id]) rates[id] = v
  }
  return { rates, models, ids: models.map((m) => m.id) }
}

/**
 * 企业端点：国内版的完整清单。国际版这条路是 500，调用方要能接住这个失败。
 *
 * 它同样带 credits（实测 32 条里绝大多数有值）与完整元数据，所以走同一套解析
 * —— 只取 id 把倍率丢掉，等于把上游已经给了的答案扔了再让前端显示「未知」。
 */
export async function fetchWorkbuddyEnterpriseModels(key, provider) {
  const realm = workbuddyRealm(key?.domain)
  const base = String(key?.models_base || '').trim() || realm.base
  const res = await fetch(`${base}${ENTERPRISE_MODELS_PATH}`, { headers: enterpriseHeaders(key) })
  const payload = await readEnvelope(res, '企业模型端点')

  // 信封里模型挂在 data.models（小写）；大小写都试一遍，别因为一处键名
  // 对不上就把一份好数据判成空
  const data = payload?.data
  const raw = data?.models || data?.Models || data?.Data?.Models
  if (!Array.isArray(raw)) throw new Error('企业模型端点缺少 data.models')

  const models = parseModelsFromConfig(payload, provider?.name)
  if (models.length === 0) throw new Error('企业模型端点返回空清单')

  const rates = {}
  for (const m of models) if (m.rate) rates[m.id] = m.rate
  return { rates, models, ids: models.map((m) => m.id) }
}

/**
 * 按 id 合并两个端点的模型列表。
 *
 * 同名 id 以 **primary（企业端点）为准** —— 它带更完整的元数据，且与既有策略
 * 一致（采信实际命中的那个端点，不做跨端点取大）。extra 里 primary 没有的 id
 * **追加在后**，从而既保留主目录的顺序与权威性，又不丢掉只在另一个端点下发的
 * 变体（如 hy4-preview-f）。
 */
export function mergeRemoteModels(primary, extra) {
  const known = new Set((primary || []).map((m) => m.id))
  return [...(primary || []), ...(extra || []).filter((m) => !known.has(m.id))]
}

/** 把促销表并入模型列表（只补促销价，其余字段不动）。 */
export function applyPromotions(models, promotions) {
  if (!promotions || promotions.size === 0) return models
  return models.map((model) => {
    const discounted = promotions.get(model.id)
    return discounted === undefined ? model : { ...model, rate_discounted: discounted }
  })
}

/**
 * 一次取齐某个账号的目录：企业端点（清单）+ /v3/config（倍率与促销）。
 *
 * 两个端点下发的 id 集合不同，**必须取并集**（见文件头注释）。
 * 企业端点失败不是致命的：国际版这条路本来就是 500，v3/config 的清单照样可用，
 * 只是少了几个隐藏型号 —— 失败信息通过 notes 如实上报，不静默吞掉。
 */
export async function fetchWorkbuddyCatalog(key, provider) {
  const notes = []
  let scoped = null
  try {
    scoped = await fetchWorkbuddyEnterpriseModels(key, provider)
  } catch (err) {
    // 凭据失效要往上抛：这不是「端点对本 realm 不可用」，是账号出了问题
    if (err?.auth_failed) throw err
    notes.push(`企业端点不可用（${err.message}），清单退回 v3/config`)
  }

  const config = await fetchWorkbuddyModelRates(key, provider)

  const models = scoped
    ? mergeRemoteModels(scoped.models, config.models)
    : config.models

  // 倍率：企业端点的并进同一张表，v3/config 是权威（同 id 冲突以它为准）
  const rates = { ...(scoped?.rates || {}), ...config.rates }

  return { realm: workbuddyRealm(key?.domain), ids: models.map((m) => m.id), rates, models, notes }
}

/** 从 /v3/config 的原始响应里取促销表（供需要单独拿促销的调用方使用）。 */
export function promotionsFromConfig(payload, now) {
  return parsePromotions(payload?.data, now)
}
