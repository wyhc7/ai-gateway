// ZEN_AUTOSEED 是模型预填的最后一条入口：它在启动时自动开出来的通道，
// 原本会把模板里的 8 个默认模型一并塞进去。用户的要求是「所有预填都不要」——
// 自动开通道可以，自动填模型不行，否则手工建的和自动播种出来的口径就不一致了。
// 模型一律等用户点「刷新」，按上游实际结果填。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const ADMIN_KEY = 'ak-seed-test'

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

test('ZEN_AUTOSEED 播种出来的通道模型留空，不预填', { timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-seed-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      WEB_DIST: join(dataDir, 'no-such-dist'),
      ZEN_AUTOSEED: '1'
    },
    stdio: 'ignore'
  })

  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')

    const r = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    assert.equal(r.status, 200)
    const providers = await r.json()
    const zen = providers.find((p) => p.protocol === 'zen-free')
    assert.ok(zen, 'ZEN_AUTOSEED=1 应当创建出 OpenCode Zen 通道')
    assert.deepEqual(zen.models, [], '播种出来的通道不该自带模型，等用户点「刷新」')
  } finally {
    child.kill()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
