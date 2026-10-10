// WorkBuddy 扫码授权的登录流测试
//
// 钉四件事：
//  1. cookie 会话必须随 state 在服务端存着并原样带回 —— 上游把浏览器登录与
//     auth/state 签发的 state 绑在一起，丢一个 cookie 这条会话就永远轮询不到凭据
//  2. 「还在登录中」要判成 pending，不能误报成错误
//  3. 拿不到 uid 时不许返回 done —— 网关的 X-User-Id 离不开它，空 uid 入库
//     等于存一个必定 401 的凭据
//  4. 发起登录时带上 CLI 指纹头（UA / Origin / X-Requested-With），否则可能被上游当爬虫拦
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'gw-wblogin-'))
process.env.DATA_DIR = dataDir

const { startWorkbuddyLogin, pollWorkbuddyLogin, cancelWorkbuddyLogin } = await import('../workbuddy-oauth.js')

// 用例中途断言失败会跳过末尾的收尾，端口一直监听着，node --test 就永远不退出
// （表现为「测试卡死、一点输出都没有」）。统一登记、退出时兜底关。
const openServers = []

function startUpstream(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      await handler({ req, res, body: raw ? JSON.parse(raw) : null })
    } catch (err) {
      if (!res.writableEnded) res.writeHead(500).end(String(err))
    }
  })
  openServers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

after(() => {
  for (const s of openServers) {
    s.closeAllConnections?.()
    s.close()
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(payload))
}

// 三段式 mock：发 state → 轮询 token（前 tokenRound-1 次回「登录中」，之后发凭据）→ 取账号。
// 返回 seen，供断言请求头与 cookie 是否原样带回。
function makeUpstream(state, { onAccount = true, tokenRound = 1 } = {}) {
  const seen = { stateHeaders: [], tokenCookie: null, round: 0 }
  const handler = ({ req, res }) => {
    if (req.url.startsWith('/v2/plugin/auth/state')) {
      seen.stateHeaders.push(req.headers)
      json(res, 200,
        { code: 0, msg: 'ok', data: { state, authUrl: `https://www.codebuddy.cn/login?state=${state}` } },
        { 'Set-Cookie': `gw_sid=${state}; Path=/; HttpOnly` })
      return
    }
    if (req.url.startsWith('/v2/plugin/auth/token')) {
      seen.tokenCookie = req.headers.cookie || null
      seen.round += 1
      if (seen.round < tokenRound) {
        // 上游「还没登录完」的真实形态：业务码非 0，不是 HTTP 错误
        json(res, 200, { code: 1001, msg: 'login ing', data: null })
        return
      }
      json(res, 200, {
        code: 0, msg: 'ok',
        data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600, refreshExpiresIn: 86400, domain: 'workbuddy.ai' }
      })
      return
    }
    if (req.url.startsWith('/v2/plugin/login/account')) {
      if (!onAccount) return json(res, 401, { code: 401, msg: 'unauthorized', data: null })
      json(res, 200, { code: 0, msg: 'ok', data: { uid: 'u-7788', enterpriseId: 'e-1', nickname: 'YG' } })
      return
    }
    json(res, 404, { code: 404, msg: 'not found', data: null })
  }
  return startUpstream(handler).then((r) => ({ ...r, seen }))
}

describe('扫码登录 · 发起', () => {
  test('拿到 state 与登录页地址，会话带过期时间', async () => {
    const { base } = await makeUpstream('st-a')
    const flow = await startWorkbuddyLogin({ base, providerId: 'prov-1', name: '账号A' })
    assert.equal(flow.state, 'st-a')
    assert.equal(flow.auth_url, 'https://www.codebuddy.cn/login?state=st-a')
    assert.ok(flow.expires_at > Date.now(), '登录会话必须有过期时间，否则会一直挂在服务端')
    cancelWorkbuddyLogin(flow.state)
  })

  test('带上 CLI 指纹头，别被上游当爬虫拦掉', async () => {
    const { base, seen } = await makeUpstream('st-hdr')
    await startWorkbuddyLogin({ base })
    const h = seen.stateHeaders[0]
    assert.ok(h, '发起登录没打到上游')
    assert.match(h['user-agent'] || '', /CodeBuddy/)
    assert.equal(h['x-requested-with'], 'XMLHttpRequest')
    assert.match(h.origin || '', /codebuddy\.cn/)
    assert.match(h.referer || '', /codebuddy\.cn/)
    cancelWorkbuddyLogin('st-hdr')
  })
})

describe('扫码登录 · 轮询', () => {
  test('轮询必须带回发 state 时的 cookie，否则上游认不出这条会话', async () => {
    const { base, seen } = await makeUpstream('st-cookie', { tokenRound: 2 })
    await startWorkbuddyLogin({ base })
    const r = await pollWorkbuddyLogin('st-cookie')
    assert.equal(r.status, 'pending', '第一轮还没登录完，应判成等待')
    assert.match(seen.tokenCookie || '', /gw_sid=st-cookie/, '轮询没带上会话 cookie，登录态会丢')
    cancelWorkbuddyLogin('st-cookie')
  })

  test('登录完成后拿到完整凭据，状态随即清掉（同一条 state 不能领两次）', async () => {
    const { base } = await makeUpstream('st-done', { tokenRound: 2 })
    await startWorkbuddyLogin({ base, providerId: 'prov-9', name: '扫码绑定' })
    assert.equal((await pollWorkbuddyLogin('st-done')).status, 'pending')

    const r = await pollWorkbuddyLogin('st-done')
    assert.equal(r.status, 'done')
    assert.equal(r.provider_id, 'prov-9')
    assert.equal(r.credential.uid, 'u-7788', 'uid 是 X-User-Id 头的来源，缺了整条通道调不通')
    assert.equal(r.credential.access_token, 'at-1')
    assert.equal(r.credential.refresh_token, 'rt-1')
    assert.equal(r.credential.domain, 'workbuddy.ai')
    assert.equal(r.credential.name, '扫码绑定')
    assert.ok(r.credential.expires_at > Date.now())

    // 凭据已领走：再轮询同一条 state 必须报错，不能重复入库
    assert.equal((await pollWorkbuddyLogin('st-done')).status, 'error')
  })

  test('取不到 uid 时不返回 done', async () => {
    const { base } = await makeUpstream('st-nouid', { onAccount: false, tokenRound: 2 })
    await startWorkbuddyLogin({ base })
    assert.equal((await pollWorkbuddyLogin('st-nouid')).status, 'pending')
    const r = await pollWorkbuddyLogin('st-nouid')
    assert.equal(r.status, 'error')
    assert.match(r.message, /uid/)
  })

  test('上游 5xx 是真错误，不当成还在等', async () => {
    const { base } = await startUpstream(({ req, res }) => {
      if (req.url.startsWith('/v2/plugin/auth/state')) {
        json(res, 200, { code: 0, data: { state: 'st-5xx', authUrl: 'https://www.codebuddy.cn/login' } })
        return
      }
      json(res, 503, { code: 503, msg: 'unavailable', data: null })
    })
    await startWorkbuddyLogin({ base })
    const r = await pollWorkbuddyLogin('st-5xx')
    assert.equal(r.status, 'error')
    assert.match(r.message, /503/)
  })

  test('未知 state 明确报错，提示重新发起', async () => {
    const r = await pollWorkbuddyLogin('state-that-never-existed')
    assert.equal(r.status, 'error')
    assert.match(r.message, /重新发起/)
  })
})

describe('扫码登录 · 取消', () => {
  test('取消后会话立即失效', async () => {
    const { base } = await makeUpstream('st-cancel')
    await startWorkbuddyLogin({ base })
    assert.equal(cancelWorkbuddyLogin('st-cancel'), true, '存在的会话应被取消')
    assert.equal((await pollWorkbuddyLogin('st-cancel')).status, 'error')
    assert.equal(cancelWorkbuddyLogin('st-cancel'), false, '已取消的会话不该再报成功')
  })

  test('取消不存在的 state 不抛错', () => {
    assert.equal(cancelWorkbuddyLogin('never-existed'), false)
  })
})
