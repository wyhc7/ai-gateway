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
  sanitizeAccounts,
  normalizeLimits,
  imageLimitOf
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
  assert.equal(out[0].image_quota, null)
  assert.deepEqual(out[0].limits, [])
})

// 上游真实返回的 limits_progress 形状（取自线上账号）
const REAL_LIMITS = [
  { feature_name: 'deep_research', remaining: 5, reset_after: '2026-11-22T12:31:01.690996+00:00' },
  { feature_name: 'file_upload', remaining: 15, reset_after: '2026-10-24T12:31:01.691016+00:00' },
  { feature_name: 'paste_text_to_file', remaining: 3, reset_after: '2026-10-24T12:31:01.691022+00:00' },
  { feature_name: 'image_gen', remaining: 22, reset_after: '2026-10-24T11:36:44.691026+00:00' },
  { feature_name: 'reason', remaining: 44, reset_after: '2026-10-23T16:29:33.265116+00:00' }
]

test('normalizeLimits：生图排第一、中文名、未知能力保留原 key', () => {
  const limits = normalizeLimits(REAL_LIMITS)
  assert.equal(limits.length, 5)
  assert.equal(limits[0].key, 'image_gen')
  assert.equal(limits[0].label, '生图')
  assert.equal(limits[0].remaining, 22)
  assert.equal(limits[0].reset_at, '2026-10-24T11:36:44.691026+00:00')
  // 认识的翻译，不认识的保留原 key
  const byKey = Object.fromEntries(limits.map((l) => [l.key, l]))
  assert.equal(byKey.deep_research.label, '深度研究')
  assert.equal(byKey.file_upload.label, '文件上传')
  const unknown = normalizeLimits([{ feature_name: 'brand_new_feature', remaining: 7 }])
  assert.equal(unknown[0].label, 'brand_new_feature')
  assert.equal(unknown[0].remaining, 7)
  // 脏数据要过滤，不能崩
  assert.deepEqual(normalizeLimits(null), [])
  assert.deepEqual(normalizeLimits([null, {}, { remaining: 3 }]), [])
})

test('imageLimitOf 取出生图那一项', () => {
  const limits = normalizeLimits(REAL_LIMITS)
  assert.equal(imageLimitOf(limits).remaining, 22)
  assert.equal(imageLimitOf([]), null)
  assert.equal(imageLimitOf(null), null)
})

test('剩余生图额度：limits.image_gen 优先，退回顶层 quota', () => {
  const out = sanitizeAccounts({
    items: [{
      email: 'a@b.com',
      quota: 22,
      type: 'free',
      restore_at: '2026-10-24T11:36:44.691026+00:00',
      limits_progress: REAL_LIMITS,
      success: 1,
      fail: 1
    }]
  })
  const a = out[0]
  assert.equal(a.image_quota, 22, '应取 limits 里 image_gen 的 remaining')
  assert.equal(a.quota_reset_at, '2026-10-24T11:36:44.691026+00:00')
  assert.equal(a.limits.length, 5)
  assert.equal(a.success, 1)
  assert.equal(a.fail, 1)

  // 老版本 / 没有 limits_progress 时退回顶层 quota
  const old = sanitizeAccounts({ items: [{ quota: 17, restore_at: '2026-10-25T00:00:00Z' }] })
  assert.equal(old[0].image_quota, 17)
  assert.equal(old[0].quota_reset_at, '2026-10-25T00:00:00Z')
  assert.deepEqual(old[0].limits, [])
})

test('额度用完时 image_quota 是 0 而不是 null', () => {
  const out = sanitizeAccounts({
    items: [{
      quota: 0,
      limits_progress: [{ feature_name: 'image_gen', remaining: 0, reset_after: '2026-10-24T00:00:00Z' }]
    }]
  })
  assert.equal(out[0].image_quota, 0, '0 是有效额度，不能被 ?? 掉')
  assert.equal(out[0].quota_reset_at, '2026-10-24T00:00:00Z')
})
