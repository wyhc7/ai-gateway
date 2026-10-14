// 混载平台的转发契约
//
// 一个平台里同时有国内与国际账号时，两件事必须成立：
//  1. 模型只出现在某个 realm 时，请求要用那个 realm 的账号发出去——
//     拿另一个 realm 的账号发过去只会拿到跨域的非 JSON 401；
//  2. 非主 realm 的同名模型对外是带后缀的别名（倍率不同就得分开点名），
//     转发前必须换回上游认得的原始 id，否则上游直接拒绝。
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-alias-'))

let workbuddyUpstreamBody = null
let workbuddyKeysForModel = null

before(async () => {
  ;({ workbuddyUpstreamBody, workbuddyKeysForModel } = await import('../proxy.js'))
})

const KEY_CN = { id: 'k-cn', domain: 'www.codebuddy.cn', enabled: true }
const KEY_INTL = { id: 'k-intl', domain: 'www.codebuddy.ai', enabled: true }

describe('别名换回上游 id', () => {
  test('带后缀的别名转发时换回原始 id', () => {
    const provider = { model_upstream_id: { 'glm-5.3-intl': 'glm-5.3' } }
    const out = workbuddyUpstreamBody(provider, { model: 'glm-5.3-intl', messages: [] })
    assert.equal(out.model, 'glm-5.3')
    assert.deepEqual(out.messages, [], '其余字段原样带过去')
  })

  test('没有别名的模型不动它', () => {
    const provider = { model_upstream_id: { 'glm-5.3-intl': 'glm-5.3' } }
    assert.equal(workbuddyUpstreamBody(provider, { model: 'glm-5.3' }).model, 'glm-5.3')
  })

  test('没有映射表 / 没有 model 字段时不炸', () => {
    const body = { model: 'glm-5.3' }
    assert.equal(workbuddyUpstreamBody({}, body), body, '没有映射表应原样返回同一个对象')
    assert.deepEqual(workbuddyUpstreamBody({ model_upstream_id: {} }, { messages: [] }), { messages: [] })
    assert.deepEqual(workbuddyUpstreamBody(null, { model: 'x' }), { model: 'x' })
  })

  test('不就地改原 body（重试时还要拿它再发一次）', () => {
    const provider = { model_upstream_id: { 'a-intl': 'a' } }
    const body = { model: 'a-intl' }
    const out = workbuddyUpstreamBody(provider, body)
    assert.equal(body.model, 'a-intl', '原对象必须保持不变')
    assert.notEqual(out, body)
  })
})

describe('按 realm 挑 Key', () => {
  const provider = { model_realm: { 'glm-5.3': 'cn', 'fast-model': 'intl' } }
  const keys = [KEY_CN, KEY_INTL]

  test('国内模型只发给国内账号', () => {
    const out = workbuddyKeysForModel(provider, 'glm-5.3', keys)
    assert.deepEqual(out.map((k) => k.id), ['k-cn'])
  })

  test('国际模型只发给国际账号', () => {
    const out = workbuddyKeysForModel(provider, 'fast-model', keys)
    assert.deepEqual(out.map((k) => k.id), ['k-intl'])
  })

  test('未知模型不筛选，走原有轮转', () => {
    assert.equal(workbuddyKeysForModel(provider, 'no-such-model', keys), keys)
    assert.equal(workbuddyKeysForModel(provider, undefined, keys), keys)
  })

  test('该 realm 一个可用 Key 都没有时原样返回，别把请求判死', () => {
    const onlyCn = [KEY_CN]
    const out = workbuddyKeysForModel(provider, 'fast-model', onlyCn)
    assert.equal(out, onlyCn, '宁可让它去试，也不要直接回一个「没有可用 Key」')
  })

  test('没有 model_realm 的旧数据行为不变', () => {
    assert.equal(workbuddyKeysForModel({}, 'glm-5.3', keys), keys)
  })
})
