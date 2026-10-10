// WorkBuddy 签到的契约测试
//
// 钉三件事：
//  1. 上游两代字段命名并存，只认一代会让某些账号永远显示「未签到」；
//  2. 计费面回 HTML（realm 不匹配 / 凭据失效）时，错误要说得出所以然，
//     不能让上层报出一个 "parse failed: invalid character" 就完事；
//  3. 签到日按北京时间算——网关跑在 UTC 机器上时，本地日期会在凌晨判错天。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const {
  parseCheckinStatus,
  fetchWorkbuddyCheckinStatus,
  performWorkbuddyCheckin,
  workbuddyBillingHeaders,
  beijingDayKey,
  packageBalance,
  fetchWorkbuddyCredits
} = await import('../workbuddy-checkin.js')

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

describe('签到状态解析', () => {
  test('驼峰与下划线两代字段名都认', () => {
    const a = parseCheckinStatus({
      code: 0,
      data: { todayCheckedIn: true, streakDays: 3, dailyCredit: 30, todayCredit: 30, active: true }
    })
    assert.equal(a.checked_in, true)
    assert.equal(a.streak_days, 3)
    assert.equal(a.daily_credit, 30)

    const b = parseCheckinStatus({
      code: 0,
      data: { today_checked_in: true, week_checkin_days: 5, checkin_dates: ['2026-10-01'] }
    })
    assert.equal(b.checked_in, true)
    assert.equal(b.streak_days, 5)
    assert.deepEqual(b.dates, ['2026-10-01'])
  })

  test('active:false 单独可辨——国际版账号常见，不能当成可签', () => {
    const s = parseCheckinStatus({ code: 0, data: { active: false, todayCheckedIn: false } })
    assert.equal(s.active, false)
    assert.equal(s.checked_in, false)
  })

  test('缺字段时按未签处理，不因为空对象而崩', () => {
    const s = parseCheckinStatus({ code: 0, data: {} })
    assert.equal(s.checked_in, false)
    assert.equal(s.streak_days, 0)
    assert.equal(s.active, true)
  })
})

describe('计费面头', () => {
  test('国际版要 IDE 头集且不要 X-Requested-With，否则被当浏览器弹回 401', () => {
    const h = workbuddyBillingHeaders({ access_token: 't', domain: 'www.codebuddy.ai', uid: 'u1' })
    assert.equal(h['X-Requested-With'], undefined)
    assert.equal(h['X-IDE-Type'], 'IDE')
    assert.equal(h['X-IDE-Version'], '1.100.0')
    assert.equal(h['X-User-Id'], 'u1')
    assert.equal(h.Authorization, 'Bearer t')
  })

  test('国内账号不带国际版那套头', () => {
    const h = workbuddyBillingHeaders({ access_token: 't', domain: 'www.codebuddy.cn' })
    assert.equal(h['X-IDE-Type'], undefined)
    assert.equal(h['X-User-Id'], undefined)
    assert.equal(h['X-Domain'], 'www.codebuddy.cn')
  })
})

describe('计费调用', () => {
  test('上游回 HTML 时给出可诊断的错误，不抛 parse failed', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(401, { 'Content-Type': 'text/html' })
      res.end('<html><body>401</body></html>')
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyCheckinStatus({ billing_base: base, access_token: 'x', domain: 'workbuddy.ai' }),
        /非 JSON/
      )
    } finally {
      server.close()
    }
  })

  test('业务码非 0 时如实抛上游消息，调用方按「今日已签到」处理', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 409, msg: '今日已签到' }))
    })
    try {
      await assert.rejects(
        () => performWorkbuddyCheckin({ billing_base: base, access_token: 'x' }),
        /今日已签到/
      )
    } finally {
      server.close()
    }
  })

  test('领取成功返回 data，信封被剥掉', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { granted: 30 } }))
    })
    try {
      const out = await performWorkbuddyCheckin({ billing_base: base, access_token: 'x' })
      assert.equal(out.granted, 30)
    } finally {
      server.close()
    }
  })
})

describe('签到日', () => {
  test('按北京时间算，UTC 机器上不能把今天判成昨天', () => {
    // 2026-10-01 23:30 UTC → 北京 10-02 07:30
    assert.equal(beijingDayKey(Date.parse('2026-10-01T23:30:00Z')), '2026-10-02')
    // 2026-10-01 16:00 UTC → 北京 10-02 00:00（刚跨天，不能还算 10-01）
    assert.equal(beijingDayKey(Date.parse('2026-10-01T16:00:00Z')), '2026-10-02')
    // 2026-10-01 15:59 UTC → 北京 10-01 23:59（还没跨天）
    assert.equal(beijingDayKey(Date.parse('2026-10-01T15:59:00Z')), '2026-10-01')
  })
})

describe('额度折算', () => {
  test('周期字段优先，消耗按 size − remain 算', () => {
    // 签到是新增一个包：size 与 remain 一起涨，那是发放不是消耗。
    // 只盯着 remain 会把「发了 30」读成「花了 30」。
    const b = packageBalance({ CycleCapacitySize: 500, CycleCapacityRemain: 470 })
    assert.equal(b.size, 500)
    assert.equal(b.remain, 470)
    assert.equal(b.used, 30)
  })

  test('上游自报的 used 更大时信它，并把 remain 拉平', () => {
    const b = packageBalance({ CycleCapacitySize: 500, CycleCapacityRemain: 470, CycleCapacityUsed: 60 })
    assert.equal(b.used, 60)
    assert.equal(b.remain, 440)
  })

  test('remain 越界时收敛到 [0, size]', () => {
    assert.equal(packageBalance({ CycleCapacitySize: 100, CycleCapacityRemain: -5 }).remain, 0)
    assert.equal(packageBalance({ CycleCapacitySize: 100, CycleCapacityRemain: 999 }).remain, 100)
  })

  test('周期字段缺席时回落到终身容量字段', () => {
    const b = packageBalance({ CapacityRemain: 80, CapacityUsed: 20, CapacitySize: 100 })
    assert.equal(b.remain, 80)
    assert.equal(b.used, 20)
    assert.equal(b.size, 100)
  })

  test('终身字段缺 used 时按 size − remain 推，不低估消耗', () => {
    const b = packageBalance({ CapacityRemain: 80, CapacitySize: 100 })
    assert.equal(b.used, 20)
  })

  test('完全没有字段时不产生 NaN', () => {
    const b = packageBalance({})
    assert.equal(b.remain, 0)
    assert.equal(b.used, 0)
    assert.equal(b.size, 0)
  })
})

describe('额度查询', () => {
  test('多个资源包累加——签到攒出来的包不能漏', async () => {
    // startUpstream 已经消费完请求体再回调，这里不能再注册一次 req 事件，
    // 否则 end 永远不会再触发，测试会一直挂到超时。
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              TotalCount: 2,
              Accounts: [
                { PackageName: '体验版', CycleCapacitySize: 100, CycleCapacityRemain: 40, CapacityUnit: 'credits' },
                { PackageName: '签到包', CycleCapacitySize: 30, CycleCapacityRemain: 30 }
              ]
            }
          }
        }
      }))
    })
    try {
      const out = await fetchWorkbuddyCredits({ billing_base: base, access_token: 't', domain: 'www.codebuddy.cn' })
      assert.equal(out.remain, 70)
      assert.equal(out.size, 130)
      assert.equal(out.used, 60)
      assert.equal(out.pack_count, 2)
      assert.equal(out.unit, 'credits')
      assert.equal(out.packages[1].name, '签到包')
    } finally {
      server.close()
    }
  })

  test('请求体带 ProductCode 与 Status=[0,3]，少了会漏掉已耗尽的包', async () => {
    let seen = null
    const { server, base } = await startUpstream(({ res, raw }) => {
      seen = JSON.parse(raw)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }))
    })
    try {
      await fetchWorkbuddyCredits({ billing_base: base, access_token: 't' })
      assert.equal(seen.ProductCode, 'p_tcaca')
      assert.deepEqual(seen.Status, [0, 3])
      assert.equal(seen.PageSize, 100)
      assert.match(seen.PackageEndTimeRangeBegin, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    } finally {
      server.close()
    }
  })

  test('信封报错时抛上游消息，不返回一个看似正常的 0', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 1003, msg: '凭据失效' }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyCredits({ billing_base: base, access_token: 'bad' }),
        /凭据失效/
      )
    } finally {
      server.close()
    }
  })
})
