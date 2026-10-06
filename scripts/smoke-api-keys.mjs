// 访问密钥端到端冒烟测试（手动运行，不进 CI）
//
//   node scripts/smoke-api-keys.mjs
//
// 为什么单独放一个脚本而不是塞进 server/test/：
// 它会真的起进程、占端口（4598/4599）、走真实 HTTP，属于「集成」而非单元测试。
// CI 里跑这个只会因为端口占用而随机变红；单元测试已经覆盖了同一批逻辑
// （server/test/api-keys.test.js），这里负责在发版前把整条链路再验一遍。
//
// 覆盖：主密钥/子密钥鉴权、/v1 与 /api/v1 两组路径、模型白名单与通配、
// provider: 前缀绕过、停用/过期/轮换/删除的即时生效、按 Key 用量统计、
// 以及「被拒绝的请求绝不触达上游」。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UP_PORT = Number(process.env.SMOKE_UP_PORT || 4599)
const GW_PORT = Number(process.env.SMOKE_GW_PORT || 4598)
const ADMIN = 'smoke-admin-key'
const SERVER_DIR = fileURLToPath(new URL('../server', import.meta.url))

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

// ---- 假上游：记录收到的请求，回一个最小可用的 completion ----
const upstreamHits = []
const upstream = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    upstreamHits.push({ path: req.url, auth: req.headers.authorization, body })
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'cheap-model' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-smoke',
      object: 'chat.completion',
      model: 'cheap-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { total_tokens: 5 }
    }))
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---- 真网关（独立 DATA_DIR，不碰任何既有数据）----
const dataDir = mkdtempSync(join(tmpdir(), 'gw-smoke-'))
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    PORT: String(GW_PORT),
    DATA_DIR: dataDir,
    ADMIN_KEY: ADMIN,
    WEB_DIST: join(dataDir, 'no-web'),
    ZEN_AUTOSEED: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let gwLog = ''
child.stdout.on('data', (d) => { gwLog += d })
child.stderr.on('data', (d) => { gwLog += d })

const base = `http://127.0.0.1:${GW_PORT}`
const adminHeaders = { 'X-Admin-Key': ADMIN, 'Content-Type': 'application/json' }

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

try {
  check('网关启动', await waitReady(), gwLog.slice(-800))

  // 1) 注册一个指向假上游的平台
  const pResp = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: '冒烟上游',
      base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      protocol: 'openai-chat',
      api_key: 'up-1',
      model_names: ['gpt-4o', 'cheap-model']
    })
  })
  check('创建平台 201', pResp.status === 201, `status=${pResp.status}`)

  const ownerKey = (await (await fetch(`${base}/api/gateway`, { headers: adminHeaders })).json()).api_key

  // 2) 无 Key 必须被拒（含以前完全没设防的 /v1/* 别名路径）
  check('/api/v1/models 无 Key → 401', (await fetch(`${base}/api/v1/models`)).status === 401)
  check('/v1/models 无 Key → 401（旧版此处无鉴权）', (await fetch(`${base}/v1/models`)).status === 401)
  check('错误 Key → 401', (await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer sk-nope' } })).status === 401)

  // 3) 创建受限 Key
  const created = await (await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: '冒烟-受限', allowed_models: ['cheap-model'], note: '冒烟' })
  })).json()
  const restrictedToken = created.token
  check('创建密钥返回明文 sk-', String(restrictedToken).startsWith('sk-'))
  check('创建响应不含 key_hash', created.key.key_hash === undefined)
  check('模型范围为 restricted', created.key.model_scope === 'restricted', created.key.model_scope)

  const listed = await (await fetch(`${base}/api/keys`, { headers: adminHeaders })).json()
  check('列表接口不回明文', !JSON.stringify(listed).includes(restrictedToken))
  check('列表带模型候选池', listed.available_models?.length === 2, JSON.stringify(listed.available_models))

  // 4) 受限 Key 的模型列表被裁剪
  const mRestricted = await (await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${restrictedToken}` }
  })).json()
  check('受限 Key 的 /v1/models 只剩 cheap-model',
    JSON.stringify(mRestricted.data.map((m) => m.id)) === JSON.stringify(['cheap-model']),
    JSON.stringify(mRestricted.data.map((m) => m.id)))

  const mOwner = await (await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${ownerKey}` }
  })).json()
  check('主密钥的 /v1/models 仍是全量', mOwner.data.length === 2, JSON.stringify(mOwner.data.map((m) => m.id)))

  // 5) 被禁模型 → 403，且不触达上游
  const before = upstreamHits.length
  const denied = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${restrictedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
  })
  const deniedBody = await denied.json()
  check('被禁模型 → 403', denied.status === 403, `status=${denied.status}`)
  check('错误类型为 model_forbidden', deniedBody.error?.type === 'model_forbidden', JSON.stringify(deniedBody))
  check('被禁请求未触达上游', upstreamHits.length === before, `hits +${upstreamHits.length - before}`)

  // 6) provider: 前缀绕不过去
  const providers = await (await fetch(`${base}/api/providers`, { headers: adminHeaders })).json()
  const prefixBypass = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${restrictedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `provider:${providers[0].id}/gpt-4o`, messages: [] })
  })
  check('provider: 前缀写法 → 403', prefixBypass.status === 403, `status=${prefixBypass.status}`)

  // 7) 放行的模型可以正常走通（并且带着平台 Key 转发）
  const allowed = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${restrictedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cheap-model', messages: [{ role: 'user', content: 'ping' }] })
  })
  check('放行模型 → 200', allowed.status === 200, `status=${allowed.status} ${JSON.stringify(await allowed.json()).slice(0, 200)}`)
  const lastHit = upstreamHits.at(-1)
  check('上游收到的是平台 Key', lastHit?.path === '/v1/chat/completions' && lastHit?.auth === 'Bearer up-1',
    JSON.stringify({ path: lastHit?.path, auth: lastHit?.auth }))

  // 8) 通配规则 + 停用 + 过期
  const wild = await (await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: '冒烟-通配', allowed_models: ['cheap-*'] })
  })).json()
  const wildModels = await (await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${wild.token}` }
  })).json()
  check('通配 cheap-* 生效', JSON.stringify(wildModels.data.map((m) => m.id)) === JSON.stringify(['cheap-model']),
    JSON.stringify(wildModels.data.map((m) => m.id)))

  await fetch(`${base}/api/keys/${wild.key.id}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ enabled: false })
  })
  const disabled = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${wild.token}` } })
  const disabledBody = await disabled.json()
  check('停用后 → 403', disabled.status === 403, `status=${disabled.status}`)
  check('停用提示指明是哪把 Key', /已被停用/.test(disabledBody.error?.message || ''), JSON.stringify(disabledBody))

  const expired = await (await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: '冒烟-过期', expires_at: Date.now() - 1000 })
  })).json()
  check('过期后 → 403',
    (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${expired.token}` } })).status === 403)

  // 9) 轮换后旧 Key 立即失效
  const rot = await (await fetch(`${base}/api/keys/${created.key.id}/rotate`, { method: 'POST', headers: adminHeaders })).json()
  check('轮换后旧 Key → 401',
    (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${restrictedToken}` } })).status === 401)
  check('轮换后新 Key → 200',
    (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${rot.token}` } })).status === 200)
  check('轮换保留模型范围', JSON.stringify(rot.key.allowed_models) === JSON.stringify(['cheap-model']), JSON.stringify(rot.key.allowed_models))

  // 10) 用量与日志
  const usage = await (await fetch(`${base}/api/keys`, { headers: adminHeaders })).json()
  const used = usage.keys.find((k) => k.id === created.key.id)
  check('用量按 Key 累计', used.usage.requests >= 1, JSON.stringify(used.usage))
  const logs = await (await fetch(`${base}/api/logs?type=chat&limit=20`, { headers: adminHeaders })).json()
  check('日志带 client_key 便于归因', logs.logs.some((l) => l.client_key))

  // 11) 删除
  await fetch(`${base}/api/keys/${created.key.id}`, { method: 'DELETE', headers: adminHeaders })
  check('删除后 → 401',
    (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${rot.token}` } })).status === 401)
} catch (err) {
  fail++
  console.log(`  FAIL 冒烟脚本异常: ${err.stack}`)
  console.log('--- 网关日志 ---\n' + gwLog.slice(-2000))
} finally {
  child.kill()
  upstream.close()
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
