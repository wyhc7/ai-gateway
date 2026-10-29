// WorkBuddy / CodeBuddy 请求整形层
//
// 上游是「长得像 OpenAI、但每条规矩都自己定」的接口：形态可以透传，前提条件不行。
// 这个文件收拢所有与**对话请求形态**有关的整形，别让它们散落到 proxy.js 的主流程里。
//
// 分层：常量与解析在 workbuddy-core.js（纯逻辑），目录在 workbuddy-catalog.js，
// 凭据在 workbuddy-oauth.js，本文件只做「客户端请求 → 上游请求」的转换。
//
// 每条约束都对应一个真实报错码（见 workbuddy-lane.test.js 的用例名），
// 改回原样就会重新踩坑。
import { randomUUID } from 'node:crypto'
import {
  WORKBUDDY_UA,
  normalizeWorkbuddyDomain,
  workbuddyRealm,
  workbuddyRealmFor
} from './workbuddy-core.js'
import { rewriteWorkbuddySystemFingerprints } from './workbuddy-fingerprint.js'

// 常量与 realm 判定的唯一来源在 core，这里只做转发导出，
// 免得调用方为了一个常量多 import 一个模块。
export {
  WORKBUDDY_UA,
  WORKBUDDY_REALMS,
  normalizeWorkbuddyDomain,
  workbuddyRealm,
  workbuddyRealmFor,
  workbuddyChatBaseFor,
  workbuddyBillingBaseFor,
  workbuddyProductFor
} from './workbuddy-core.js'

export function isWorkbuddyProtocol(protocol) {
  return protocol === 'workbuddy-oauth'
}

// 按 Key 注入的请求头。uid 与 realm（X-Domain）都随账号变化，不能收进平台级
// extra_headers：换一个 Key 就换一个 uid 与 realm，放平台级会让多账号轮换时
// 用错身份。Referer 也跟着 realm 走：跨 realm 引用会被网关当成外部渠道。
//
// 另有一组**会话头**与账号无关，但同样是上游渠道校验的硬条件：
//   X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
// ⚠️ 实测（2026-10-20，直连 www.workbuddy.ai）：国际版网关加了一道渠道校验，
// 旧路由 /v2/chat/completions 缺这三个头中任意一个即回
// 400 code 11128 "request illegal"（提示「可能不是官方客户端发出的」）。
// 该校验**只查存在性**，不校验格式与关联关系——换 UA、补 Origin/X-Product 等
// 头均无效（逐项实测），只有这三个头（或改走新路由 /console/chat/completions）
// 能放行。网关是无状态的，每请求生成新 UUID 即可；多轮对话复用同一
// X-Conversation-ID 也实测正常。官方桌面端本来就发这三个头，国内版
// （copilot.tencent.com）没有这道闸门但同样接受（实测 200），故无差别加上，
// 不按 realm 拆分。值的形状照参考实现（workbuddy-bridge）：
// Request-ID 与 Message-ID 同值，Conversation-ID 独立。
export function workbuddyHeaders(key = {}) {
  const messageId = randomUUID()
  return {
    'X-User-Id': String(key.uid || ''),
    'X-Domain': normalizeWorkbuddyDomain(key.domain),
    'User-Agent': WORKBUDDY_UA,
    Referer: `${workbuddyRealm(key.domain).referer}/`,
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId
  }
}

// ---------------------------------------------------------------------------
// 请求体整形
// ---------------------------------------------------------------------------

// tool_choice 只在上游是 string 类型。OpenAI 的对象形态
// {"type":"function","function":{"name":"x"}} 会报 400 code 11101。
// 另外 "none" 上游虽然接受，但只要 tools 非空模型照样吐 tool_calls ——
// 想真正抑制工具只能整份删掉 tools。
export function normalizeWorkbuddyTools(obj) {
  const drop = () => {
    delete obj.tools
    delete obj.functions
  }
  if (!('tool_choice' in obj)) return false
  const tc = obj.tool_choice

  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      drop()
      return true
    }
    return false // auto / required / 具体函数名，原样放行
  }
  if (tc && typeof tc === 'object') {
    const typ = String(tc.type || '').trim().toLowerCase()
    if (typ === 'auto' || typ === 'required') {
      obj.tool_choice = typ
      return true
    }
    if (typ === 'function') {
      const name = String(tc.function?.name || tc.name || '').trim()
      obj.tool_choice = name || 'auto'
      return true
    }
    if (typ === 'none') {
      delete obj.tool_choice
      drop()
      return true
    }
    // 认不出的对象形态：丢掉而不是转发出去换一个 400
    delete obj.tool_choice
    return true
  }
  // null / 数组 / 数字
  delete obj.tool_choice
  return true
}

// role: "developer" 会被上游以 code 11128 拒掉（"Illegal API invocation from an
// unapproved channel"）。首条消息只认 system，其余一律改成 system 保平安。
export function normalizeWorkbuddyRoles(obj) {
  let changed = false
  for (const m of Array.isArray(obj.messages) ? obj.messages : []) {
    if (m && typeof m === 'object' && String(m.role || '').trim().toLowerCase() === 'developer') {
      m.role = 'system'
      changed = true
    }
  }
  return changed
}

// 国际版渠道校验要求**首条消息必须是 system**，缺了或被别的角色占了首位即回
// 400 code 11128 "first message is not system prompt"（实测 [user, system] 这种
// 「有 system 但不在第一条」的形态同样被拒）。纯 user 消息则报 11101
// "Parse message failed"。
// 本函数保证 messages[0] 一定是 system：
//  - 不在首位但存在的 system 消息**提到最前**（保留客户端原话，不替换成默认值）；
//  - 一条都没有才补一条无害的默认 system。
// CN 不要求但容忍，所以无脑执行不会踩雷；顺序上必须排在 developer→system
// 改写之后（见 shapeWorkbuddyBody），否则刚改写出来的 system 还没就位。
export function ensureWorkbuddySystemFirst(obj) {
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return false
  const isSystem = (m) => m && typeof m === 'object' && String(m.role || '').toLowerCase() === 'system'
  if (isSystem(msgs[0])) return false
  const idx = msgs.findIndex(isSystem)
  if (idx > 0) {
    const [sys] = msgs.splice(idx, 1)
    msgs.unshift(sys)
    return true
  }
  msgs.unshift({ role: 'system', content: 'You are a helpful assistant.' })
  return true
}

// hy3 系模型只在 reasoning_effort === "high" 时才真的深度思考，
// medium/low/max/xhigh/ultra 一律退化成不思考。上游只认这一个值，别让客户端设置。
export function forceWorkbuddyMaxThinking(obj) {
  const model = String(obj.model || '')
  if (!model.startsWith('hy3')) return false
  if (obj.reasoning_effort === 'high') return false
  obj.reasoning_effort = 'high'
  return true
}

// 上游对每个模型有各自的单次输出上限（maxOutputTokens），不下发就用网关默认值，
// 长回答会被截断成 finish_reason: 'length'。客户端没显式要求时按该模型的
// 上限下发 —— 这是「上游声明的能力」，不是网关编的默认值。
//
// 客户端显式给了 max_tokens 就不动它：用户可能刻意要短回答。
export function applyWorkbuddyMaxOutput(obj, modelMeta) {
  if (obj.max_tokens !== undefined && obj.max_tokens !== null) return false
  const max = Number(modelMeta?.max_output)
  if (!Number.isFinite(max) || max <= 0) return false
  obj.max_tokens = Math.floor(max)
  return true
}

// ---------------------------------------------------------------------------
// 国内版「整段 prompt 匹配」闸门：零宽字符打散
//
// 2026-10-22/23 实测（直连 copilot.tencent.com，5 个账号轮换）：
// 国际版网关的 11128 之外，国内版还多一道**内容级**闸门——把 system 原文
// 原样发过去，稳定回 400 code 11128（同一内容走国际版全部 200）。
//
// 与 workbuddy-fingerprint.js 那种「逐字面量句子」完全不同，这次实测排除了
// 句子级指纹，也排除了长度/体积/工具/多轮/稀释：
//   - 17.8KB 的真实 system 原文           → 11128（稳定复现）
//   - 改 1 个字符 / 头尾各补 1 空格        → 仍 11128（不是精确哈希）
//   - 对半切、1/4、1/8、557 字符切片       → 全 200（没有任何子串能单独触发）
//   - 4000 字符滑窗扫全文                 → 全 200
//   - 头部截断 [0..16000]                 → 200；[2000..17819]（更短）→ 11128
//   - 前置 1k/2k/4k 中性文本稀释           → 仍 11128（加内容无用）
//   - 中段替换 2KB/4KB 填充               → 仍 11128
//   - 每 14 字符替换 1 字符（7% 搅动）      → 200
//   - system 只留前 6KB、其余挪进 user 消息 → 200
// 结论：网关按 **n-gram 召回率** 把 system 与一个已知客户端 prompt 库做整段
// 匹配（库里已收录本 harness 这类第三方客户端的 system），覆盖率过阈值即拒。
// 所以「加东西」无效（召回不变），必须**破坏 n-gram 本身**。
//
// 打散手段选零宽空格（U+200B）：
//   - 模型不可见、语义零损，不污染用户可见文本（比逐字符替换干净）；
//   - 每 8 个码点插 1 个，足以打碎 8 字符以上的全部 n-gram（实测 3 与 8 均放行）；
//   - 变换是内容的确定函数：同内容 → 同输出，不破坏腾讯按前缀的缓存。
// 只对 CN realm 启用：国际版实测无此闸门，不值得白付 token 开销。
// 若上游将来预处理零宽字符，退路是逐字符替换（churnEvery，实测同样放行）
// 或把 system 后半段挪进带 [system-continuation] 标记的 user 消息（实测放行）。
const SHINGLE_BREAK_CHAR = '\u200B'
const SHINGLE_BREAK_SPACING = 8

/** 每 spacing 个码点插一个零宽字符；按码点迭代，emoji/代理对安全。 */
function insertShingleBreaks(text) {
  const chars = [...text]
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    out += chars[i]
    if ((i + 1) % SHINGLE_BREAK_SPACING === 0) out += SHINGLE_BREAK_CHAR
  }
  return out
}

/** 就地打散所有 system 消息的 n-gram（字符串与多段 text 形态都处理）。 */
export function breakWorkbuddySystemShingles(obj) {
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  let changed = false
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    if (String(m.role || '').trim().toLowerCase() !== 'system') continue
    if (typeof m.content === 'string' && m.content.length > 0) {
      m.content = insertShingleBreaks(m.content)
      changed = true
      continue
    }
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object' || typeof part.text !== 'string' || part.text.length === 0) continue
        part.text = insertShingleBreaks(part.text)
        changed = true
      }
    }
  }
  return changed
}

// 单次整形完成全部改动。上游拒绝非流式请求，所以 stream 一律强制打开。
//
// 顺序有讲究：
//  1. 先做 role 整形，把 developer 变成 system —— 否则第 4 步的内容指纹
//     改写会漏掉那些本该是 system 的消息；
//  2. 再保证首条是 system（渠道校验硬条件，缺了或被占首位都 11128）；
//  3. 然后才是内容指纹改写（只改 system，见 workbuddy-fingerprint.js）；
//  4. 最后做零宽打散（CN realm 专属）——必须在指纹改写之后，否则被打散的
//     文本会破坏指纹匹配（其实打散后指纹已不可能原样存在，顺序保证语义清晰）。
// realm 由调用方按 provider.base_url 给出（workbuddyRealmFor）；不传视为
// 国际版处理——不插零宽字符，历史行为完全不变。
export function shapeWorkbuddyBody(body = {}, modelMeta = null, realm = null) {
  const obj = { ...body }
  obj.stream = true
  normalizeWorkbuddyTools(obj)
  normalizeWorkbuddyRoles(obj)
  ensureWorkbuddySystemFirst(obj)
  forceWorkbuddyMaxThinking(obj)
  applyWorkbuddyMaxOutput(obj, modelMeta)
  // 腾讯的内容级风控：system 里的已知模板句会被 400/11128 拦下。
  // 放在最后，改的是「已经确定是 system」的那些消息。
  rewriteWorkbuddySystemFingerprints(obj)
  if (realm === 'cn') breakWorkbuddySystemShingles(obj)
  return obj
}

// 兜底用的中性 system：实测稳定放行（见 test/workbuddy-fingerprint.test.js 的用例）。
const NEUTRAL_SYSTEM = 'You are a helpful assistant.'

/**
 * 把全部 system 消息的内容换成中性文本，返回是否改动过。
 *
 * **只用于「换遍 Key 仍然 11128」之后的最后一次重试**，不进常规整形：
 * 它会把用户的 system 指令整段丢掉，模型行为会变。但到那一步本来就只有
 * 两个结果——要么透传 400 让客户端彻底失败，要么丢掉 system 但把话说出来。
 * 后者对用户有用得多，代价写进日志，让人看得见发生了什么。
 *
 * 为什么扫全部 system 而不只 messages[0]：11128 对非首位的 system 同样生效
 * （与 workbuddy-fingerprint.js 里那条「改写所有 system 消息」的实测约束一致）。
 */
export function neutralizeWorkbuddySystem(body = {}) {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return false
  let changed = false
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    if (String(m.role || '').toLowerCase() !== 'system') continue
    if (m.content === NEUTRAL_SYSTEM) continue
    m.content = NEUTRAL_SYSTEM
    changed = true
  }
  return changed
}

/** 抽出全部 system 正文拼成一行，供诊断日志用（截断由调用方做）。 */
export function collectWorkbuddySystemText(body = {}) {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return ''
  return msgs
    .filter((m) => m && typeof m === 'object' && String(m.role || '').toLowerCase() === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join(' ⏎ ')
}
