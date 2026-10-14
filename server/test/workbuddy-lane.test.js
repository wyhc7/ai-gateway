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
  ensureWorkbuddySystemMessage
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
    assert.equal(workbuddyChatBaseFor('www.codebuddy.ai'), 'https://www.codebuddy.ai')
    // CN 的计费域与对话域是分开的两个站，Global/Intl 则同域
    assert.equal(workbuddyBillingBaseFor('www.codebuddy.cn'), 'https://www.codebuddy.cn')
    assert.equal(workbuddyBillingBaseFor('workbuddy.ai'), 'https://www.workbuddy.ai')
    assert.equal(workbuddyBillingBaseFor(''), 'https://www.codebuddy.cn')
    assert.equal(workbuddyRealmFor('codebuddy.ai'), 'intl')
    assert.equal(workbuddyRealmFor('https://www.workbuddy.ai/x'), 'global')
    assert.equal(workbuddyRealmFor('codebuddy.cn'), 'cn')
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

  test('Global 账号没有 system 消息会报 11101，整形时补一条', () => {
    const obj = { messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(ensureWorkbuddySystemMessage(obj), true)
    assert.equal(obj.messages[0].role, 'system')
    // 已有 system 消息时不重复插入
    assert.equal(ensureWorkbuddySystemMessage(obj), false)
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
