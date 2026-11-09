// 余额计费单元测试：整数微点、流水、真实用量扣费、余额门禁、用户自助密钥归属。
//
// 覆盖的核心不变量：
// 1) 主密钥、升级前的老 Key 一律不计费、不拦；只有绑定账号的 Key 才纳入余额体系。
// 2) 余额永不为负；流水的 delta 是「实际变动」，任何时刻都能拿流水把余额对回去。
// 3) 失败请求不扣费；单价为 0 不产生流水噪音。
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-billing-'))

let state = null
let billing = null
let ak = null

before(async () => {
  ;({ state } = await import('../store.js'))
  billing = await import('../billing.js')
  ak = await import('../api-keys.js')
})

function makeUser(id = 'u1', balance = 0, enabled = true) {
  return { id, username: `user-${id}`, role: 'user', enabled, balance_micro: balance }
}

beforeEach(() => {
  state.accounts = []
  state.api_keys = []
  state.billing_ledger = []
  state.billing = billing.DEFAULT_BILLING()
  state.session_secret = 'fixed-billing-test-secret'
  state.admin_api_key = 'ak-billing-test'
})

describe('配置与字段归一化', () => {
  test('DEFAULT_BILLING：人民币四档定价，无请求基础费', () => {
    const b = billing.DEFAULT_BILLING()
    assert.equal(b.unit, '元')
    assert.equal(b.currency, 'CNY')
    assert.equal(b.micros_per_unit, 1_000_000)
    assert.equal(b.price_input_cached_micro_per_mtok, 10_000, '0.01 元 / 百万')
    assert.equal(b.price_input_uncached_micro_per_mtok, 100_000, '0.1 元 / 百万')
    assert.equal(b.price_output_micro_per_mtok, 500_000, '0.5 元 / 百万')
    assert.equal(b.price_per_image_micro, 60_000, '0.06 元 / 张')
    assert.equal(b.request_fee_micro, 0)
    assert.equal(b.enabled, true)
  })

  test('normalizeBilling 夹住非法值、补齐缺失字段', () => {
    const raw = { micros_per_unit: -5, price_input_cached_micro_per_mtok: 'oops', request_fee_micro: 7, ledger_limit: 999999, enabled: 'no' }
    assert.equal(billing.normalizeBilling(raw), true)
    assert.equal(raw.micros_per_unit, 1, '下限夹到 1')
    assert.equal(raw.price_input_cached_micro_per_mtok, 10_000, '非法值回落默认')
    assert.equal(raw.price_input_uncached_micro_per_mtok, 100_000, '缺失补默认')
    assert.equal(raw.price_output_micro_per_mtok, 500_000, '缺失补默认')
    assert.equal(raw.price_per_image_micro, 60_000, '缺失补默认')
    assert.equal(raw.request_fee_micro, 7)
    assert.equal(raw.ledger_limit, 5000, '上限夹到 5000')
    assert.equal(raw.unit, '元')
    assert.equal(raw.currency, 'CNY')
    assert.equal(raw.enabled, true, '字符串 no 不是布尔 false，按启用处理')
    assert.equal(billing.normalizeBilling(raw), false, '二次归一化不应再改动')
  })

  test('normalizeAccountBalances 给老账号补 0，不覆盖已有余额', () => {
    const root = { accounts: [{ id: 'a' }, { id: 'b', balance_micro: 2_500_000 }, { id: 'c', balance_micro: 'bad' }] }
    assert.equal(billing.normalizeAccountBalances(root), true)
    assert.equal(root.accounts[0].balance_micro, 0)
    assert.equal(root.accounts[1].balance_micro, 2_500_000)
    assert.equal(root.accounts[2].balance_micro, 0)
    assert.equal(billing.normalizeAccountBalances(root), false)
  })

  test('normalizeLedger 丢掉损坏条目并裁到上限（下限夹到 50）', () => {
    state.billing_ledger = Array.from({ length: 62 }, (_, i) => ({ account_id: 'u1', n: i }))
    state.billing_ledger.splice(3, 1, null)
    state.billing.ledger_limit = 50
    assert.equal(billing.normalizeLedger(state), true)
    assert.equal(state.billing_ledger.length, 50, '裁到 50 条')
    assert.ok(state.billing_ledger.every((e) => e && e.account_id === 'u1'), '损坏条目被丢弃')
    assert.equal(billing.normalizeLedger(state), false, '二次归一化不再改动')

    // 下限保护：配一个过小的上限也不会把流水秒清
    state.billing_ledger = Array.from({ length: 60 }, (_, i) => ({ account_id: 'u1', n: i }))
    state.billing.ledger_limit = 5
    billing.normalizeLedger(state)
    assert.equal(state.billing_ledger.length, 50)
  })

  test('formatUnits 去尾随零、不产生浮点尾巴', () => {
    assert.equal(billing.formatUnits(0, 1_000_000), '0')
    assert.equal(billing.formatUnits(1_000_000, 1_000_000), '1')
    assert.equal(billing.formatUnits(2_500_000, 1_000_000), '2.5')
    assert.equal(billing.formatUnits(1, 1_000_000), '0.000001')
  })
})

describe('余额变动与流水', () => {
  test('充值后余额与展示口径一致，流水记实际变动', () => {
    state.accounts.push(makeUser('u1'))
    const out = billing.applyBalance('u1', { amount_micro: 10_000_000, type: 'topup', actor: 'root', note: '10 月配额' })
    assert.equal(out.micro, 10_000_000)
    assert.equal(out.value, 10)
    assert.equal(out.display, '10 元')

    const ledger = billing.ledgerOf('u1')
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].type, 'topup')
    assert.equal(ledger[0].delta_micro, 10_000_000)
    assert.equal(ledger[0].balance_after_micro, 10_000_000)
    assert.equal(ledger[0].actor, 'root')
    assert.equal(ledger[0].delta_display, '+10 元')
  })

  test('扣减夹到 0，流水 delta 是实际变动而非请求值', () => {
    state.accounts.push(makeUser('u1', 3_000_000))
    const out = billing.applyBalance('u1', { amount_micro: -9_000_000, type: 'adjust', note: '超扣' })
    assert.equal(out.micro, 0, '余额不允许为负')
    assert.equal(billing.ledgerOf('u1')[0].delta_micro, -3_000_000, '流水记实际扣掉的 3 点')
    assert.equal(billing.ledgerOf('u1')[0].balance_after_micro, 0)
  })

  test('ledgerOf 只返回该账号的流水，倒序且带可读展示', () => {
    state.accounts.push(makeUser('u1'), makeUser('u2'))
    billing.applyBalance('u1', { amount_micro: 5_000_000, type: 'topup' })
    billing.applyBalance('u2', { amount_micro: 9_000_000, type: 'topup' })
    billing.applyBalance('u1', { amount_micro: -1_000_000, type: 'consume' })
    const rows = billing.ledgerOf('u1')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].type, 'consume')
    assert.equal(rows[0].delta_micro, -1_000_000)
    assert.equal(rows[0].balance_after_micro, 4_000_000)
    assert.equal(rows[0].balance_display, '4 元')
  })

  test('parseAmountToMicro：元 → 微元，非法/溢出返回 null', () => {
    assert.equal(billing.parseAmountToMicro('10'), 10_000_000)
    assert.equal(billing.parseAmountToMicro('-2.5'), -2_500_000)
    assert.equal(billing.parseAmountToMicro(0), null)
    assert.equal(billing.parseAmountToMicro('abc'), null)
    assert.equal(billing.parseAmountToMicro(1e30), null)
  })

  test('pricingInfo 给出可读单价，serializeBalance 给零余额', () => {
    state.accounts.push(makeUser('u1'))
    const p = billing.pricingInfo()
    assert.equal(p.price_input_uncached_display, '0.1 元 / 百万 tokens')
    assert.equal(p.price_input_cached_display, '0.01 元 / 百万 tokens')
    assert.equal(p.price_output_display, '0.5 元 / 百万 tokens')
    assert.equal(p.price_per_image_display, '0.06 元 / 张')
    assert.equal(p.request_fee_display, '0 元 / 次')
    assert.equal(p.unit, '元')
    assert.equal(p.currency, 'CNY')
    assert.equal(p.table.length, 4, '价目表四档')
    const b = billing.serializeBalance('u1')
    assert.equal(b.micro, 0)
    assert.equal(b.value, 0)
    assert.equal(b.display, '0 元')
    assert.equal(b.micros_per_unit, 1_000_000)
  })
})

describe('真实用量扣费 consumeForUsage', () => {
  test('主密钥 / 未绑定账号的老 Key 完全不扣费', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    const u = { input_cached: 0, input_uncached: 100000, output: 0 }
    billing.consumeForUsage({ kind: 'owner', unrestricted: true }, { usage: u, ok: true, model: 'gpt-4o' })
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: '' } }, { usage: u, ok: true })
    billing.consumeForUsage({ kind: 'key', _key: {} }, { usage: u, ok: true })
    assert.equal(state.accounts[0].balance_micro, 10_000_000)
    assert.equal(state.billing_ledger.length, 0)
  })

  test('绑定账号的 Key 按四档结算：10 万未命中输入 = 0.01 元', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    billing.consumeForUsage(
      { kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 100_000, output: 0 }, ok: true, model: 'gpt-4o-mini' }
    )
    // 100000 / 1e6 × 100000 微元 = 10,000 微元 = 0.01 元
    assert.equal(state.accounts[0].balance_micro, 10_000_000 - 10_000)
    const row = billing.ledgerOf('u1')[0]
    assert.equal(row.type, 'consume')
    assert.equal(row.model, 'gpt-4o-mini')
    assert.equal(row.note, '输入 100000', '流水 note 写清用量构成')
    assert.deepEqual(row.usage, { input_cached: 0, input_uncached: 100000, output: 0, images: 0 })
  })

  test('缓存命中比未命中便宜十倍', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    // 100 万命中 = 10,000 微元
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 1_000_000, input_uncached: 0, output: 0 }, ok: true })
    assert.equal(state.accounts[0].balance_micro, 10_000_000 - 10_000, '命中 100 万 = 0.01 元')
    // 100 万未命中 = 100,000 微元
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 1_000_000, output: 0 }, ok: true })
    assert.equal(state.accounts[0].balance_micro, 10_000_000 - 10_000 - 100_000, '未命中 100 万 = 0.1 元')
  })

  test('生图按张扣：2 张 = 0.12 元', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 0, output: 0, images: 2 }, ok: true, model: 'gpt-image-2' })
    assert.equal(state.accounts[0].balance_micro, 10_000_000 - 120_000)
    assert.equal(billing.ledgerOf('u1')[0].note, '2 张')
  })

  test('失败请求不扣费；基础费开启时 0 用量仍扣一次', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 99999, output: 0 }, ok: false })
    assert.equal(state.accounts[0].balance_micro, 10_000_000)

    state.billing.request_fee_micro = 500_000
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 0, output: 0 }, ok: true })
    assert.equal(state.accounts[0].balance_micro, 9_500_000)
  })

  test('计费关闭时一律不扣；全部单价为 0 不产生流水', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    state.billing.enabled = false
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 5000, output: 100 }, ok: true })
    assert.equal(state.accounts[0].balance_micro, 10_000_000)

    state.billing.enabled = true
    state.billing.price_input_cached_micro_per_mtok = 0
    state.billing.price_input_uncached_micro_per_mtok = 0
    state.billing.price_output_micro_per_mtok = 0
    state.billing.price_per_image_micro = 0
    billing.consumeForUsage({ kind: 'key', _key: { owner_account_id: 'u1' } },
      { usage: { input_cached: 0, input_uncached: 5000, output: 100 }, ok: true })
    assert.equal(state.accounts[0].balance_micro, 10_000_000)
    assert.equal(state.billing_ledger.length, 0, '免费模式不该刷流水')
  })

  test('recordUsage 接通扣费：成功调用按用量扣，失败调用不扣', () => {
    state.accounts.push(makeUser('u1', 10_000_000))
    const { token } = ak.createUserKey('u1', { username: 'alice' })
    const auth = ak.resolveAuth(token).auth
    // 输出 1000 tokens = 1000/1e6 × 500,000 微元 = 500 微元 = 0.0005 元。
    // 前一个用例把四档单价都改成 0 了，这里必须显式恢复默认定价，
    // 否则记录到的余额差只剩基础费（用例间共享 store.state，不能默认干净）。
    Object.assign(state.billing, {
      unit: '元', currency: 'CNY',
      price_input_cached_micro_per_mtok: 10_000,
      price_input_uncached_micro_per_mtok: 100_000,
      price_output_micro_per_mtok: 500_000,
      price_per_image_micro: 60_000,
      request_fee_micro: 0
    })
    // 以「本用例开始时」的余额为基准算差值，不假设 accounts[0] 就是 u1
    // （前面的 describe 会往 state.accounts 里塞别的账号）。
    // createUserKey 不会再动余额；先断言起点，失败时能立刻看出是被谁改的
    const before = billing.balanceMicroOf('u1')
    assert.equal(before, 10_000_000, '起点余额应为 10 元')
    ak.recordUsage(auth, { usage: { input_cached: 0, input_uncached: 0, output: 1000 }, ok: true, model: 'gpt-4o' })
    assert.equal(billing.balanceMicroOf('u1'), before - 500, '输出 1000 tokens 扣 500 微元')
    assert.equal(ak.getApiKey(auth.id).usage.tokens, 1000, '原有用量统计照常落盘')

    ak.recordUsage(auth, { usage: { input_cached: 0, input_uncached: 0, output: 9999 }, ok: false, model: 'gpt-4o' })
    assert.equal(billing.balanceMicroOf('u1'), before - 500, '失败不扣')
    assert.equal(ak.getApiKey(auth.id).usage.failed, 1)
  })
})

describe('调用前余额门禁 balanceGateError', () => {
  test('主密钥与未绑定账号的 Key 永远放行', () => {
    state.accounts.push(makeUser('u1', 0))
    assert.equal(billing.balanceGateError({ kind: 'owner', unrestricted: true }), null)
    assert.equal(billing.balanceGateError({ kind: 'key', _key: { owner_account_id: '' } }), null)
    assert.equal(billing.balanceGateError(null), null)
  })

  test('绑定账号且余额为 0 → 402 insufficient_balance', () => {
    state.accounts.push(makeUser('u1', 0))
    const g = billing.balanceGateError({ kind: 'key', _key: { owner_account_id: 'u1' } })
    assert.equal(g.status, 402)
    assert.equal(g.type, 'insufficient_balance')
    assert.match(g.message, /余额不足/)
  })

  test('充值后放行；账号停用优先 403；计费关闭时全放行', () => {
    state.accounts.push(makeUser('u1', 0))
    const auth = { kind: 'key', _key: { owner_account_id: 'u1' } }
    billing.applyBalance('u1', { amount_micro: 1, type: 'topup' })
    assert.equal(billing.balanceGateError(auth), null, '哪怕只有 1 微点也算有余额')

    state.accounts[0].enabled = false
    const stopped = billing.balanceGateError(auth)
    assert.equal(stopped.status, 403)
    assert.equal(stopped.type, 'account_disabled')

    state.billing.enabled = false
    assert.equal(billing.balanceGateError(auth), null)
  })
})

describe('用户自助密钥', () => {
  test('新账号初始无密钥：userKeysOf 返回空数组', () => {
    state.accounts.push(makeUser('u1'))
    assert.deepEqual(ak.userKeysOf('u1'), [])
    assert.deepEqual(ak.userKeysOf(''), [], '空 id 不返回任何密钥')
  })

  test('生成后绑定 owner_account_id，config.json 只存摘要', () => {
    state.accounts.push(makeUser('u1'))
    const out = ak.createUserKey('u1', { username: 'alice' })
    assert.ok(out.token.startsWith('sk-'))
    assert.equal(out.key.owner_account_id, 'u1')
    assert.equal(out.key.state, 'active')
    assert.equal(out.key.model_scope, 'all')
    const raw = state.api_keys[0]
    assert.equal(raw.owner_account_id, 'u1')
    assert.equal(raw.key_hash, ak.hashToken(out.token))
    assert.notEqual(raw.key_preview, out.token)
    assert.ok(!JSON.stringify(raw).includes(out.token), '明文不落盘')
  })

  test('一个账号最多一把；重复生成 409', () => {
    state.accounts.push(makeUser('u1'))
    ak.createUserKey('u1', {})
    assert.throws(() => ak.createUserKey('u1', {}), (e) => e.status === 409)
    assert.equal(state.api_keys.length, 1)
  })

  test('归属隔离：不能轮换/删除别人的密钥', () => {
    state.accounts.push(makeUser('u1'), makeUser('u2'))
    const a = ak.createUserKey('u1', {})
    const b = ak.createUserKey('u2', {})
    assert.equal(ak.rotateUserKey('u2', a.key.id), null)
    assert.equal(ak.deleteUserKey('u2', a.key.id), false)
    assert.deepEqual(ak.userKeysOf('u1').map((k) => k.id), [a.key.id])
    assert.deepEqual(ak.userKeysOf('u2').map((k) => k.id), [b.key.id])

    const rotated = ak.rotateUserKey('u1', a.key.id)
    assert.notEqual(rotated.token, a.token)
    assert.equal(ak.resolveAuth(a.token).ok, false, '轮换后旧钥匙立即失效')
    assert.equal(ak.resolveAuth(rotated.token).ok, true)
    assert.equal(rotated.key.owner_account_id, 'u1', '轮换保留归属')

    assert.equal(ak.deleteUserKey('u1', a.key.id), true)
    assert.equal(ak.resolveAuth(rotated.token).ok, false)
    assert.deepEqual(ak.userKeysOf('u1'), [])
  })
})
