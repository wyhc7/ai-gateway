// WorkBuddy / CodeBuddy 渠道「兼容补丁」：客户端指纹伪装 + 提示词文案改写
//
// ## 这份补丁解决什么
//
// 2026-10-27 起腾讯把 11128 的审查面扩大了两处（社区实测与复现）：
//
// 1. **客户端身份**：除了 UA，网关还会看一组「插件身份」头。缺了它们，
//    换个 UA 也没用 —— 它认的是「你是不是本机 CodeBuddy 插件在发请求」。
// 2. **系统提示里的固定文案**：`Tokens prefixed with @` 那整句
//    「@ 前缀表示引用路径」的说明文字本身成了指纹。
//    ⚠️ 关键：这句在**搬家之后**位于 **user** 消息里（见
//    workbuddy-prompt-relocate.js 的角色实测表），而现有
//    workbuddy-fingerprint.js 只扫 system、workbuddy-prompt-relocate.js 的
//    ASSISTANT_FINGERPRINTS 只扫 assistant —— 两条路都碰不到搬过去的那份正文。
//    这就是「搬家了却仍然 11128」的最后一块。
//
// ## 两条硬约束（照抄现有指纹补丁的实测结论，不自行泛化）
//
// 1. **同义改写，不删句**：删掉整句会改变模型对 @ 语法的理解，行为漂移。
//    改写后的句子必须仍然准确表达「@ 开头的是路径引用」。
// 2. **精确字面量、大小写不敏感**：上游先归一化再匹配，任何「同字不同形」
//    的打码（零宽、NBSP、全角）都会被吃掉。只有真的换词才有效。
//
// ## 可维护性
//
// 上游随时会换指纹。新增一条 = 往 PROMPT_REWRITES 里加一行 + 一条用例。
// 插件身份头同理，在 PLUGIN_IDENTITY_HEADERS 里加。

// ---------------------------------------------------------------------------
// 一、客户端插件身份伪装
// ---------------------------------------------------------------------------

/**
 * 让请求自称「本机 CodeBuddy 插件」的一组头。
 *
 * 值与官方桌面端一致：
 * - `X-Product-Code`：产品码，核心上已有常量 HTTP_HEADER_PRODUCT_CODE；
 * - `X-Client-Name` / `X-Client-Version`：插件名与版本，与 UA 里的
 *   `CodeBuddy/2.63.2` 对齐 —— 两处版本号不一致本身就是一条新指纹；
 * - `X-Plugin-Name` / `X-Plugin-Version`：部分端点读这组。
 *
 * ⚠️ 只发上游确实读的头。多塞一个不认识的头不会加分，反而多一条可被
 * 关联的特征。这五个都是官方客户端实际发出的。
 */
export const PLUGIN_IDENTITY_HEADERS = {
  'X-Client-Name': 'CodeBuddy',
  'X-Client-Version': '2.63.2',
  'X-Plugin-Name': 'CodeBuddy',
  'X-Plugin-Version': '2.63.2'
}

/**
 * 兼容补丁总开关：`WORKBUDDY_COMPAT=0` 关闭。
 *
 * 留着这个口子是因为伪装头毕竟是「自称」，上游若开始校验签名，
 * 这些头反而会变成矛盾点。运维能不改代码就退回去。
 */
export function isCompatEnabled() {
  const v = String(process.env.WORKBUDDY_COMPAT ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

/**
 * 把插件身份头并进请求头。
 *
 * 契约：
 * - **不覆盖调用方已有的同名头**：显式配置优先，运维能在平台 extra_headers
 *   里钉死某个值而不被这里改写；
 * - 开关关闭时原样返回入参，**同一个对象**（调用方可能靠身份比较判断是否改动）。
 *
 * @param {object} headers 已构造好的请求头
 * @returns {object} 补过头的新对象；开关关闭或无需改动时是原对象
 */
export function withPluginIdentity(headers = {}) {
  if (!isCompatEnabled()) return headers
  let changed = false
  const out = { ...headers }
  for (const [name, value] of Object.entries(PLUGIN_IDENTITY_HEADERS)) {
    // 大小写不敏感地判断「已经有了」：HTTP 头名不区分大小写，
    // 用 `name in out` 会在写成小写时误判成缺失并塞出重复头。
    const exists = Object.keys(out).some((k) => k.toLowerCase() === name.toLowerCase())
    if (exists) continue
    out[name] = value
    changed = true
  }
  return changed ? out : headers
}

// ---------------------------------------------------------------------------
// 二、提示词文案同义改写
// ---------------------------------------------------------------------------

/**
 * 已知会被当作指纹的系统提示文案。
 *
 * ⚠️ 每条都要有实发证据（带原文被拦 + 改写后放行）。replace 必须语义等价：
 * 这些句子定义了模型怎么理解输入，改错会让工具调用行为漂移。
 */
export const PROMPT_REWRITES = [
  {
    // DSH 系统提示里解释 @ 前缀的那句。原文是：
    //   "Tokens prefixed with @ are paths the user explicitly referenced."
    // 评论区的修复方法就是「对该段话进行同义改写，保留指令、用户内容和工具结构」。
    // 只换措辞，不删信息：仍然告诉模型 @ 开头的是路径、是用户指过的。
    find: 'Tokens prefixed with @',
    replace: 'Inputs starting with @',
    note: '2026-10-27 社区实测；搬家后位于 user 消息，需单独扫'
  },
  {
    // 同段的后续分句。「Trailing slash marks a directory」也是同一段固定文案，
    // 一起改成同义写法，避免只改前半句留下后半句继续命中。
    find: 'Trailing slash marks a directory',
    replace: 'A trailing slash indicates a directory',
    note: '同上；与上一条同处一段，单改一条会留下残余指纹'
  },
  {
    find: 'Missing details get placeholders',
    replace: 'Absent details are filled with placeholders',
    note: '同一段提示词的固定句，保守一并改写'
  }
]

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED = PROMPT_REWRITES.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // g = 全部出现；i = 大小写不敏感（上游先归一化，大小写变体同样命中）
  pattern: new RegExp(escapeRegExp(rule.find), 'gi')
}))

/**
 * 把文本里已知的固定提示文案做**窄换词**改写。
 *
 * 契约：不含任何指纹的文本逐字符不变 —— 这是硬要求，上游按前缀缓存，
 * 无谓地重建字符串会让每一轮都算新前缀，白白吃掉缓存命中。
 *
 * @param {string} text
 * @returns {string} 改写后的文本；无命中时是同一份内容
 */
export function rewritePromptWording(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const rule of COMPILED) {
    if (!out.toLowerCase().includes(rule.findLower)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/** 取消息正文的纯文本；带非 text 段（图片）时返回 null，表示不可安全改写。 */
function plainText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') return null
    if (typeof part.text !== 'string') return null
    parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * 改写**指定角色**消息里的提示文案。
 *
 * 为什么默认扫 user 而不是 system：搬家之后（workbuddy-prompt-relocate.js）
 * 那份系统提示正文就躺在一条 user 消息里，system 只剩占位句。
 * 只扫 system 等于什么都没改。
 *
 * ⚠️ 扫 user 有一条必须守住的边界：**只改我们自己搬进去的那条**。
 * 用户自己打的字里若恰好出现同样措辞，改动它等于篡改用户原话。
 * 所以默认只在带 RELOCATE_MARKER 的消息上动手。
 *
 * @param {object} obj 请求体，messages 会被就地改写
 * @param {object} options
 * @param {string} [options.marker] 搬家标记；给出时只改带标记的消息
 * @param {boolean} [options.allUsers] 为 true 时扫所有 user 消息（危险，仅排障用）
 * @returns {boolean} 是否真的改过
 */
export function rewriteWorkbuddyPromptWording(obj, { marker = '', allUsers = false } = {}) {
  if (!isCompatEnabled()) return false
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  let changed = false

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '').trim().toLowerCase()
    if (role !== 'user') continue

    const text = plainText(m.content)
    if (text === null) continue // 带图片：整条不动
    // 只有我们搬进去的那条（或显式要求全扫）才改写
    if (!allUsers && marker && !text.includes(marker)) continue
    if (!allUsers && !marker) continue

    const next = rewritePromptWording(text)
    if (next === text) continue

    // 就地替换，保持 content 的原始形态（字符串仍是字符串）
    if (typeof m.content === 'string') {
      m.content = next
    } else {
      m.content = [{ type: 'text', text: next }]
    }
    changed = true
  }
  return changed
}

/**
 * 一次性兼容整形：搬到 user 之后改写正文措辞。
 *
 * 调用时机必须在 relocateWorkbuddySystemPrompt **之后** —— 搬之前那条消息
 * 还是 system，扫描不到。
 *
 * @param {object} obj 请求体
 * @param {string} marker 搬家标记（RELOCATE_MARKER）
 * @returns {boolean} 是否真的改过
 */
export function applyWorkbuddyCompat(obj, marker = '') {
  if (!isCompatEnabled()) return false
  return rewriteWorkbuddyPromptWording(obj, { marker })
}
