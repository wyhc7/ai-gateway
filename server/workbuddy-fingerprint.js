// 腾讯系渠道的**内容级**风控指纹改写
//
// 事实来源：dsh-our-free-model（MIT）的 vendor/channel-pack/src/openai-gateway/
// tencent-fingerprint.ts —— 那份文件带完整实测表（被拦 + 改写后放行两条证据），
// 下面每条结论都照抄它，不自行泛化、不自行扩大改写面。
//
// ## 现象
//
// system 消息里带上某些**客户端自带的模板句**时，腾讯网关稳定回
// HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"，
// 客户端侧只看到 provider_code=INVALID_REQUEST reason=unknown。同一账号、同一
// 模型、同一套头，换掉那一句就通 —— 差别只在 system 里注了什么。
//
// ## 三条不能违反的实测约束
//
// 1. **只改 system**：user / tool 里同一句不拦。改写它们只会白白破坏用户原话与
//    工具输出，且换不来任何收益。
// 2. **改写所有 system 消息**，不只 messages[0]：非首位的 system 同样被拦。
//    （WorkBuddy 网关那条「首条必须是 system」是另一回事，见 ensureWorkbuddySystemMessage。）
// 3. **大小写不敏感的精确字面量匹配**：全小写与全大写都被拦，但只差一个词
//    （usually → normally）或多一个空格就不拦 —— 服务端认的是逐字符的字面量，
//    **不能**把它泛化成正则或关键词匹配。
//
// ## 表驱动，而不是写死一处
//
// 屏蔽名单在上游手里、可能随时更新，任何客户端将来都可能撞上新指纹。
// 新增一条 = 往 CONTENT_FINGERPRINTS 里加一行 + 一条用例。

/**
 * 已知会被腾讯网关拦下的 system 模板句。
 *
 * ⚠️ 每一条都必须有实发证据（被拦 + 改写后放行，两条都要）。
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
export const CONTENT_FINGERPRINTS = [
  {
    // 某客户端的内建常量：`$Js = "Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现'
  }
]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  // 小写形态，用于 includes 预检（不命中就不必跑正则，字符串原样返回）
  findLower: rule.find.toLowerCase(),
  // g = 全部出现都改写；i = 大小写不敏感（实测全小写 / 全大写同样被拦）
  pattern: new RegExp(escapeRegExp(rule.find), 'gi')
}))

/**
 * 把 system 文本里已知的腾讯风控指纹做**窄改写**。
 *
 * 契约：
 * - 不含任何指纹的文本逐字符不变 —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：改写句与原句语义等价，模型读到的
 *   仍是「主分支（提 PR 通常走这里）」。
 *
 * @param {string} text 已取出的 system 纯文本
 * @returns {string} 改写后的文本；无指纹时是同一份字符串内容
 */
export function rewriteTencentContentFingerprints(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，out 保持同一份字符串内容。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // String.replace 配 g 正则在调用前后会把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/** 消息的 content 是否为「多段文本」形态（OpenAI 的 content: [{type:'text',text}]）。 */
function isTextParts(content) {
  return Array.isArray(content)
}

/**
 * 就地改写请求体里**所有 system 消息**的指纹。
 *
 * ⚠️ 只碰 role 为 system 的消息。user / tool 里同一句实测不拦，改它们只会破坏
 * 用户原话与工具输出（见文件头第 1 条约束）。
 *
 * @param {object} obj 已经过 role 整形的请求体（messages 必须已是 system/user/…）
 * @returns {boolean} 是否真的改写过（调用方据此判断是否需要重新序列化）
 */
export function rewriteWorkbuddySystemFingerprints(obj) {
  let changed = false
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    if (String(m.role || '').trim().toLowerCase() !== 'system') continue

    if (typeof m.content === 'string') {
      const next = rewriteTencentContentFingerprints(m.content)
      if (next !== m.content) {
        m.content = next
        changed = true
      }
      continue
    }
    // 多段形态：逐段改写。只动 text 段，图片段原样留着。
    if (isTextParts(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue
        if (typeof part.text !== 'string') continue
        const next = rewriteTencentContentFingerprints(part.text)
        if (next !== part.text) {
          part.text = next
          changed = true
        }
      }
    }
  }
  return changed
}
