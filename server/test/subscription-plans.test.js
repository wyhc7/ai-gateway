// 订阅接入方案的回归测试
//
// 这里钉的是方案本身的形状：接入地址是常量、协议是常量、模型一律留空。
// 前两项错了会让整条通道发到错误的域上；最后一项错了，用户建出来的平台
// 会带着一份与上游实际可用型号对不上的死名单。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-plans-'))

const { SUBSCRIPTION_PLANS, findPlan } = await import('../subscription-plans.js')

describe('订阅接入方案', () => {
  test('至少有 WorkBuddy 一条', () => {
    assert.ok(SUBSCRIPTION_PLANS.length >= 1)
    assert.ok(findPlan('workbuddy'), 'WorkBuddy 方案缺失')
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

  test('WorkBuddy 的接入地址是对话域，不是计费域', () => {
    // 计费与成长中心在 workbuddy.ai，对话必须走 codebuddy.ai。
    // 对调不会立刻报错，只会在第一次对话时拿到一个非 JSON 的 401，
    // 报错信息是 "parse failed: invalid character '<'"，完全反推不出是域名选错了。
    const wb = findPlan('workbuddy')
    assert.equal(wb.base_url, 'https://www.codebuddy.ai')
    assert.ok(!wb.base_url.includes('workbuddy.ai'), '不能填成计费域')
    assert.equal(wb.protocol, 'workbuddy-oauth')
  })

  test('方案自带接入提示，别让用户自己去文件里抠字段', () => {
    const wb = findPlan('workbuddy')
    assert.ok(wb.hint && wb.hint.length > 0)
    assert.ok(wb.hint.includes('workbuddy-<uid>.json'), '应指明凭据文件')
  })

  test('未知 id 返回 null', () => {
    assert.equal(findPlan('no-such-plan'), null)
  })
})
