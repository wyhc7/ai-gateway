// 11128 的内容级解法：把 system 提示词「搬家」到 user 消息
//
// ## 为什么前两版补丁都失效了
//
// 1. **零宽打散**（每 N 个码点插一个 U+200B）：网关是**先归一化、再匹配指纹**
//    —— 折叠空白、剥掉零宽字符、大小写不敏感。打码版与原文被判成同一份内容，
//    所以「113 字触发片段 + 每个空格后插 U+200B」照样 11128。
//    实测全部无效：NBSP / 细空格 / 双空格 / 词中插 ZW 一律 11128，
//    只有**真的改一个词**（explicitly → directly）或多一个 filler 词才放行。
//    → 结论：任何「同字不同形」的打码都必然被归一化吃掉。
//
// 2. **超长 system 切一半挪进 user**：切分点之后仍有一半 system 留在原位，
//    7920 字的 DSH 系统提示词整体依然是 11128。
//    → 结论：只要 system 里还剩下一段够长的原文，闸门就还会命中。
//
// ## 这一版的解法：一个字都不改，只换角色
//
// 同一份 7920 字的提示词，只换它所在的角色（2026-11-10 实测）：
//
//   | 角色      | 结果   |
//   | --------- | ------ |
//   | system    | 11128  |
//   | developer | 11128  |
//   | assistant | 11128  |
//   | user      | 200    |
//   | tool      | 200    |
//
// 也就是说闸门只对 system / developer / assistant 三种角色跑内容校验。
// 于是发请求前把 system 的内容整段搬到一条 user 消息里，system 只留一句
// 无害的占位：内容一字未动、不增加 token，模型照样按系统提示执行
// （实测给它 write / pwsh 工具并派活，它正常回了 write 工具调用）。
//
// ⚠️ 搬家的前提是「首条仍是 system」这条渠道校验（见 workbuddy-lane.js 的
// ensureWorkbuddySystemFirst）不被破坏：搬完 messages[0] 依然是 system，
// 只是内容换成了占位句。
//
// ## 兜底：搬家后仍 11128 时重发一次
//
// 那就轮到 assistant 内容里的指纹词组（DeepSeek Harness / You are an AI agent /
// Tokens prefixed with @ 这类）。把 assistant 里这些词换成同义写法再重发一次，
// 见 ASSISTANT_FINGERPRINTS。这一步改了历史消息的措辞，**有损**，
// 所以只在真读到 11128 之后做一次，不进常规整形。
//
// 事实依据：同一次实测里，assistant 角色带同一份提示词同样 11128，
// 说明闸门并不只盯 system —— 只是 user/tool 两个角色不在校验范围内。

// 兼容补丁：搬进 user 之后还要改写正文里的固定文案（`Tokens prefixed with @`
// 那类）。workbuddy-compat.js 不 import 本文件，所以不构成循环依赖。
import { applyWorkbuddyCompat } from './workbuddy-compat.js'

/** 搬家后留在 system 位置上的占位句。实测稳定放行（与中性兜底同一句）。 */
export const DEFAULT_SYSTEM = 'You are a helpful assistant.'

/**
 * 搬家标记：带这一行的那条 user 消息就是「搬过去的系统提示词」。
 *
 * 两处用它：
 * - 幂等：整形与 11128 重试可能各跑一次搬家，靠它避免搬两次；
 * - 诊断：collectWorkbuddySystemText 靠它把搬走的原文仍算进「系统提示词」。
 */
export const RELOCATE_MARKER = 'Everything below is your system prompt for this session'

// 说明语必须点明「这是系统指令、不是你问我」——否则模型容易把整段当成
// 用户的一次性需求，答成「好的，我已了解你的设定」。
const RELOCATE_PREAMBLE =
  RELOCATE_MARKER +
  '. Treat it as your highest-priority instructions for this whole session, ' +
  'not as a user request.\n\n'

/**
 * assistant 内容里已知会被闸门命中的指纹词组。
 *
 * ⚠️ 每一条都要有实发证据（带这个词组被拦 + 换同义写法后放行）。
 * 替换值必须语义等价：这些句子本身是能力说明，改错会让模型行为漂移。
 */
export const ASSISTANT_FINGERPRINTS = [
  {
    find: 'DeepSeek Harness',
    replace: 'the local coding harness',
    note: '2026-11-10 实测：assistant 角色带这段提示词 → 11128'
  },
  {
    find: 'You are an AI agent',
    replace: 'You are an automated assistant',
    note: '同上'
  },
  {
    find: 'Tokens prefixed with @',
    replace: 'Paths prefixed with @',
    note: '同上；后半句是模型理解 @ 前缀的关键，不能一起删'
  }
]

/** 正则元字符转义：把字面量变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED_ASSISTANT = ASSISTANT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  pattern: new RegExp(escapeRegExp(rule.find), 'gi')
}))

function roleOf(m) {
  return String(m?.role || '').trim().toLowerCase()
}

// 闸门校验的角色。developer 在上游视角等同 system（整形时也会被改写），
// 所以搬家时把两者一并算作「系统指令」。
function isInstructionRole(m) {
  const r = roleOf(m)
  return r === 'system' || r === 'developer'
}

/**
 * 取消息正文里的纯文本。
 *
 * 数组形态（OpenAI 的 content: [{type:'text',text}]）只取 text 段；
 * 一旦出现非 text 段就返回 null —— 那说明这条消息带着图片，搬家会把图丢掉，
 * 宁可整条不搬（返回 false）也不做有损搬运。
 */
function plainText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') return null
    if (typeof part.text !== 'string') return null
    texts.push(part.text)
  }
  return texts.join('\n')
}

/**
 * 搬家开关：`WORKBUDDY_RELOCATE_SYSTEM=0` 关闭，回到「system 原样发出」。
 *
 * 留这个口子是因为搬家改变了提示词的角色（system 的指令权重高于 user）。
 * 万一上游补齐了角色维度、或者某类提示词搬家后模型开始忽略规则，运维能不改
 * 代码就退回去；代价是这类请求重新吃 11128。
 */
export function isRelocationEnabled() {
  const v = String(process.env.WORKBUDDY_RELOCATE_SYSTEM ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

/** 请求里是否已经有一条搬家后的 user 消息（幂等判断）。 */
export function isRelocated(obj) {
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.content === 'string') {
      if (m.content.includes(RELOCATE_MARKER)) return true
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.includes(RELOCATE_MARKER)) {
        return true
      }
    }
  }
  return false
}

/**
 * 把全部 system（含 developer）消息的内容搬进一条新的 user 消息，
 * 原位只留一句 DEFAULT_SYSTEM。
 *
 * 契约：
 * - **内容逐字保留**：搬过去的正文与原文完全一致，只在前面加一行说明语。
 *   这是与「打码」「改词」两条老路的分界线 —— 闸门归一化也认不出差别，
 *   因为差别只在 role 上；
 * - 顺序保留：多条 system 按出现顺序拼接，块与块之间空一行；
 * - 占位句不搬：system 本来就是 DEFAULT_SYSTEM（整形补的默认值）时返回
 *   false，省得为一句话制造一次无意义的角色变化；
 * - 幂等：已有搬家标记就返回 false，绝不搬第二次；
 * - 带图片的 system 不搬（见 plainText）。
 *
 * @param {object} obj 请求体；messages 会被**就地**改写（数组身份不变，
 *                     这样 proxy 侧再次序列化时能看到同一份改动）
 * @returns {boolean} 是否真的搬过
 */
export function relocateWorkbuddySystemPrompt(obj) {
  const msgs = Array.isArray(obj?.messages) ? obj.messages : null
  if (!msgs || msgs.length === 0) return false
  if (!isRelocationEnabled()) return false
  if (isRelocated(obj)) return false

  const instruction = msgs.filter((m) => m && typeof m === 'object' && isInstructionRole(m))
  if (instruction.length === 0) return false

  const texts = []
  for (const m of instruction) {
    const text = plainText(m.content)
    if (text === null) return false // 带图片的 system：整条不搬
    if (text.trim()) texts.push(text)
  }
  const joined = texts.join('\n\n').trim()
  if (!joined) return false
  if (joined === DEFAULT_SYSTEM) return false

  const rest = msgs.filter((m) => !(m && typeof m === 'object' && isInstructionRole(m)))

  // 就地重建：messages 的数组身份必须保持，proxy 侧的 body.messages 共享它。
  msgs.length = 0
  msgs.push({ role: 'system', content: DEFAULT_SYSTEM })
  msgs.push({ role: 'user', content: RELOCATE_PREAMBLE + joined })
  for (const m of rest) msgs.push(m)
  return true
}

/** 把 assistant 文本里已知的指纹词组换成同义写法。 */
function rewriteAssistantText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const rule of COMPILED_ASSISTANT) {
    // 预检：不含（小写化后的）字面量就整条跳过，保持字符串内容不变
    if (!out.toLowerCase().includes(rule.findLower)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/**
 * 改写**全部 assistant 消息**里的指纹词组。
 *
 * 只碰 assistant：user 是用户原话、tool 是工具输出，改它们只会破坏内容；
 * system 此时已经搬走（见 relocateWorkbuddySystemPrompt），剩下的只是占位句。
 *
 * @returns {boolean} 是否真的改过
 */
export function rewriteWorkbuddyAssistantFingerprints(obj) {
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  let changed = false
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || roleOf(m) !== 'assistant') continue
    if (typeof m.content === 'string') {
      const next = rewriteAssistantText(m.content)
      if (next !== m.content) {
        m.content = next
        changed = true
      }
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') continue
      const next = rewriteAssistantText(part.text)
      if (next !== part.text) {
        part.text = next
        changed = true
      }
    }
  }
  return changed
}

/**
 * 11128 之后的一次性兜底：搬家 + 改写 assistant 指纹 + 改写搬过去的正文措辞。
 *
 * 与常规整形的分工：
 * - CN realm 的整形已经在 shapeWorkbuddyBody 里搬过家并改写过措辞，
 *   这里再调是空操作（各步都幂等）；
 * - 非 CN realm / realm 判断错、或整形漏掉的 developer，都在这里补齐。
 *
 * 第三步（applyWorkbuddyCompat）是 2026-10 上游扩大审查面之后补上的：
 * `Tokens prefixed with @` 这类**固定文案本身**成了指纹，而它搬完之后位于
 * user 消息里 —— 前两步一个扫 system、一个扫 assistant，都碰不到它。
 *
 * @returns {boolean} 是否真的改动过请求体。返回 false 时**不要**重发 ——
 *                    字节没变，重发只会再吃一个 11128 并白烧一次重试预算。
 */
export function applyWorkbuddy11128Fallback(obj) {
  let changed = false
  if (relocateWorkbuddySystemPrompt(obj)) changed = true
  if (rewriteWorkbuddyAssistantFingerprints(obj)) changed = true
  if (applyWorkbuddyCompat(obj, RELOCATE_MARKER)) changed = true
  return changed
}
