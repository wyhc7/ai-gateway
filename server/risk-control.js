// 上游风控响应识别
//
// ## 为什么要单独认这件事
//
// 账号被上游风控时，HTTP 状态与普通错误几乎一样（403 或 400），只有响应体
// 里的文案不同。运维看到「403」第一反应是 token 失效，于是反复续期、换号重试，
// 而真正的处理方式是去申诉 / 停用这个号。
//
// 实测样本（2026-11-16，www.codebuddy.cn /v2/chat/completions）：
//
//   HTTP 403
//   {
//     "code": 11140,
//     "msg": "request illegal",
//     "displayMsg": {
//       "en": "Your account has been restricted due to unusual activity",
//       "zh": "账号存在异常行为，已被限制使用"
//     },
//     "displayTips": { "zh": "系统检测到该账号存在异常使用行为，如需申诉请提交反馈" },
//     "actions": ["EDIT_INPUT", "SUBMIT_FEEDBACK"]
//   }
//
// ⚠️ 注意 11140 **不等于**风控：同一个 code 也用于普通的 "request illegal"
// （参数非法，如传了不在档位表里的 contextLength）。所以判定不能只看 code，
// 必须看文案。这也是这里把 code 与文案分开返回的原因：code 只用于展示。
//
// ## 判据
//
// 只认「账号本身被限制」这一类措辞。刻意**不**匹配 rate limit / 429：
// 那是限流，几秒到几分钟就好，标成风控会让人去申诉一个没问题的号。
//
// 表驱动：新增一条 = 往 RISK_PATTERNS 里加一行 + 一条用例。

/** 命中任一即视为风控（中英文都要覆盖：同一份提示会按 Accept-Language 变）。 */
export const RISK_PATTERNS = [
  // 中文：账号级限制的几种常见写法
  /账号存在异常行为/,
  /账号存在异常使用行为/,
  /存在异常行为/,
  /已被限制使用/,
  /账号已被限制/,
  /账号已被封禁/,
  /封禁/,
  // 英文
  /account has been restricted/i,
  /unusual activity/i,
  /unusual usage/i,
  /abnormal activity/i,
  /account.{0,24}(restricted|suspended|banned)/i
]

/**
 * 从响应文本或已解析对象里认出风控。
 *
 * @param {string|object} input 响应体（字符串或已 JSON.parse 的对象）
 * @returns {{code: number|string|null, message: string, message_en: string|null, tips: string|null}|null}
 *          不是风控就返回 null
 */
export function detectRiskControl(input) {
  if (input === null || input === undefined) return null

  let obj = null
  let text = ''
  if (typeof input === 'string') {
    text = input
    try { obj = JSON.parse(input) } catch { obj = null }
  } else if (typeof input === 'object') {
    obj = input
    try { text = JSON.stringify(input) } catch { text = '' }
  } else {
    return null
  }

  // 文案判定：中文提示、英文提示、tips 都算在内。
  // 对已解析对象直接序列化后再匹配，避免为每种嵌套位置各写一遍取值逻辑。
  const haystack = text
  if (!haystack) return null
  const hit = RISK_PATTERNS.some((re) => re.test(haystack))
  if (!hit) return null

  const displayMsg = obj?.displayMsg || null
  const displayTips = obj?.displayTips || null
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  const message =
    pick(displayMsg?.zh) ||
    pick(displayMsg?.['zh-hans']) ||
    pick(displayMsg?.en) ||
    pick(obj?.msg) ||
    pick(obj?.message) ||
    '账号被上游风控限制'

  return {
    code: obj?.code ?? null,
    message,
    message_en: pick(displayMsg?.en),
    tips: pick(displayTips?.zh) || pick(displayTips?.en)
  }
}

/**
 * 把识别结果压成存到 Key 上的标记。
 *
 * 只留展示与判断需要的字段：整份响应体不进配置文件（它可能很大，
 * 而且含 requestId 之类与服务无关的内容）。
 *
 * @param {{code:number|string|null, message:string}} risk detectRiskControl 的返回值
 * @param {number} [at] 打标记的时间戳
 */
export function riskFlagOf(risk, at = Date.now()) {
  if (!risk) return null
  return {
    at,
    code: risk.code ?? null,
    message: String(risk.message || '账号被上游风控限制').slice(0, 200)
  }
}
