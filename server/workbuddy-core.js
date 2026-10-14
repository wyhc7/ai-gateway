// WorkBuddy / CodeBuddy（腾讯）纯逻辑层：常量 + 凭据/模型解析
//
// 分层仿照 dsh-our-free-model（MIT）的 vendor/channel-pack/src/buddy.ts：
// **本文件只放常量与纯函数（无网络、无存储）**，网络流程分别在
// workbuddy-oauth.js（登录/续期）与 workbuddy-catalog.js（模型目录）。
// 这样上游形态的每一条约束都能被单测直接钉住，不必起 HTTP 服务。
//
// 事实来源（两处，都带实测记录，不是照文档猜的）：
//  - dsh-our-free-model 的 buddy.ts / buddy-oauth.ts / tencent-fingerprint.ts
//  - https://github.com/zidanefaqih/codebuddy-intl-cpa 的 workbuddy/ 插件
//
// 一句话概括这套上游：**可以照 OpenAI 发，但必须先抹掉所有「不像它家客户端」的痕迹**。

// ---------------------------------------------------------------------------
// 产品配置
//
// 同一个后端承载两个产品（CodeBuddy 与 WorkBuddy），它们共用大部分路径，
// 但**身份标识不同**：端点、X-Domain、X-Product-Code、User-Agent、登录 platform。
// 把差异收在一张表里，而不是散落成各处的 if —— 发错身份会被网关当外部渠道拦掉。
//
// ⚠️ platform 是登录入口的分水岭：国际版（workbuddy）只认 ide，CodeBuddy 认 CLI。
// ---------------------------------------------------------------------------

/** 产品配置。`key` 与 realm 是两个维度：realm 定域名，产品定身份标识。 */
export const WORKBUDDY_PRODUCTS = {
  codebuddy: {
    key: 'codebuddy',
    // 主 API 端点。realm 会覆盖成对应域，这里只是默认值
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    productCode: 'codebuddy',
    deploymentType: 'SaaS',
    userAgent: 'CodeBuddyIDE/1.106.1',
    platform: 'CLI'
  },
  workbuddy: {
    key: 'workbuddy',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    productCode: 'workbuddy',
    deploymentType: 'SaaS',
    userAgent: 'CodeBuddyIDE/1.106.1',
    platform: 'ide'
  }
}

/** 默认产品：国内版即 CodeBuddy。 */
export const DEFAULT_PRODUCT = WORKBUDDY_PRODUCTS.codebuddy

// ---------------------------------------------------------------------------
// Realm（域名维）
//
// 三个 realm，各自的网关互不通用：同一枚 Bearer 发到别的 realm，网关按身份
// 不匹配拒绝，且返回非 JSON 的 401 HTML —— 在网关里表现成
// "parse failed: invalid character '<'"，极难从报错反推是 realm 选错了。
//
//   cn     X-Domain 是 www.codebuddy.cn（旧登录态文件里 domain 留空的也算）
//   global X-Domain 是 workbuddy.ai
//   intl   X-Domain 是 codebuddy.ai，登录入口只认 IDE 客户端（platform=ide）
//
// CN 的对话域与计费域是分开的两个站（copilot.tencent.com vs www.codebuddy.cn），
// Global 与 Intl 则同域。realm 的归属由 X-Domain 判定，不由平台配置决定。
//
// ⚠️ **intl 的接入地址已迁移到 workbuddy.ai**（2026-10-14 实测）
//
// codebuddy.ai 这个域整体停服了：apex 与 www 在 8.8.8.8 / 1.1.1.1 /
// 114.114.114.114 / 223.5.5.5 上**一致**返回 0.0.0.1（黑洞记录），对话端点
// 同样连不通 —— 不是 DNS 抖动，是腾讯自己下发的废弃解析。旧配置下国际版
// 授权会卡满超时后报「This operation was aborted」，而国内版一切正常。
//
// 迁移依据（同一台海外机器实测）：
//   - www.workbuddy.ai 的 auth/state 0.49s 返回 state + authUrl，auth/token
//     轮询正常回 11217「login ing」，对话端点回 401（正常的凭据校验）；
//   - 它**同时接受** X-Domain: codebuddy.ai 与 X-Domain: workbuddy.ai（都 200），
//     所以存量 intl 账号的 X-Domain 不必改，只换接入地址即可平滑迁移；
//   - 两个域的 CNAME 都指向 *.eo.dnse2.com，本就是同一套边缘网络。
//
// 因此 realm 的**判据（X-Domain）仍是 codebuddy.ai**，只是接入地址改指
// workbuddy.ai。把判据也一起改掉会让存量账号被误判成 global，那会改变
// 它的对话路由与计费归属 —— 不是这次要动的东西。
// ---------------------------------------------------------------------------
export const WORKBUDDY_REALMS = {
  cn: {
    base: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    referer: 'https://www.codebuddy.cn',
    platform: 'CLI',
    product: 'codebuddy'
  },
  global: {
    base: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    referer: 'https://www.workbuddy.ai',
    platform: 'ide',
    product: 'workbuddy'
  },
  intl: {
    // 旧值 https://www.codebuddy.ai 已停服（解析成 0.0.0.1），见上面注释。
    // 复用 global 的接入地址：它接受 codebuddy.ai 的 X-Domain，是同一套后端。
    base: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    referer: 'https://www.workbuddy.ai',
    platform: 'ide',
    product: 'workbuddy'
  }
}

/** 域名归一化：去掉协议头、路径、大小写与首尾空白。 */
function normalizeHost(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** 账号属于哪个 realm。判据是域名，不是平台配置。 */
export function workbuddyRealmFor(domain) {
  const d = normalizeHost(domain)
  if (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) return 'global'
  if (d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai')) return 'intl'
  return 'cn'
}

export function workbuddyRealm(domain) {
  return WORKBUDDY_REALMS[workbuddyRealmFor(domain)]
}

export function workbuddyChatBaseFor(domain) {
  return workbuddyRealm(domain).base
}

export function workbuddyBillingBaseFor(domain) {
  return workbuddyRealm(domain).billingBase
}

/** 该账号用哪个产品身份发请求（决定 UA / X-Product-Code / platform）。 */
export function workbuddyProductFor(domain) {
  return WORKBUDDY_PRODUCTS[workbuddyRealm(domain).product] || DEFAULT_PRODUCT
}

// X-Domain 必须是账号所属的 realm。国际账号是 workbuddy.ai 或 codebuddy.ai，
// 国内账号是 codebuddy.cn。选错 realm 的下文见上面注释。
// 留空按 CN 处理——参考实现对「domain 为空的旧登录态文件」就是这么兜底的，
// 默认成国际域反而会把一个国内账号发到 workbuddy.ai 去。
export function normalizeWorkbuddyDomain(domain) {
  const d = normalizeHost(domain)
  return d || 'www.codebuddy.cn'
}

// ---------------------------------------------------------------------------
// 端点路径
// ---------------------------------------------------------------------------

/** 云端配置目录：模型清单 + 倍率 + 促销活动。 */
export const CONFIG_PATH = '/v3/config'
/** 企业模型端点：{scope} 对个人账号是字面量 personal。 */
export const ENTERPRISE_MODELS_SCOPE = 'personal'
export const ENTERPRISE_MODELS_PATH = `/console/enterprises/${ENTERPRISE_MODELS_SCOPE}/models`
/** 对话端点（OpenAI 兼容形态，但规矩自己定）。 */
export const CHAT_PATH = '/v2/chat/completions'
/** 登录：签发 state + authUrl。 */
export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
/** 登录：轮询 token。 */
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
/** 登录：轮询账号（需 Bearer）。 */
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
/** 静默续期。 */
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
/** 计费面：签到状态 / 领取 / 额度。 */
export const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const CHECKIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin'
export const RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

// ---------------------------------------------------------------------------
// 请求头常量（逆向自 IDE 定义）
// ---------------------------------------------------------------------------
export const HTTP_HEADER_DOMAIN = 'X-Domain'
export const HTTP_HEADER_ENTERPRISE_ID = 'X-Enterprise-Id'
export const HTTP_HEADER_TENANT_ID = 'X-Tenant-Id'
export const HTTP_HEADER_REFRESH_TOKEN = 'X-Refresh-Token'
export const HTTP_HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'
export const HTTP_HEADER_PRODUCT = 'X-Product'
export const HTTP_HEADER_PRODUCT_CODE = 'X-Product-Code'

/** 续期来源标识。 */
export const AUTH_REFRESH_SOURCE = 'ide-main'

/** 对话面 UA：上游要求客户端自称是 CodeBuddy CLI。 */
export const WORKBUDDY_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/**
 * 目录面（/v3/config）的两种 UA：上游按 UA 下发**两份不同的清单**，
 * 必须都取再并集，只取一份必然少模型。
 *
 * ⚠️ 实测（2026-10-15，同一账号、同一端点、只换 UA）：
 *   国际版 www.workbuddy.ai     CLI UA → 20 个（cli agent 19）/ IDE UA → 13 个（craft agent 4）
 *   国内版 copilot.tencent.com  CLI UA → 33 个             / IDE UA → 22 个
 * 两份**互有独有**：国际版 CLI 独有 glm-5.3、kimi-k3、gpt-5.5、hy3 等 16 个，
 * IDE 独有 auto-chat、nes-1.2、o4-mini 等 9 个。
 * 只取 IDE 那份时网关里国际版只有 14 个模型，取并集后是 29 个。
 * 倍率数值两边一致，仅写法不同（IDE "x0.34" vs CLI "x0.34 credits"）。
 *
 * 早期注释称「CLI UA 只拿到削减表」——那是旧上游的结论，**现已反转**，勿再照抄。
 */
export const WORKBUDDY_V3_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0'
/** 企业模型端点 UA：反过来，拿 IDE 的 UA 会 404。目录面也用它取那份更全的清单。 */
export const WORKBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** 计费面 UA：与对话面不同，是简短的 "CodeBuddy"。 */
export const WORKBUDDY_BILLING_UA = 'CodeBuddy'

// ---------------------------------------------------------------------------
// 超时与错误码
// ---------------------------------------------------------------------------

/** 登录轮询总超时（5 分钟）。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 轮询间隔（1 秒）。 */
export const POLL_INTERVAL_MS = 1000
/**
 * auth/state 请求超时（10 秒）。
 *
 * ⚠️ 原为 5 秒（对齐 IDE），实测**不够**：WorkBuddy（国际版）的 auth/state 发往
 * www.workbuddy.ai，用 Node 的 fetch（undici）连测 6 次稳定耗时 5860–7525 ms，
 * 即每一次都会撞上 5 秒超时，用户侧表现为「无法获取登录地址（Host 网络请求失败）」。
 * 放宽到 10 秒后覆盖上述区间并留出余量。
 * 该常量由两个产品共用：放宽只影响「失败时多等 5 秒」，不会拖慢国内版
 * （copilot.tencent.com 实测数百毫秒即返回）。
 */
export const STATE_REQUEST_TIMEOUT_MS = 10_000
/** 其余控制面请求超时。 */
export const REQUEST_TIMEOUT_MS = 60_000

/** token 尚未就绪（继续轮询）。 */
export const CODE_TOKEN_NOT_READY = 11217
/** 账户信息尚未完成（继续轮询）。 */
export const CODE_ACCOUNT_NOT_READY = 12151

// ---------------------------------------------------------------------------
// 凭据结构与解析
// ---------------------------------------------------------------------------

/**
 * 从登录态文件解析凭据。
 *
 * 登录态文件里的字段是驼峰，网关内部统一用下划线（与 Grok / Codex 的 Key 一致）。
 * 支持嵌套（CLI 实际写盘的形状）与扁平两种，避免用户手工改过文件就认不出来。
 *
 * ⚠️ 昵称与过期时间的兜底顺序照参考实现：login/account 的 nickname 常为空，
 * 真正的昵称只在 access_token 的 JWT 声明里；expiresIn 是相对秒数，需换算。
 */
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
  const uid = account.uid || account.UID || auth.uid || jwtSubject(access_token)
  const domain = auth.domain || account.domain || ''
  // 过期时间：先认文件里的绝对字段，缺失时回落到 JWT 的 exp（同为权威值）
  const expires_at = auth.expiresAt || auth.expires_at || jwtExpiresAtMs(access_token) || 0
  const nickname = account.nickname || jwtNickname(access_token) || ''

  // 少了 uid 或 token 就没法调上游，与其存一个半残的 Key，不如当场说清楚
  if (!access_token || !uid) return null
  const out = { access_token, refresh_token, uid, domain, expires_at }
  if (nickname) out.nickname = nickname
  return out
}

/**
 * 把一次续期/登录返回的 token 数据合并回凭据对象。
 *
 * ⚠️ refreshToken 可能轮换，轮换后**必须写回**，否则下次续期会拿一个已经作废的
 * token 去刷，表现为「续期永远失败、账号被反复冷却」。
 *
 * 过期时间的换算基准取新 access_token 的 JWT `iat`（优先，权威）而不是当前时刻：
 * 相对秒数（expiresIn）是相对**签发时刻**的，拿接收时刻当基准会随网络延迟偏移。
 */
export function applyWorkbuddyTokenData(key, body) {
  const out = { ...key }
  if (body?.accessToken) out.access_token = String(body.accessToken)
  if (body?.refreshToken) out.refresh_token = String(body.refreshToken)
  if (body?.domain) out.domain = String(body.domain)
  if (body?.tokenType) out.token_type = String(body.tokenType)
  if (body?.scope) out.scope = String(body.scope)

  // 绝对 expiresAt 优先；缺失时按相对 expiresIn 换算
  const absolute = body?.expiresAt
  if (absolute !== undefined && absolute !== null && String(absolute).trim() !== '') {
    const raw = String(absolute)
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      out.expires_at = n > 1e12 ? n : n * 1000
    } else {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) out.expires_at = parsed
    }
  } else {
    const expiresIn = Number(body?.expiresIn)
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      const baseMs = jwtIssuedAtMs(out.access_token) ?? Date.now()
      out.expires_at = baseMs + expiresIn * 1000
    } else {
      const fromJwt = jwtExpiresAtMs(out.access_token)
      if (fromJwt !== undefined) out.expires_at = fromJwt
    }
  }

  // 昵称在续期响应里通常没有，缺失时不要覆盖已有值
  const nickname = body?.nickname ? String(body.nickname) : jwtNickname(out.access_token)
  if (nickname) out.nickname = nickname
  return out
}

// ---------------------------------------------------------------------------
// JWT 兜底解析
//
// 只做 base64url 解码，**不验签** —— 这些值只用于展示与续期调度，不作为安全判据。
// ---------------------------------------------------------------------------

/** 解出 JWT payload；非 JWT 或解析失败返回 null。 */
function jwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

/**
 * 从 JWT 的 `exp`（秒）读绝对过期毫秒时间戳。
 *
 * 存在的理由（实测）：CodeBuddy 的 /v2/plugin/auth/token **不返回绝对的
 * expiresAt**，只给相对 expiresIn。若凭据里的 expires_at 为空（历史写入或
 * 后端变更），回落到 JWT 的 exp —— 它同样是权威的过期时刻。
 */
export function jwtExpiresAtMs(token) {
  const p = jwtPayload(token)
  return typeof p?.exp === 'number' && Number.isFinite(p.exp) ? p.exp * 1000 : undefined
}

/** 从 JWT 的 `iat`（秒）读签发毫秒时间戳，用于把相对秒数换成绝对时刻。 */
export function jwtIssuedAtMs(token) {
  const p = jwtPayload(token)
  return typeof p?.iat === 'number' && Number.isFinite(p.iat) ? p.iat * 1000 : undefined
}

/** 从 JWT 读昵称。login/account 响应常不含昵称，真值在这里。 */
export function jwtNickname(token) {
  const p = jwtPayload(token)
  if (!p) return ''
  const v = p.nickname ?? p.preferred_username ?? p.name
  return typeof v === 'string' ? v.trim() : ''
}

/** 从 JWT 的 `sub` 读用户 id；解析失败返回空串。 */
export function jwtSubject(token) {
  const p = jwtPayload(token)
  return typeof p?.sub === 'string' ? p.sub : ''
}

// ---------------------------------------------------------------------------
// 倍率解析
//
// 上游把倍率写成字符串，且**两个端点写法不一致**：
//   /v3/config  给 "x0.79"          （x 在前）
//   企业端点     给 "x0.71 credits"  （x 在前 + 单位后缀）
//   modelPromotions 给 "0.50x"      （x 在后！）
// 只剥前缀的话，带单位的会解析成 NaN → null，一条真实倍率会被误判成「上游没给」。
// ---------------------------------------------------------------------------

/**
 * 倍率的数值形态；无法解析或缺失时返回 null。
 *
 * ⚠️ null 与 0 是**两件事**：0 是「免费」的语义，缺失是「上游没说」。
 * 把缺失塞成 0 等于把一个会扣费的模型标成免费。
 */
export function workbuddyRateValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  // 只取第一段（去掉 " credits" 这类单位后缀），再剥 x/× 前缀或后缀
  const head = s.split(/\s+/)[0]
  const n = Number(head.replace(/^[xX×]/, '').replace(/[xX×]$/, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * 倍率的**原样保留**形态；解析不出时返回 undefined。
 *
 * 刻意不做格式归一化（不把 "x0.71 credits" 改写成 "x0.71"）：上游写法就是事实，
 * 自行换算只是多一层可能算错的地方，前端已有 rateLabel 负责展示层裁剪。
 * 这里唯一的职责是判断「能不能当倍率用」—— 解析不出（上游改了措辞）就当没给。
 *
 * **不回退成 x1**：编造倍率比不显示更糟。
 */
export function normalizeRateText(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return undefined
  return workbuddyRateValue(s) === null ? undefined : s
}

/**
 * 把倍率归一化成 `x<数字>` 展示形态；解析不出时返回 undefined。
 *
 * ⚠️ 与 normalizeRateText 的分工（**不是重复**）：
 *  - 模型的 `credits` 走 normalizeRateText，**原样保留**上游写法（`x0.00 credits`）；
 *  - **促销价走本函数**，因为促销价会被拼进同一个展示格（`x0.17→x0.50`），
 *    而促销的原始写法是 `0.50x`（x 在后）。不归一化就会出现 `x0.17→0.50x`
 *    —— 同一行两种写法，用户读不出这是同一个量。
 *
 * ⚠️ **保留数字串本身，不做数值化**（`0.50x` → `x0.50` 而不是 `x0.5`）：
 * 与参考实现一致，且避免无谓地改动上游给出的字面值。
 */
export function formatRateAsX(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return undefined
  // 能用数值解析才算「给了倍率」；解析不出就不编一个出来
  if (workbuddyRateValue(s) === null) return undefined
  const head = s.split(/\s+/)[0]
  const m = /^[xX×](\d+(?:\.\d+)?)$/.exec(head)
    || /^(\d+(?:\.\d+)?)[xX×]$/.exec(head)
    || /^(\d+(?:\.\d+)?)$/.exec(head)
  return m ? `x${m[1]}` : undefined
}

/**
 * 组合倍率的展示文案：有促销时标出促销价，否则只显示原价。
 *
 * 形态 `x0.17→x0.50`。用箭头而非「（促销 x…）」：这段文案会被拼进模型列表的
 * 窄格里，箭头更短且一眼看出折扣幅度。
 */
export function formatCreditsRate(rate, discounted) {
  if (rate === undefined || rate === null) return discounted
  return discounted !== undefined && discounted !== null ? `${rate}→${discounted}` : rate
}

// ---------------------------------------------------------------------------
// 促销活动（modelPromotions）
//
// 真实结构是**数组**，每项按 modelIds 关联，不是全局对象：
//   [{ kind:'discount', enabled:true, priority:100,
//      discount:{ discountedCredits:'0.50x', factor:0.5 },
//      schedule:{ daily:[{start:'23:00',end:'7:50'}], timezone:'Asia/Shanghai' },
//      modelIds:['glm-5.2'] }]
//
// ⚠️ 必须本地推算时段，不能只看 enabled：enabled 只表示活动启用，是否**此刻**
// 打折由 schedule 决定。实测 glm-5.2 有两条互补活动（夜间 0.50x、白天只有角标），
// 不看时段就会全天显示夜间折扣价，用户按折扣价预期、实际被按原价计费。
// ---------------------------------------------------------------------------

/** 解析 `HH:MM`（容忍不补零，如 `7:50`）为当日分钟数；非法返回 undefined。 */
function parseHHMM(value) {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}

/** 取指定时区「当前墙上时间」的当日分钟数。用 Intl 而非硬编码 +8。 */
function zonedMinutes(now, timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'Asia/Shanghai'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now)
    const h = Number(parts.find((p) => p.type === 'hour')?.value)
    const m = Number(parts.find((p) => p.type === 'minute')?.value)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined
  } catch {
    // 时区字符串非法（上游改了格式）：返回 undefined，由调用方按「不误杀」处理
    return undefined
  }
}

/** 活动是否带任何时间窗口（每日时段或有效期）。 */
function hasTimeWindow(schedule) {
  return (Array.isArray(schedule.daily) && schedule.daily.length > 0)
    || schedule.validFrom !== undefined || schedule.validUntil !== undefined
}

/** 活动在 now 是否生效。 */
function promotionActiveNow(item, now) {
  const raw = item.schedule
  if (typeof raw !== 'object' || raw === null) return true
  const schedule = raw

  const from = typeof schedule.validFrom === 'string' ? Date.parse(schedule.validFrom) : Number.NaN
  const until = typeof schedule.validUntil === 'string' ? Date.parse(schedule.validUntil) : Number.NaN
  if (Number.isFinite(from) && now.getTime() < from) return false
  if (Number.isFinite(until) && now.getTime() >= until) return false

  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true
  const minutes = zonedMinutes(now, schedule.timezone)
  // 时区不可解析时不误杀：宁可多显示一次折扣，也不要让活动凭空消失
  if (minutes === undefined) return true
  return schedule.daily.some((slot) => {
    if (typeof slot !== 'object' || slot === null) return false
    const start = parseHHMM(slot.start)
    const end = parseHHMM(slot.end)
    if (start === undefined || end === undefined) return false
    // 支持跨零点（如 23:00–7:50）
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  })
}

/** 读促销项的 priority；缺失或非法时按 0（最低）。 */
function priorityOf(item) {
  if (typeof item !== 'object' || item === null) return 0
  const p = item.priority
  return typeof p === 'number' && Number.isFinite(p) ? p : 0
}

/**
 * 从 `data.modelPromotions` 提取「模型 id → **此刻生效的**促销价」映射。
 *
 * 四个必须处理的退化情形：时段未到/已过、有效期已过、enabled:false、同模型多活动
 * （取 priority 最高者）。
 *
 * ⚠️ **factor: 0 是「免费」而非「活动已结束」**：实测 hy4-preview 的夜间活动是
 * `{discountedCredits:'0x', displayMode:'replace', factor:0}` —— 它真的免费。
 * 把 `0x` 当哨兵丢弃会让「夜间免费」永远不显示。**真正的「已结束」由有效期表达**。
 * 作为防御：**无任何时间窗口**的 factor:0 仍按「已结束占位」跳过 ——
 * 免费额度必然是限时的，没有窗口的 0x 更可能是遗留占位。
 */
export function parsePromotions(record, now = new Date()) {
  const result = new Map()
  const chosen = new Map() // id -> 已写入的 priority
  const promotions = record?.modelPromotions
  if (!Array.isArray(promotions)) return result

  // 按 priority 升序写入，使高 priority 覆盖低 priority
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b))
  for (const item of sorted) {
    if (typeof item !== 'object' || item === null) continue
    if (item.enabled === false) continue
    if (!promotionActiveNow(item, now)) continue
    const discount = item.discount
    if (typeof discount !== 'object' || discount === null) continue

    const factor = typeof discount.factor === 'number' ? discount.factor : undefined
    const windowed = typeof item.schedule === 'object' && item.schedule !== null
      && hasTimeWindow(item.schedule)

    let rate
    if (factor === 0) {
      if (!windowed) continue
      rate = '免费'
    } else {
      // 归一化成 x<数字>：促销价要与原价拼进同一格（x0.17→x0.50），
      // 而促销原始写法是 0.50x，不归一化会拼出 x0.17→0.50x 这种混合写法
      rate = formatRateAsX(discount.discountedCredits)
      // 归一化后仍是 x0 说明是无 factor 的 0x 占位，同样跳过
      if (rate === 'x0') continue
    }
    if (rate === undefined) continue

    const modelIds = item.modelIds
    if (!Array.isArray(modelIds)) continue
    const priority = priorityOf(item)
    for (const id of modelIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      const prev = chosen.get(id)
      if (prev !== undefined && prev > priority) continue
      chosen.set(id, priority)
      result.set(id, rate)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 模型解析与过滤
// ---------------------------------------------------------------------------

/** 已知模型 ID → 展示名。仅在上游未下发 name 时兜底。 */
const MODEL_DISPLAY_NAMES = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'hy4-preview': 'Hy4 Preview',
  'hy4-preview-x': 'Hy4 Preview X',
  hy3: 'Hy3',
  'hy3-x': 'Hy3 X',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5v-turbo': 'GLM-5V Turbo',
  'kimi-k3-1': 'Kimi K3-1',
  'kimi-k2.7': 'Kimi K2.7',
  'kimi-k2.6': 'Kimi K2.6',
  'minimax-m3': 'MiniMax M3'
}

/** 模型 ID → 人类可读展示名；未知回退为 ID 本身。 */
export function displayNameForModel(id) {
  return MODEL_DISPLAY_NAMES[id] ?? id
}

/**
 * 是否为「自动选择」类的内部别名。
 *
 * 实测企业模型端点同时下发 `auto`（展示名 Auto）与 `default`（展示名 Default），
 * 两者都不指向具体模型 —— 服务端自行挑一个后端。
 *
 * ⚠️ **只打标注，不过滤**（与参考实现的关键差异）：参考项目那是客户端模型
 * 选择器，藏掉它们免得用户困惑；而本网关的 provider.models 是路由表，且上游
 * **确实接受**这两个名字（auto 的 description 自己写着「积分倍率随之浮动」）。
 * 过滤掉等于让点名 auto 的请求直接 404，把上游真实存在的入口凭空删掉。
 *
 * 国际版还有 `default-model` / `fast-model` 等抽象别名，但那些**被 craft agent
 * 引用**（是官方推荐的入口），故只按这两个字面量判定，**不做前缀匹配** ——
 * 前缀匹配会误伤 `default-model`。
 */
export function isAutoSelectAlias(id) {
  return id === 'auto' || id === 'default'
}

/**
 * 判断一条模型记录是否为「可供用户选择的对话模型」。
 *
 * 依据来自真实 /v3/config 响应与调用实测，排除四类非对话/不可用模型：
 *  - 补全/NES 专用：id 以 `nes-` / `completion-` / `codewise-` 开头，或带
 *    `supportsExtra` 标记。codewise-default-model-v2 实测返回
 *    `code 11102 model service info not found`，即后端未开放；
 *  - 输出上限过小的（≤256 tokens 的都是补全用途，对话模型普遍 ≥24000）；
 *  - 带 `text-to-image` 标签的生成式模型（如 hunyuan-image-alpha）。
 *
 * ⚠️ **本函数只用于打标注，不用于过滤**（这是与参考实现的关键差异）：
 * 参考项目那是**客户端模型选择器**，把非对话模型藏掉是对的；而本网关的
 * `provider.models` 是**路由表** —— matchProvider 靠它匹配、生图路由也走它。
 * 在这里过滤等于让那些模型彻底不可路由（点名即 404），把上游真实存在的
 * 能力凭空删掉。故保留全量并标 `chat: false`，由展示层决定怎么淡化。
 */
export function isChatModel(id, meta) {
  if (typeof id !== 'string' || id.length === 0) return false
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.supportsExtra === true) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  const tags = meta?.tags
  if (Array.isArray(tags) && tags.some((tag) => tag === 'text-to-image')) return false
  return true
}

/** 从一条原始记录取模型 id，兼容多种键名（大写、下划线、name 兜底）。 */
export function modelIdOf(raw) {
  if (!raw || typeof raw !== 'object') return ''
  const id = raw.id || raw.ModelName || raw.model_name || raw.name
  return id ? String(id) : ''
}

/**
 * 把上游一条模型记录压成网关内部使用的形状（snake_case，前端已按此渲染）。
 *
 * 上游这两个端点给的信息很全（实测每条 20+ 字段），全丢掉只留 id 是浪费：
 * name 是人看的名字、vendor 是厂商、maxInputTokens/maxOutputTokens 决定调用方
 * 要不要开 1M、supportsImages/Reasoning/ToolCall 决定能不能用多模态和工具。
 * 这些都直接来自上游，展示出来即可，不需要网关自己编。
 *
 * ⚠️ 每个可选字段**只在「上游确实给了」时才写**。给不了就不写，前端按缺字段
 * 渲染 —— 不能拿默认值假装上游说过这句话。
 */
export function normalizeModel(raw, providerName) {
  const id = modelIdOf(raw)
  if (!id) return null
  const ctx = raw.contextWindow || {}
  const out = {
    id,
    owned_by: raw.vendor || providerName
  }
  // 倍率缺失就是缺失，不塞 0（0 是「免费」的语义）
  const rateText = normalizeRateText(raw.credits)
  if (rateText !== undefined) out.rate = rateText
  if (raw.name) out.name = String(raw.name)
  else out.name = displayNameForModel(id)
  if (raw.descriptionZh) out.description = String(raw.descriptionZh)
  else if (raw.descriptionEn) out.description = String(raw.descriptionEn)
  if (raw.vendor) out.vendor = String(raw.vendor)
  if (raw.iconUrl) out.icon = String(raw.iconUrl)
  else if (raw.iconUrl_en) out.icon = String(raw.iconUrl_en)
  if (Number.isFinite(Number(raw.maxInputTokens))) out.max_input = Number(raw.maxInputTokens)
  if (Number.isFinite(Number(raw.maxOutputTokens))) out.max_output = Number(raw.maxOutputTokens)
  // 上下文窗口：上游优先给 contextWindow.defaultLength，但实测**几乎不下发**
  // （国内 0/33 条有），真正给的是 maxInputTokens（31/33）。
  // 两者都不给时才留空 → 前端显示「未知」。宁可说不知道，也不用网关的猜测
  // 冒充上游事实。
  const ctxLen = Number(ctx.defaultLength)
  const maxIn = Number(raw.maxInputTokens)
  if (Number.isFinite(ctxLen) && ctxLen > 0) out.context = Math.floor(ctxLen)
  else if (Number.isFinite(maxIn) && maxIn > 0) out.context = Math.floor(maxIn)
  if (raw.supportsImages !== undefined) out.images = Boolean(raw.supportsImages)
  if (raw.supportsReasoning !== undefined) out.reasoning = Boolean(raw.supportsReasoning)
  if (raw.supportsToolCall !== undefined) out.tools = Boolean(raw.supportsToolCall)
  if (raw.onlyReasoning !== undefined) out.thinking_only = Boolean(raw.onlyReasoning)
  if (raw.isDefault) out.is_default = true
  if (Array.isArray(raw.tags) && raw.tags.length) out.tags = raw.tags.map(String)
  return out
}

/**
 * 解析 /v3/config 与「企业模型端点」共用的响应体，得到模型清单。
 *
 * 两者结构一致（`data.models` + `data.agents` + `data.productFeaturesConfig`），
 * 只是 agent 名不同（`cli` = 企业端点，`craft` = /v3/config）。
 *
 * 解析策略（顺序即优先级）：
 *  1. **主对话 agent 引用的模型** —— 输入框里可选的模型，排在最前；
 *  2. **data.models 中剩余的模型** —— 国际版的 craft 只引用 5 个抽象别名，
 *     其余可用模型只出现在 data.models 里；若只取 craft，这些模型会消失；
 *  3. **试用模型**（productFeaturesConfig.ModelTrialBanner）—— 例如国际版的
 *     hy4-preview：既不在 craft 列表也不在 data.models，仅由试用横幅下发，
 *     但实测可正常调用，故一并加入。
 *
 * ⚠️ **不过滤任何模型，只打标注**（这是与参考实现的关键差异）。
 * 本网关的 provider.models 是**路由表**（matchProvider 靠它匹配、生图也走它），
 * 删掉条目等于让上游真实存在的能力变得不可路由（点名即 404）。故：
 *  - 非对话模型（补全 / 生图）→ 保留 + `chat: false`；
 *  - 内部别名（auto / default）→ 保留 + `auto_select: true`。
 * 由展示层决定怎么淡化，路由层始终能点名。
 */
export function parseModelsFromConfig(body, providerName) {
  if (!body || typeof body !== 'object') return []
  const data = body.data
  if (!data || typeof data !== 'object') return []

  // data.models: id → 远端声明的模型元数据
  const metaById = new Map()
  if (Array.isArray(data.models)) {
    for (const model of data.models) {
      const id = modelIdOf(model)
      if (id) metaById.set(id, model)
    }
  }

  // 促销折扣是**独立于 data.models 的全局活动表**，先解析成 id → 促销价映射
  const promotions = parsePromotions(data)

  // 收集**全部** agent 引用的 id，用于标记 agent_referenced
  const agentReferencedIds = new Set()
  if (Array.isArray(data.agents)) {
    for (const agent of data.agents) {
      if (!agent || typeof agent !== 'object') continue
      if (!Array.isArray(agent.models)) continue
      for (const id of agent.models) if (typeof id === 'string') agentReferencedIds.add(id)
    }
  }

  const parsed = []
  const seen = new Set()
  const push = (id, { force = false } = {}) => {
    if (typeof id !== 'string' || id.length === 0) return
    if (seen.has(id)) return
    seen.add(id)
    const meta = metaById.get(id)
    const model = normalizeModel(meta || { id }, providerName) || { id, owned_by: providerName }
    model.id = id
    // 标注而非过滤：展示层据此淡化非对话模型与内部别名，路由层仍可点名
    if (!isChatModel(id, meta)) model.chat = false
    if (isAutoSelectAlias(id)) model.auto_select = true
    const discounted = promotions.get(id)
    if (discounted !== undefined) model.rate_discounted = discounted
    if (agentReferencedIds.has(id) || force) model.agent_referenced = true
    parsed.push(model)
  }

  // 1. 主对话 agent 引用的模型优先。
  //    两个端点用不同的 agent 名承载「输入框可选的模型」，取先出现的那个。
  for (const agentName of PREFERRED_AGENT_NAMES) {
    const agents = Array.isArray(data.agents) ? data.agents : []
    const agent = agents.find((a) => a && typeof a === 'object' && a.name === agentName)
    if (!agent) continue
    if (Array.isArray(agent.models)) for (const id of agent.models) push(id)
    break
  }

  // 2. 补齐 data.models 里其余模型
  for (const id of metaById.keys()) push(id)

  // 3. 追加试用模型（试用横幅本身就是「服务端推荐可用」的信号）
  for (const id of trialModelIds(data)) push(id, { force: true })

  return parsed
}

/** 承载「可选对话模型」清单的 agent 名，按优先级排列。 */
export const PREFERRED_AGENT_NAMES = ['cli', 'craft']

/** 从 productFeaturesConfig.ModelTrialBanner 提取试用模型 id。 */
function trialModelIds(data) {
  const features = data?.productFeaturesConfig
  if (!features || typeof features !== 'object') return []
  const banner = features.ModelTrialBanner
  if (!banner || typeof banner !== 'object') return []
  const banners = banner.banners
  if (!Array.isArray(banners)) return []
  const ids = []
  for (const item of banners) {
    if (!item || typeof item !== 'object') continue
    const target = item.targetModelId
    if (typeof target === 'string' && target.length > 0) ids.push(target)
  }
  return ids
}

// ---------------------------------------------------------------------------
// 多 realm 合并
// ---------------------------------------------------------------------------

/**
 * 合并多个 realm 的模型清单与倍率。
 *
 * 同一个 id 出现在两个 realm 时，只有倍率也相同才算同一个模型 —— 倍率不同
 * 说明扣费口径不同，必须当成两个模型，否则调用方点名 glm-5.3 时根本不知道
 * 网关会拿哪一个去扣费。倍率不同的那个给非主 realm 加 realm 后缀，并记下
 * 别名到上游 id 的映射，转发时再换回去。
 *
 * 元数据按「先到先得，后来者只补空缺」合并：清单以给得更全的那个 realm 为准。
 * 谁先来由排序决定（模型最多的 realm 优先，并列时国内优先）。
 */
export function mergeWorkbuddyCatalogs(entries) {
  // 先过滤再排序：坏条目混进来时，排序比较器里就会先炸。
  // 注意只丢「结构不对」的条目，空清单要留下 —— 它说明这个 realm 查过了、
  // 确实没有模型，与「没查过」不是一回事。
  const order = [...(entries || [])]
    .filter((e) => e && Array.isArray(e.ids))
    .sort((a, b) => (b.ids.length - a.ids.length) || (a.realm === 'cn' ? -1 : 1))

  const rates = {}
  const models = []
  const upstream = {}
  const realmById = {} // 对外 id -> realm，转发时用来挑对账号
  const byId = new Map()

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
        // 已被别的 realm 占用：倍率一致就并成同一个模型，只把缺的元数据补上
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
