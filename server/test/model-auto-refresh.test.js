// 凌晨自动刷新模型的调度测试。
//
// 钉住四条契约：
// 1) 到点时刻的判断（默认 05:00，前一分钟不跑，整点跑）
// 2) 同一天不重复（按服务器本地日期记，不是 UTC——差 8 小时会串天）
// 3) 昨天跑过、今天到点补跑
// 4) tick 真正执行：落 last_day/last_at、逐平台刷新、写系统日志；
//    平台失败不影响其他平台，全部记进日志

import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gw-auto-refresh-'))

let state = null
let mod = null
let getLogs = null

before(async () => {
  ;({ state } = await import('../store.js'))
  mod = await import('../model-auto-refresh.js')
  ;({ getLogs } = await import('../logger.js'))
})

beforeEach(() => {
  state.providers = []
  state.model_refresh_last_day = undefined
  state.model_refresh_last_at = undefined
  state.auto_refresh_models_at = undefined
})

const at = (h, m) => new Date(2026, 9, 15, h, m, 0)

describe('autoRefreshDue：到点判断', () => {
  test('默认 05:00：04:59 不跑，05:00 跑', () => {
    assert.equal(mod.autoRefreshDue(at(4, 59), undefined, '2026-10-14'), false)
    assert.equal(mod.autoRefreshDue(at(5, 0), undefined, '2026-10-14'), true)
    assert.equal(mod.autoRefreshDue(at(23, 30), undefined, '2026-10-14'), true)
  })

  test('同一天不重复：今天已跑过就不跑', () => {
    assert.equal(mod.autoRefreshDue(at(5, 1), undefined, '2026-10-15'), false)
    assert.equal(mod.autoRefreshDue(at(23, 59), undefined, '2026-10-15'), false)
  })

  test('昨天跑过、今天到点补跑', () => {
    assert.equal(mod.autoRefreshDue(at(5, 0), undefined, '2026-10-14'), true)
  })

  test('自定义时刻：02:30', () => {
    assert.equal(mod.autoRefreshDue(at(2, 29), '02:30', '2026-10-14'), false)
    assert.equal(mod.autoRefreshDue(at(2, 30), '02:30', '2026-10-14'), true)
  })

  test('非法配置回落默认 05:00，不把定时刷新关掉', () => {
    assert.equal(mod.autoRefreshDue(at(4, 59), 'abc', '2026-10-14'), false)
    assert.equal(mod.autoRefreshDue(at(5, 0), 'abc', '2026-10-14'), true)
    assert.equal(mod.autoRefreshDue(at(4, 59), '25:99', '2026-10-14'), false)
    assert.equal(mod.autoRefreshDue(at(5, 0), '25:99', '2026-10-14'), true)
  })
})

describe('localDayKey：服务器本地日期', () => {
  test('用本地时间而非 UTC（UTC 会把凌晨算成前一天）', () => {
    // 2026-10-15 00:30 本地时间；UTC 是 10-14，用 toISOString 会串天
    assert.equal(mod.localDayKey(at(0, 30)), '2026-10-15')
    assert.equal(mod.localDayKey(at(23, 59)), '2026-10-15')
  })
})

describe('autoRefreshModelsTick：真正执行', () => {
  test('到点：落标记、逐平台刷新、写系统日志', async () => {
    state.providers = [
      { id: 'p-ok', name: '平台A', enabled: true, models: [], keys: [] },
      { id: 'p-fail', name: '平台B', enabled: true, models: [], keys: [] },
      { id: 'p-off', name: '平台C', enabled: false, models: [], keys: [] }
    ]
    // refreshModels 走 store/proxy，这里用能真实返回的手段造两种结果：
    // p-ok 无 Key → 返回 { ok:false, error:'该平台尚未配置可用的 Key' }
    // 所以这个用例只验证：跑过、标记落盘、日志写出、停用平台不碰
    const r = await mod.autoRefreshModelsTick(at(5, 0))
    assert.equal(r.ran, true)
    assert.equal(state.model_refresh_last_day, '2026-10-15')
    assert.ok(state.model_refresh_last_at > 0)

    const sys = getLogs({ limit: 50 }).filter((l) => l.type === 'system' && String(l.detail).includes('自动刷新模型'))
    assert.ok(sys.length > 0, '必须写系统日志')
    assert.ok(String(sys[sys.length - 1].detail).includes('05:00'), '日志带出到点时刻')
    assert.ok(String(sys[sys.length - 1].detail).includes('平台B'), '失败平台也要点名')
    assert.ok(!String(sys[sys.length - 1].detail).includes('平台C'), '停用平台不刷新')
  })

  test('未到点：什么都不做', async () => {
    state.providers = [{ id: 'p-1', name: '平台A', enabled: true, models: [], keys: [] }]
    const r = await mod.autoRefreshModelsTick(at(4, 59))
    assert.equal(r.ran, false)
    assert.equal(state.model_refresh_last_day, undefined)
  })

  test('同一天第二次调用：不重跑', async () => {
    state.providers = [{ id: 'p-1', name: '平台A', enabled: true, models: [], keys: [] }]
    assert.equal((await mod.autoRefreshModelsTick(at(5, 0))).ran, true)
    const r2 = await mod.autoRefreshModelsTick(at(5, 1))
    assert.equal(r2.ran, false)
  })
})
