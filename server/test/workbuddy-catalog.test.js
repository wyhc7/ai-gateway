// WorkBuddy 积分倍率的契约测试
//
// 钉三件事：
//  1. 倍率原样保留上游的 "x0.79" 形态，不自行换算；
//  2. UA 必须是 CodeBuddyIDE——CLI UA 拿到的是削减表；
//  3. 倍率取不到不该影响模型清单（它只是展示信息）。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const { workbuddyRateValue, fetchWorkbuddyModelRates, WORKBUDDY_V3_UA } = await import('../workbuddy-catalog.js')

function startUpstream(handler) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => handler({ req, res, raw }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// 上游真实形态（2026-10-10 实测 /v3/config）：带前缀的字符串
const SAMPLE = {
  code: 0,
  data: {
    models: [
      { id: 'glm-5.3', credits: 'x0.79' },
      { id: 'hy3', credits: 'x0.00' },
      { id: 'deepseek-v4-pro', credits: 'x0.51' },
      // auto 的倍率是浮动的，上游就不给固定值
      { id: 'auto', descriptionZh: '积分倍率随之浮动' },
      { id: 'hy3-x', credits: '' }
    ]
  }
}

describe('倍率取值', () => {
  test('带前缀的字符串按数字解析，零也算零', () => {
    assert.equal(workbuddyRateValue('x0.79'), 0.79)
    assert.equal(workbuddyRateValue('X0.5'), 0.5)
    assert.equal(workbuddyRateValue('×0.29'), 0.29)
    assert.equal(workbuddyRateValue('x0.00'), 0)
    assert.equal(workbuddyRateValue(0.25), 0.25)
  })

  test('空值与乱码返回 null，不能当成 0（0 是「免费」的语义）', () => {
    assert.equal(workbuddyRateValue(''), null)
    assert.equal(workbuddyRateValue('   '), null)
    assert.equal(workbuddyRateValue(null), null)
    assert.equal(workbuddyRateValue(undefined), null)
    assert.equal(workbuddyRateValue('n/a'), null)
  })
})

describe('倍率获取', () => {
  test('只收有倍率的模型，缺值的（auto）不塞 0 进去', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SAMPLE))
    })
    try {
      const { rates, count } = await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' })
      assert.equal(count, 3)
      assert.equal(rates['glm-5.3'], 'x0.79')
      assert.equal(rates.hy3, 'x0.00')
      assert.equal(rates['deepseek-v4-pro'], 'x0.51')
      assert.equal('auto' in rates, false)
      assert.equal('hy3-x' in rates, false)
    } finally {
      server.close()
    }
  })

  test('必须自称 CodeBuddyIDE，CLI UA 拿到的是削减表', async () => {
    let seen = null
    const { server, base } = await startUpstream(({ req, res }) => {
      seen = { ua: req.headers['user-agent'], domain: req.headers['x-domain'], uid: req.headers['x-user-id'] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SAMPLE))
    })
    try {
      await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn', uid: 'u-1' })
      assert.equal(seen.ua, WORKBUDDY_V3_UA)
      assert.match(seen.ua, /CodeBuddyIDE/)
      assert.equal(seen.domain, 'www.codebuddy.cn')
      assert.equal(seen.uid, 'u-1')
    } finally {
      server.close()
    }
  })

  test('跨 realm 回 HTML 时给出可诊断的错误，不抛 parse failed', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(401, { 'Content-Type': 'text/html' })
      res.end('<html>401</html>')
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x', domain: 'workbuddy.ai' }),
        /非 JSON/
      )
    } finally {
      server.close()
    }
  })

  test('信封报错时抛上游消息', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 1101, msg: '登录态失效' }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x' }),
        /登录态失效/
      )
    } finally {
      server.close()
    }
  })

  test('响应缺 data.models 时报错，不静默返回空表', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: {} }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x' }),
        /data\.models/
      )
    } finally {
      server.close()
    }
  })
})
