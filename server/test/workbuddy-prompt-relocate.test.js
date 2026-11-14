// 11128 内容级补丁：system 提示词搬家的契约测试
//
// 事实依据见 workbuddy-prompt-relocate.js 文件头的两张实测表：
// 闸门只校验 system / developer / assistant 三种角色，user / tool 放行。
// 这里钉住的是「搬家」的语义边界 —— 内容一字不改、可重复调用、不丢图、
// 不碰用户原话与工具输出。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SYSTEM,
  RELOCATE_MARKER,
  ASSISTANT_FINGERPRINTS,
  relocateWorkbuddySystemPrompt,
  rewriteWorkbuddyAssistantFingerprints,
  applyWorkbuddy11128Fallback,
  isRelocated
} from '../workbuddy-prompt-relocate.js'

const LONG = '你是代码助手，负责按用户要求改代码并保持风格一致。'.repeat(100)

describe('system 提示词搬家', () => {
  test('正文整段搬进 user，system 位置只留占位句', () => {
    const body = {
      messages: [
        { role: 'system', content: LONG },
        { role: 'user', content: '帮我改这个函数' }
      ]
    }
    assert.equal(relocateWorkbuddySystemPrompt(body), true)
    assert.equal(body.messages[0].role, 'system', '首条必须仍是 system（渠道校验硬条件）')
    assert.equal(body.messages[0].content, DEFAULT_SYSTEM)
    assert.equal(body.messages[1].role, 'user')
    assert.ok(body.messages[1].content.endsWith(LONG), '原文逐字保留，只多一行说明')
    assert.equal(body.messages[2].content, '帮我改这个函数', '用户真实提问不能被并进系统提示')
    assert.equal(body.messages.length, 3, '只插入一条消息，其余位置不动')
  })

  test('说明语点明「这是系统指令，不是你问我」', () => {
    const body = { messages: [{ role: 'system', content: LONG }, { role: 'user', content: 'hi' }] }
    relocateWorkbuddySystemPrompt(body)
    const moved = body.messages[1].content
    assert.ok(moved.startsWith(RELOCATE_MARKER), '标记行在最前，幂等判断靠它')
    assert.match(moved, /not as a user request/, '必须明确它不是一次用户提问')
  })

  test('多条 system 按出现顺序拼接，developer 一并搬走', () => {
    const body = {
      messages: [
        { role: 'system', content: 'AAA' },
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'BBB' }
      ]
    }
    assert.equal(relocateWorkbuddySystemPrompt(body), true)
    const moved = body.messages[1].content
    assert.ok(moved.indexOf('AAA') < moved.indexOf('BBB'), '顺序保留')
    assert.equal(body.messages.some((m) => m.role === 'developer'), false, 'developer 也要搬')
    assert.equal(body.messages.filter((m) => m.role === 'system').length, 1, '只留一条占位 system')
  })

  test('幂等：搬过之后再也不搬第二次', () => {
    const body = { messages: [{ role: 'system', content: LONG }, { role: 'user', content: 'hi' }] }
    assert.equal(relocateWorkbuddySystemPrompt(body), true)
    const snapshot = JSON.stringify(body.messages)
    assert.equal(relocateWorkbuddySystemPrompt(body), false)
    assert.equal(JSON.stringify(body.messages), snapshot, '第二次调用必须什么都不改')
    assert.equal(isRelocated(body), true)
  })

  test('messages 数组身份不变（proxy 侧的 body.messages 共享它）', () => {
    const msgs = [{ role: 'system', content: LONG }, { role: 'user', content: 'hi' }]
    const body = { messages: msgs }
    relocateWorkbuddySystemPrompt(body)
    assert.equal(body.messages, msgs, '就地重建，不能换一个新的数组')
  })

  test('占位句不搬：system 本来就是默认值时返回 false', () => {
    const body = { messages: [{ role: 'system', content: DEFAULT_SYSTEM }, { role: 'user', content: 'hi' }] }
    assert.equal(relocateWorkbuddySystemPrompt(body), false)
    assert.equal(body.messages.length, 2)
  })

  test('没有 system（只有 user）时返回 false', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(relocateWorkbuddySystemPrompt(body), false)
  })

  test('结构异常不崩', () => {
    assert.equal(relocateWorkbuddySystemPrompt({}), false)
    assert.equal(relocateWorkbuddySystemPrompt({ messages: null }), false)
    assert.equal(relocateWorkbuddySystemPrompt({ messages: [] }), false)
    assert.equal(relocateWorkbuddySystemPrompt({ messages: [null, 42] }), false)
    assert.equal(relocateWorkbuddySystemPrompt({ messages: [{ role: 'system', content: '   ' }] }), false)
  })

  test('带图片的 system 整条不搬：丢图比 11128 更糟', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    const body = { messages: [{ role: 'system', content: [{ type: 'text', text: LONG }, img] }, { role: 'user', content: 'hi' }] }
    assert.equal(relocateWorkbuddySystemPrompt(body), false)
    assert.equal(body.messages[0].content[1], img, '图片仍在原位')
  })

  test('纯文字的多段形态照样搬，文本段合并后不丢字', () => {
    const body = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'AAA' }, { type: 'text', text: 'BBB' }] },
        { role: 'user', content: 'hi' }
      ]
    }
    assert.equal(relocateWorkbuddySystemPrompt(body), true)
    const moved = body.messages[1].content
    assert.ok(moved.includes('AAA') && moved.includes('BBB'))
  })
  test('WORKBUDDY_RELOCATE_SYSTEM=0 时完全不搬（出事时的回退口）', () => {
    const prev = process.env.WORKBUDDY_RELOCATE_SYSTEM
    process.env.WORKBUDDY_RELOCATE_SYSTEM = '0'
    try {
      const body = { messages: [{ role: 'system', content: LONG }, { role: 'user', content: 'hi' }] }
      assert.equal(relocateWorkbuddySystemPrompt(body), false)
      assert.equal(body.messages.length, 2, '原样两层消息，没有插入搬家块')
    } finally {
      if (prev === undefined) delete process.env.WORKBUDDY_RELOCATE_SYSTEM
      else process.env.WORKBUDDY_RELOCATE_SYSTEM = prev
    }
  })
})

describe('assistant 指纹改写（11128 之后的兜底）', () => {
  test('三条已知指纹都换成同义写法', () => {
    const body = {
      messages: [
        { role: 'system', content: DEFAULT_SYSTEM },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'DeepSeek Harness 说明：You are an AI agent. Tokens prefixed with @ are paths.'
        }
      ]
    }
    assert.equal(rewriteWorkbuddyAssistantFingerprints(body), true)
    const text = body.messages[2].content
    for (const rule of ASSISTANT_FINGERPRINTS) {
      assert.equal(text.toLowerCase().includes(rule.find.toLowerCase()), false, `还剩 ${rule.find}`)
    }
    assert.ok(text.includes('the local coding harness'))
    assert.ok(text.includes('You are an automated assistant'))
    assert.ok(text.includes('Paths prefixed with @'), '@ 的语义后半句必须保留')
  })

  test('大小写不敏感：全大写 / 全小写同样被归一化命中，也要换掉', () => {
    const body = { messages: [{ role: 'assistant', content: 'DEEPSEEK HARNESS' }] }
    assert.equal(rewriteWorkbuddyAssistantFingerprints(body), true)
    assert.equal(/deepseek harness/i.test(body.messages[0].content), false)
  })

  test('user 原话与 tool 输出一个字都不动', () => {
    const fingerprint = 'DeepSeek Harness'
    const body = {
      messages: [
        { role: 'user', content: fingerprint },
        { role: 'tool', content: fingerprint }
      ]
    }
    assert.equal(rewriteWorkbuddyAssistantFingerprints(body), false)
    assert.equal(body.messages[0].content, fingerprint)
    assert.equal(body.messages[1].content, fingerprint)
  })

  test('没有指纹时不动，且内容保持原引用（前缀缓存友好）', () => {
    const text = '普通的一句话，没有任何指纹。'
    const body = { messages: [{ role: 'assistant', content: text }] }
    assert.equal(rewriteWorkbuddyAssistantFingerprints(body), false)
    assert.equal(body.messages[0].content, text)
  })
})

describe('11128 兜底入口', () => {
  test('搬家 + 指纹改写一次做完', () => {
    const body = {
      messages: [
        { role: 'system', content: LONG },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'DeepSeek Harness' }
      ]
    }
    assert.equal(applyWorkbuddy11128Fallback(body), true)
    assert.equal(isRelocated(body), true)
    assert.equal(/deepseek harness/i.test(body.messages[2].content), false)
  })

  test('两件事都做过了就返回 false —— 请求体没变，不该重发', () => {
    const body = {
      messages: [
        { role: 'system', content: LONG },
        { role: 'user', content: 'hi' }
      ]
    }
    assert.equal(applyWorkbuddy11128Fallback(body), true)
    assert.equal(applyWorkbuddy11128Fallback(body), false, '第二次必须什么都不改')
  })

  test('已经搬过家、但 assistant 里还有指纹时仍返回 true', () => {
    const body = {
      messages: [
        { role: 'system', content: DEFAULT_SYSTEM },
        { role: 'user', content: RELOCATE_MARKER + '...' },
        { role: 'assistant', content: 'You are an AI agent' }
      ]
    }
    assert.equal(isRelocated(body), true)
    assert.equal(applyWorkbuddy11128Fallback(body), true, '只剩指纹改写这一件事可做')
    assert.equal(/you are an ai agent/i.test(body.messages[2].content), false)
  })
})
