// WorkBuddy 纯逻辑层（core）的契约测试
//
// core 是常量 + 纯函数（无网络、无存储），所以这里全部是直接调用，
// 不需要起 HTTP 服务。钉的是上游形态里那些「看起来是细节、实际会出事」的点。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const {
  WORKBUDDY_REALMS,
  WORKBUDDY_PRODUCTS,
  workbuddyRealmFor,
  workbuddyProductFor,
  normalizeWorkbuddyDomain,
  workbuddyRateValue,
  normalizeRateText,
  formatCreditsRate,
  parsePromotions,
  parseModelsFromConfig,
  normalizeModel,
  isChatModel,
  isAutoSelectAlias,
  displayNameForModel,
  parseWorkbuddyAuthFile,
  applyWorkbuddyTokenData,
  jwtExpiresAtMs,
  jwtIssuedAtMs,
  jwtNickname,
  jwtSubject,
  expiryToMs,
  pickWorkbuddyNickname,
  STATE_REQUEST_TIMEOUT_MS,
  LOGIN_TIMEOUT_MS,
  CODE_TOKEN_NOT_READY,
  CODE_ACCOUNT_NOT_READY,
  ENTERPRISE_MODELS_PATH
} = await import('../workbuddy-core.js')

// 造一个真实形状的 JWT（只做 base64url，不验签——网关侧也只解码）
function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

describe('realm 与产品身份', () => {
  test('三个 realm 各走各的网关，Referer 不串台', () => {
    assert.equal(workbuddyRealmFor('www.codebuddy.cn'), 'cn')
    assert.equal(workbuddyRealmFor('workbuddy.ai'), 'global')
    assert.equal(workbuddyRealmFor('codebuddy.ai'), 'intl')
    assert.equal(workbuddyRealmFor('https://www.workbuddy.ai/x'), 'global')
    assert.equal(workbuddyRealmFor(''), 'cn', '留空落国内，不能落空')
    assert.equal(workbuddyRealmFor(null), 'cn')
  })

  test('CN 的对话域与计费域是两个站，其余 realm 同域', () => {
    assert.equal(WORKBUDDY_REALMS.cn.base, 'https://copilot.tencent.com')
    assert.equal(WORKBUDDY_REALMS.cn.billingBase, 'https://www.codebuddy.cn')
    assert.equal(WORKBUDDY_REALMS.global.base, WORKBUDDY_REALMS.global.billingBase)
    assert.equal(WORKBUDDY_REALMS.intl.base, WORKBUDDY_REALMS.intl.billingBase)
  })

  // codebuddy.ai 整体停服：apex 与 www 在四个公共 DNS 上一致返回 0.0.0.1
  // （黑洞），对话端点同样连不通。旧配置下国际版授权会卡满超时后报
  // 「This operation was aborted」。接入地址必须指向 workbuddy.ai。
  test('intl 的接入地址已迁离停服的 codebuddy.ai', () => {
    for (const realm of ['intl', 'global']) {
      const r = WORKBUDDY_REALMS[realm]
      assert.equal(r.base, 'https://www.workbuddy.ai', `${realm} 的接入地址应指向 workbuddy.ai`)
      assert.equal(r.billingBase, 'https://www.workbuddy.ai')
      assert.equal(r.referer, 'https://www.workbuddy.ai')
      assert.ok(!r.base.includes('codebuddy.ai'), `${realm} 不能再指向已停服的域名`)
    }
  })

  // realm 的**判据**仍是 X-Domain，不能跟着接入地址一起改：
  // 存量 intl 账号的 X-Domain 是 codebuddy.ai，把判据改成 workbuddy.ai 会让
  // 它们被误判成 global，从而改变对话路由与计费归属。
  test('realm 判据仍认 codebuddy.ai（存量账号的 X-Domain 没变）', () => {
    assert.equal(workbuddyRealmFor('codebuddy.ai'), 'intl')
    assert.equal(workbuddyRealmFor('www.codebuddy.ai'), 'intl')
    assert.equal(workbuddyRealmFor('workbuddy.ai'), 'global')
    assert.equal(workbuddyRealmFor('www.codebuddy.cn'), 'cn')
  })

  // 登录入口的分水岭：国际版只认 IDE 客户端。发错 platform 会拿不到 state。
  test('平台标识随 realm 变：国际版是 ide，国内是 CLI', () => {
    assert.equal(WORKBUDDY_REALMS.cn.platform, 'CLI')
    assert.equal(WORKBUDDY_REALMS.intl.platform, 'ide')
    assert.equal(WORKBUDDY_REALMS.global.platform, 'ide')
  })

  test('产品身份随 realm 定，不是全局常量', () => {
    assert.equal(workbuddyProductFor('www.codebuddy.cn').productCode, 'codebuddy')
    assert.equal(workbuddyProductFor('www.codebuddy.ai').productCode, 'workbuddy')
    assert.equal(workbuddyProductFor('workbuddy.ai').productCode, 'workbuddy')
    // 每个 realm 都指向一个真实存在的产品配置，不能是 undefined
    for (const realm of Object.values(WORKBUDDY_REALMS)) {
      assert.ok(WORKBUDDY_PRODUCTS[realm.product], `realm.product 指向不存在的产品：${realm.product}`)
    }
  })

  test('域名归一化允许用户直接粘 URL', () => {
    assert.equal(normalizeWorkbuddyDomain('https://CodeBuddy.ai/path'), 'codebuddy.ai')
    assert.equal(normalizeWorkbuddyDomain(''), 'www.codebuddy.cn')
  })
})

describe('倍率解析', () => {
  test('前缀、后缀、纯数字三种写法都能取到数值', () => {
    assert.equal(workbuddyRateValue('x0.79'), 0.79)
    assert.equal(workbuddyRateValue('X0.5'), 0.5)
    assert.equal(workbuddyRateValue('×0.29'), 0.29)
    assert.equal(workbuddyRateValue('0.50x'), 0.5, '促销值 x 在后，实测与模型倍率写法相反')
    assert.equal(workbuddyRateValue(0.25), 0.25)
  })

  test('带 credits 单位后缀也要能解析', () => {
    assert.equal(workbuddyRateValue('x2.20 credits'), 2.2)
    assert.equal(workbuddyRateValue('x0.71 credits'), 0.71)
    assert.equal(workbuddyRateValue('2.20 CREDITS'), 2.2)
  })

  test('零是有效值（免费），缺失与乱码返回 null', () => {
    assert.equal(workbuddyRateValue('x0.00'), 0)
    assert.equal(workbuddyRateValue('x0.00 credits'), 0)
    assert.equal(workbuddyRateValue(''), null)
    assert.equal(workbuddyRateValue('   '), null)
    assert.equal(workbuddyRateValue(null), null)
    assert.equal(workbuddyRateValue('n/a'), null)
  })

  // 原样保留上游写法：自行换算/改写只是多一层可能算错的地方，
  // 而前端已有展示层裁剪（rateLabel）。
  test('normalizeRateText 原样保留，只判断「能不能当倍率用」', () => {
    assert.equal(normalizeRateText('x0.79'), 'x0.79')
    assert.equal(normalizeRateText('x0.71 credits'), 'x0.71 credits')
    assert.equal(normalizeRateText('x0.00'), 'x0.00', '零倍率要收下')
    assert.equal(normalizeRateText(''), undefined)
    assert.equal(normalizeRateText('n/a'), undefined)
  })

  test('促销文案用箭头，缺原价时只显示促销价', () => {
    assert.equal(formatCreditsRate('x0.17', 'x0.50'), 'x0.17→x0.50')
    assert.equal(formatCreditsRate('x0.03', undefined), 'x0.03')
    assert.equal(formatCreditsRate(undefined, 'x0.50'), 'x0.50')
    assert.equal(formatCreditsRate(undefined, undefined), undefined)
  })
})

describe('促销活动时段推算', () => {
  // 实测 glm-5.2 有两条互补活动：夜间 0.50x、白天只带角标。
  // 不看时段就会全天显示夜间折扣价，用户按折扣价预期、实际被按原价计费。
  const promo = {
    kind: 'discount',
    enabled: true,
    priority: 100,
    discount: { discountedCredits: '0.50x', factor: 0.5 },
    schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' },
    modelIds: ['glm-5.2']
  }

  test('夜间生效、白天不生效（跨零点时段）', () => {
    // 北京 02:00 → 命中 23:00–7:50
    const night = parsePromotions({ modelPromotions: [promo] }, new Date('2026-10-14T18:00:00Z'))
    assert.equal(night.get('glm-5.2'), 'x0.50')
    // 北京 12:00 → 不在窗口内
    const day = parsePromotions({ modelPromotions: [promo] }, new Date('2026-10-14T04:00:00Z'))
    assert.equal(day.has('glm-5.2'), false)
  })

  test('时段边界：起点含、终点不含', () => {
    // 北京 23:00 整 → 含
    assert.equal(parsePromotions({ modelPromotions: [promo] }, new Date('2026-10-14T15:00:00Z')).get('glm-5.2'), 'x0.50')
    // 北京 07:50 整 → 不含
    assert.equal(parsePromotions({ modelPromotions: [promo] }, new Date('2026-10-13T23:50:00Z')).has('glm-5.2'), false)
  })

  test('enabled:false 的活动跳过', () => {
    const off = { ...promo, enabled: false }
    assert.equal(parsePromotions({ modelPromotions: [off] }, new Date('2026-10-14T18:00:00Z')).size, 0)
  })

  test('有效期已过的活动跳过', () => {
    const expired = { ...promo, schedule: { validUntil: '2026-10-01T00:00:00Z' } }
    assert.equal(parsePromotions({ modelPromotions: [expired] }, new Date('2026-10-14T18:00:00Z')).size, 0)
  })

  test('同一模型多条活动时取 priority 最高', () => {
    const low = { ...promo, priority: 1, discount: { discountedCredits: '0.10x', factor: 0.1 } }
    const high = { ...promo, priority: 200, discount: { discountedCredits: '0.90x', factor: 0.9 } }
    const m = parsePromotions({ modelPromotions: [high, low] }, new Date('2026-10-14T18:00:00Z'))
    assert.equal(m.get('glm-5.2'), 'x0.90')
  })

  // 实测 hy4-preview 的夜间活动就是 factor:0 + 限时窗口 —— 它真的免费。
  // 把 0x 当哨兵丢弃会让「夜间免费」永远不显示（用户报障过）。
  test('带时间窗口的 factor:0 是「免费」，不是「已结束」', () => {
    const free = { ...promo, discount: { discountedCredits: '0x', factor: 0, displayMode: 'replace' } }
    assert.equal(parsePromotions({ modelPromotions: [free] }, new Date('2026-10-14T18:00:00Z')).get('glm-5.2'), '免费')
  })

  // 防御：免费额度必然限时。没有窗口的 0x 更可能是遗留占位。
  test('没有时间窗口的 factor:0 视为已结束占位，跳过', () => {
    const orphan = { kind: 'discount', enabled: true, discount: { discountedCredits: '0x', factor: 0 }, modelIds: ['x'] }
    assert.equal(parsePromotions({ modelPromotions: [orphan] }, new Date()).size, 0)
  })

  test('没有促销表时不炸', () => {
    assert.equal(parsePromotions({}, new Date()).size, 0)
    assert.equal(parsePromotions({ modelPromotions: null }, new Date()).size, 0)
    assert.equal(parsePromotions(null, new Date()).size, 0)
  })
})

describe('模型解析', () => {
  const config = {
    data: {
      models: [
        { id: 'glm-5.3', credits: 'x0.79', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 131072, vendor: 'zhipu' },
        { id: 'auto', name: 'Auto' },
        { id: 'nes-completion', maxOutputTokens: 128 },
        { id: 'hunyuan-image-alpha', tags: ['text-to-image'] },
        { id: 'codewise-jump', supportsExtra: true }
      ],
      agents: [{ name: 'craft', models: ['glm-5.3', 'auto'] }],
      productFeaturesConfig: { ModelTrialBanner: { banners: [{ targetModelId: 'hy4-preview' }] } }
    }
  }

  test('agent 引用的模型排在最前', () => {
    const list = parseModelsFromConfig(config, 'WB')
    assert.equal(list[0].id, 'glm-5.3')
  })

  test('规格与倍率一并带出，不只取 id', () => {
    const m = parseModelsFromConfig(config, 'WB').find((x) => x.id === 'glm-5.3')
    assert.equal(m.rate, 'x0.79')
    assert.equal(m.max_input, 1000000)
    assert.equal(m.max_output, 131072)
    assert.equal(m.vendor, 'zhipu')
    assert.equal(m.name, 'GLM-5.3')
  })

  // 关键差异：provider.models 是**路由表**，删条目等于让上游真实存在的能力
  // 变得不可路由（点名即 404）。故标注而非过滤。
  test('非对话模型保留并标 chat:false，不从路由表里删掉', () => {
    const list = parseModelsFromConfig(config, 'WB')
    const ids = list.map((m) => m.id)
    for (const id of ['nes-completion', 'hunyuan-image-alpha', 'codewise-jump']) {
      assert.ok(ids.includes(id), `${id} 被误删，会变成不可路由`)
      assert.equal(list.find((m) => m.id === id).chat, false, `${id} 应标 chat:false`)
    }
  })

  test('自动选择别名保留并标 auto_select，不删', () => {
    const list = parseModelsFromConfig(config, 'WB')
    const auto = list.find((m) => m.id === 'auto')
    assert.ok(auto, 'auto 是上游真实接受的入口，不能删')
    assert.equal(auto.auto_select, true)
  })

  test('试用横幅下发的模型也收进来并标 agent_referenced', () => {
    const m = parseModelsFromConfig(config, 'WB').find((x) => x.id === 'hy4-preview')
    assert.ok(m, '试用模型实测可调用，漏掉用户就选不到')
    assert.equal(m.agent_referenced, true)
  })

  test('agent 名兼容 cli（企业端点）与 craft（v3/config）', () => {
    const withCli = { data: { models: [{ id: 'a' }, { id: 'b' }], agents: [{ name: 'cli', models: ['b'] }] } }
    assert.equal(parseModelsFromConfig(withCli, 'WB')[0].id, 'b')
  })

  test('促销价并入模型', () => {
    const withPromo = {
      data: {
        models: [{ id: 'glm-5.2', credits: 'x0.17' }],
        modelPromotions: [{
          enabled: true,
          discount: { discountedCredits: '0.50x', factor: 0.5 },
          modelIds: ['glm-5.2']
        }]
      }
    }
    const m = parseModelsFromConfig(withPromo, 'WB')[0]
    assert.equal(m.rate, 'x0.17')
    assert.equal(m.rate_discounted, 'x0.50')
  })

  test('结构不对时返回空数组，不炸', () => {
    assert.deepEqual(parseModelsFromConfig(null, 'WB'), [])
    assert.deepEqual(parseModelsFromConfig({}, 'WB'), [])
    assert.deepEqual(parseModelsFromConfig({ data: {} }, 'WB'), [])
  })

  test('上游没给的字段就不写，不拿默认值假装上游说过', () => {
    const bare = normalizeModel({ id: 'codewise-jump', credits: '' }, 'WB')
    assert.equal('rate' in bare, false, '缺失倍率不能变成 0 或空串')
    assert.equal('max_input' in bare, false)
    assert.equal('images' in bare, false)
  })

  test('展示名兜底表只在上游未给 name 时生效', () => {
    assert.equal(displayNameForModel('glm-5.3'), 'GLM-5.3')
    assert.equal(displayNameForModel('unknown-model'), 'unknown-model')
    assert.equal(normalizeModel({ id: 'glm-5.3' }, 'WB').name, 'GLM-5.3')
    assert.equal(normalizeModel({ id: 'glm-5.3', name: '上游给的名字' }, 'WB').name, '上游给的名字')
  })
})

describe('凭据解析与 JWT 兜底', () => {
  test('嵌套（CLI 实际写盘）与扁平两种形状都认', () => {
    const nested = parseWorkbuddyAuthFile(JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', domain: 'workbuddy.ai' },
      account: { uid: 'u-1' }
    }))
    assert.equal(nested.access_token, 'at')
    assert.equal(nested.uid, 'u-1')
    assert.equal(nested.domain, 'workbuddy.ai')

    const flat = parseWorkbuddyAuthFile(JSON.stringify({ access_token: 'at2', uid: 'u-2' }))
    assert.equal(flat.access_token, 'at2')
    assert.equal(flat.uid, 'u-2')
  })

  test('缺 uid 或 token 返回 null —— 半残凭据不许入库', () => {
    assert.equal(parseWorkbuddyAuthFile(JSON.stringify({ auth: { accessToken: 'at' } })), null)
    assert.equal(parseWorkbuddyAuthFile(JSON.stringify({ account: { uid: 'u' } })), null)
    assert.equal(parseWorkbuddyAuthFile('not json'), null)
    assert.equal(parseWorkbuddyAuthFile(''), null)
  })

  // 网关自己的批量导出产物长这样：
  //   { format:'workbuddy-accounts', version:1, accounts:[ { uid, accessToken, ... } ] }
  // 直接喂给单条解析会读不到字段（obj 是外层对象，没有 accessToken），
  // 所以这里要能揭开 accounts 再看一层。多账号的批量场景走导入接口，
  // 单条解析只在恰好一个账号时替它摊平。
  test('批量导出文件（accounts 包裹）单条也能解析', () => {
    const out = parseWorkbuddyAuthFile(JSON.stringify({
      format: 'workbuddy-accounts',
      version: 1,
      count: 1,
      accounts: [{
        uid: 'u-49f65fb8',
        accessToken: 'at-batch',
        refreshToken: 'rt-batch',
        domain: 'www.codebuddy.cn',
        expiresAt: 1795218069000
      }]
    }))
    assert.ok(out, '不能返回 null')
    assert.equal(out.uid, 'u-49f65fb8')
    assert.equal(out.access_token, 'at-batch')
    assert.equal(out.refresh_token, 'rt-batch')
    assert.equal(out.domain, 'www.codebuddy.cn')
  })

  test('accounts 里有多条时单条解析返回 null（该走批量导入接口）', () => {
    const out = parseWorkbuddyAuthFile(JSON.stringify({
      format: 'workbuddy-accounts',
      accounts: [
        { uid: 'u-1', accessToken: 'at-1' },
        { uid: 'u-2', accessToken: 'at-2' }
      ]
    }))
    assert.equal(out, null)
  })

  // 导出文件里的 expiresAt 是**秒**（1795260343），网关内部 expires_at 一律毫秒。
  // 直接原样取走会让下游减 Date.now() 得负数 → 0 → workbuddyTokenNeedsRefresh 判
  // false → 账号永不主动续期。这条就是那个事故的钉子。
  test('导出文件的 expiresAt 是秒时，解析结果必须是毫秒', () => {
    const sec = 1795260343
    const out = parseWorkbuddyAuthFile(JSON.stringify({
      uid: 'u-sec', accessToken: 'at-sec', expiresAt: sec
    }))
    assert.equal(out.expires_at, sec * 1000)
    assert.ok(out.expires_at > 1e12, '必须是毫秒量级')
    assert.ok(out.expires_at > Date.now(), '换算后必须在未来')
  })

  test('expiresAt 已经是毫秒时不被二次放大', () => {
    const ms = 1795260343000
    const out = parseWorkbuddyAuthFile(JSON.stringify({ uid: 'u-ms', accessToken: 'at-ms', expiresAt: ms }))
    assert.equal(out.expires_at, ms)
  })

  // 导出文件的 nickname 常是打码串（"188****1530"），JWT 的 preferred_username
  // 才是完整值。直接取打码串会让账号列表显示成一串星号。
  test('打码昵称让位给 JWT 里的完整用户名', () => {
    const token = jwt({ preferred_username: '18859341530' })
    const out = parseWorkbuddyAuthFile(JSON.stringify({
      uid: 'u-mask', accessToken: token, nickname: '188****1530'
    }))
    assert.equal(out.nickname, '18859341530')
  })

  test('文件里的昵称不含星号时优先用它（用户可能改过名）', () => {
    const token = jwt({ preferred_username: '18859341530' })
    const out = parseWorkbuddyAuthFile(JSON.stringify({
      uid: 'u-named', accessToken: token, nickname: '我的小号'
    }))
    assert.equal(out.nickname, '我的小号')
  })

  test('空对象 / 数组直接喂进来返回 null，不再静默读出空凭据', () => {
    assert.equal(parseWorkbuddyAuthFile('{}'), null)
    assert.equal(parseWorkbuddyAuthFile('[]'), null)
    assert.equal(parseWorkbuddyAuthFile('null'), null)
  })

  // 实测 /v2/plugin/auth/token 不返回绝对 expiresAt，只给 expiresIn。
  // 缺绝对字段时 JWT 的 exp 是权威兜底，否则 UI 永远显示「有效期未知」。
  test('缺 uid 时回落到 JWT 的 sub', () => {
    const token = jwt({ sub: 'u-from-jwt' })
    const out = parseWorkbuddyAuthFile(JSON.stringify({ auth: { accessToken: token } }))
    assert.equal(out.uid, 'u-from-jwt')
  })

  test('缺过期时间时回落到 JWT 的 exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = jwt({ exp })
    const out = parseWorkbuddyAuthFile(JSON.stringify({ auth: { accessToken: token }, account: { uid: 'u' } }))
    assert.equal(out.expires_at, exp * 1000)
  })

  test('昵称优先取账号字段，缺失时回落到 JWT 声明', () => {
    const token = jwt({ nickname: '来自JWT' })
    assert.equal(jwtNickname(token), '来自JWT')
    assert.equal(jwtNickname('not-a-jwt'), '')
    const withAcct = parseWorkbuddyAuthFile(JSON.stringify({
      auth: { accessToken: token }, account: { uid: 'u', nickname: '账号里的' }
    }))
    assert.equal(withAcct.nickname, '账号里的')
  })

  test('JWT 解析失败一律安全返回，不抛', () => {
    assert.equal(jwtExpiresAtMs('garbage'), undefined)
    assert.equal(jwtIssuedAtMs(''), undefined)
    assert.equal(jwtNickname(null), '')
    assert.equal(jwtSubject('a.b'), '')
    assert.equal(jwtExpiresAtMs(jwt({ exp: 'not-a-number' })), undefined)
  })
})

describe('续期数据合并', () => {
  test('refreshToken 轮换后必须写回，否则下次续期拿废 token 去刷', () => {
    const key = { access_token: 'old', refresh_token: 'old-rt' }
    const out = applyWorkbuddyTokenData(key, { accessToken: 'new', refreshToken: 'new-rt' })
    assert.equal(out.access_token, 'new')
    assert.equal(out.refresh_token, 'new-rt')
    assert.equal(key.access_token, 'old', '不就地改原对象')
  })

  // 相对秒数（expiresIn）是相对**签发时刻**的，拿接收时刻当基准会随网络延迟偏移。
  test('expiresIn 以 JWT iat 为基准换算，而不是当前时刻', () => {
    const iat = Math.floor(Date.now() / 1000) - 100
    const token = jwt({ iat })
    const out = applyWorkbuddyTokenData({}, { accessToken: token, expiresIn: 3600 })
    assert.equal(out.expires_at, iat * 1000 + 3600 * 1000)
  })

  test('没有 iat 时才用当前时刻兜底', () => {
    const before = Date.now()
    const out = applyWorkbuddyTokenData({}, { accessToken: jwt({}), expiresIn: 3600 })
    assert.ok(out.expires_at >= before + 3600 * 1000 - 1000)
  })

  test('绝对 expiresAt 优先，兼容毫秒与秒级时间戳', () => {
    const ms = Date.now() + 100000
    assert.equal(applyWorkbuddyTokenData({}, { expiresAt: ms }).expires_at, ms)
    assert.equal(applyWorkbuddyTokenData({}, { expiresAt: Math.floor(ms / 1000) }).expires_at, Math.floor(ms / 1000) * 1000)
  })

  test('续期响应缺昵称时不覆盖已有值', () => {
    const out = applyWorkbuddyTokenData({ nickname: '原有昵称' }, { accessToken: jwt({}) })
    assert.equal(out.nickname, '原有昵称')
  })
})

describe('过期时刻单位归一（expiryToMs）', () => {
  // 导出文件的 expiresAt 是秒，网关内部一律毫秒。这一对是整套单位问题的地基。
  test('秒值放大成毫秒', () => {
    assert.equal(expiryToMs(1795260343), 1795260343000)
    assert.equal(expiryToMs('1795260343'), 1795260343000)
  })

  test('毫秒值原样返回', () => {
    assert.equal(expiryToMs(1795260343000), 1795260343000)
    assert.equal(expiryToMs('1795260343000'), 1795260343000)
  })

  test('ISO 时间字符串也能解', () => {
    assert.equal(expiryToMs('2026-11-21T11:25:43.000Z'), Date.parse('2026-11-21T11:25:43.000Z'))
  })

  test('空值 / 非法 / 非正数一律 0（调用方据此判「没有过期时刻」）', () => {
    for (const v of [undefined, null, '', '   ', 'abc', 0, -1, NaN]) {
      assert.equal(expiryToMs(v), 0, `输入 ${String(v)} 应得 0`)
    }
  })
})

describe('昵称选择（pickWorkbuddyNickname）', () => {
  test('文件昵称是打码串时用 JWT 完整值', () => {
    const token = jwt({ preferred_username: '18859341530' })
    assert.equal(pickWorkbuddyNickname('188****1530', token), '18859341530')
  })

  test('文件昵称正常时优先用它', () => {
    const token = jwt({ preferred_username: '18859341530' })
    assert.equal(pickWorkbuddyNickname('我的小号', token), '我的小号')
  })

  test('JWT 也没有时退回打码串，最后才是空串', () => {
    assert.equal(pickWorkbuddyNickname('188****1530', jwt({})), '188****1530')
    assert.equal(pickWorkbuddyNickname('', jwt({})), '')
    assert.equal(pickWorkbuddyNickname(undefined, ''), '')
  })
})

describe('常量', () => {
  // 实测 WorkBuddy 国际版 auth/state 耗时 5860–7525 ms：5 秒超时每次都会撞上，
  // 用户侧表现为「无法获取登录地址」。
  test('auth/state 超时必须够宽（实测最慢 7.5 秒）', () => {
    assert.ok(STATE_REQUEST_TIMEOUT_MS >= 8000, '5 秒不够，实测会稳定超时')
  })

  test('登录总超时 5 分钟，与 IDE 一致', () => {
    assert.equal(LOGIN_TIMEOUT_MS, 5 * 60 * 1000)
  })

  test('轮询未就绪的错误码与参考实现一致', () => {
    assert.equal(CODE_TOKEN_NOT_READY, 11217)
    assert.equal(CODE_ACCOUNT_NOT_READY, 12151)
  })

  test('企业端点路径含 personal scope', () => {
    assert.equal(ENTERPRISE_MODELS_PATH, '/console/enterprises/personal/models')
  })
})
