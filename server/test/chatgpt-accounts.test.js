// 转换层账号代理的单元测试。
//
// 这一层的价值全在「浏览器拿不到转换层 auth-key」和「只放行白名单路径」两条，
// 所以断言就围着这两条打，外加最容易写错的两个推导：base_url → 根地址、
// 平台挑选优先级。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bridgeBaseOf,
  pickBridgeProvider,
  sanitizeAccounts
} from '../chatgpt-accounts.js'
import { isBridgeProvider } from '../providers-image-only.js'

test('bridgeBaseOf 去掉版本段', () => {
  assert.equal(bridgeBaseOf({ base_url: 'http://127.0.0.1:3000/v1' }), 'http://127.0.0.1:3000')
  assert.equal(bridgeBaseOf({ base_url: 'http://127.0.0.1:3000/v1/' }), 'http://127.0.0.1:3000')
  assert.equal(bridgeBaseOf({ base_url: 'https://gw.example.com/api/v1' }), 'https://gw.example.com/api')
  assert.equal(bridgeBaseOf({ base_url: 'http://127.0.0.1:3000' }), 'http://127.0.0.1:3000')
  assert.equal(bridgeBaseOf({ base_url: '' }), '')
})

test('isBridgeProvider：image_only 或内网地址才算转换层', () => {
  assert.equal(isBridgeProvider({ image_only: true, base_url: 'https://api.x.com/v1' }), true)
  assert.equal(isBridgeProvider({ base_url: 'http://127.0.0.1:3000/v1' }), true)
  assert.equal(isBridgeProvider({ base_url: 'http://192.168.1.9:3000/v1' }), true)
  assert.equal(isBridgeProvider({ base_url: 'http://172.20.0.5:3000/v1' }), true)
  // 官方公网 API 不是转换层
  assert.equal(isBridgeProvider({ base_url: 'https://api.openai.com/v1' }), false)
  assert.equal(isBridgeProvider({ base_url: 'https://api.deepseek.com/v1' }), false)
  // 172.32 已越出私有段
  assert.equal(isBridgeProvider({ base_url: 'http://172.32.0.1:3000/v1' }), false)
})

test('pickBridgeProvider：优先 image_only，其次内网 openai-chat', () => {
  const providers = [
    { id: 'pub', protocol: 'openai-chat', base_url: 'https://api.openai.com/v1' },
    { id: 'local', protocol: 'openai-chat', base_url: 'http://127.0.0.1:8080/v1' },
    { id: 'img', protocol: 'openai-chat', base_url: 'http://127.0.0.1:3000/v1', image_only: true }
  ]
  assert.equal(pickBridgeProvider(providers).id, 'img')
  // 显式指定优先
  assert.equal(pickBridgeProvider(providers, 'local').id, 'local')
  // 指定了不存在/推不出地址的 id，返回 null 而不是乱猜
  assert.equal(pickBridgeProvider(providers, 'nope'), null)
  // 没有 image_only 时退回内网 openai-chat
  assert.equal(pickBridgeProvider(providers.filter((p) => p.id !== 'img')).id, 'local')
  // 全是公网平台时没有可代理目标
  assert.equal(pickBridgeProvider([{ id: 'pub', protocol: 'openai-chat', base_url: 'https://api.openai.com/v1' }]), null)
})

test('sanitizeAccounts 绝不返回 token 明文', () => {
  const fakeJwt = `h.${Buffer.from(JSON.stringify({
    exp: 1793618957,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'free' }
  })).toString('base64url')}.s`
  const out = sanitizeAccounts({
    items: [{
      access_token: fakeJwt,
      refresh_token: 'rt.secret',
      id_token: 'idt.secret',
      email: 'a@b.com',
      status: '正常',
      source_type: 'oauth_login',
      quota: 22
    }]
  })
  assert.equal(out.length, 1)
  const a = out[0]
  assert.equal(a.email, 'a@b.com')
  assert.equal(a.plan, 'free')
  assert.equal(a.quota, 22)
  assert.equal(a.refresh_token, true)
  assert.equal(a.token_tail, fakeJwt.slice(-6))
  assert.equal(a.access_expires_at, 1793618957000)

  // 整个返回体序列化后不能出现任何 token
  const json = JSON.stringify(out)
  assert.equal(json.includes(fakeJwt), false, '不得出现 access_token')
  assert.equal(json.includes('rt.secret'), false, '不得出现 refresh_token')
  assert.equal(json.includes('idt.secret'), false, '不得出现 id_token')
})

test('plan 优先取上游 type：续期后的 JWT 不含 chatgpt_plan_type', () => {
  // 实测：OAuth 刷新后的 access_token，auth 段只剩 amr / user_id / residency
  const refreshedJwt = `h.${Buffer.from(JSON.stringify({
    exp: 1793620365,
    'https://api.openai.com/auth': { amr: ['otp'], user_id: 'user-x' }
  })).toString('base64url')}.s`
  const out = sanitizeAccounts({
    items: [{ access_token: refreshedJwt, type: 'free', email: 'a@b.com', quota: 22 }]
  })
  assert.equal(out[0].plan, 'free', '上游 type 应兜住 JWT 里缺失的字段')
  assert.equal(out[0].access_expires_at, 1793620365000)
})

test('sanitizeAccounts 容忍空与畸形输入', () => {
  assert.deepEqual(sanitizeAccounts(null), [])
  assert.deepEqual(sanitizeAccounts({ items: [] }), [])
  const out = sanitizeAccounts({ items: [{ access_token: 'not-a-jwt' }] })
  assert.equal(out.length, 1)
  assert.equal(out[0].plan, '')
  assert.equal(out[0].refresh_token, false)
  assert.equal(out[0].access_expires_at, null)
})
