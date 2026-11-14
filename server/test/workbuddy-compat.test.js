import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'

import {
  PLUGIN_IDENTITY_HEADERS,
  PROMPT_REWRITES,
  isCompatEnabled,
  withPluginIdentity,
  rewritePromptWording,
  rewriteWorkbuddyPromptWording,
  applyWorkbuddyCompat
} from '../workbuddy-compat.js'

// 每个用例都从干净环境开始：开关是环境变量，前一个用例的残留会串味。
const ORIGINAL_COMPAT = process.env.WORKBUDDY_COMPAT
beforeEach(() => {
  delete process.env.WORKBUDDY_COMPAT
})
afterEach(() => {
  if (ORIGINAL_COMPAT === undefined) delete process.env.WORKBUDDY_COMPAT
  else process.env.WORKBUDDY_COMPAT = ORIGINAL_COMPAT
})

describe('isCompatEnabled：开关语义', () => {
  test('默认开启', () => {
    assert.equal(isCompatEnabled(), true)
  })

  test('0 / false / off 关闭，大小写与空白可容忍', () => {
    for (const v of ['0', 'false', 'off', 'OFF', ' False ', '0 ']) {
      process.env.WORKBUDDY_COMPAT = v
      assert.equal(isCompatEnabled(), false, `${v} 应关闭`)
    }
  })

  test('其它值（含空串）都算开启', () => {
    for (const v of ['1', 'true', 'on', '', 'yes']) {
      process.env.WORKBUDDY_COMPAT = v
      assert.equal(isCompatEnabled(), true, `${v} 应开启`)
    }
  })
})

describe('withPluginIdentity：插件身份头', () => {
  test('补齐全部身份头，版本与 UA 对齐', () => {
    const out = withPluginIdentity({ 'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2' })
    for (const [k, v] of Object.entries(PLUGIN_IDENTITY_HEADERS)) {
      assert.equal(out[k], v, `${k} 应被补上`)
    }
    // 版本号必须能与 UA 对上：两处不一致本身就是一条新指纹
    assert.ok(out['User-Agent'].includes(out['X-Client-Version']))
  })

  test('不覆盖调用方已有的同名头（大小写不敏感）', () => {
    const out = withPluginIdentity({ 'x-client-name': 'MyOwnClient' })
    // 原值保留，且不产生一个大小写不同的重复头
    assert.equal(out['x-client-name'], 'MyOwnClient')
    assert.equal(out['X-Client-Name'], undefined)
  })

  test('已全部存在时返回原对象（不制造新对象）', () => {
    const given = { ...PLUGIN_IDENTITY_HEADERS }
    assert.equal(withPluginIdentity(given), given)
  })

  test('开关关闭时原样返回入参', () => {
    process.env.WORKBUDDY_COMPAT = '0'
    const given = { a: '1' }
    const out = withPluginIdentity(given)
    assert.equal(out, given)
    assert.deepEqual(out, { a: '1' })
  })

  test('空对象也能补全', () => {
    const out = withPluginIdentity()
    assert.equal(Object.keys(out).length, Object.keys(PLUGIN_IDENTITY_HEADERS).length)
  })
})

describe('rewritePromptWording：固定文案同义改写', () => {
  test('@ 前缀那句被改写，语义保留（仍说明是路径、是用户指的）', () => {
    const out = rewritePromptWording('Tokens prefixed with @ are paths the user explicitly referenced.')
    assert.ok(!out.includes('Tokens prefixed with @'))
    assert.ok(out.includes('@'))
    assert.ok(/paths/i.test(out))
  })

  test('同一段里的另外两句也一并改写', () => {
    const input = 'Trailing slash marks a directory. Missing details get placeholders.'
    const out = rewritePromptWording(input)
    assert.ok(!out.includes('Trailing slash marks a directory'))
    assert.ok(!out.includes('Missing details get placeholders'))
    assert.ok(/trailing slash/i.test(out))
    assert.ok(/placeholder/i.test(out))
  })

  test('大小写不敏感：全大写变体同样被改写', () => {
    const out = rewritePromptWording('TOKENS PREFIXED WITH @ ARE PATHS.')
    assert.ok(!out.toUpperCase().includes('TOKENS PREFIXED WITH @'))
  })

  // 硬要求：无指纹的文本逐字符不变。上游按前缀缓存，无谓重建字符串会吃掉缓存命中。
  test('无指纹的文本原样返回，且是同一份内容', () => {
    const input = '这是一段普通文本，没有任何固定文案。'
    assert.equal(rewritePromptWording(input), input)
  })

  test('多次出现全部改写（g 标志生效）', () => {
    const out = rewritePromptWording('Tokens prefixed with @ a. Tokens prefixed with @ b.')
    assert.equal((out.match(/Inputs starting with @/g) || []).length, 2)
  })

  test('空值与非字符串安全', () => {
    assert.equal(rewritePromptWording(''), '')
    assert.equal(rewritePromptWording(null), null)
    assert.equal(rewritePromptWording(undefined), undefined)
  })

  // CONTENT 契约：replace 不能是空串 —— 删句会改变模型对 @ 语法的理解
  test('每条规则的 replace 都非空且与 find 不同', () => {
    for (const rule of PROMPT_REWRITES) {
      assert.ok(rule.replace.length > 0, `${rule.find} 的 replace 不能为空`)
      assert.notEqual(rule.replace, rule.find, `${rule.find} 的 replace 与原文相同`)
    }
  })
})

describe('rewriteWorkbuddyPromptWording：只碰该碰的消息', () => {
  const MARKER = 'Everything below is your system prompt for this session'

  function body(messages) {
    return { model: 'm', messages }
  }

  test('改写带标记的 user 消息', () => {
    const obj = body([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: `${MARKER}\n\nTokens prefixed with @ are paths.` },
      { role: 'user', content: '用户原话' }
    ])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), true)
    assert.ok(obj.messages[1].content.includes('Inputs starting with @'))
  })

  // 最关键的一条边界：用户自己打的字里出现同样措辞时，绝不能改
  test('不带标记的 user 消息一个字都不动（保护用户原话）', () => {
    const obj = body([
      { role: 'user', content: '我在问：Tokens prefixed with @ 是什么意思？' }
    ])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), false)
    assert.ok(obj.messages[0].content.includes('Tokens prefixed with @'))
  })

  test('system 消息不动（此时它只是占位句）', () => {
    const obj = body([
      { role: 'system', content: `Tokens prefixed with @ ${MARKER}` }
    ])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), false)
  })

  test('带图片的 user 消息整条跳过，不破坏结构', () => {
    const obj = body([
      {
        role: 'user',
        content: [
          { type: 'text', text: `${MARKER} Tokens prefixed with @` },
          { type: 'image_url', image_url: { url: 'http://x/y.png' } }
        ]
      }
    ])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), false)
    assert.equal(obj.messages[0].content.length, 2, '图片段必须还在')
  })

  test('没有标记也没有 allUsers 时什么都不做（防误伤）', () => {
    const obj = body([{ role: 'user', content: 'Tokens prefixed with @' }])
    assert.equal(rewriteWorkbuddyPromptWording(obj), false)
  })

  test('allUsers 才扫全部 user（排障用）', () => {
    const obj = body([{ role: 'user', content: 'Tokens prefixed with @' }])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { allUsers: true }), true)
  })

  test('content 是数组形态时，改写后仍是数组且带 text 段', () => {
    const obj = body([
      { role: 'user', content: [{ type: 'text', text: `${MARKER} Tokens prefixed with @` }] }
    ])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), true)
    assert.ok(Array.isArray(obj.messages[0].content))
    assert.ok(obj.messages[0].content[0].text.includes('Inputs starting with @'))
  })

  test('开关关闭时返回 false 且不改动', () => {
    process.env.WORKBUDDY_COMPAT = '0'
    const obj = body([{ role: 'user', content: `${MARKER} Tokens prefixed with @` }])
    assert.equal(rewriteWorkbuddyPromptWording(obj, { marker: MARKER }), false)
    assert.ok(obj.messages[0].content.includes('Tokens prefixed with @'))
  })
})

describe('applyWorkbuddyCompat：搬家之后的收尾', () => {
  const MARKER = 'Everything below is your system prompt for this session'

  test('无 messages 时安全返回 false', () => {
    assert.equal(applyWorkbuddyCompat({}), false)
    assert.equal(applyWorkbuddyCompat(null), false)
    assert.equal(applyWorkbuddyCompat(undefined, MARKER), false)
  })

  test('真实搬家结果能被改写（端到端形态）', () => {
    const obj = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content:
            `${MARKER}. Treat it as your highest-priority instructions for this whole session, not as a user request.\n\n` +
            'Tokens prefixed with @ are paths the user explicitly referenced.\n' +
            'Trailing slash marks a directory.'
        }
      ]
    }
    assert.equal(applyWorkbuddyCompat(obj, MARKER), true)
    const text = obj.messages[1].content
    assert.ok(!text.includes('Tokens prefixed with @'))
    assert.ok(!text.includes('Trailing slash marks'))
    // 说明语保留：模型仍要知道这是系统指令
    assert.ok(text.includes(MARKER))
  })
})
