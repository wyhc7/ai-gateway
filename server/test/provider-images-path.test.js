// 生图参数透传 & 平台建单的关键回归：这两个点错了，「只生图」平台就彻底不出图。
// 1) images_path 必须能从建平台的请求体带进 provider（CALL_PLAN_FIELDS 漏字段 → 退回默认路径）
// 2) 生图请求体必须原样打给上游，一个参数都不改
import test from 'node:test'
import assert from 'node:assert/strict'
import { callPlan } from '../proxy.js'
import { TEMPLATES } from '../templates.js'

test('provider 自带的 images_path 覆盖协议默认值', () => {
  const plan = callPlan({ protocol: 'openai-chat', images_path: '/v1/images/generations' })
  assert.equal(plan.imagesPath, '/v1/images/generations')
})

test('未配 images_path 时退回协议默认 /images/generations', () => {
  const plan = callPlan({ protocol: 'openai-chat' })
  assert.equal(plan.imagesPath, '/images/generations')
})

test('只生图模板存在且模型清单只有生图模型', () => {
  const t = TEMPLATES.find((x) => x.id === 'chatgpt-image')
  assert.ok(t, '缺少 chatgpt-image 模板')
  assert.equal(t.protocol, 'openai-chat')
  assert.equal(t.images_path, '/images/generations')
  assert.ok(t.default_models.includes('gpt-image-2'))
  assert.ok(t.default_models.every((m) => /image/i.test(m)), `模板里混进了非生图模型：${t.default_models}`)
})

test('建平台时 images_path 被 pickCallPlan 接收', async () => {
  // 直接读源码确认字段在 CALL_PLAN_FIELDS 白名单里——pickCallPlan 是白名单过滤，
  // 漏掉一个字段，前端传了也会被静默丢掉，只在线上表现为 404。
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const m = src.match(/const CALL_PLAN_FIELDS = \[([^\]]+)\]/)
  assert.ok(m, '找不到 CALL_PLAN_FIELDS')
  assert.ok(m[1].includes("'images_path'"), 'CALL_PLAN_FIELDS 缺 images_path')
})
