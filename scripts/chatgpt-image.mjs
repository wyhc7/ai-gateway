#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gpt 网页版生图 · 一键联调
//
//   node scripts/chatgpt-image.mjs ping                    # 探 chatgpt2api 与网关活着没
//   node scripts/chatgpt-image.mjs models                  # 打印网关里所有生图模型
//   node scripts/chatgpt-image.mjs gen "一只橘猫"           # 文生图 → 存 png
//   node scripts/chatgpt-image.mjs edit <原图路径> "加顶帽子"  # 图编辑（multipart）
//   node scripts/chatgpt-image.mjs onboard                 # 直接在网关建「只生图」平台
//   node scripts/chatgpt-image.mjs probe                  # 直连 chatgpt2api 看它认不认 prompt 参数
//
// 环境变量（都可不设，走默认）：
//   GW_BASE     网关地址           默认 http://127.0.0.1:3080
//   GW_KEY      网关访问密钥       默认从 server/data/config.json 里读 gateway_api_key
//   ADMIN_KEY   网关管理密钥       默认从 server/data/config.json 里读 admin_api_key
//   C2A_BASE    chatgpt2api 地址   默认 http://127.0.0.1:3000
//   C2A_KEY     chatgpt2api auth-key
//   IMG_MODEL   生图模型           默认 gpt-image-2
//
// 生图正常要 30~90 秒，脚本默认超时 300 秒，与网关 IMAGES_TOTAL_TIMEOUT_MS 对齐。
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const REPO = resolve(import.meta.dirname, '..')
const CONFIG_PATH = join(REPO, 'server', 'data', 'config.json')
const OUT_DIR = join(REPO, 'out', 'images')
const TIMEOUT_MS = Number(process.env.IMG_TIMEOUT_MS || 300000)

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const cfg = readConfig()
const GW_BASE = (process.env.GW_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const GW_KEY = process.env.GW_KEY || cfg.gateway_api_key || ''
const ADMIN_KEY = process.env.ADMIN_KEY || cfg.admin_api_key || ''
const C2A_BASE = (process.env.C2A_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const C2A_KEY = process.env.C2A_KEY || ''
const MODEL = process.env.IMG_MODEL || 'gpt-image-2'

const IMAGE_MODEL_RE = /image|dall-?e|imagen|flux|sd-?xl|seedream|kolors|wanx/i

function gwHeaders(extra = {}) {
  return { Authorization: `Bearer ${GW_KEY}`, ...extra }
}

async function timedFetch(url, options = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const t0 = Date.now()
  try {
    const resp = await fetch(url, { ...options, signal: ac.signal })
    return { resp, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

async function readError(resp) {
  let text = ''
  try {
    text = await resp.text()
  } catch {
    return `HTTP ${resp.status}`
  }
  try {
    const j = JSON.parse(text)
    return j?.error?.message || j?.error || j?.message || `HTTP ${resp.status} ${text.slice(0, 300)}`
  } catch {
    return `HTTP ${resp.status} ${text.slice(0, 300)}`
  }
}

// 三种上游响应形态都吃：
// 1) OpenAI 标准 {data:[{b64_json}]}
// 2) chatgpt2api 常回 {data:[{url}]}
// 3) 兜底：把整串响应里所有 https 图片链接与裸露 base64 抠出来
function extractImages(json) {
  const items = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const out = []
  for (const it of items) {
    if (typeof it === 'string') {
      if (/^https?:/i.test(it)) out.push({ url: it })
      else if (it.length > 200) out.push({ b64: it })
      continue
    }
    if (it?.b64_json) out.push({ b64: it.b64_json, revised: it.revised_prompt })
    else if (it?.url) out.push({ url: it.url, revised: it.revised_prompt })
    else if (it?.image) out.push({ b64: String(it.image).replace(/^data:[^,]+,/, ''), revised: it.revised_prompt })
  }
  if (out.length === 0) {
    const raw = JSON.stringify(json ?? '')
    for (const m of raw.matchAll(/https?:\/\/[^"\\\s]+?\.(?:png|jpe?g|webp)(?:\?[^"\\\s]*)?/gi)) out.push({ url: m[0] })
    for (const m of raw.matchAll(/"b64_json"\s*:\s*"([^"]{500,})"/g)) out.push({ b64: m[1] })
  }
  return out
}

async function saveImages(images, tag) {
  await mkdir(OUT_DIR, { recursive: true })
  const saved = []
  let i = 0
  for (const img of images) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${tag}-${stamp}-${i}.png`
    const path = join(OUT_DIR, name)
    if (img.b64) {
      await writeFile(path, Buffer.from(img.b64, 'base64'))
    } else if (img.url) {
      const { resp } = await timedFetch(img.url, {}, 120000)
      if (!resp.ok) {
        saved.push({ path: null, url: img.url, error: await readError(resp) })
        i += 1
        continue
      }
      await writeFile(path, Buffer.from(await resp.arrayBuffer()))
    }
    saved.push({ path, url: img.url || null, revised: img.revised || null })
    i += 1
  }
  return saved
}

function printSaved(saved, ms) {
  for (const s of saved) {
    if (s.path) console.log(`[ok] 已保存 ${s.path}${s.url ? `（源 ${s.url}）` : ''}`)
    else console.log(`[warn] 图片下载失败 ${s.url} → ${s.error}`)
    if (s.revised) console.log(`     上游改写后的 prompt：${s.revised}`)
  }
  console.log(`[done] 用时 ${(ms / 1000).toFixed(1)}s，${saved.length} 张`)
}

// ---------------------------------------------------------------- ping
async function cmdPing() {
  const rows = []
  try {
    const { resp, ms } = await timedFetch(`${C2A_BASE}/v1/models`, { headers: C2A_KEY ? { Authorization: `Bearer ${C2A_KEY}` } : {} }, 15000)
    rows.push(['chatgpt2api', `${C2A_BASE}/v1/models`, resp.ok ? `OK ${resp.status} (${ms}ms)` : `FAIL ${await readError(resp)}`])
  } catch (e) {
    rows.push(['chatgpt2api', `${C2A_BASE}/v1/models`, `FAIL ${e.message}`])
  }
  try {
    const { resp, ms } = await timedFetch(`${GW_BASE}/api/v1/models`, { headers: gwHeaders() }, 15000)
    rows.push(['网关', `${GW_BASE}/api/v1/models`, resp.ok ? `OK ${resp.status} (${ms}ms)` : `FAIL ${await readError(resp)}`])
  } catch (e) {
    rows.push(['网关', `${GW_BASE}/api/v1/models`, `FAIL ${e.message}`])
  }
  for (const r of rows) console.log(`${r[0].padEnd(12)} ${r[2].padEnd(40)} ${r[1]}`)
  if (!GW_KEY) console.log('[warn] 没读到网关访问密钥：设 GW_KEY，或确认 server/data/config.json 存在')
}

// ---------------------------------------------------------------- models
async function cmdModels() {
  const { resp } = await timedFetch(`${GW_BASE}/api/v1/models`, { headers: gwHeaders() }, 20000)
  if (!resp.ok) throw new Error(await readError(resp))
  const data = await resp.json()
  const all = data.data || []
  const imgs = all.filter((m) => IMAGE_MODEL_RE.test(String(m.id || '')))
  console.log(`共 ${all.length} 个模型，其中生图 ${imgs.length} 个：`)
  for (const m of imgs) console.log(`  - ${m.id}${m.provider_name ? `  ← ${m.provider_name}` : ''}`)
  if (imgs.length === 0) console.log('  （没有生图模型：平台没刷新模型，或上游没暴露 gpt-image-2）')
}

// ---------------------------------------------------------------- gen
async function cmdGen(prompt) {
  if (!prompt) throw new Error('用法：gen "提示词"')
  const body = {
    model: MODEL,
    prompt,
    n: Number(process.env.IMG_N || 1),
    size: process.env.IMG_SIZE || '1024x1024',
    response_format: 'b64_json',
    ...(process.env.IMG_QUALITY ? { quality: process.env.IMG_QUALITY } : {})
  }
  console.log(`[req] ${GW_BASE}/api/v1/images/generations model=${MODEL} size=${body.size}`)
  const { resp, ms } = await timedFetch(`${GW_BASE}/api/v1/images/generations`, {
    method: 'POST',
    headers: gwHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw new Error(await readError(resp))
  const json = await resp.json()
  printSaved(await saveImages(extractImages(json), 'gen'), ms)
}

// ---------------------------------------------------------------- edit
async function cmdEdit(srcPath, prompt) {
  if (!srcPath || !prompt) throw new Error('用法：edit <原图路径> "改动描述"')
  const buf = await readFile(resolve(srcPath))
  const form = new FormData()
  form.append('model', MODEL)
  form.append('prompt', prompt)
  form.append('n', String(Number(process.env.IMG_N || 1)))
  form.append('size', process.env.IMG_SIZE || '1024x1024')
  form.append('image', new Blob([buf], { type: guessMime(srcPath) }), basename(srcPath))
  console.log(`[req] ${GW_BASE}/api/v1/images/edits（multipart）`)
  const { resp, ms } = await timedFetch(`${GW_BASE}/api/v1/images/edits`, {
    method: 'POST',
    headers: gwHeaders({ 'Idempotency-Key': randomUUID() }),
    body: form
  }, TIMEOUT_MS)
  if (!resp.ok) throw new Error(await readError(resp))
  printSaved(await saveImages(extractImages(await resp.json()), 'edit'), ms)
}

function guessMime(p) {
  const e = extname(p).toLowerCase()
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.webp') return 'image/webp'
  return 'image/png'
}

// ---------------------------------------------------------------- onboard
// 直接调网关管理接口建平台：走「添加订阅」的 chatgpt-web 方案（image_only），
// base_url 指 chatgpt2api，再把 chatgpt2api 的 auth-key 作为平台 Key 塞进去。
// 带上 plan_id 是关键：服务端据此把 image_only 与模型清单按方案裁定，
// 而不是信客户端发来的 model_names。
const ONBOARD_MODELS = (process.env.WITH_ALT_IMAGES === '1'
  ? ['gpt-image-2', 'codex-gpt-image-2', 'gpt-image-1']
  : ['gpt-image-2'])

async function cmdOnboard() {
  if (!ADMIN_KEY) throw new Error('缺 ADMIN_KEY（网关管理密钥）')
  if (!C2A_KEY) throw new Error('缺 C2A_KEY（chatgpt2api 的 auth-key）')
  const baseUrl = process.env.C2A_BASE_URL || `${C2A_BASE}/v1`
  const models = ONBOARD_MODELS

  const list = await (await fetch(`${GW_BASE}/api/providers`, { headers: { 'X-Admin-Key': ADMIN_KEY } })).json()
  const exist = (Array.isArray(list) ? list : []).find((p) => p.base_url === baseUrl && IMAGE_MODEL_RE.test((p.models || []).map((m) => m.id).join(' ')))
  if (exist) {
    const r = await fetch(`${GW_BASE}/api/providers/${exist.id}`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, image_only: true, images_path: '/images/generations', model_names: models })
    })
    console.log(`[ok] 已更新现有平台 ${exist.name} (${exist.id})`)
    console.log(JSON.stringify(await r.json(), null, 2))
    return
  }

  const resp = await fetch(`${GW_BASE}/api/providers`, {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ChatGPT 网页版（chatgpt2api）· 生图',
      base_url: baseUrl,
      protocol: 'openai-chat',
      plan_id: 'chatgpt-web',
      image_only: true,
      images_path: '/images/generations',
      enabled: true,
      model_names: models
    })
  })
  if (!resp.ok) throw new Error(await readError(resp))
  const p = await resp.json()

  // Key 单独一条接口加：POST /api/providers 建平台时塞 api_key 那条路
  // 依赖前端把字段原样带上，走 keys 接口更确定，也方便之后追加更多号池 Key。
  const kresp = await fetch(`${GW_BASE}/api/providers/${p.id}/keys`, {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: C2A_KEY, name: 'chatgpt2api auth-key' })
  })
  if (!kresp.ok) throw new Error(`平台已建好 (${p.id})，但加 Key 失败：${await readError(kresp)}`)
  // 加 Key 的返回值可能是 provider 本身，也可能包在 {provider:…} 里，
  // 两种都认，最后以 key 数量为准做一次确认。
  const kr = await kresp.json().catch(() => ({}))
  const keyCount = (kr.provider || kr).keys?.length ?? 0
  if (keyCount === 0) throw new Error(`平台已建好 (${p.id})，但返回里没有 Key，检查 auth_key 是否为空`)

  console.log(`[ok] 已创建平台 ${p.name} (${p.id})，模型：${models.join(', ')}，Key ${keyCount} 个`)
  console.log(`[next] node scripts/chatgpt-image.mjs ping && node scripts/chatgpt-image.mjs gen "一只橘猫"`)
}

// ---------------------------------------------------------------- probe
// 直连 chatgpt2api，用来分辨「是网关转发坏了」还是「上游不认这些参数」。
// 依次试：标准生图接口 → 少 params 的最小请求 → 上游 /models 探测能力位。
async function cmdProbe() {
  if (!C2A_KEY) throw new Error('缺 C2A_KEY（chatgpt2api 的 auth-key）')
  const h = { Authorization: `Bearer ${C2A_KEY}`, 'Content-Type': 'application/json' }
  console.log(`# 1) 上游 /v1/models`)
  try {
    const { resp } = await timedFetch(`${C2A_BASE}/v1/models`, { headers: h }, 20000)
    console.log(resp.ok ? JSON.stringify(await resp.json()).slice(0, 1200) : await readError(resp))
  } catch (e) {
    console.log(`FAIL ${e.message}`)
  }
  const variants = [
    { label: '标准参数', body: { model: MODEL, prompt: 'a red apple on white background', n: 1, size: '1024x1024' } },
    { label: '最小参数', body: { model: MODEL, prompt: 'a red apple on white background' } }
  ]
  for (const v of variants) {
    console.log(`\n# 2) /v1/images/generations · ${v.label}`)
    try {
      const { resp, ms } = await timedFetch(`${C2A_BASE}/v1/images/generations`, { method: 'POST', headers: h, body: JSON.stringify(v.body) })
      if (!resp.ok) {
        console.log(`FAIL ${await readError(resp)}`)
        continue
      }
      const j = await resp.json()
      const imgs = extractImages(j)
      console.log(`OK ${ms}ms，解析到 ${imgs.length} 张，响应顶层键：${Object.keys(j || {}).join(',')}`)
      printSaved(await saveImages(imgs, `probe-${v.label}`), ms)
      return
    } catch (e) {
      console.log(`FAIL ${e.message}`)
    }
  }
}

// ---------------------------------------------------------------- main
const [cmd, ...rest] = process.argv.slice(2)
const table = {
  ping: cmdPing,
  models: cmdModels,
  gen: () => cmdGen(rest.join(' ').trim()),
  edit: () => cmdEdit(rest[0], rest.slice(1).join(' ').trim()),
  onboard: cmdOnboard,
  probe: cmdProbe
}

const fn = table[cmd]
if (!fn) {
  console.log(`用法：
  node scripts/chatgpt-image.mjs ping                  探活
  node scripts/chatgpt-image.mjs models                列出网关里的生图模型
  node scripts/chatgpt-image.mjs gen "一只橘猫"          文生图
  node scripts/chatgpt-image.mjs edit <原图> "加顶帽子"    图编辑
  node scripts/chatgpt-image.mjs onboard               在网关建「只生图」平台
  node scripts/chatgpt-image.mjs probe                 直连上游探参数兼容性`)
  process.exit(cmd ? 1 : 0)
}

try {
  await fn()
} catch (e) {
  console.error(`[fail] ${e.message}`)
  process.exit(1)
}
