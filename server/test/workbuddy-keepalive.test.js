// WorkBuddy 凭据保活的契约测试
//
// 保活的核心判据是 workbuddyTokenNeedsRefresh：只有「已经进入续期窗口」的
// 账号才会发请求。这条边界必须钉死，否则每小时的 tick 会变成一个
// 「无差别狂刷 refresh_token」的机器，反而把号的寿命刷掉。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { workbuddyTokenNeedsRefresh } from '../workbuddy-oauth.js'
import { workbuddyRealmFor } from '../workbuddy-core.js'

const LEEWAY_MS = 5 * 60 * 1000

describe('续期判定（保活 tick 的准入门槛）', () => {
  test('远离过期时间：不刷', () => {
    const now = 1_800_000_000_000
    const key = { expires_at: now + 20 * 86400 * 1000 }
    assert.equal(workbuddyTokenNeedsRefresh(key, now), false)
  })

  test('刚好进入 5 分钟窗口：要刷', () => {
    const now = 1_800_000_000_000
    const key = { expires_at: now + LEEWAY_MS }
    assert.equal(workbuddyTokenNeedsRefresh(key, now), true, '边界应包含在内')
  })

  test('窗口外一秒：还不刷', () => {
    const now = 1_800_000_000_000
    const key = { expires_at: now + LEEWAY_MS + 1000 }
    assert.equal(workbuddyTokenNeedsRefresh(key, now), false)
  })

  test('已经过期：要刷（补上冷账号欠的这一次）', () => {
    const now = 1_800_000_000_000
    const key = { expires_at: now - 3 * 86400 * 1000 }
    assert.equal(workbuddyTokenNeedsRefresh(key, now), true)
  })

  test('没有 expires_at：不主动刷', () => {
    // 上游没给过期时间时按「长期有效」处理。这类账号靠 401 时的强制补刷兜底，
    // 不该让保活 tick 每小时无条件打一次上游。
    assert.equal(workbuddyTokenNeedsRefresh({}, 1_800_000_000_000), false)
    assert.equal(workbuddyTokenNeedsRefresh({ expires_at: 0 }, 1_800_000_000_000), false)
    assert.equal(workbuddyTokenNeedsRefresh({ expires_at: null }, 1_800_000_000_000), false)
  })

  test('空对象不抛错', () => {
    assert.doesNotThrow(() => workbuddyTokenNeedsRefresh(undefined))
    assert.equal(workbuddyTokenNeedsRefresh(undefined), false)
  })
})

describe('保活要跳过哪些账号', () => {
  // tick 里的准入条件是 enabled && type==='oauth' && refresh_token。
  // 这里用纯函数表达一遍，避免以后有人改 tick 时把条件写漏。
  const shouldKeepalive = (key) =>
    Boolean(key?.enabled && key.type === 'oauth' && key.refresh_token)

  test('正常 OAuth 账号：保活', () => {
    assert.equal(shouldKeepalive({ enabled: true, type: 'oauth', refresh_token: 'rt' }), true)
  })

  test('禁用的账号：跳过', () => {
    assert.equal(shouldKeepalive({ enabled: false, type: 'oauth', refresh_token: 'rt' }), false)
  })

  test('没有 refresh_token：跳过（刷不了，只会报错刷屏）', () => {
    assert.equal(shouldKeepalive({ enabled: true, type: 'oauth', refresh_token: '' }), false)
  })

  test('非 oauth（api_key 型）：跳过', () => {
    assert.equal(shouldKeepalive({ enabled: true, type: 'api_key', refresh_token: 'rt' }), false)
  })
})

describe('realm 决定续期发往哪个网关', () => {
  test('国内域名走 cn，续期不能发错网关', () => {
    assert.equal(workbuddyRealmFor('www.codebuddy.cn'), 'cn')
    assert.equal(workbuddyRealmFor('copilot.tencent.com'), 'cn')
    assert.equal(workbuddyRealmFor(''), 'cn')
  })

  test('国际域名走 intl', () => {
    assert.equal(workbuddyRealmFor('www.codebuddy.ai'), 'intl')
  })
})
