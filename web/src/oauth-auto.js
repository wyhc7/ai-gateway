// OAuth 加号的「自动送回 callback」工具。
//
// 问题：ChatGPT 的 OAuth 客户端把 redirect_uri 钉死在
//   https://platform.openai.com/auth/callback
// 改不了（改了是 redirect_uri_mismatch）。于是授权完成后 code 只出现在
// 浏览器地址栏里，服务器永远看不到，必须由浏览器主动送回。
//
// 这里提供两条不需要手工复制粘贴的路：
//   1. 书签脚本（bookmarklet）：授权页点一下书签，直接把 callback 发回网关
//   2. 剪贴板轮询：用户复制了 callback 地址，页面自动读剪贴板发现就提交
//
// 都不含任何服务端凭据：bookmarklet 里只有网关地址 + 平台 id + session_id，
// 真正换 token 的动作仍由网关带着 auth-key 去做。

/** 从任意一段文本里挑出 code 与 state。用户可能粘整条 URL，也可能只粘 code。 */
export function extractCodeAndState(input) {
  const raw = String(input || '').trim()
  if (!raw) return { code: '', state: '' }
  try {
    const u = new URL(raw)
    return {
      code: u.searchParams.get('code') || '',
      state: u.searchParams.get('state') || ''
    }
  } catch {
    // 不是完整 URL：可能是裸 code，也可能是 "code=xxx&state=yyy"
    if (raw.includes('code=')) {
      const q = new URLSearchParams(raw.replace(/^[^?]*\?/, ''))
      return { code: q.get('code') || '', state: q.get('state') || '' }
    }
    return { code: raw, state: '' }
  }
}

/** 判断一段文本像不像 ChatGPT 的 OAuth 回调。剪贴板轮询靠它决定要不要自动提交。 */
export function looksLikeCallback(text) {
  const s = String(text || '')
  if (!s.includes('code=')) return false
  return /platform\.openai\.com\/auth\/callback/.test(s) || /[?&]state=/.test(s)
}

/**
 * 生成书签脚本。
 *
 * 为什么走 URL hash 传 callback：bookmarklet 里直接拼的地址可能含 code（敏感），
 * 放到 hash 里不会进服务端访问日志与 Referer，减少泄露面。
 *
 * 注意 bookmarklet 跑在 platform.openai.com 的页面上，所以网关地址必须是
 * 浏览器能直接访问到的绝对地址（不能用 127.0.0.1，除非网关就在本机）。
 *
 * @param {string} gatewayBase 形如 https://gw.example.com（不带结尾斜杠）
 * @param {string} providerId  转换层平台 id
 * @param {string} sessionId   OAuth 会话 id
 */
export function buildBookmarklet(gatewayBase, providerId, sessionId) {
  const base = String(gatewayBase || '').replace(/\/+$/, '')
  // 必须指向 /oauth/callback 而不是 /oauth/finish：
  // finish 走管理密钥鉴权且不接受跨域；callback 是专给书签的端点，
  // 自己回 CORS 头、用 platform_id+session_id 鉴权、返回人类可读的 HTML。
  const target = `${base}/api/chatgpt-accounts/oauth/callback`
  // 单行、无换行，避免书签被浏览器截断
  const js = `(function(){try{var cb=location.href;if(cb.indexOf('code=')<0){alert('这个页面不是授权回调页，请回到 platform.openai.com/auth/callback 那一页再点');return}var f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(target)};f.target='_blank';function add(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i)}add('provider_id',${JSON.stringify(String(providerId || ''))});add('session_id',${JSON.stringify(String(sessionId || ''))});add('callback',cb);document.body.appendChild(f);f.submit();}catch(e){alert('提交失败: '+e.message)}})()`.replace(/\s+/g, ' ')
  return `javascript:${js}`
}
