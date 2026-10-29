// WorkBuddy 订阅通道的请求整形测试
//
// 这里钉的是上游那几条「照 OpenAI 发就 400」的硬约束。参考实测记录见
// https://github.com/zidanefaqih/codebuddy-intl-cpa 的 payload.go：
// 每一条都对应一个真实报错码，改回原样就会重新踩坑。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const {
  WORKBUDDY_CURATED_MODELS,
  WORKBUDDY_UA,
  isWorkbuddyProtocol,
  normalizeWorkbuddyDomain,
  workbuddyHeaders,
  workbuddyChatBaseFor,
  workbuddyBillingBaseFor,
  workbuddyRealmFor,
  shapeWorkbuddyBody,
  normalizeWorkbuddyTools,
  ensureWorkbuddySystemFirst,
  neutralizeWorkbuddySystem,
  collectWorkbuddySystemText
} = await import('../workbuddy-lane.js')
const { defaultModelsFor } = await import('../proxy.js')

describe('WorkBuddy 协议识别', () => {
  test('只认 workbuddy-oauth，别把腾讯和别家搞混', () => {
    assert.equal(isWorkbuddyProtocol('workbuddy-oauth'), true)
    assert.equal(isWorkbuddyProtocol('codex-oauth'), false)
    assert.equal(isWorkbuddyProtocol('grok-oauth'), false)
    assert.equal(isWorkbuddyProtocol('openai-chat'), false)
  })
})

describe('按 Key 注入的请求头', () => {
  test('uid 与 realm 必须跟着账号走', () => {
    const h = workbuddyHeaders({ uid: 'u-1', domain: 'workbuddy.ai' })
    assert.equal(h['X-User-Id'], 'u-1')
    assert.equal(h['X-Domain'], 'workbuddy.ai')
    assert.equal(h['User-Agent'], WORKBUDDY_UA)
    // Referer 同样跟着 realm：跨 realm 引用会被网关当成外部渠道
    assert.equal(h.Referer, 'https://www.workbuddy.ai/')
  })

  // 空 domain 落国内而不是国际：参考实现对「domain 为空的旧登录态文件」
  // 就是兜到 CN 的，默认成国际域会把一个国内账号发到 workbuddy.ai 去。
  test('缺 realm 时落到国内默认值，不能落空', () => {
    assert.equal(normalizeWorkbuddyDomain(''), 'www.codebuddy.cn')
    assert.equal(normalizeWorkbuddyDomain(null), 'www.codebuddy.cn')
    // 允许用户直接粘一个完整 URL 进来
    assert.equal(normalizeWorkbuddyDomain('https://CodeBuddy.ai/path'), 'codebuddy.ai')
  })

  test('缺 uid 时也产出字段，避免上游拿 undefined 去比对', () => {
    const h = workbuddyHeaders({})
    assert.equal(h['X-User-Id'], '')
    assert.equal(h['X-Domain'], 'www.codebuddy.cn')
    assert.equal(h.Referer, 'https://www.codebuddy.cn/')
  })

  test('三个 realm 各走各的网关，Referer 不串台', () => {
    assert.equal(workbuddyChatBaseFor('www.codebuddy.cn'), 'https://copilot.tencent.com')
    assert.equal(workbuddyChatBaseFor('workbuddy.ai'), 'https://www.workbuddy.ai')
    // intl 的接入地址已迁到 workbuddy.ai（旧 www.codebuddy.ai 解析成 0.0.0.1）。
    // 注意 realm 判据仍是 codebuddy.ai —— 下面两行是「不同维度」的断言，
    // 不要因为接入地址相同就以为判据也合并了。
    assert.equal(workbuddyChatBaseFor('www.codebuddy.ai'), 'https://www.workbuddy.ai')
    assert.equal(workbuddyRealmFor('www.codebuddy.ai'), 'intl')
    // CN 的计费域与对话域是分开的两个站，Global/Intl 则同域
    assert.equal(workbuddyBillingBaseFor('www.codebuddy.cn'), 'https://www.codebuddy.cn')
    assert.equal(workbuddyBillingBaseFor('workbuddy.ai'), 'https://www.workbuddy.ai')
    assert.equal(workbuddyBillingBaseFor('www.codebuddy.ai'), 'https://www.workbuddy.ai')
    assert.equal(workbuddyBillingBaseFor(''), 'https://www.codebuddy.cn')
    assert.equal(workbuddyRealmFor('codebuddy.ai'), 'intl')
    assert.equal(workbuddyRealmFor('https://www.workbuddy.ai/x'), 'global')
    assert.equal(workbuddyRealmFor('codebuddy.cn'), 'cn')
  })

  // 国际版渠道校验（2026-10-20 上线）：旧路由缺这三个会话头中任意一个即
  // 400 code 11128 "request illegal"。只查存在性，UA/Origin/X-Product 均无效。
  test('三个会话头必须存在，否则国际版 11128 拒绝', () => {
    const h = workbuddyHeaders({ uid: 'u-1', domain: 'workbuddy.ai' })
    for (const name of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
      assert.equal(typeof h[name], 'string', `${name} 缺失或不是字符串`)
      assert.ok(h[name].length > 0, `${name} 是空串，等于没发`)
      assert.match(h[name], /^[0-9a-f-]{36}$/, `${name} 不是 UUID 形态`)
    }
    // 形状照官方桌面端：Request-ID 与 Message-ID 同值，Conversation-ID 独立
    assert.equal(h['X-Conversation-Request-ID'], h['X-Conversation-Message-ID'])
    assert.notEqual(h['X-Conversation-ID'], h['X-Conversation-Request-ID'])
  })

  test('会话头每请求新生成（网关无状态，不复用不串话）', () => {
    const a = workbuddyHeaders({ uid: 'u-1', domain: 'workbuddy.ai' })
    const b = workbuddyHeaders({ uid: 'u-1', domain: 'workbuddy.ai' })
    assert.notEqual(a['X-Conversation-ID'], b['X-Conversation-ID'])
    assert.notEqual(a['X-Conversation-Request-ID'], b['X-Conversation-Request-ID'])
  })

  test('国内版也发会话头（官方桌面端同样发，实测 200 不踩雷）', () => {
    const h = workbuddyHeaders({ uid: 'u-1', domain: 'www.codebuddy.cn' })
    assert.ok(h['X-Conversation-ID'])
    assert.ok(h['X-Conversation-Request-ID'])
    assert.ok(h['X-Conversation-Message-ID'])
    assert.equal(h['X-Domain'], 'www.codebuddy.cn')
  })
})

describe('请求体整形', () => {
  test('上游拒绝非流式，stream 一律强制打开', () => {
    const out = shapeWorkbuddyBody({ model: 'glm-5.2', messages: [], stream: false })
    assert.equal(out.stream, true)
  })

  test('tool_choice 对象形态收敛成字符串，否则上游 400 code 11101', () => {
    const obj = { tool_choice: { type: 'function', function: { name: 'read_file' } } }
    normalizeWorkbuddyTools(obj)
    assert.equal(obj.tool_choice, 'read_file')
  })

  test('tool_choice=none 必须连 tools 一起删掉', () => {
    // 上游虽然接受 none，但 tools 非空时模型照样吐 tool_calls
    const obj = { tool_choice: 'none', tools: [{ type: 'function', function: { name: 'a' } }] }
    normalizeWorkbuddyTools(obj)
    assert.equal(obj.tool_choice, undefined)
    assert.equal(obj.tools, undefined)
  })

  test('认不出的对象形态直接丢弃，不转发出去换一个 400', () => {
    const obj = { tool_choice: { type: 'made-up' } }
    normalizeWorkbuddyTools(obj)
    assert.equal(obj.tool_choice, undefined)
  })

  test('auto / required / 具体函数名原样放行', () => {
    for (const v of ['auto', 'required', 'read_file']) {
      const obj = { tool_choice: v }
      normalizeWorkbuddyTools(obj)
      assert.equal(obj.tool_choice, v)
    }
  })

  test('developer 角色改写成 system，否则上游 11128 拒绝', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.2',
      messages: [{ role: 'developer', content: 'x' }]
    })
    assert.equal(out.messages[0].role, 'system')
  })

  // 国际版渠道校验要求首条消息必须是 system：纯 user 消息报 11101，
  // [user, system] 这种「有 system 但不在第一条」报 11128 first message is
  // not system prompt。本组钉的就是「首条一定是 system」这条硬约束。
  test('没有 system 消息时补一条默认的（纯 user 上游 11101）', () => {
    const obj = { messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(ensureWorkbuddySystemFirst(obj), true)
    assert.equal(obj.messages[0].role, 'system')
    assert.equal(obj.messages[0].content, 'You are a helpful assistant.')
    // 再调一次不动：首条已经是 system
    assert.equal(ensureWorkbuddySystemFirst(obj), false)
  })

  test('system 不在首条时提到最前，保留客户端原话', () => {
    const obj = { messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '你是客服' },
      { role: 'user', content: 'again' }
    ] }
    assert.equal(ensureWorkbuddySystemFirst(obj), true)
    assert.equal(obj.messages[0].role, 'system')
    assert.equal(obj.messages[0].content, '你是客服', '不能把客户端的 system 内容换成默认值')
    assert.equal(obj.messages.length, 3, '只移动不删减')
    assert.equal(obj.messages[1].content, 'hi')
    assert.equal(obj.messages[2].content, 'again')
  })

  test('首条已是 system 时什么都不做', () => {
    const obj = { messages: [
      { role: 'system', content: 'ok' },
      { role: 'user', content: 'hi' }
    ] }
    assert.equal(ensureWorkbuddySystemFirst(obj), false)
    assert.equal(obj.messages[0].content, 'ok')
    assert.equal(obj.messages.length, 2)
  })

  test('空消息列表不炸，也没有可移动的东西', () => {
    assert.equal(ensureWorkbuddySystemFirst({ messages: [] }), false)
    assert.equal(ensureWorkbuddySystemFirst({}), false)
  })

  test('整形入口端到端：[user, system] 出来首条是 system', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: '规则' }]
    })
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[0].content, '规则')
  })

  test('developer 占首条时：先改写角色再保证首位（顺序不能反）', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [{ role: 'developer', content: 'x' }, { role: 'user', content: 'hi' }]
    })
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[0].content, 'x')
  })

  test('hy3 系锁死 reasoning_effort=high，否则上游退化成不思考', () => {
    const out = shapeWorkbuddyBody({ model: 'hy3', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(out.reasoning_effort, 'high')
    // 非 hy3 系不碰，免得改坏别的模型
    const other = shapeWorkbuddyBody({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(other.reasoning_effort, undefined)
  })

  test('不改动入参', () => {
    const input = { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }
    shapeWorkbuddyBody(input)
    assert.equal(input.stream, undefined, '入参被就地改写会让调用方难以推理')
  })
})

describe('max_tokens 按模型上限下发', () => {
  // 上游对每个模型有各自的单次输出上限（实测各端点 128000–131072）。
  // 不下发就用网关默认值（实测 32000），大文件写入与长回答会被截断成
  // finish_reason: 'length' —— 那是「上游声明的能力」，不是网关能替它省的。
  test('客户端没给 max_tokens 时按该模型的上限下发', () => {
    const out = shapeWorkbuddyBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }] }, { max_output: 131072 })
    assert.equal(out.max_tokens, 131072)
  })

  test('客户端显式给了就尊重它（用户可能刻意要短回答）', () => {
    const out = shapeWorkbuddyBody(
      { model: 'glm-5.3', max_tokens: 512, messages: [{ role: 'user', content: 'x' }] },
      { max_output: 131072 }
    )
    assert.equal(out.max_tokens, 512)
  })

  test('目录里没有该模型（或上游没给上限）时不猜一个值', () => {
    const a = shapeWorkbuddyBody({ model: 'x', messages: [{ role: 'user', content: 'x' }] }, null)
    assert.equal(a.max_tokens, undefined)
    const b = shapeWorkbuddyBody({ model: 'x', messages: [{ role: 'user', content: 'x' }] }, {})
    assert.equal(b.max_tokens, undefined)
    const c = shapeWorkbuddyBody({ model: 'x', messages: [{ role: 'user', content: 'x' }] }, { max_output: 0 })
    assert.equal(c.max_tokens, undefined, '0 是无效上限，不能下发')
  })
})

describe('内容指纹改写接入', () => {
  // 腾讯网关按 system 里的模板句做内容级拦截（400 / 11128）。
  // 整形流程必须顺带把它改掉，否则带这类提示词的客户端每次请求都失败。
  test('system 里的已知指纹在整形时被改写', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs): master' },
        { role: 'user', content: 'hi' }
      ]
    })
    assert.match(out.messages[0].content, /PRs usually go here/)
    assert.equal(out.messages[0].content.includes('usually use this'), false)
  })

  // 顺序要求：developer → system 的改写必须先发生，否则内容指纹那一步
  // 会漏掉这条消息（它当时还不是 system）。
  test('developer 角色改写后，其内容也参与指纹改写', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [{ role: 'developer', content: 'Main branch (you will usually use this for PRs)' }]
    })
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[0].content, 'Main branch (PRs usually go here)')
  })

  test('user 消息里的同一句不动（实测不拦，改了只会破坏用户原话）', () => {
    const text = 'Main branch (you will usually use this for PRs)'
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [{ role: 'system', content: 'ok' }, { role: 'user', content: text }]
    })
    assert.equal(out.messages[1].content, text)
  })
})

describe('CN 整段 prompt 匹配闸门：零宽打散', () => {
  // 2026-10-22/23 实测（见 workbuddy-lane.js 的长注释）：国内版按 n-gram
  // 召回率把 system 与已知客户端 prompt 库做整段匹配，覆盖率过阈值即 11128。
  // 修法是 CN realm 下给所有 system 消息插零宽字符打碎 n-gram。
  // 这组测试钉住三件事：CN 才打散、打散可逆（剥掉零宽=原文）、其他角色不动。
  const ZWC = '\u200B'
  const strip = (s) => s.split(ZWC).join('')

  test('realm=cn 时 system 被打散，剥掉零宽字符后等于原文', () => {
    const sys = '你是客服助手，负责回答用户问题。'.repeat(5)
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }]
    }, null, 'cn')
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[0].content.includes(ZWC), true, 'CN system 必须插零宽字符')
    assert.equal(strip(out.messages[0].content), sys, '剥掉零宽后必须等于原文（语义零损）')
    assert.equal(out.messages[1].content, 'hi', 'user 消息不动')
  })

  test('realm 非 cn（global/null）时完全不打散，历史行为不变', () => {
    const sys = '你是客服助手。'.repeat(10)
    for (const realm of [null, undefined, 'global', 'intl']) {
      const out = shapeWorkbuddyBody({
        model: 'glm-5.3',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }]
      }, null, realm)
      assert.equal(out.messages[0].content.includes(ZWC), false, `realm=${realm} 不应插零宽字符`)
    }
  })

  test('打散落在指纹改写之后：输出的指纹是改写后的句子', () => {
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs): master' },
        { role: 'user', content: 'hi' }
      ]
    }, null, 'cn')
    const stripped = strip(out.messages[0].content)
    assert.match(stripped, /PRs usually go here/, '指纹先被改写，再被打散')
    assert.equal(stripped.includes('usually use this'), false)
  })

  test('多段形态：只打散 text 段，其他段原样保留', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    const out = shapeWorkbuddyBody({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '第一段系统提示'.repeat(4) }, img] },
        { role: 'user', content: 'hi' }
      ]
    }, null, 'cn')
    const parts = out.messages[0].content
    assert.equal(parts[0].text.includes(ZWC), true)
    assert.equal(strip(parts[0].text), '第一段系统提示'.repeat(4))
    assert.equal(parts[1], img, '非 text 段不碰')
  })
})

describe('模型清单', () => {
  test('不再内置写死清单：模型只能来自上游', () => {
    // 曾经这里有一份写死的 18 个模型。它既漏掉了上游新增的型号，又留着
    // 上游早已下线的，拿它兜底等于用过期数据覆盖上游的真实数据。
    // 清单现在只有一个来源：上游接口（workbuddy-catalog.js）。
    assert.equal(WORKBUDDY_CURATED_MODELS, undefined, '不应再导出写死的模型清单')
  })

  test('取不到模型时不得回落到写死清单', () => {
    // 上游全挂 → defaultModelsFor 返回空 → refreshModels 标注 unavailable 并清空
    assert.equal(defaultModelsFor('workbuddy-oauth'), null)
  })
})

// 11128 的两种成因里，只有「账号级灰度闸门」能靠换 Key 解决。
// 另一种是 system 里的模板句（精确字面量），换多少号都拦——那种情况必须改内容。
// 下面钉的是兜底函数本身的行为，别让它误伤 user/tool，也别漏掉非首位的 system。
describe('11128 内容级兜底：中性化 system', () => {
  test('改掉 system，保留 user 原话与工具输出', () => {
    const body = {
      messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs)' },
        { role: 'user', content: '帮我改这个函数' },
        { role: 'tool', content: 'Main branch (you will usually use this for PRs)' }
      ]
    }
    assert.equal(neutralizeWorkbuddySystem(body), true)
    assert.equal(body.messages[0].content, 'You are a helpful assistant.')
    assert.equal(body.messages[1].content, '帮我改这个函数', 'user 原话一个字都不能动')
    assert.equal(
      body.messages[2].content,
      'Main branch (you will usually use this for PRs)',
      'tool 输出不能动：改它只会破坏工具结果且换不来放行'
    )
  })

  test('非首位的 system 也要改（11128 对它同样生效）', () => {
    const body = {
      messages: [
        { role: 'system', content: '正常系统提示' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: '另一段系统提示' }
      ]
    }
    assert.equal(neutralizeWorkbuddySystem(body), true)
    assert.equal(body.messages[0].content, 'You are a helpful assistant.')
    assert.equal(body.messages[2].content, 'You are a helpful assistant.')
  })

  test('已经是中性文本就不用再改：返回 false，避免无意义的重试预算消耗', () => {
    const body = { messages: [{ role: 'system', content: 'You are a helpful assistant.' }] }
    assert.equal(neutralizeWorkbuddySystem(body), false)
  })

  test('没有 system 时返回 false —— 那说明 11128 不是内容级，不该走这条兜底', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(neutralizeWorkbuddySystem(body), false)
  })

  test('结构异常不崩（messages 缺失 / 元素是 null / content 不是字符串）', () => {
    assert.equal(neutralizeWorkbuddySystem({}), false)
    assert.equal(neutralizeWorkbuddySystem({ messages: null }), false)
    assert.equal(neutralizeWorkbuddySystem({ messages: [null, 42, { role: 'system' }] }), true)
  })
})

describe('11128 诊断日志：system 原文收集', () => {
  test('拼出全部 system 正文，用来收集新的指纹句', () => {
    const body = {
      messages: [
        { role: 'system', content: 'AAA' },
        { role: 'user', content: 'BBB' },
        { role: 'system', content: 'CCC' }
      ]
    }
    const text = collectWorkbuddySystemText(body)
    assert.ok(text.includes('AAA'))
    assert.ok(text.includes('CCC'))
    assert.ok(!text.includes('BBB'), 'user 内容不进诊断日志')
  })

  test('content 是数组形态时退化成 JSON，不抛错', () => {
    const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'DDD' }] }] }
    assert.ok(collectWorkbuddySystemText(body).includes('DDD'))
  })

  test('没有 system 时返回空串', () => {
    assert.equal(collectWorkbuddySystemText({ messages: [{ role: 'user', content: 'x' }] }), '')
  })
})

// 2026-10-29：用线上截获的真实请求体逐变量隔离，确认 11128 的唯一触发源是
// system 里的长内容（tools / max_tokens / stream_options / store 全排除）。
// 同一段文本放进 user 就放行，所以把 system 后半段挪进第一条 user。
test('超长 system 的后半段挪进 user，前段留在 system', async () => {
  const { splitLongWorkbuddySystem } = await import('../workbuddy-lane.js')
  const long = 'A'.repeat(6000) + 'B'.repeat(6000)
  const obj = {
    messages: [
      { role: 'system', content: long },
      { role: 'user', content: 'hi' }
    ]
  }
  const changed = splitLongWorkbuddySystem(obj, 0.5, 1000)
  assert.equal(changed, true, '超过阈值应切分')
  const sys = obj.messages[0]
  const usr = obj.messages[1]
  assert.ok([...sys.content].length <= 6000 + 5, 'system 只保留前一半')
  assert.ok(sys.content.startsWith('A'), 'system 留下的是前段')
  assert.ok(usr.content.includes('[system-continuation]'), '搬过去的段落要有标记，免得模型当成用户提问')
  assert.ok(usr.content.includes('B'), '后段内容确实进了 user')
  assert.ok(usr.content.trim().endsWith('hi'), '原有 user 内容仍在末尾')
})

test('短 system 不动，不能无差别改写正常请求', async () => {
  const { splitLongWorkbuddySystem } = await import('../workbuddy-lane.js')
  const obj = { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }] }
  assert.equal(splitLongWorkbuddySystem(obj, 0.5, 8000), false, '短 system 不该被切')
  assert.equal(obj.messages[0].content, 'You are a helpful assistant.', '原样保留')
})

test('ratio 设 1 时关闭切分（保留回老行为的口子）', async () => {
  const { splitLongWorkbuddySystem } = await import('../workbuddy-lane.js')
  const obj = { messages: [{ role: 'system', content: 'X'.repeat(20000) }, { role: 'user', content: 'hi' }] }
  // ratio=1 -> cut 在末尾 -> tail 为空 -> 不改动
  assert.equal(splitLongWorkbuddySystem(obj, 1, 1000), false, '切分为空就不该动')
  assert.equal(obj.messages[0].content.length, 20000)
})

test('没有 user 消息时，搬过去的内容自己补一条 user', async () => {
  const { splitLongWorkbuddySystem } = await import('../workbuddy-lane.js')
  const obj = { messages: [{ role: 'system', content: 'A'.repeat(5000) + 'B'.repeat(5000) }] }
  assert.equal(splitLongWorkbuddySystem(obj, 0.5, 1000), true)
  const added = obj.messages.find((m) => m.role === 'user')
  assert.ok(added && added.content.includes('[system-continuation]'), '要补一条 user 承载后半段')
})

test('system 是数组形态（多段 text）时保持原样不切', async () => {
  const { splitLongWorkbuddySystem } = await import('../workbuddy-lane.js')
  const obj = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'A'.repeat(20000) }] },
      { role: 'user', content: 'hi' }
    ]
  }
  assert.equal(splitLongWorkbuddySystem(obj, 0.5, 1000), false, '非字符串 content 不冒险切')
})
