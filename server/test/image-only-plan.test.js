// 只生图方案（chatgpt-web）的行为锁：清单里不能出现任何文本模型。
// 这条链路上有三个入口会写入模型清单——建平台、刷新拉取、编辑保存，
// 任何一个漏了，客户端 /v1/models 就会拿到 gpt-5 系，图片请求也有机会被发到 chat 通道。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isImageModel, filterModelsForProvider, IMAGE_ONLY_FALLBACK_MODELS } from '../providers-image-only.js'
import { SUBSCRIPTION_PLANS } from '../subscription-plans.js'
import { TEMPLATES } from '../templates.js'

const plan = SUBSCRIPTION_PLANS.find((p) => p.id === 'chatgpt-web')

test('chatgpt-web 方案存在且标记为只生图', () => {
  assert.ok(plan, '缺少 chatgpt-web 订阅方案')
  assert.equal(plan.image_only, true)
  assert.equal(plan.auth_kind, 'api_key')
  assert.equal(plan.images_path, '/images/generations')
  assert.equal(plan.protocol, 'openai-chat')
})

test('方案默认模型全是生图模型，一个文本模型都没有', () => {
  assert.ok(plan.default_models.length > 0)
  for (const id of plan.default_models) {
    assert.ok(isImageModel(id), `${id} 不是生图模型`)
    assert.doesNotMatch(id, /^gpt-5(?!.*image)/, `混进了文本模型 ${id}`)
  }
  assert.ok(plan.default_models.includes('gpt-image-2'))
})

test('模板里不再有 chatgpt 相关条目（已搬到订阅方案）', () => {
  const ids = TEMPLATES.map((t) => t.id)
  assert.ok(!ids.includes('chatgpt-web'), 'templates 里还留着 chatgpt-web')
  assert.ok(!ids.includes('chatgpt-image'), 'templates 里还留着 chatgpt-image')
  assert.ok(!TEMPLATES.some((t) => t.name.includes('chatgpt2api')), 'templates 里还留着 chatgpt2api 条目')
})

test('刷新拉回整份目录时，文本模型被剔掉', () => {
  const provider = { image_only: true, name: 'x' }
  const upstream = [
    { id: 'gpt-5' },
    { id: 'gpt-5-mini' },
    { id: 'gpt-image-2' },
    { id: 'codex-gpt-image-2' },
    { id: 'gpt-image-1' },
    { id: 'dall-e-3' }
  ]
  const kept = filterModelsForProvider(provider, upstream).map((m) => m.id)
  assert.deepEqual(kept, ['gpt-image-2', 'codex-gpt-image-2', 'gpt-image-1', 'dall-e-3'])
})

test('普通平台完全不受影响，且返回同一引用', () => {
  const upstream = [{ id: 'gpt-5' }, { id: 'gpt-image-2' }]
  assert.equal(filterModelsForProvider({}, upstream), upstream)
  assert.equal(filterModelsForProvider(null, upstream), upstream)
  assert.equal(filterModelsForProvider({ image_only: false }, upstream), upstream)
})

test('兜底清单只有 gpt-image-2', () => {
  assert.deepEqual(IMAGE_ONLY_FALLBACK_MODELS, ['gpt-image-2'])
})

test('判据覆盖常见生图型号，且不误伤文本模型', () => {
  for (const id of ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'imagen-4', 'flux-schnell', 'sdxl', 'seedream-3', 'nano-banana']) {
    assert.ok(isImageModel(id), `${id} 应判为生图模型`)
  }
  for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat', 'grok-4.6', 'o3']) {
    assert.ok(!isImageModel(id), `${id} 不该被判为生图模型`)
  }
})
