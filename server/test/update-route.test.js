// 更新接口的线上形状测试。
//
// 为什么单开一层：update.js 的单元测试直接调函数，验不到「HTTP 响应里到底有没有这些
// 字段」，也验不到「更新失败时前端能不能拿到步骤日志」这条契约。上一版刷新接口就是
// 服务层对了、路由层把字段丢掉。所以这里拉起真实网关进程，真发 HTTP。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-update-route-test'

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function gitAt(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout.trim()
}

/** 裸库当远程 + 工作库当部署目录；上游领先 1 个提交，工作区干净 */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gw-update-route-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')

  await gitAt(['init', '-q', '--bare', origin])
  await gitAt(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin)

  await gitAt(['init', '-q', work])
  await gitAt(['symbolic-ref', 'HEAD', 'refs/heads/main'], work)
  await gitAt(['config', 'user.email', 'test@example.com'], work)
  await gitAt(['config', 'user.name', 'Test'], work)
  await gitAt(['config', 'commit.gpgsign', 'false'], work)

  writeFileSync(join(work, 'README.md'), '# fixture\n')
  await gitAt(['add', '-A'], work)
  await gitAt(['commit', '-q', '-m', 'init'], work)
  const first = await gitAt(['rev-parse', 'HEAD'], work)
  await gitAt(['remote', 'add', 'origin', origin], work)
  await gitAt(['push', '-q', '-u', 'origin', 'main'], work)

  mkdirSync(join(work, 'server'), { recursive: true })
  writeFileSync(join(work, 'server', 'from-upstream.js'), 'export const ok = true\n')
  await gitAt(['add', '-A'], work)
  await gitAt(['commit', '-q', '-m', 'feat: 上游新增了一个后端文件'], work)
  const upstream = await gitAt(['rev-parse', 'HEAD'], work)
  await gitAt(['push', '-q', 'origin', 'main'], work)
  await gitAt(['reset', '--hard', '-q', first], work)

  return { root, work, first, upstream }
}

function startGateway(port, dataDir, repoDir) {
  return spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      WEB_DIST: join(dataDir, 'no-such-dist'),
      ZEN_AUTOSEED: '0',
      UPDATE_REPO_DIR: repoDir,
      UPDATE_BRANCH: 'main',
      UPDATE_SERVICE: 'gw-update-route-test',
      // 这条是安全阀：测试绝不允许真的去重启服务器上的服务
      UPDATE_NO_RESTART: '1'
    },
    stdio: 'ignore'
  })
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function api(port, path, { method = 'GET', adminKey = ADMIN_KEY } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: adminKey ? { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
  })
}

test('更新接口：检查与更新都走管理鉴权，失败时也把步骤日志透传到响应里', { timeout: 90000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-update-route-'))
  const f = await fixture()
  const port = await freePort()
  const child = startGateway(port, dataDir, f.work)

  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')

    // —— 鉴权：更新接口能改服务器代码，绝不能匿名可达 ——
    assert.equal((await api(port, '/api/update/check', { adminKey: null })).status, 401)
    assert.equal((await api(port, '/api/update/apply', { method: 'POST', adminKey: null })).status, 401)

    // —— 检查：界面渲染所需的字段一个都不能少 ——
    const checked = await api(port, '/api/update/check?force=1')
    assert.equal(checked.status, 200)
    const r = await checked.json()

    for (const field of ['ok', 'current', 'latest', 'has_update', 'behind', 'commits', 'files', 'areas', 'plan', 'can_update', 'restart']) {
      assert.ok(field in r, `HTTP 响应必须带上 ${field} 字段`)
    }
    assert.equal(r.ok, true)
    assert.equal(r.has_update, true)
    assert.equal(r.behind, 1)
    assert.equal(r.can_update, true)
    assert.equal(r.current.short, f.first.slice(0, 7))
    assert.equal(r.latest.short, f.upstream.slice(0, 7))
    assert.equal(r.commits[0].subject, 'feat: 上游新增了一个后端文件')
    assert.deepEqual(r.files.paths, ['server/from-upstream.js'])
    assert.deepEqual(r.areas, [{ key: 'server', label: '后端', count: 1 }])
    assert.equal(r.plan.buildWeb, false, '只改后端不该安排前端构建')
    assert.equal(r.restart.auto, false, 'UPDATE_NO_RESTART=1 时不该自动重启')

    // —— 工作区脏：能查出原因，且更新被拒 ——
    writeFileSync(join(f.work, 'README.md'), '# 本地改过了\n')
    const dirty = await (await api(port, '/api/update/check?force=1')).json()
    assert.equal(dirty.can_update, false)
    assert.match(dirty.blocked_reason, /README\.md/)

    // 更新失败必须回 200 且带 steps：请求没出错，出错的是更新过程，
    // 前端要靠步骤日志指出卡在哪一步，走 error.message 会把细节丢光。
    const blocked = await api(port, '/api/update/apply', { method: 'POST' })
    assert.equal(blocked.status, 200, '更新失败也应回 200，让前端拿到完整步骤')
    const blockedBody = await blocked.json()
    assert.equal(blockedBody.ok, false)
    assert.ok(Array.isArray(blockedBody.steps) && blockedBody.steps.length > 0)
    assert.equal(blockedBody.steps.at(-1).ok, false)
    assert.equal(existsSync(join(f.work, 'server', 'from-upstream.js')), false, '被拒时不该把上游文件带进来')

    // —— 清干净后真的更新成功 ——
    await gitAt(['checkout', '--', 'README.md'], f.work)
    const applied = await api(port, '/api/update/apply', { method: 'POST' })
    assert.equal(applied.status, 200)
    const a = await applied.json()
    assert.equal(a.ok, true)
    assert.equal(a.from, f.first.slice(0, 7))
    assert.equal(a.to, f.upstream.slice(0, 7))
    assert.deepEqual(a.steps.map((s) => s.name), ['拉取远程代码', '合并代码', '构建管理界面', '重启服务'])
    assert.equal(existsSync(join(f.work, 'server', 'from-upstream.js')), true)

    // —— 更新完再查一次：应变成已是最新，且不再有可更新内容 ——
    const after = await (await api(port, '/api/update/check?force=1')).json()
    assert.equal(after.has_update, false)
    assert.equal(after.current.short, f.upstream.slice(0, 7))
  } finally {
    child.kill()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(f.root, { recursive: true, force: true })
  }
})
