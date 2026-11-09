// 四档统一定价的计价断言。
//
// 定价（1 元 = 1,000,000 微元）：
//   输入·缓存命中    0.01 元 / 百万 tokens =     10,000 微元
//   输入·缓存未命中   0.1 元 / 百万 tokens =    100,000 微元
//   输出             0.5 元 / 百万 tokens =    500,000 微元
//   生图             0.06 元 / 张        =     60,000 微元
//
// 只测纯函数 computeUsageCostMicro 与 normalizeBilling 的迁移，
// 不碰 store.state，因此不需要起服务。
import test from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_BILLING, normalizeBilling } = await import('../billing.js')

// computeUsageCostMicro 读的是 store.state.billing，测试里直接替换成默认配置后调用。
// 用动态 import 拿到 store 的引用做注入，避免为了跑测试去动真实配置文件。
const store = await import('../store.js')
function withPricing(fn) {
  const prev = store.state.billing
  store.state.billing = DEFAULT_BILLING()
  try {
    return fn()
  } finally {
    store.state.billing = prev
  }
}
const { computeUsageCostMicro } = await import('../billing.js')

test('默认定价就是约定的四档人民币单价', () => {
  const b = DEFAULT_BILLING()
  assert.equal(b.unit, '元')
  assert.equal(b.currency, 'CNY')
  assert.equal(b.micros_per_unit, 1_000_000)
  assert.equal(b.price_input_cached_micro_per_mtok, 10_000)     // 0.01 元
  assert.equal(b.price_input_uncached_micro_per_mtok, 100_000)  // 0.1 元
  assert.equal(b.price_output_micro_per_mtok, 500_000)          // 0.5 元
  assert.equal(b.price_per_image_micro, 60_000)                 // 0.06 元
})

test('缓存命中 100 万输入 tokens 收 0.01 元', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ input_cached: 1_000_000, input_uncached: 0, output: 0 }), 10_000)
  })
})

test('缓存未命中 100 万输入 tokens 收 0.1 元', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ input_cached: 0, input_uncached: 1_000_000, output: 0 }), 100_000)
  })
})

test('输出 100 万 tokens 收 0.5 元', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ input_cached: 0, input_uncached: 0, output: 1_000_000 }), 500_000)
  })
})

test('生图按张数累乘：3 张收 0.18 元', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ images: 3 }), 180_000)
    assert.equal(computeUsageCostMicro({ images: 1 }), 60_000)
  })
})

test('混合用量：命中 + 未命中 + 输出 一起算', () => {
  withPricing(() => {
    // 500k 命中 = 5,000；500k 未命中 = 50,000；200k 输出 = 100,000
    const usage = { input_cached: 500_000, input_uncached: 500_000, output: 200_000 }
    assert.equal(computeUsageCostMicro(usage), 5_000 + 50_000 + 100_000)
  })
})

test('典型一次对话：命中 8k + 未命中 2k + 输出 1k', () => {
  withPricing(() => {
    //   8000 × 10000 / 1e6 =    80
    //   2000 × 100000 / 1e6 =  200
    //   1000 × 500000 / 1e6 =  500
    const cost = computeUsageCostMicro({ input_cached: 8_000, input_uncached: 2_000, output: 1_000 })
    assert.equal(cost, 780)
    // 780 微元 = 0.00078 元，约 7.8 厘
  })
})

test('只有 total 时按未命中输入价兜底，不当成 0', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ total: 1_000_000 }), 100_000)
  })
})

test('极小调用至少扣 1 微元，避免流水里看不到这次调用', () => {
  withPricing(() => {
    // 1 个 token 命中缓存 = 0.01 微元，四舍五入到 0，但必须记 1
    assert.equal(computeUsageCostMicro({ input_cached: 1 }), 1)
  })
})

test('全 0 用量不扣费', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({}), 0)
    assert.equal(computeUsageCostMicro({ input_cached: 0, input_uncached: 0, output: 0, images: 0 }), 0)
  })
})

test('负数与非法值被当成 0，不会反过来给用户加钱', () => {
  withPricing(() => {
    assert.equal(computeUsageCostMicro({ input_cached: -100, input_uncached: -5, output: -1 }), 0)
    assert.equal(computeUsageCostMicro({ images: -3 }), 0)
    assert.equal(computeUsageCostMicro({ input_cached: 'abc', output: null }), 0)
  })
})

test('老默认值迁移不会被放大：1 点/千 token 落到新默认价而不是 1000 元', () => {
  const old = {
    unit: '点',
    currency: 'POINT',
    micros_per_unit: 1_000_000,
    price_per_1k_tokens_micro: 1_000_000, // 老默认：每 1000 tokens 1 点
    enabled: true
  }
  normalizeBilling(old)
  // 折算成 1e9 微元/百万 = 1000 元/百万，远超上限，必须回落到 0.1 元
  assert.equal(old.price_input_uncached_micro_per_mtok, 100_000)
  assert.equal(old.price_per_1k_tokens_micro, undefined, '老字段必须被删除，避免两套口径并存')
})

test('老配置里的自定义低价仍然照实迁移', () => {
  const old = { micros_per_unit: 1_000_000, price_per_1k_tokens_micro: 50, enabled: true }
  normalizeBilling(old)
  // 50 微元/千 = 50,000 微元/百万，低于上限，照实保留
  assert.equal(old.price_input_uncached_micro_per_mtok, 50_000)
})

test('已有新字段时不再用老字段覆盖', () => {
  const cfg = { price_input_uncached_micro_per_mtok: 100_000, price_per_1k_tokens_micro: 999, enabled: true }
  normalizeBilling(cfg)
  assert.equal(cfg.price_input_uncached_micro_per_mtok, 100_000, '新字段优先')
})

test('normalizeBilling 会补上新字段并把单位改成元', () => {
  const bare = { enabled: true }
  normalizeBilling(bare)
  assert.equal(bare.unit, '元')
  assert.equal(bare.currency, 'CNY')
  assert.equal(bare.price_input_cached_micro_per_mtok, 10_000)
  assert.equal(bare.price_input_uncached_micro_per_mtok, 100_000)
  assert.equal(bare.price_output_micro_per_mtok, 500_000)
  assert.equal(bare.price_per_image_micro, 60_000)
})

test('调高输出单价只影响输出部分', () => {
  withPricing(() => {
    const prevOut = store.state.billing.price_output_micro_per_mtok
    store.state.billing.price_output_micro_per_mtok = 1_000_000 // 1 元/百万
    const cost = computeUsageCostMicro({ input_cached: 0, input_uncached: 1_000_000, output: 1_000_000 })
    store.state.billing.price_output_micro_per_mtok = prevOut
    assert.equal(cost, 100_000 + 1_000_000)
  })
})
