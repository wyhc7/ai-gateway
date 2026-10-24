// 转换层账号管理代理。
//
// 背景：chatgpt2api 这类自建转换层有自己的账号池（/api/accounts），但它的
// auth-key 只应该待在服务器上。如果让浏览器直连 3000 端口，要么得把端口开给
// 公网、要么得把 auth-key 塞进前端 —— 两条都不该做。
//
// 所以由网关代理一层：浏览器只需带**管理密钥**调 /api/chatgpt-accounts/*，
// 网关在这一侧把 auth-key 补上再打上游。auth-key 永远不出服务器。
//
// 代理范围是**白名单**：只放行本文件 ALLOW 里列出的方法+路径，其余一律 404。
// 不写成「前缀转发一切」，因为上游还挂着模型调用等端点，转发面越大越容易被
// 当成通用隧道用。
//
// 目标地址从平台的 base_url 推（去掉结尾 /v1），因此一个网关可以同时代理
// 多个转换层平台；找不到「像转换层」的平台就报错而不是瞎猜 127.0.0.1。

import { isBridgeProvider } from './providers-image-only.js'

const ALLOW = [
  ['GET', /^\/api\/accounts$/],
  ['POST', /^\/api\/accounts$/],
  ['DELETE', /^\/api\/accounts$/],
  ['POST', /^\/api\/accounts\/refresh$/],
  ['POST', /^\/api\/accounts\/export$/],
  ['POST', /^\/api\/accounts\/oauth\/start$/],
  ['POST', /^\/api\/accounts\/oauth\/finish$/],
  ['GET', /^\/api\/accounts\/refresh\/progress\/[A-Za-z0-9_-]+$/],
  ['GET', /^\/api\/accounts\/re-login\/progress\/[A-Za-z0-9_-]+$/]
]

// 上游超时：OAuth 兑换要打 chatgpt/auth.openai.com，给足 60 秒
const UPSTREAM_TIMEOUT_MS = Number(process.env.CHATGPT_ACCOUNTS_TIMEOUT_MS || 60000)

/** 从平台 base_url 推出转换层根地址（去掉结尾的 /v1、/v1/ 等版本段）。 */
export function bridgeBaseOf(provider) {
  const raw = String(provider?.base_url || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, '').replace(/\/v\d+(\.\d+)?$/i, '')
    return `${u.protocol}//${u.host}${path}`
  } catch {
    return raw.replace(/\/+$/, '').replace(/\/v\d+(\.\d+)?$/i, '')
  }
}

/**
 * 选一个用来代理账号的转换层平台。
 *
 * 优先级刻意分两档，不能只按 isBridgeProvider 过一遍就取第一个：
 *   image_only 很明确就是 chatgpt2api 生图方案建的平台，指向真账号池；
 *   而 isBridgeProvider 还会把「任何内网 openai-chat 平台」算进来（那只是
 *   为了 UI 文案），这类平台可能是 Ollama、vLLM 之类根本没有 /api/accounts。
 * 所以先找 image_only，找不到再退回内网 openai-chat。
 */
export function pickBridgeProvider(providers, providerId) {
  const list = Array.isArray(providers) ? providers : []
  if (providerId) {
    const hit = list.find((p) => p.id === providerId)
    if (hit && bridgeBaseOf(hit)) return hit
    return null
  }
  const imageOnly = list.find((p) => p.image_only && bridgeBaseOf(p))
  if (imageOnly) return imageOnly

  const LOCAL_RE = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
  return list.find((p) => p.protocol === 'openai-chat' && LOCAL_RE.test(String(p.base_url || '')) && bridgeBaseOf(p)) || null
}

/** 该平台的转换层凭据（第一个启用的 Key）。 */
function bridgeKeyOf(provider) {
  const keys = Array.isArray(provider?.keys) ? provider.keys : []
  const enabled = keys.find((k) => k.enabled) || keys[0]
  return enabled ? String(enabled.api_key || '') : ''
}

function isAllowed(method, path) {
  return ALLOW.some(([m, re]) => m === method && re.test(path))
}

/**
 * 把一次账号请求转发到转换层。
 *
 * @returns {Promise<{status:number, body:any}>}
 */
export async function proxyAccountsRequest(provider, method, path, body) {
  const base = bridgeBaseOf(provider)
  if (!base) {
    const err = new Error('该平台没有可用的 base_url，推不出转换层地址')
    err.statusCode = 400
    throw err
  }
  const key = bridgeKeyOf(provider)
  if (!key) {
    const err = new Error('该平台还没有填转换层凭据，请先在平台列表点「添加 Key」填入 CHATGPT2API_AUTH_KEY')
    err.statusCode = 400
    throw err
  }
  if (!isAllowed(method, path)) {
    const err = new Error(`转换层代理不支持 ${method} ${path}`)
    err.statusCode = 404
    throw err
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'ai-gateway/accounts-proxy'
      },
      signal: ac.signal
    }
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const resp = await fetch(base + path, init)
    const text = await resp.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: { message: text.slice(0, 800) || '(上游返回空)' } }
    }
    return { status: resp.status, body: parsed }
  } catch (e) {
    const msg = e?.name === 'AbortError'
      ? `转换层 ${base} 超时无响应（${UPSTREAM_TIMEOUT_MS}ms）`
      : `连不上转换层 ${base}：${e?.message || e}`
    const err = new Error(msg)
    err.statusCode = 502
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 上游 limits_progress 里各类能力的展示名。没列到的按原 key 显示，
// 这样上游新增能力（新的 feature_name）不会因为网关不认识就被吞掉。
const LIMIT_LABELS = {
  image_gen: '生图',
  deep_research: '深度研究',
  file_upload: '文件上传',
  paste_text_to_file: '粘贴转文件',
  reason: '推理'
}

/**
 * 把 limits_progress 规整成前端能直接渲染的形状，并按「生图优先」排序。
 *
 * 上游原本是个数组：[{feature_name, remaining, reset_after}]，其中
 * image_gen.remaining 就是**剩余生图额度**（与顶层 quota 同源）。顶层 quota
 * 单独留着是为了兼容只有 quota、没有 limits_progress 的老版本。
 */
export function normalizeLimits(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const key = String(it.feature_name || '').trim()
    if (!key) continue
    const remaining = Number(it.remaining)
    out.push({
      key,
      label: LIMIT_LABELS[key] || key,
      remaining: Number.isFinite(remaining) ? remaining : null,
      reset_at: it.reset_after || null
    })
  }
  // 生图放最前面：这个面板存在的意义就是盯生图额度
  out.sort((a, b) => {
    if (a.key === 'image_gen') return -1
    if (b.key === 'image_gen') return 1
    return 0
  })
  return out
}

/** 从 limits 里取生图这一项（拿不到就返回 null）。 */
export function imageLimitOf(limits) {
  const arr = Array.isArray(limits) ? limits : []
  return arr.find((l) => l.key === 'image_gen') || null
}

/** 把上游返回的账号压成前端要用的形状：不返回任何 token，只留展示字段。 */
export function sanitizeAccounts(payload) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload)
      ? payload
      : []
  return items.map((a) => {
    const at = String(a?.access_token || a?.accessToken || '')
    let jwtPlan = ''
    let accessExp = 0
    if (at) {
      const parts = at.split('.')
      if (parts.length > 1) {
        try {
          const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
          jwtPlan = p?.['https://api.openai.com/auth']?.chatgpt_plan_type || ''
          accessExp = Number(p?.exp || 0) * 1000
        } catch {
          /* payload 解不出来就留空，不影响展示 */
        }
      }
    }
    // plan 优先用上游账号记录的 type：OAuth 续期后拿到的 access_token 里
    // 往往**不含** chatgpt_plan_type（实测刷新后的 JWT auth 段只剩 amr /
    // user_id / residency），只信 JWT 会把免费号显示成空套餐。
    const plan = String(a?.type || jwtPlan || '')
    const limits = normalizeLimits(a?.limits_progress)
    const imageLimit = imageLimitOf(limits)
    // 剩余生图额度：优先 limits_progress.image_gen，退回顶层 quota
    const imageQuota = imageLimit?.remaining ?? (typeof a?.quota === 'number' ? a.quota : null)
    return {
      email: a?.email || '',
      status: a?.status || '',
      source_type: a?.source_type || '',
      quota: typeof a?.quota === 'number' ? a.quota : null,
      image_quota: imageQuota,
      // 生图额度恢复时间：limits 里的 reset_at 更精确，顶层 restore_at 兜底
      quota_reset_at: imageLimit?.reset_at || a?.restore_at || null,
      limits,
      plan,
      refresh_token: Boolean(a?.refresh_token),
      access_expires_at: accessExp || null,
      restore_at: a?.restore_at || null,
      last_used_at: a?.last_used_at || null,
      success: typeof a?.success === 'number' ? a.success : null,
      fail: typeof a?.fail === 'number' ? a.fail : null,
      last_token_refresh_at: a?.last_token_refresh_at || null,
      last_refresh_error: a?.last_refresh_error || null,
      token_tail: at ? at.slice(-6) : ''
    }
  })
}

// ---------------------------------------------------------------------------
// 账号池随「平台导入导出」一起走
// ---------------------------------------------------------------------------
//
// 为什么放在这里而不是让前端自己调两次接口：
//   账号池在转换层（chatgpt2api）里，auth-key 只存在于服务器上。前端拿不到
//   auth-key，也就不该自己去拼一次上游请求 —— 那样会把代理层绕开。
//
// 安全取舍：导出的账号包含完整 access_token / refresh_token，**等同于把号
// 交出去**。这和一个脱敏的平台 Key（2f3b********bc4a）不是一个安全等级。
// 之所以还是完整导出，是因为不带 token 的备份在换机器时毫无用处 ——
// 用户要的是「一个文件恢复一切」。代价是：备份文件本身必须当密钥看待。

/**
 * 取账号池的完整条目（含 token），用于打包进备份文件。
 *
 * 走 GET /api/accounts 而不是 POST /api/accounts/export：
 *   后者返回的是一份面向「Codex 迁移」的平铺数组，字段是上游裁剪过的；
 *   前者给的是账号记录的原始形状，导入时能把 limits_progress、restore_at、
 *   success/fail 这些运行时状态一并还原回去。
 *
 * @returns {Promise<{provider_id:string, items:object[]}>}
 */
export async function collectAccountsForExport(providers, providerId) {
  const provider = pickBridgeProvider(providers, providerId)
  if (!provider) {
    // 没有转换层平台不算错 —— 这个网关可能只用官方 API，压根没有账号池
    return { provider_id: '', items: [] }
  }
  const { status, body } = await proxyAccountsRequest(provider, 'GET', '/api/accounts')
  if (status !== 200) {
    const err = new Error(`取账号池失败（上游 ${status}）`)
    err.statusCode = status >= 500 ? 502 : status
    err.detail = body
    throw err
  }
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : []
  return { provider_id: provider.id, items }
}

/**
 * 把备份里的账号写回转换层。
 *
 * 上游 POST /api/accounts 的语义是「合并」不是「覆盖」：同一个 token 再加一次
 * 会被跳过，新 token 才加进去。所以恢复操作是幂等的 —— 重复导入不会炸号，
 * 也不会把现有账号删掉。这一点刻意保留，不做「先清空再写入」的语义，
 * 否则一次误操作就能把整个号池抹掉。
 *
 * @returns {Promise<{added:number, skipped:number, refreshed:number, errors:any[]}>}
 */
export async function restoreAccountsFromBackup(providers, providerId, items) {
  const provider = pickBridgeProvider(providers, providerId)
  if (!provider) {
    const err = new Error('备份里有账号池，但当前没有可写入的转换层平台，请先导入平台配置')
    err.statusCode = 400
    throw err
  }
  const accounts = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it === 'object' && (it.access_token || it.accessToken)
  )
  if (accounts.length === 0) {
    return { added: 0, skipped: 0, refreshed: 0, errors: [] }
  }
  const { status, body } = await proxyAccountsRequest(provider, 'POST', '/api/accounts', {
    accounts,
    tokens: []
  })
  if (status !== 200) {
    const err = new Error(`写回账号池失败（上游 ${status}）`)
    err.statusCode = status >= 500 ? 502 : status
    err.detail = body
    throw err
  }
  return {
    added: Number(body?.added || 0),
    skipped: Number(body?.skipped || 0),
    refreshed: Number(body?.refreshed || 0),
    errors: Array.isArray(body?.errors) ? body.errors : []
  }
}
