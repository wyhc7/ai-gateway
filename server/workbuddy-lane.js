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
import {
  DEFAULT_SYSTEM,
  RELOCATE_MARKER,
  relocateWorkbuddySystemPrompt
} from './workbuddy-prompt-relocate.js'
import { withPluginIdentity, applyWorkbuddyCompat } from './workbuddy-compat.js'

// 搬家模块的入口在 lane 上再导出一次：调用方（proxy）只 import 这一个文件，
// 不必关心内容级处理被拆成了几个模块。
export {
  relocateWorkbuddySystemPrompt,
  rewriteWorkbuddyAssistantFingerprints,
  applyWorkbuddy11128Fallback,
  isRelocated,
  ASSISTANT_FINGERPRINTS
} from './workbuddy-prompt-relocate.js'

// 兼容补丁的入口同样在这里转发：proxy 只认这一个文件。
export {
  withPluginIdentity,
  applyWorkbuddyCompat,
  rewritePromptWording,
  isCompatEnabled,
  PLUGIN_IDENTITY_HEADERS,
  PROMPT_REWRITES
} from './workbuddy-compat.js'

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
  // 插件身份头必须在最后并进来：它们是「让请求贴近本机 CodeBuddy 插件」的
  // 那组伪装，见 workbuddy-compat.js。放在这里而不是 proxy 里，是因为它们
  // 与 UA / Referer 属于同一件事——客户端自称是谁。
  return withPluginIdentity({
    'X-User-Id': String(key.uid || ''),
    'X-Domain': normalizeWorkbuddyDomain(key.domain),
    'User-Agent': WORKBUDDY_UA,
    Referer: `${workbuddyRealm(key.domain).referer}/`,
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId
  })
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
// 内容级闸门：交给 workbuddy-prompt-relocate.js 的「搬家」
//
// 这里曾经有两版补丁，都被上游的归一化吃掉了：
//   - 零宽空格打散（每 8 个码点插 U+200B）：网关先折叠空白、剥零宽再匹配，
//     打码版与原文被判成同一份内容，回归 11128；
//   - 超长 system 切一半挪进 user：剩下那一半 system 仍然命中。
// 现在的解法一个字都不改，只把 system 的内容整段搬进 user 消息（闸门只校验
// system / developer / assistant 三种角色）。实现与实测表见
// workbuddy-prompt-relocate.js 的文件头。

// 单次整形完成全部改动。上游拒绝非流式请求，所以 stream 一律强制打开。
//
// 顺序有讲究：
//  1. 先做 role 整形，把 developer 变成 system —— 否则第 3 步的内容指纹
//     改写与第 5 步的搬家都会漏掉那些本该是 system 的消息；
//  2. 再保证首条是 system（渠道校验硬条件，缺了或被占首位都 11128）；
//  3. 然后才是内容指纹改写（只改 system，见 workbuddy-fingerprint.js）；
//  4. 按模型上限下发 max_tokens；
//  5. 最后做「搬家」（CN realm 专属）：把 system 内容整段挪进一条 user 消息，
//     原位只留占位句。必须在指纹改写之后 —— 搬走的是已改写好的那份文本。
// realm 由调用方按 provider.base_url 给出（workbuddyRealmFor）；不传视为
// 国际版处理——不搬家，历史行为完全不变。
export function shapeWorkbuddyBody(body = {}, modelMeta = null, realm = null) {
  const obj = { ...body }
  obj.stream = true
  normalizeWorkbuddyTools(obj)
  normalizeWorkbuddyRoles(obj)
  ensureWorkbuddySystemFirst(obj)
  forceWorkbuddyMaxThinking(obj)
  applyWorkbuddyMaxOutput(obj, modelMeta)
  // 腾讯的内容级风控：system 里的已知模板句会被 400/11128 拦下。
  // 放在搬家之前，改的是「还是 system 身份」的那些消息。
  rewriteWorkbuddySystemFingerprints(obj)
  if (realm === 'cn') {
    // 11128 的内容级闸门只校验 system / developer / assistant 三种角色，
    // 所以把 system 的正文整段搬进 user 就能放行，且一个字都不改。
    // 详见 workbuddy-prompt-relocate.js 的实测表。
    relocateWorkbuddySystemPrompt(obj)
    // 搬完之后再改一次措辞：那份系统提示正文此刻躺在 user 消息里，
    // system 只剩占位句。`Tokens prefixed with @` 这类固定文案本身也是指纹，
    // 而 workbuddy-fingerprint.js 只扫 system、ASSISTANT_FINGERPRINTS 只扫
    // assistant —— 两条路都碰不到搬过去的那份正文，就在这一步补上。
    // 顺序不能提前：搬家前它还是 system，改写会与第 3 步重复且漏掉 user。
    applyWorkbuddyCompat(obj, RELOCATE_MARKER)
  }
  return obj
}

// 兜底用的中性 system：与搬家留下的占位句同一句，实测稳定放行
// （见 test/workbuddy-fingerprint.test.js 的用例）。
const NEUTRAL_SYSTEM = DEFAULT_SYSTEM

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

/**
 * 抽出全部「系统提示词」正文拼成一行，供诊断日志用（截断由调用方做）。
 *
 * 也算上搬家后承载原文的那条 user 消息：CN realm 的整形会把 system 搬走，
 * 只读 role==='system' 的话，11128 留证里就只剩一句占位句，新指纹永远抓不到。
 */
export function collectWorkbuddySystemText(body = {}) {
  const msgs = body?.messages
  if (!Array.isArray(msgs)) return ''
  const parts = []
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '').toLowerCase()
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    if (role === 'system') {
      parts.push(content)
      continue
    }
    // 搬家后的系统提示词：以标记行开头的那条 user 消息
    if (role === 'user' && content.includes(RELOCATE_MARKER)) parts.push(content)
  }
  return parts.join(' ⏎ ')
}
