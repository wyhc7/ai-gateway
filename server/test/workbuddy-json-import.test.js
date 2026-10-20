// WorkBuddy 登录态 JSON 批量导入的 HTTP 契约测试。
//
// 三条契约都在真实网关上钉住：
// 1. 按域名分流：国内域进国内版平台、国际域（workbuddy.ai / codebuddy.ai）
//    进国际版平台——混合数组一次导入，不按用户从哪个平台点进来决定
// 2. 同一 uid 重复导入 = 更新 token（清冷却与旧错误），不堆重复 Key
// 3. 单条失败不拖垮整批：坏条目、无对应平台的条目各自失败并说明原因
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'ak-wb-json-import-test'

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function startGateway(port, dataDir) {
  return spawn('node', ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      WEB_DIST: join(dataDir, 'no-such-dist')
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

function api(port, path, { method = 'GET', body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function withGateway(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-wb-json-'))
  const port = await freePort()
  const child = startGateway(port, dataDir)
  try {
    assert.ok(await waitReady(port), '网关未在超时内就绪')
    await fn(port)
  } finally {
    child.kill()
  }
}

/** 建两个平台的 WorkBuddy（国内 + 国际），返回 { cnId, intlId } */
async function createBothPlatforms(port) {
  const cn = await (await api(port, '/api/providers', {
    method: 'POST',
    body: { name: 'WB国内', base_url: 'https://copilot.tencent.com', protocol: 'workbuddy-oauth' }
  })).json()
  const intl = await (await api(port, '/api/providers', {
    method: 'POST',
    body: { name: 'WB国际', base_url: 'https://www.workbuddy.ai', protocol: 'workbuddy-oauth', workbuddy_region: 'intl' }
  })).json()
  return { cnId: cn.id, intlId: intl.id }
}

const importJson = (port, entries) => api(port, '/api/providers/import-workbuddy-json', { method: 'POST', body: { entries } })

/** 取某平台的全部 Key（走平台列表，序列化后不含明文 token） */
async function keysOf(port, providerId) {
  const list = await (await api(port, '/api/providers')).json()
  const p = list.find((x) => x.id === providerId)
  return p.keys || []
}

test('WorkBuddy 登录态 JSON 批量导入', async () => {
  await withGateway(async (port) => {
    const { cnId, intlId } = await createBothPlatforms(port)

    // 1. 混合 realm 的数组一次导入，按各自域名分流
    const r1 = await importJson(port, [
      { name: '国内甲', access_token: 'at-cn-1', refresh_token: 'rt-cn-1', uid: 'uid-cn-1', domain: 'www.codebuddy.cn' },
      { name: '全球乙', access_token: 'at-gl-1', uid: 'uid-gl-1', domain: 'workbuddy.ai' },
      { name: '国际丙', access_token: 'at-in-1', uid: 'uid-in-1', domain: 'www.codebuddy.ai' }
    ])
    assert.equal(r1.status, 200)
    const b1 = await r1.json()
    assert.equal(b1.added, 3)
    assert.equal(b1.updated, 0)
    assert.equal(b1.failed, 0)
    const byUid = Object.fromEntries(b1.results.map((x) => [x.uid, x]))
    assert.equal(byUid['uid-cn-1'].realm, 'cn')
    assert.equal(byUid['uid-cn-1'].provider, 'WB国内')
    assert.equal(byUid['uid-gl-1'].realm, 'global')
    assert.equal(byUid['uid-gl-1'].provider, 'WB国际')
    // codebuddy.ai 判 intl，同样落国际版平台（接入地址已迁到 workbuddy.ai）
    assert.equal(byUid['uid-in-1'].realm, 'intl')
    assert.equal(byUid['uid-in-1'].provider, 'WB国际')

    // 落地校验：国内平台 1 个、国际平台 2 个
    const cnKeys = await keysOf(port, cnId)
    const intlKeys = await keysOf(port, intlId)
    assert.equal(cnKeys.length, 1)
    assert.equal(cnKeys[0].uid, 'uid-cn-1')
    assert.equal(intlKeys.length, 2)
    assert.deepEqual(intlKeys.map((k) => k.uid).sort(), ['uid-gl-1', 'uid-in-1'])

    // 2. 同一 uid 重复导入 = 更新，不堆重复 Key
    //    先给国内那个 Key 制造一个冷却 + 旧错误，验证更新时被清零
    const put = await api(port, `/api/providers/${cnId}/keys/${cnKeys[0].id}`, {
      method: 'PUT',
      body: { cooldown_until: Date.now() + 600000, last_error: '旧账：上游 401', last_error_at: Date.now() }
    })
    assert.equal(put.status, 200)

    const r2 = await importJson(port, [
      { access_token: 'at-cn-1-rotated', refresh_token: 'rt-cn-1-new', uid: 'uid-cn-1', domain: 'www.codebuddy.cn' }
    ])
    const b2 = await r2.json()
    assert.equal(b2.added, 0)
    assert.equal(b2.updated, 1)
    assert.equal(b2.results[0].status, 'updated')

    const cnKeys2 = await keysOf(port, cnId)
    assert.equal(cnKeys2.length, 1, '同一 uid 再导入不能堆出第二个 Key')
    // token 已换新 + 冷却/旧错误清零（序列化不吐明文，用 reset 端点旁证太绕，
    // 直接读数据文件不可取——这里验行为：Key 数量不变且没有冷却徽章数据）
    assert.equal(cnKeys2[0].last_error, null, '更新时要清掉旧错误，别让新 token 背旧账')
    assert.ok(!cnKeys2[0].cooldown_until || cnKeys2[0].cooldown_until < Date.now(), '更新时要清掉冷却')

    // 3. 坏条目单条失败，不拖垮整批
    const r3 = await importJson(port, [
      { access_token: 'at-ok', uid: 'uid-ok-1', domain: 'www.codebuddy.cn' },
      { access_token: '', uid: 'uid-bad', domain: 'www.codebuddy.cn' },
      { access_token: 'at-no-uid', uid: '', domain: 'www.codebuddy.cn' },
      { not: 'a login state' }
    ])
    const b3 = await r3.json()
    assert.equal(b3.added, 1)
    assert.equal(b3.failed, 3)
    for (const res of b3.results.filter((x) => x.status === 'failed')) {
      assert.ok(res.error, '失败必须带原因')
    }
    assert.equal((await keysOf(port, cnId)).length, 2)

    // 4. 空 domain 按国内兜底（与 normalizeWorkbuddyDomain 一致）
    const r4 = await importJson(port, [{ access_token: 'at-nodomain', uid: 'uid-nodomain', domain: '' }])
    const b4 = await r4.json()
    assert.equal(b4.added, 1)
    assert.equal(b4.results[0].realm, 'cn')
    assert.equal(b4.results[0].provider, 'WB国内')

    // 5. expires_in（剩余秒数）换算成 expires_at
    const r5 = await importJson(port, [{ access_token: 'at-exp', uid: 'uid-exp', domain: 'www.codebuddy.cn', expires_in: 3600 }])
    assert.equal((await r5.json()).added, 1)
    const expKey = (await keysOf(port, cnId)).find((k) => k.uid === 'uid-exp')
    assert.ok(expKey.expires_at > Date.now() + 3000000 && expKey.expires_at <= Date.now() + 3600000, 'expires_in 应按剩余秒数换算')

    // 6. 空 entries 直接 400
    const r6 = await importJson(port, [])
    assert.equal(r6.status, 400)
  })
})

test('没有对应版本的平台时该账号失败，其它账号不受影响', async () => {
  await withGateway(async (port) => {
    // 只建国内平台
    const cn = await (await api(port, '/api/providers', {
      method: 'POST',
      body: { name: '只有国内', base_url: 'https://copilot.tencent.com', protocol: 'workbuddy-oauth' }
    })).json()

    const r = await importJson(port, [
      { access_token: 'at-cn', uid: 'uid-cn', domain: 'www.codebuddy.cn' },
      { access_token: 'at-intl', uid: 'uid-intl', domain: 'workbuddy.ai' }
    ])
    const b = await r.json()
    assert.equal(b.added, 1)
    assert.equal(b.failed, 1)
    const failed = b.results.find((x) => x.status === 'failed')
    assert.equal(failed.uid, 'uid-intl')
    assert.match(failed.error, /国际版/)
  })
})

test('平台停用时不作为导入目标', async () => {
  await withGateway(async (port) => {
    const { cnId } = await createBothPlatforms(port)
    // 把国内平台停用
    await api(port, `/api/providers/${cnId}`, { method: 'PUT', body: { enabled: false } })

    const r = await importJson(port, [{ access_token: 'at-cn', uid: 'uid-cn', domain: 'www.codebuddy.cn' }])
    const b = await r.json()
    assert.equal(b.added, 0)
    assert.equal(b.failed, 1)
    assert.match(b.results[0].error, /国内版/)
  })
})
