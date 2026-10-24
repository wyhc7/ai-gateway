#!/usr/bin/env node
/**
 * 节点体检：判断当前代理出口 IP 适不适合加号。
 *
 * 为什么需要：
 *   加号时 OpenAI 看到的是本机代理的出口 IP。机场节点大多已被公开标记为
 *   proxy=true —— 这比机房 IP（hosting=true）更容易触发风控。
 *   今天三个号在 45 分钟内全挂，就是「同一被标记 IP + 连续登录」。
 *
 * 用法：
 *   node scripts/node-check.mjs                     # 查系统代理
 *   node scripts/node-check.mjs --proxy http://127.0.0.1:7897
 *   node scripts/node-check.mjs --proxy socks5://127.0.0.1:7897
 *   node scripts/node-check.mjs --count 5           # 连查 5 次，看轮换是否稳定
 *
 * 退出码：0 可用，1 不建议用，2 查询失败。
 */

const PROXY =
  process.argv.find((a) => a.startsWith('--proxy='))?.slice(8) ||
  (process.argv.includes('--proxy')
    ? process.argv[process.argv.indexOf('--proxy') + 1]
    : process.env.HTTPS_PROXY || process.env.https_proxy || null)

const COUNT = Number(
  process.argv.find((a) => a.startsWith('--count='))?.slice(8) ||
    (process.argv.includes('--count')
      ? process.argv[process.argv.indexOf('--count') + 1]
      : 1)
)

// 判断标准。数字来自实际经验，不是官方文档：
//   加号时最在意的是「这个 IP 有没有被别人用来注册过一堆号」，
//   proxy / hosting 标记是这件事最直接的代理指标。
const VERDICT = {
  clean: { ok: true, label: '可用', why: '既不是机房也不是代理，最像真人' },
  hosting: { ok: false, label: '不建议', why: '机房 IP，OpenAI 一眼看出不是家宽' },
  proxy: { ok: false, label: '不要用', why: '被公开标记为代理，加号最容易触发风控' },
  mobile: { ok: true, label: '很好', why: '移动网络，最接近真实用户' }
}

async function lookup(proxy) {
  // ip-api.com 的字段要靠 query string 传，注意别用 PowerShell 的 ` 转义
  const url = 'http://ip-api.com/json/?fields=query,country,regionName,city,isp,org,as,hosting,proxy,mobile'
  const res = await fetchWithProxy(url, proxy)
  if (!res.ok) throw new Error(`ip-api 返回 ${res.status}`)
  const j = await res.json()
  if (j.status === 'fail') throw new Error(j.message || '查询失败')
  return j
}

async function fetchWithProxy(url, proxy) {
  // Node 20+ 原生 fetch 不认 HTTPS_PROXY，也没有内置的 http/socks 代理支持，
  // 而为一个体检脚本装 undici 不值得。
  // 统一走 curl：Windows 10+ 自带，Linux/macOS 也都有，http 和 socks 通吃。
  if (!proxy) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (res.ok) return res
    } catch {
      // 直连失败时也交给 curl —— 有些环境 fetch 会被 TLS 指纹拦截
    }
  }
  return fetchViaCurl(url, proxy)
}

async function fetchViaCurl(url, proxy) {
  const { execFileSync } = await import('node:child_process')
  const args = ['-s', '-m', '20']
  if (proxy) args.push('--proxy', proxy)
  args.push(url)
  const body = execFileSync('curl', args, { encoding: 'utf8' })
  return { ok: true, json: async () => JSON.parse(body) }
}

function judge(info) {
  if (info.mobile) return VERDICT.mobile
  if (info.proxy) return VERDICT.proxy
  if (info.hosting) return VERDICT.hosting
  return VERDICT.clean
}

async function main() {
  console.log('代理:', PROXY || '(直连)')
  console.log('')

  const seen = new Map()
  let lastVerdict = null

  for (let i = 0; i < COUNT; i++) {
    try {
      const info = await lookup(PROXY)
      const v = judge(info)
      lastVerdict = v

      console.log(`第 ${i + 1} 次`)
      console.log(`  IP      ${info.query}`)
      console.log(`  位置    ${info.country} ${info.regionName} ${info.city}`)
      console.log(`  ISP     ${info.isp}`)
      console.log(`  ASN     ${info.as}`)
      console.log(`  机房    ${info.hosting ? '是 ✗' : '否 ✓'}`)
      console.log(`  代理    ${info.proxy ? '是 ✗' : '否 ✓'}`)
      console.log(`  移动    ${info.mobile ? '是' : '否'}`)
      console.log(`  判定    ${v.label} —— ${v.why}`)
      console.log('')

      seen.set(info.query, (seen.get(info.query) || 0) + 1)
    } catch (e) {
      console.error(`第 ${i + 1} 次查询失败: ${e.message}`)
      if (i === 0) return 2
    }
  }

  if (COUNT > 1) {
    console.log('=== 轮换情况 ===')
    console.log(`  ${seen.size} 个不同 IP / ${COUNT} 次`)
    if (seen.size === 1) {
      console.log('  固定 IP —— 加号时所有账号从同一个 IP 出去，风险最高')
    } else {
      console.log('  有轮换 —— 但同一时段仍是同一批 IP，别在短时间内连加')
    }
    console.log('')
  }

  if (lastVerdict && !lastVerdict.ok) {
    console.log('结论: 这个节点不适合加号。换个节点再查。')
    return 1
  }
  console.log('结论: 可以用。但同一 IP 上 2 小时内别加超过 1 个号。')
  return 0
}

process.exit(await main())
