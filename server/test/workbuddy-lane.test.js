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

describe('模型清单', () => {
  test('隐藏模型必须在清单里，否则等于白接半个通道', () => {
    // 上游 /models 不回报这 8 个，但直调一律可用 —— 少了它们，可用面直接腰斩
    const hidden = ['gpt-5.6-luna', 'claude-opus-5', 'gpt-5.6-sol', 'glm-5.3', 'gpt-5.6-terra', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'gpt-6-astra']
    const ids = new Set(WORKBUDDY_CURATED_MODELS.map((m) => m.id))
    for (const id of hidden) assert.ok(ids.has(id), `${id} 不在清单里`)
  })

  test('每项都带 id 与 owned_by', () => {
    assert.ok(WORKBUDDY_CURATED_MODELS.length >= 19)
    assert.ok(WORKBUDDY_CURATED_MODELS.every((m) => m.id && m.owned_by))
  })
})
