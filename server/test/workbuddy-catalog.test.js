// WorkBuddy 模型目录的契约测试
//
// 钉四件事：
//  1. 倍率原样保留上游的 "x0.79" 形态，不自行换算；
//  2. UA 按端点自称——v3/config 要 IDE，企业端点要 CLI，反过来一个拿削减表一个 404；
//  3. 两个 realm 的目录必须分开取再合并：国际版企业端点是 500，清单只能来自 v3/config；
//  4. 同一个 id 倍率不同时必须当成两个模型，否则调用方点名时不知道会拿哪一个扣费。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const {
  workbuddyRateValue,
  fetchWorkbuddyModelRates,
  fetchWorkbuddyEnterpriseModels,
  mergeWorkbuddyCatalogs,
  WORKBUDDY_V3_UA,
  WORKBUDDY_CLI_UA
} = await import('../workbuddy-catalog.js')

function startUpstream(handler) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => handler({ req, res, raw }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// 国内版真实形态（2026-10-10 实测 copilot.tencent.com）
const CN_V3 = {
  code: 0,
  data: {
    models: [
      { id: 'glm-5.3', credits: 'x0.79' },
      { id: 'hy3', credits: 'x0.00' },
      // auto 的倍率是浮动的，上游就不给固定值
      { id: 'auto', descriptionZh: '积分倍率随之浮动' },
      { id: 'hy3-x', credits: '' }
    ]
  }
}

// 国际版真实形态（2026-10-11 实测 www.codebuddy.ai）：模型名是抽象别名
const INTL_V3 = {
  code: 0,
  data: {
    models: [
      { id: 'fast-model', credits: 'x0.34' },
      { id: 'primary-model', credits: 'x3.31' },
      { id: 'default-model' }
    ]
  }
}

describe('倍率取值', () => {
  test('带前缀的字符串按数字解析，零也算零', () => {
    assert.equal(workbuddyRateValue('x0.79'), 0.79)
    assert.equal(workbuddyRateValue('X0.5'), 0.5)
    assert.equal(workbuddyRateValue('×0.29'), 0.29)
    assert.equal(workbuddyRateValue('x0.00'), 0)
    assert.equal(workbuddyRateValue(0.25), 0.25)
  })

  test('空值与乱码返回 null，不能当成 0（0 是「免费」的语义）', () => {
    assert.equal(workbuddyRateValue(''), null)
    assert.equal(workbuddyRateValue('   '), null)
    assert.equal(workbuddyRateValue(null), null)
    assert.equal(workbuddyRateValue(undefined), null)
    assert.equal(workbuddyRateValue('n/a'), null)
  })

  test('企业端点的倍率带 credits 单位后缀，也要能解析', () => {
    // 实测两个端点写法不一致：/v3/config 给 "x0.79"，
    // 企业端点给 "x0.71 credits"。只剥前缀的话后者是 NaN → null，
    // 一条真实存在的倍率会被当成「上游没给」丢掉。
    assert.equal(workbuddyRateValue('x2.20 credits'), 2.2)
    assert.equal(workbuddyRateValue('x0.71 credits'), 0.71)
    assert.equal(workbuddyRateValue('x5.00 credits'), 5)
    assert.equal(workbuddyRateValue('x0.00 credits'), 0)
    assert.equal(workbuddyRateValue('2.20 CREDITS'), 2.2)
  })

  test('带后缀的零倍率仍是免费，不能判成缺失', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'hy3', credits: 'x0.00 credits' }] } }))
    })
    try {
      const { rates, models } = await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' })
      assert.equal(rates.hy3, 'x0.00 credits', '倍率要收下')
      assert.equal(workbuddyRateValue(rates.hy3), 0, '判零要成立')
      assert.equal(models[0].rate, 'x0.00 credits')
    } finally {
      server.close()
    }
  })
})

describe('v3/config：倍率与国际版清单', () => {
  test('只收有倍率的模型，缺值的（auto）不塞 0 进去；同时返回全部 id', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(CN_V3))
    })
    try {
      const { rates, ids } = await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' })
      assert.deepEqual(ids, ['glm-5.3', 'hy3', 'auto', 'hy3-x'])
      assert.equal(rates['glm-5.3'], 'x0.79')
      assert.equal(rates.hy3, 'x0.00')
      assert.equal('auto' in rates, false)
      assert.equal('hy3-x' in rates, false)
    } finally {
      server.close()
    }
  })

  test('必须自称 CodeBuddyIDE，CLI UA 拿到的是削减表', async () => {
    let seen = null
    const { server, base } = await startUpstream(({ req, res }) => {
      seen = { ua: req.headers['user-agent'], domain: req.headers['x-domain'], uid: req.headers['x-user-id'] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(CN_V3))
    })
    try {
      await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn', uid: 'u-1' })
      assert.equal(seen.ua, WORKBUDDY_V3_UA)
      assert.match(seen.ua, /CodeBuddyIDE/)
      assert.equal(seen.domain, 'www.codebuddy.cn')
      assert.equal(seen.uid, 'u-1')
    } finally {
      server.close()
    }
  })

  test('跨 realm 回 HTML 时给出可诊断的错误，不抛 parse failed', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(401, { 'Content-Type': 'text/html' })
      res.end('<html>401</html>')
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x', domain: 'workbuddy.ai' }),
        /非 JSON/
      )
    } finally {
      server.close()
    }
  })

  test('401/403 标记为凭据失效，调用方据此摘掉失效账号', async () => {
    // 凭据失效与「这个端点对本 realm 不可用」是两件事：
    // 前者要告诉用户去处理账号，后者才是正常降级。混为一谈会让失效账号
    // 静默留在库里，看起来一切正常。
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(401, { 'Content-Type': 'text/html' })
      res.end('<html>401 Authorization Required</html>')
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x', domain: 'www.codebuddy.cn' }),
        (err) => {
          assert.equal(err.auth_failed, true, '401 必须标记为凭据失效')
          assert.equal(err.status, 401)
          return true
        }
      )
    } finally {
      server.close()
    }
  })

  test('上游给的能力与规格一并带出，不只取 id 与倍率', async () => {
    // 上游每条模型带 20+ 字段（实测），全削成 id 是浪费：
    // 调用方要靠这些判断能不能开 1M、能不能用多模态与工具。
    const rich = {
      code: 0,
      data: {
        models: [
          {
            id: 'glm-5.3',
            credits: 'x0.79',
            name: 'GLM-5.3',
            descriptionZh: '旗舰模型',
            vendor: 'zhipu',
            maxInputTokens: 1000000,
            maxOutputTokens: 131072,
            contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] },
            supportsImages: true,
            supportsReasoning: true,
            supportsToolCall: true,
            iconUrl: 'https://x/icon.svg'
          }
        ]
      }
    }
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rich))
    })
    try {
      const { models } = await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' }, { name: 'WB' })
      const m = models[0]
      assert.equal(m.id, 'glm-5.3')
      assert.equal(m.rate, 'x0.79')
      assert.equal(m.name, 'GLM-5.3')
      assert.equal(m.description, '旗舰模型')
      assert.equal(m.vendor, 'zhipu')
      assert.equal(m.max_input, 1000000)
      assert.equal(m.max_output, 131072)
      assert.equal(m.context, 300000)
      assert.equal(m.images, true)
      assert.equal(m.reasoning, true)
      assert.equal(m.tools, true)
      assert.equal(m.icon, 'https://x/icon.svg')
    } finally {
      server.close()
    }
  })

  test('上游没给的字段就不写，不拿默认值假装上游说过', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'codewise-jump', credits: '' }] } }))
    })
    try {
      const { models } = await fetchWorkbuddyModelRates({ rates_base: base, access_token: 't', domain: 'www.codebuddy.cn' }, { name: 'WB' })
      const m = models[0]
      assert.equal(m.id, 'codewise-jump')
      assert.equal('rate' in m && m.rate !== null, false, '缺失倍率不能变成 0 或空串')
      assert.equal('max_input' in m, false)
      assert.equal('images' in m, false)
    } finally {
      server.close()
    }
  })

  test('信封报错时抛上游消息', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 1101, msg: '登录态失效' }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x' }),
        /登录态失效/
      )
    } finally {
      server.close()
    }
  })

  test('响应缺 data.models 时报错，不静默返回空表', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: {} }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyModelRates({ rates_base: base, access_token: 'x' }),
        /data\.models/
      )
    } finally {
      server.close()
    }
  })
})

describe('企业端点：国内版清单', () => {
  test('GET + CLI UA，解析小写的 data.models', async () => {
    let seen = null
    const { server, base } = await startUpstream(({ req, res }) => {
      seen = { method: req.method, ua: req.headers['user-agent'], path: req.url }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        msg: 'OK',
        data: { models: [{ ModelName: 'glm-5.3' }, { ModelName: 'hy3' }, { ModelName: 'glm-5.3' }] }
      }))
    })
    try {
      const { ids } = await fetchWorkbuddyEnterpriseModels({ models_base: base, access_token: 't', domain: 'www.codebuddy.cn' })
      assert.equal(seen.method, 'GET')
      assert.equal(seen.ua, WORKBUDDY_CLI_UA)
      assert.match(seen.path, /console\/enterprises\/personal\/models/)
      assert.deepEqual(ids, ['glm-5.3', 'hy3'], '重复项应去重')
    } finally {
      server.close()
    }
  })

  test('企业端点同样带倍率与规格，不能只取 id 就丢掉', async () => {
    // 实测企业端点 32 条里绝大多数带 credits。只取 id 扔掉倍率，
    // 等于把上游已经给出的答案扔了再让界面显示「未知」。
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            { id: 'glm-5.3', credits: 'x0.79', name: 'GLM-5.3', vendor: 'zhipu', maxInputTokens: 1000000 },
            { id: 'hunyuan-image-alpha', credits: 'x5.00', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] }
          ]
        }
      }))
    })
    try {
      const { models, rates } = await fetchWorkbuddyEnterpriseModels({ models_base: base, access_token: 't', domain: 'www.codebuddy.cn' }, { name: 'WB' })
      assert.equal(rates['glm-5.3'], 'x0.79')
      assert.equal(rates['hunyuan-image-alpha'], 'x5.00')
      assert.equal(models[0].name, 'GLM-5.3')
      assert.equal(models[0].max_input, 1000000)
      assert.deepEqual(models[1].tags, ['text-to-image'])
    } finally {
      server.close()
    }
  })

  test('国际版这条路是 500（生产实测 openresty 直接回 500 页），错误要能被调用方接住', async () => {    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>500 Internal Server Error</h1></body></html>')
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyEnterpriseModels({ models_base: base, access_token: 'x', domain: 'www.codebuddy.ai' }),
        /非 JSON|HTTP 500/
      )
    } finally {
      server.close()
    }
  })

  test('空清单视为失败，不让它静默清空模型列表', async () => {
    const { server, base } = await startUpstream(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { models: [] } }))
    })
    try {
      await assert.rejects(
        () => fetchWorkbuddyEnterpriseModels({ models_base: base, access_token: 'x' }),
        /空清单/
      )
    } finally {
      server.close()
    }
  })
})

describe('两个 realm 的合并', () => {
  const cn = { realm: 'cn', ids: ['glm-5.3', 'hy3'], rates: { 'glm-5.3': 'x0.79', hy3: 'x0.00' } }
  const intl = { realm: 'intl', ids: ['fast-model', 'primary-model'], rates: { 'fast-model': 'x0.34', 'primary-model': 'x3.31' } }

  test('模型名不重叠时直接并集，都不加后缀', () => {
    const { models, upstream, realmById } = mergeWorkbuddyCatalogs([cn, intl])
    const ids = models.map((m) => m.id)
    assert.deepEqual(ids.sort(), ['fast-model', 'glm-5.3', 'hy3', 'primary-model'])
    assert.deepEqual(upstream, {}, '没有冲突就不该有别名')
    assert.equal(realmById['fast-model'], 'intl')
    assert.equal(realmById['glm-5.3'], 'cn')
  })

  test('同一个 id 倍率不同时当成两个模型，非主 realm 加后缀', () => {
    // 国际版也有 glm-5.3，但倍率是 x3.31，扣费口径不同
    const intlSameId = { realm: 'intl', ids: ['glm-5.3', 'fast-model'], rates: { 'glm-5.3': 'x3.31', 'fast-model': 'x0.34' } }
    const { models, upstream } = mergeWorkbuddyCatalogs([cn, intlSameId])

    const plain = models.find((m) => m.id === 'glm-5.3')
    const aliased = models.find((m) => m.id === 'glm-5.3-intl')
    assert.ok(plain, '主 realm 保留原始 id')
    assert.ok(aliased, '另一个 realm 必须有独立的可点名条目')
    assert.equal(plain.rate, 'x0.79')
    assert.equal(aliased.rate, 'x3.31')
    assert.equal(aliased.upstream_id, 'glm-5.3', '别名转发时要能换回上游 id')
    assert.equal(upstream['glm-5.3-intl'], 'glm-5.3')
  })

  test('同一个 id 且倍率相同则并成一个模型，不制造重复', () => {
    const intlSame = { realm: 'intl', ids: ['glm-5.3'], rates: { 'glm-5.3': 'x0.79' } }
    const { models, upstream } = mergeWorkbuddyCatalogs([cn, intlSame])
    assert.equal(models.filter((m) => m.id.startsWith('glm-5.3')).length, 1)
    assert.deepEqual(upstream, {})
  })

  test('没有倍率的模型按「都缺失」比较，不因为一边是 null 一边是 undefined 就拆成两个', () => {
    const a = { realm: 'cn', ids: ['auto'], rates: {} }
    const b = { realm: 'intl', ids: ['auto'], rates: { auto: '' } }
    const { models } = mergeWorkbuddyCatalogs([a, b])
    assert.equal(models.length, 1)
  })

  test('主 realm 取模型多的那个，后缀落在少的那个上', () => {
    const { models } = mergeWorkbuddyCatalogs([cn, { realm: 'intl', ids: ['hy3'], rates: { hy3: 'x0.01' } }])
    // cn 的模型更多，hy3 归 cn；intl 的那个倍率不同，加后缀
    assert.ok(models.some((m) => m.id === 'hy3' && m.realm === 'cn'))
    assert.ok(models.some((m) => m.id === 'hy3-intl' && m.rate === 'x0.01'))
  })

  test('空目录不炸，也不产出条目', () => {
    const { models, rates } = mergeWorkbuddyCatalogs([{ realm: 'cn', ids: [], rates: {} }, null])
    assert.deepEqual(models, [])
    assert.deepEqual(rates, { cn: {} })
  })

  test('元数据随模型一起合并：清单与倍率来自同一次抓取', () => {
    // 真实场景：企业端点给全量清单（实测 32 条）但部分型号没有倍率，
    // v3/config 给倍率（22 条）。refreshWorkbuddyCatalog 会先把企业端点的
    // 倍率并进同一张表，所以这里模拟的是「同一 realm 的一份目录，
    // 清单更全、倍率由两个端点合力凑齐」。
    const ent = {
      realm: 'cn',
      ids: ['glm-5.3', 'hy3', 'legacy-model'],
      rates: { 'glm-5.3': 'x0.79', hy3: 'x0.00' },
      models: [
        { id: 'glm-5.3', rate: 'x0.79', name: 'GLM-5.3', vendor: 'zhipu', max_input: 1000000 },
        { id: 'hy3', rate: 'x0.00', name: 'Hy3' },
        { id: 'legacy-model', rate: null, name: 'Legacy', vendor: 'old' }
      ]
    }
    const { models, rates } = mergeWorkbuddyCatalogs([ent])
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))
    assert.equal(models.length, 3, '清单条数照上游给的来，不因倍率缺失而缩水')
    assert.equal(byId['glm-5.3'].rate, 'x0.79')
    assert.equal(byId['glm-5.3'].max_input, 1000000, '规格要带出来')
    assert.equal(byId['glm-5.3'].vendor, 'zhipu')
    assert.equal(byId.hy3.rate, 'x0.00')
    assert.equal(byId['legacy-model'].rate, null, '上游没给倍率就是没有，不填 0')
    assert.equal(rates.cn['glm-5.3'], 'x0.79')
  })

  test('主 realm 先到，后来者只补缺项，不覆盖已有值', () => {
    const a = { realm: 'cn', ids: ['glm-5.3'], rates: { 'glm-5.3': 'x0.79' }, models: [{ id: 'glm-5.3', rate: 'x0.79', name: 'GLM-5.3' }] }
    const b = { realm: 'intl', ids: ['glm-5.3'], rates: { 'glm-5.3': 'x0.79' }, models: [{ id: 'glm-5.3', rate: 'x0.79', vendor: 'zhipu', max_input: 1000000 }] }
    const { models } = mergeWorkbuddyCatalogs([a, b])
    assert.equal(models.length, 1, '倍率相同就并成一个模型')
    const m = models[0]
    assert.equal(m.name, 'GLM-5.3', '先到的名称保留')
    assert.equal(m.vendor, 'zhipu', '后到的缺项要补上')
    assert.equal(m.max_input, 1000000)
  })

  test('倍率为 0 是有效值，不能被当成缺失而覆盖', () => {
    const a = { realm: 'cn', ids: ['hy3'], rates: { hy3: 'x0.00' }, models: [{ id: 'hy3', rate: 'x0.00', name: 'Hy3' }] }
    const b = { realm: 'intl', ids: ['hy3'], rates: { hy3: 'x0.00' }, models: [{ id: 'hy3', rate: 'x0.00', vendor: 'tencent' }] }
    const { models } = mergeWorkbuddyCatalogs([a, b])
    assert.equal(models.length, 1)
    assert.equal(models[0].rate, 'x0.00', 'x0.00 是「免费」，不是「没给」')
  })
})
