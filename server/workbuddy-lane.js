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

// 按 Key 注入的请求头。三个值都随账号变化，不能收进平台级 extra_headers：
// 换一个 Key 就换一个 uid 与 realm，放平台级会让多账号轮换时用错身份。
// Referer 也跟着 realm 走：跨 realm 引用会被网关当成外部渠道。
export function workbuddyHeaders(key = {}) {
  return {
    'X-User-Id': String(key.uid || ''),
    'X-Domain': normalizeWorkbuddyDomain(key.domain),
    'User-Agent': WORKBUDDY_UA,
    Referer: `${workbuddyRealm(key.domain).referer}/`
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

// Global 账号收到纯 user 消息会报 11101 "Parse message failed"。补一条无害的
// system 消息把两边路径统一 —— CN 不要求但容忍，所以无脑补不会踩雷。
export function ensureWorkbuddySystemMessage(obj) {
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return false
  if (msgs.some((m) => m && String(m.role || '').toLowerCase() === 'system')) return false
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

// 单次整形完成全部改动。上游拒绝非流式请求，所以 stream 一律强制打开。
//
// 顺序有讲究：
//  1. 先做 role 整形，把 developer 变成 system —— 否则第 4 步的内容指纹
//     改写会漏掉那些本该是 system 的消息；
//  2. 再补 system 消息，保证 Global 账号不会拿到纯 user 的请求；
//  3. 然后才是内容指纹改写（只改 system，见 workbuddy-fingerprint.js）。
export function shapeWorkbuddyBody(body = {}, modelMeta = null) {
  const obj = { ...body }
  obj.stream = true
  normalizeWorkbuddyTools(obj)
  normalizeWorkbuddyRoles(obj)
  ensureWorkbuddySystemMessage(obj)
  forceWorkbuddyMaxThinking(obj)
  applyWorkbuddyMaxOutput(obj, modelMeta)
  // 腾讯的内容级风控：system 里的已知模板句会被 400/11128 拦下。
  // 放在最后，改的是「已经确定是 system」的那些消息。
  rewriteWorkbuddySystemFingerprints(obj)
  return obj
}
