// UI 冒烟：WorkBuddy 登录态 JSON 批量导入弹窗
// 起真实网关（WEB_DIST 指向刚构建的 dist）→ 建两个平台 → 无头浏览器
// → 注入 admin key → 点「导入 JSON」→ 粘贴混合 realm 数组 → 解析预览 → 导入 → 校验结果与 Key 列表
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const ADMIN_KEY = 'ak-wb-json-ui-test'

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const dataDir = mkdtempSync(join(tmpdir(), 'gw-wb-json-ui-'))
const port = await freePort()
const child = spawn('node', ['index.js'], {
  cwd: join(ROOT, 'server'),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_KEY, WEB_DIST: join(ROOT, 'web/dist') },
  stdio: 'ignore'
})

const api = (path, { method = 'GET', body } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method,
  headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
})

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

try {
  if (!await waitReady()) throw new Error('网关未就绪')
  // 两个平台：国内 + 国际
  await (await api('/api/providers', { method: 'POST', body: { name: 'UI国内版', base_url: 'https://copilot.tencent.com', protocol: 'workbuddy-oauth' } })).json()
  await (await api('/api/providers', { method: 'POST', body: { name: 'UI国际版', base_url: 'https://www.workbuddy.ai', protocol: 'workbuddy-oauth', workbuddy_region: 'intl' } })).json()

  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.addInitScript((key) => {
    localStorage.setItem('admin-key', key)
  }, ADMIN_KEY)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`http://127.0.0.1:${port}/#/providers`, { waitUntil: 'load' })
  await page.waitForSelector('.el-button', { timeout: 10000 })

  // 展开国内版平台卡片（点平台名）
  await page.getByText('UI国内版').first().click()
  await page.waitForTimeout(500)

  // 「导入 JSON」按钮存在且可点
  const jsonBtn = page.getByRole('button', { name: '导入 JSON' }).first()
  await jsonBtn.waitFor({ state: 'visible', timeout: 8000 })
  await jsonBtn.click()
  await page.waitForTimeout(400)

  const dlg = page.locator('.el-dialog').filter({ hasText: '导入 WorkBuddy 登录态 JSON' })
  await dlg.waitFor({ state: 'visible', timeout: 5000 })

  // 粘贴混合 realm 数组（含一个坏条目）
  const mixed = JSON.stringify([
    { auth: { accessToken: 'at-cn-ui-1', refreshToken: 'rt-cn-ui-1', domain: 'www.codebuddy.cn' }, account: { uid: 'uid-ui-cn-1' } },
    { auth: { accessToken: 'at-gl-ui-1', domain: 'workbuddy.ai' }, account: { uid: 'uid-ui-gl-1' } },
    { auth: { accessToken: 'at-bad' } }
  ])
  await dlg.locator('textarea').fill(mixed)
  await dlg.getByRole('button', { name: '解析粘贴内容' }).click()
  await page.waitForTimeout(400)

  // 预览：2 个好条目 + 1 条坏条目报错
  const previewCount = await dlg.locator('.wb-json-entry').count()
  console.log('预览条目数:', previewCount)
  const parseErr = await dlg.locator('.wb-json-error').first().textContent().catch(() => '')
  console.log('解析提示:', parseErr.trim())
  const realms = await dlg.locator('.wb-json-preview .badge').allTextContents()
  console.log('realm 徽章:', realms.join(','))

  // 执行导入
  await dlg.getByRole('button', { name: /导入 \d+ 个账号/ }).click()
  await page.waitForTimeout(1200)
  const resultText = await dlg.locator('.wb-json-results .section-title').textContent().catch(() => '')
  console.log('结果标题:', resultText.trim())
  const resultRows = await dlg.locator('.wb-json-results .wb-json-entry').count()
  console.log('结果行数:', resultRows)

  // 关掉弹窗，看 Key 列表：国内平台 1 个、国际平台 1 个
  await dlg.getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForTimeout(400)
  await page.getByText('UI国际版').first().click()
  await page.waitForTimeout(500)
  const intlKeys = await page.locator('.provider-card').filter({ hasText: 'UI国际版' }).locator('.key-item').count()
  console.log('国际版平台 Key 数:', intlKeys)

  // 服务端最终校验
  const list = await (await api('/api/providers')).json()
  for (const p of list) {
    console.log(`平台 ${p.name}: ${p.keys.length} 个 Key ->`, p.keys.map((k) => `${k.name}[${k.uid}]`).join(', '))
  }

  const ok = previewCount === 2 && realms.includes('国内') && realms.includes('全球')
    && resultRows === 2 && intlKeys === 1
    && list.find((p) => p.name === 'UI国内版').keys.length === 1
    && list.find((p) => p.name === 'UI国际版').keys.length === 1
  console.log(ok ? '\nUI 冒烟通过' : '\nUI 冒烟失败')
  await browser.close()
  process.exitCode = ok ? 0 : 1
} finally {
  child.kill()
}
