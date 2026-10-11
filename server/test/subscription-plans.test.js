// 订阅接入方案的回归测试
//
// 这里钉的是方案本身的形状：接入地址是常量、协议是常量、模型一律留空。
// 前两项错了会让整条通道发到错误的域上；最后一项错了，用户建出来的平台
// 会带着一份与上游实际可用型号对不上的死名单。
//
// WorkBuddy 拆成国内版 / 国际版两条，重点钉住「各自落各自的登录入口」：
// 两边不是同一个域、不是同一个 platform 参数，混了不会立刻报错，只会在
// 授权框里跳到另一个版本的登录页。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-plans-'))

const { SUBSCRIPTION_PLANS, findPlan } = await import('../subscription-plans.js')

const WB_PLANS = SUBSCRIPTION_PLANS.filter((p) => p.protocol === 'workbuddy-oauth')

describe('订阅接入方案', () => {
  test('WorkBuddy 分成国内版与国际版两条', () => {
    assert.equal(WB_PLANS.length, 2, `应有两条 WorkBuddy 方案，实际 ${WB_PLANS.length}`)
    assert.ok(findPlan('workbuddy-cn'), '国内版方案缺失')
    assert.ok(findPlan('workbuddy-intl'), '国际版方案缺失')
    // 名称要能一眼分开——选择器里靠文字区分，两条同名等于没拆
    const names = WB_PLANS.map((p) => p.name)
    assert.equal(new Set(names).size, names.length, '两条方案名称必须不同')
  })

  test('每条方案都必须写明协议与接入地址', () => {
    for (const p of SUBSCRIPTION_PLANS) {
      assert.ok(p.id, '缺 id')
      assert.ok(p.name, `${p.id} 缺名称`)
      assert.ok(p.protocol, `${p.id} 缺协议`)
      assert.ok(p.base_url, `${p.id} 缺接入地址`)
    }
  })

  test('模型一律留空：预填一份必然与上游实际可用型号对不上', () => {
    for (const p of SUBSCRIPTION_PLANS) {
      assert.deepEqual(p.models, [], `${p.id} 不该预填模型`)
    }
  })

  test('国内版落国内入口，国际版落国际入口，两者不是同一个域', () => {
    const cn = findPlan('workbuddy-cn')
    const intl = findPlan('workbuddy-intl')

    assert.equal(cn.base_url, 'https://copilot.tencent.com')
    assert.equal(cn.region, 'cn')

    assert.equal(intl.base_url, 'https://www.codebuddy.ai')
    assert.equal(intl.region, 'intl')

    assert.notEqual(cn.base_url, intl.base_url, '两条方案的接入地址必须不同')

    // workbuddy.ai 是计费/成长域，谁都不能拿它当对话入口——
    // 对调不会立刻报错，只会在第一次对话时拿到非 JSON 的 401，
    // 报错是 "parse failed: invalid character '<'"，完全反推不出是域名选错了
    for (const p of WB_PLANS) {
      assert.ok(!p.base_url.includes('workbuddy.ai'), `${p.id} 不能填成计费域`)
      assert.equal(p.protocol, 'workbuddy-oauth')
    }
  })

  test('region 与接入域互相印证，别让方案自己跟自己打架', () => {
    for (const p of WB_PLANS) {
      if (p.region === 'cn') assert.ok(p.base_url.includes('tencent.com'), `${p.id} 标了国内却没落国内域`)
      if (p.region === 'intl') assert.ok(p.base_url.includes('codebuddy.ai'), `${p.id} 标了国际却没落国际域`)
    }
  })

  test('方案自带接入提示，别让用户自己去文件里抠字段', () => {
    for (const p of WB_PLANS) {
      assert.ok(p.hint && p.hint.length > 0, `${p.id} 缺 hint`)
    }
    // 国内版额外指明凭据文件路径，导入 Token 的入口靠它找到文件
    assert.ok(findPlan('workbuddy-cn').hint.includes('workbuddy-<uid>.json'), '应指明凭据文件')
  })

  test('未知 id 返回 null', () => {
    assert.equal(findPlan('no-such-plan'), null)
    // 旧的单一方案 id 已废弃，不能再解析到任何一条——
    // 否则老 id 会悄悄落进国内版，把「我建的是国际版」变成静默错误
    assert.equal(findPlan('workbuddy'), null)
  })
})
