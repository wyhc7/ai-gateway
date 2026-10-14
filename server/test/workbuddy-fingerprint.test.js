// 腾讯内容级风控指纹（400 / code 11128）的改写契约
//
// 依据 dsh-our-free-model 的实测表（被拦 + 改写后放行，两条证据齐备）。
// 这里钉的是**改写面**，不是改写效果 —— 效果需要实网，属人工验证。
//
// 三条不能违反的约束（改错任何一条都会引入真实缺陷）：
//  1. 只改 system：user / tool 里同一句实测不拦，改它们只会破坏用户原话与工具输出；
//  2. 改所有 system 消息，不只 messages[0]：非首位同样被拦；
//  3. 大小写不敏感的**精确字面量**匹配：不能泛化成正则/关键词
//     （只差一个词或一个空格就不拦，泛化会误伤正常内容）。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const {
  CONTENT_FINGERPRINTS,
  rewriteTencentContentFingerprints,
  rewriteWorkbuddySystemFingerprints
} = await import('../workbuddy-fingerprint.js')

const BAD = 'Main branch (you will usually use this for PRs)'
const GOOD = 'Main branch (PRs usually go here)'

describe('单段文本改写', () => {
  test('命中指纹时改写成等义句', () => {
    assert.equal(rewriteTencentContentFingerprints(BAD), GOOD)
  })

  test('句子嵌在长文本里也改，前后内容不动', () => {
    const text = `# 项目上下文\n${BAD}: master\n\n其余说明`
    const out = rewriteTencentContentFingerprints(text)
    assert.match(out, /Main branch \(PRs usually go here\): master/)
    assert.match(out, /# 项目上下文/)
    assert.match(out, /其余说明/)
  })

  test('大小写不敏感：全小写与全大写都被上游拦，也必须能改掉', () => {
    assert.equal(rewriteTencentContentFingerprints(BAD.toLowerCase()), GOOD)
    assert.equal(rewriteTencentContentFingerprints(BAD.toUpperCase()), GOOD)
  })

  test('同一句出现多次时全部改写', () => {
    const out = rewriteTencentContentFingerprints(`${BAD}\n${BAD}`)
    assert.equal(out.split(GOOD).length - 1, 2)
    assert.equal(out.includes('usually use this'), false)
  })

  // 这条是硬要求：腾讯侧按前缀缓存，无谓地重建字符串会让每轮都算新前缀，
  // 白白吃掉缓存命中。
  test('不含指纹的文本逐字符不变（前缀缓存不能被打断）', () => {
    const text = 'Main branch: master\n完全正常的一段话'
    assert.equal(rewriteTencentContentFingerprints(text), text)
    assert.equal(rewriteTencentContentFingerprints(''), '')
    assert.equal(rewriteTencentContentFingerprints(undefined), undefined)
  })

  // 服务端认的是逐字符字面量：差一个词 / 多一个空格都不拦。
  // 泛化成关键词匹配就会去改这些**本来能通过**的文本，属于无谓改写。
  test('只差一个词或空格时不改（说明服务端认字面量，不能泛化）', () => {
    for (const near of [
      'Main branch (you will normally use this for PRs)',
      'Main branch  (you will usually use this for PRs)',
      'Main branch: master'
    ]) {
      assert.equal(rewriteTencentContentFingerprints(near), near, `不该改：${near}`)
    }
  })
})

describe('请求体改写：只碰 system', () => {
  test('system 消息被改写', () => {
    const obj = { messages: [{ role: 'system', content: BAD }] }
    assert.equal(rewriteWorkbuddySystemFingerprints(obj), true)
    assert.equal(obj.messages[0].content, GOOD)
  })

  // 实测：同一句放进 user / tool 不拦。改写它们零收益，却会破坏用户原话
  // 与工具输出 —— 那是不可接受的副作用。
  test('user / tool / assistant 里的同一句绝不改', () => {
    const obj = {
      messages: [
        { role: 'user', content: BAD },
        { role: 'tool', content: BAD },
        { role: 'assistant', content: BAD }
      ]
    }
    assert.equal(rewriteWorkbuddySystemFingerprints(obj), false)
    assert.equal(obj.messages[0].content, BAD)
    assert.equal(obj.messages[1].content, BAD)
    assert.equal(obj.messages[2].content, BAD)
  })

  // 实测：指纹在第二条 system（非 messages[0]）同样被拦。
  test('非首位的 system 同样改写', () => {
    const obj = {
      messages: [
        { role: 'system', content: '正常系统提示' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: BAD }
      ]
    }
    assert.equal(rewriteWorkbuddySystemFingerprints(obj), true)
    assert.equal(obj.messages[2].content, GOOD)
    assert.equal(obj.messages[0].content, '正常系统提示')
  })

  test('多段 content 形态逐段改写，只动 text 段', () => {
    const obj = {
      messages: [{
        role: 'system',
        content: [
          { type: 'text', text: BAD },
          { type: 'image_url', image_url: { url: 'http://x/y.png' } }
        ]
      }]
    }
    assert.equal(rewriteWorkbuddySystemFingerprints(obj), true)
    assert.equal(obj.messages[0].content[0].text, GOOD)
    assert.equal(obj.messages[0].content[1].image_url.url, 'http://x/y.png', '图片段必须原样保留')
  })

  test('没有命中时不报告改动（调用方据此跳过重新序列化）', () => {
    const obj = { messages: [{ role: 'system', content: '干净的系统提示' }] }
    assert.equal(rewriteWorkbuddySystemFingerprints(obj), false)
  })

  test('结构异常不炸', () => {
    assert.equal(rewriteWorkbuddySystemFingerprints({}), false)
    assert.equal(rewriteWorkbuddySystemFingerprints({ messages: null }), false)
    assert.equal(rewriteWorkbuddySystemFingerprints({ messages: [null, 1, 'x'] }), false)
  })
})

describe('指纹表', () => {
  test('每条都带 find / replace / note（来源与证据必须写在代码里）', () => {
    assert.ok(CONTENT_FINGERPRINTS.length > 0, '至少有一条实测指纹')
    for (const rule of CONTENT_FINGERPRINTS) {
      assert.ok(rule.find && typeof rule.find === 'string')
      assert.ok(rule.replace && typeof rule.replace === 'string')
      assert.ok(rule.note && typeof rule.note === 'string', '缺证据说明会让后人误删或泛化')
      assert.notEqual(rule.find, rule.replace)
    }
  })

  test('改写句与原句语义等价且确实不同（不能改成空串糊弄）', () => {
    for (const rule of CONTENT_FINGERPRINTS) {
      assert.ok(rule.replace.length > 0)
      assert.ok(rule.replace.includes('Main branch') || rule.replace.length > 10, '改写句要保留原意')
    }
  })
})
