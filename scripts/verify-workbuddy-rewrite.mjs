// 端到端验证：用真实 HTTP 上游跑通「目录刷新 → 请求整形 → 转发」整条链路
//
// 单元测试各自钉住一层，但层与层的接缝（谁传什么给谁）只有连起来才看得出来。
// 这个脚本模拟两个 realm 的上游，验证：
//  1. 目录刷新能同时吃下企业端点与 v3/config，产出并集 + 别名 + 促销价；
//  2. 别名（glm-5.3-intl）转发前被换回上游 id；
//  3. 按 realm 挑 Key，不会拿国际账号发国内模型；
//  4. system 里的 11128 指纹在真正发出去之前被改写；
//  5. max_tokens 按该模型的上游上限下发。
//
// 用法：node scripts/verify-workbuddy-rewrite.mjs
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-verify-'))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// —— 假上游：一个站同时提供 v3/config、企业端点、对话端点 ——
const seen = { chat: [], config: 0, enterprise: 0 }

function upstreamHandler(req, res) {
  const json = (payload, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (req.url.startsWith('/v3/config')) {
    seen.config += 1
    // 国内账号：给 glm-5.3（x0.79）+ auto（无倍率）+ 促销
    return json({
      code: 0,
      data: {
        models: [
          { id: 'glm-5.3', credits: 'x0.79', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 131072, vendor: 'zhipu' },
          { id: 'glm-5.2', credits: 'x0.17', maxOutputTokens: 65536 },
          { id: 'auto', name: 'Auto' },
          { id: 'nes-completion', maxOutputTokens: 128 }
        ],
        agents: [{ name: 'craft', models: ['glm-5.3', 'glm-5.2'] }],
        modelPromotions: [{
          enabled: true,
          priority: 100,
          discount: { discountedCredits: '0.50x', factor: 0.5 },
          modelIds: ['glm-5.2']
        }]
      }
    })
  }

  if (req.url.includes('/console/enterprises/')) {
    seen.enterprise += 1
    // 企业端点：给全量清单（含 v3/config 没有的隐藏型号）
    return json({
      code: 0,
      data: {
        models: [
          { id: 'glm-5.3', credits: 'x0.79', maxOutputTokens: 131072 },
          { id: 'hidden-only', credits: 'x2.20 credits' }
        ]
      }
    })
  }

  if (req.url.startsWith('/v2/chat/completions')) {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen.chat.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    })
    return
  }

  json({ code: 404, msg: 'not found' }, 404)
}

const server = http.createServer(upstreamHandler)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`假上游已启动：${base}\n`)

// —— 动态 import：DATA_DIR 必须先设好 ——
const { state } = await import('../server/store.js')
const { refreshWorkbuddyCatalog } = await import('../server/proxy.js')
const { shapeWorkbuddyBody } = await import('../server/workbuddy-lane.js')
const { fetchWorkbuddyCatalog } = await import('../server/workbuddy-catalog.js')

// —— 1. 目录刷新：并集 + 倍率 + 促销 ——
console.log('【1】目录刷新（企业端点 ∪ v3/config）')
const provider = {
  id: 'p-wb',
  name: 'WorkBuddy 国内版',
  protocol: 'workbuddy-oauth',
  base_url: 'https://copilot.tencent.com',
  keys: [{
    id: 'k-cn',
    type: 'oauth',
    provider: 'workbuddy',
    name: '国内账号',
    enabled: true,
    access_token: 'tok-cn',
    domain: 'www.codebuddy.cn',
    uid: 'u-1',
    // 注入本地上游：把两个端点都指向假服务器
    models_base: base,
    rates_base: base,
    chat_base: base
  }],
  models: [],
  model_rates: {}
}

state.providers.push(provider)
const merged = await refreshWorkbuddyCatalog(provider)
check('刷新成功', merged?.ok === true, `count=${merged?.count}`)
check('两个端点都被调用', seen.config > 0 && seen.enterprise > 0, `config=${seen.config} enterprise=${seen.enterprise}`)

const ids = provider.models.map((m) => m.id)
check('企业端点独有的模型并进来了', ids.includes('hidden-only'), ids.join(','))
check('v3/config 独有的模型也在', ids.includes('glm-5.2') && ids.includes('auto'))
check('非对话模型保留在路由表（标 chat:false 而不是删掉）', ids.includes('nes-completion'))
const nesModel = provider.models.find((m) => m.id === 'nes-completion')
check('非对话模型被标注', nesModel?.chat === false)
const autoModel = provider.models.find((m) => m.id === 'auto')
check('auto 保留并标注', Boolean(autoModel) && autoModel.auto_select === true)

const glm53 = provider.models.find((m) => m.id === 'glm-5.3')
check('倍率带出', glm53?.rate === 'x0.79', String(glm53?.rate))
check('规格带出（max_output 用于下发 max_tokens）', glm53?.max_output === 131072, String(glm53?.max_output))

const glm52 = provider.models.find((m) => m.id === 'glm-5.2')
check('促销价带出且格式统一', glm52?.rate_discounted === 'x0.50', String(glm52?.rate_discounted))
check('企业端点的 credits 后缀被正确解析成倍率', provider.models.find((m) => m.id === 'hidden-only')?.rate === 'x2.20 credits')

// —— 2. 请求整形：别名换回 + 指纹改写 + max_tokens ——
console.log('\n【2】请求整形')
provider.model_upstream_id = { 'glm-5.3-intl': 'glm-5.3' }
const { workbuddyUpstreamBody } = await import('../server/proxy.js')
const aliased = workbuddyUpstreamBody(provider, { model: 'glm-5.3-intl', messages: [] })
check('别名换回上游 id', aliased.model === 'glm-5.3', aliased.model)

const shaped = shapeWorkbuddyBody({
  model: 'glm-5.3',
  stream: false,
  messages: [
    { role: 'system', content: 'Main branch (you will usually use this for PRs): master' },
    { role: 'user', content: 'Main branch (you will usually use this for PRs)' }
  ]
}, glm53)
check('stream 强制打开', shaped.stream === true)
check('system 里的 11128 指纹被改写', shaped.messages[0].content.includes('PRs usually go here'))
check('user 里的同一句不动', shaped.messages[1].content.includes('usually use this'))
check('max_tokens 按上游上限下发', shaped.max_tokens === 131072, String(shaped.max_tokens))

const kept = shapeWorkbuddyBody({ model: 'glm-5.3', max_tokens: 256, messages: [{ role: 'user', content: 'x' }] }, glm53)
check('客户端显式给的 max_tokens 被尊重', kept.max_tokens === 256, String(kept.max_tokens))

// —— 3. 按 realm 挑 Key ——
console.log('\n【3】按 realm 挑 Key')
const { workbuddyKeysForModel } = await import('../server/proxy.js')
const keys = [
  { id: 'k-cn', domain: 'www.codebuddy.cn' },
  { id: 'k-intl', domain: 'www.codebuddy.ai' }
]
const cnKeys = workbuddyKeysForModel({ model_realm: { 'glm-5.3': 'cn' } }, 'glm-5.3', keys)
check('国内模型只发给国内账号', cnKeys.length === 1 && cnKeys[0].id === 'k-cn')
const unknown = workbuddyKeysForModel({ model_realm: {} }, 'whatever', keys)
check('未知模型不筛选（不误伤）', unknown.length === 2)

// —— 4. 真实 HTTP：一次完整的目录抓取（走 fetch，不经 provider 包装）——
console.log('\n【4】真实 HTTP 目录抓取')
const fetched = await fetchWorkbuddyCatalog(
  { models_base: base, rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' },
  { name: 'WB' }
)
check('抓取到并集清单', fetched.ids.includes('hidden-only') && fetched.ids.includes('glm-5.2'))
check('无降级说明（两个端点都成功）', fetched.notes.length === 0, JSON.stringify(fetched.notes))

server.close()

// —— 汇总 ——
const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${results.length - failed.length}/${results.length}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
console.log('端到端链路验证通过。')
