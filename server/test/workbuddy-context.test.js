// 上下文档位与长上下文超时预算。
//
// 两件事各有一半在别的层，这里只钉纯逻辑与整形结果：
//  - 目录把上游的 contextWindow.supportedLengths 暴露成 context_options；
//  - 请求按 context_length 点档，且**只发上游声明过的值**（发错会被判非法调用）；
//  - 等响应头的预算随输入规模放大，总预算按模型真实的 max_tokens 算。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  normalizeModel,
  supportedContextLengths,
  pickWorkbuddyContextLength
} from '../workbuddy-core.js'
import { applyWorkbuddyContextLength, shapeWorkbuddyBody } from '../workbuddy-lane.js'
import {
  estimateInputTokens,
  connectTimeoutFor,
  CONNECT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MAX_MS
} from '../proxy.js'

// 上游真实下发形状（2026-11-16 抓包）：glm-5.3 三档、glm-4.6 只有 maxInputTokens
const GLM53 = {
  id: 'glm-5.3',
  maxInputTokens: 1000000,
  maxOutputTokens: 64000,
  contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] }
}

describe('supportedContextLengths：只认上游声明的事实', () => {
  test('三档原样取出、升序', () => {
    assert.deepEqual(supportedContextLengths(GLM53), [300000, 600000, 1000000])
  })

  test('没有 contextWindow 时返回空数组（不是报错，也不是猜一个值）', () => {
    assert.deepEqual(supportedContextLengths({ id: 'glm-4.6', maxInputTokens: 168000 }), [])
    assert.deepEqual(supportedContextLengths({}), [])
    assert.deepEqual(supportedContextLengths(null), [])
  })

  test('字符串数值归一成数字、去重', () => {
    const raw = { contextWindow: { supportedLengths: ['300000', 600000, 600000] } }
    assert.deepEqual(supportedContextLengths(raw), [300000, 600000])
  })

  test('非法值与零、负数一律剔掉', () => {
    const raw = { contextWindow: { supportedLengths: [0, -5, 'abc', null, 300000] } }
    assert.deepEqual(supportedContextLengths(raw), [300000])
  })
})

describe('normalizeModel：多档上下文进目录', () => {
  test('defaultLength 仍是 context，全部档位进 context_options', () => {
    const m = normalizeModel(GLM53, 'P')
    assert.equal(m.context, 300000)
    assert.deepEqual(m.context_options, [300000, 600000, 1000000])
    assert.equal(m.max_input, 1000000)
    assert.equal(m.max_output, 64000)
  })

  // 只有一个档位时「可选」没有意义，写进去只会让前端多渲染一个假选项
  test('只有单一档位时不写 context_options', () => {
    const m = normalizeModel({ id: 'x', contextWindow: { supportedLengths: [300000] } }, 'P')
    assert.equal(m.context_options, undefined)
    assert.equal(m.context, undefined, '没有 defaultLength 也不该编一个')
  })

  test('只有 maxInputTokens 的模型行为不变', () => {
    const m = normalizeModel({ id: 'glm-4.6', maxInputTokens: 168000 }, 'P')
    assert.equal(m.context, 168000)
    assert.equal(m.context_options, undefined)
  })
})

describe('pickWorkbuddyContextLength：只放行声明过的值', () => {
  const meta = { context_options: [300000, 600000, 1000000] }

  test('档位表里的值放行', () => {
    for (const v of [300000, 600000, 1000000]) {
      assert.equal(pickWorkbuddyContextLength(meta, v), v)
    }
  })

  // 这条是真事故边界：传不在表里的值，上游回 403/11140，与账号风控同形
  test('不在档位表里的值一律拒绝，绝不透传', () => {
    assert.equal(pickWorkbuddyContextLength(meta, 400000), null)
    assert.equal(pickWorkbuddyContextLength(meta, 2000000), null)
    assert.equal(pickWorkbuddyContextLength(meta, 1), null)
  })

  test('非法输入返回 null', () => {
    for (const v of [null, undefined, '', 'abc', 0, -1, NaN, Infinity]) {
      assert.equal(pickWorkbuddyContextLength(meta, v), null, `${String(v)} 应被拒绝`)
    }
  })

  test('模型没有档位信息时一律 null（不能猜）', () => {
    assert.equal(pickWorkbuddyContextLength({}, 600000), null)
    assert.equal(pickWorkbuddyContextLength(null, 600000), null)
  })

  test('字符串形式的合法值也能认（前端表单常传字符串）', () => {
    assert.equal(pickWorkbuddyContextLength(meta, '1000000'), 1000000)
  })
})

describe('applyWorkbuddyContextLength：对外 snake、对内 camel', () => {
  const meta = { context_options: [300000, 600000, 1000000] }

  test('合法档位写成 camelCase 的 contextLength，并摘掉 input 里的两种写法', () => {
    const body = { model: 'glm-5.3', context_length: 600000 }
    const r = applyWorkbuddyContextLength(body, meta)
    assert.equal(body.contextLength, 600000)
    assert.equal(body.context_length, undefined, 'snake 写法必须摘掉，上游不认')
    assert.equal(r.applied, 600000)
    assert.equal(r.reason, null)
  })

  test('客户端直接传 camelCase 也接受，但同样要过校验', () => {
    const ok = { contextLength: 1000000 }
    applyWorkbuddyContextLength(ok, meta)
    assert.equal(ok.contextLength, 1000000)

    const bad = { contextLength: 400000 }
    const r = applyWorkbuddyContextLength(bad, meta)
    assert.equal(bad.contextLength, undefined, '非法值必须摘掉，不能被原样转发')
    assert.match(r.reason, /不在可选档位/)
  })

  test('非法值：摘字段、回退默认档、给出可读原因', () => {
    const body = { context_length: 123456 }
    const r = applyWorkbuddyContextLength(body, meta)
    assert.equal(body.contextLength, undefined)
    assert.equal(r.requested, 123456)
    assert.equal(r.applied, null)
    assert.match(r.reason, /300000/)
  })

  test('非正整数给出单独的原因', () => {
    for (const v of [-1, 'abc']) {
      const body = { context_length: v }
      const r = applyWorkbuddyContextLength(body, meta)
      assert.match(r.reason, /不是正整数/)
      assert.equal(body.contextLength, undefined)
    }
  })

  test('没传就不动请求体（这条是「不改变既有行为」的保证）', () => {
    const body = { model: 'glm-5.3', messages: [] }
    const r = applyWorkbuddyContextLength(body, meta)
    assert.equal(body.contextLength, undefined)
    assert.equal(r.requested, null)
    assert.equal(r.reason, null)
  })

  test('模型无档位时给「没有可选档位」的原因', () => {
    const body = { context_length: 600000 }
    const r = applyWorkbuddyContextLength(body, {})
    assert.equal(body.contextLength, undefined)
    assert.match(r.reason, /没有可选上下文档位/)
  })
})

describe('shapeWorkbuddyBody：contextLength 与 max_tokens 一起落到上游体', () => {
  const meta = { max_output: 64000, context_options: [300000, 600000, 1000000] }

  test('两个字段各自正确，且不残留 snake 写法', () => {
    const out = shapeWorkbuddyBody(
      { model: 'glm-5.3', context_length: 1000000, messages: [{ role: 'user', content: 'hi' }] },
      meta,
      'cn'
    )
    assert.equal(out.contextLength, 1000000)
    assert.equal(out.max_tokens, 64000)
    assert.equal(out.context_length, undefined)
  })

  test('非法档位不会出现在发给上游的请求体里', () => {
    const out = shapeWorkbuddyBody(
      { model: 'glm-5.3', context_length: 999, messages: [{ role: 'user', content: 'hi' }] },
      meta,
      'cn'
    )
    assert.equal(out.contextLength, undefined)
    assert.equal(out.context_length, undefined)
  })

  test('没点档位时请求体形态与以往一致', () => {
    const out = shapeWorkbuddyBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, meta, 'cn')
    assert.equal(out.contextLength, undefined)
    assert.equal(out.max_tokens, 64000)
  })
})

describe('estimateInputTokens：只用于放大预算，宁可高估', () => {
  test('空请求为 0', () => {
    assert.equal(estimateInputTokens({}), 0)
    assert.equal(estimateInputTokens(null), 0)
  })

  test('字符串 content 与多段 content 都算进去', () => {
    const a = estimateInputTokens({ messages: [{ role: 'user', content: '你好世界' }] })
    const b = estimateInputTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好世界' }] }] })
    assert.ok(a > 0)
    assert.equal(a, b)
  })

  test('工具 schema 也计入（量不可忽略）', () => {
    const noTools = estimateInputTokens({ messages: [{ role: 'user', content: 'x' }] })
    const withTools = estimateInputTokens({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'read', description: '读文件'.repeat(50) } }]
    })
    assert.ok(withTools > noTools, '工具 schema 必须计入')
  })

  test('大输入大致成比例（估算不会塌成常数）', () => {
    const one = estimateInputTokens({ messages: [{ role: 'user', content: '字'.repeat(10000) }] })
    const ten = estimateInputTokens({ messages: [{ role: 'user', content: '字'.repeat(100000) }] })
    assert.ok(ten > one * 5, `十万字应远大于一万字（${one} -> ${ten}）`)
  })
})

describe('connectTimeoutFor：等响应头的预算随输入放大', () => {
  test('小输入就是基础值（零头不超过 1 秒）', () => {
    assert.equal(connectTimeoutFor(0, 1800000), CONNECT_TIMEOUT_MS)
    const tiny = connectTimeoutFor(100, 1800000)
    assert.ok(tiny >= CONNECT_TIMEOUT_MS, '不能比基础值还小')
    assert.ok(tiny <= CONNECT_TIMEOUT_MS + 1000, `100 token 的零头应可忽略（实际 ${tiny}ms）`)
  })

  test('随 token 数变大而变大', () => {
    const a = connectTimeoutFor(100000, 1800000)
    const b = connectTimeoutFor(300000, 1800000)
    const c = connectTimeoutFor(960000, 1800000)
    assert.ok(a > CONNECT_TIMEOUT_MS)
    assert.ok(b > a, `${b} 应大于 ${a}`)
    assert.ok(c > b, `${c} 应大于 ${b}`)
  })

  test('30 万 token 至少给到 2.5 分钟以上（原先是 80 秒）', () => {
    // 用户报的正是「上下文一长就超时」。若这里退化回 80 秒，长上下文必然复现。
    assert.ok(connectTimeoutFor(300000, 1800000) >= 150000, '30 万 token 应给足 150 秒以上')
  })

  test('永远不超过硬上限', () => {
    assert.equal(connectTimeoutFor(1e9, 1800000), CONNECT_TIMEOUT_MAX_MS)
    assert.ok(connectTimeoutFor(1e9, 1800000) <= CONNECT_TIMEOUT_MAX_MS)
  })

  test('不超过本次请求的总预算', () => {
    const total = 200000
    assert.ok(connectTimeoutFor(960000, total) <= Math.max(total, CONNECT_TIMEOUT_MS))
  })

  // 运营把总预算调得比基础值还小时，也不能把每次尝试压成几十毫秒
  test('总预算异常小时仍保底给基础值', () => {
    assert.equal(connectTimeoutFor(500000, 1000), CONNECT_TIMEOUT_MS)
  })

  test('负数与 NaN 当 0 处理', () => {
    assert.equal(connectTimeoutFor(-5, 1800000), CONNECT_TIMEOUT_MS)
    assert.equal(connectTimeoutFor(NaN, 1800000), CONNECT_TIMEOUT_MS)
  })
})
