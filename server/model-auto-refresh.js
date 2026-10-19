// 凌晨自动刷新模型。
//
// 上游模型清单会变：新模型上线、旧模型下线、倍率调整。只在用户点
// 「刷新」时取一次，等于把某天的手动快照当常量——客户端拉到的清单
// 越来越旧。每天到点（默认凌晨 5 点，服务器本地时间，可用配置项
// auto_refresh_models_at 改）对所有启用平台刷一遍；WorkBuddy 平台
// 的模型与倍率是同一次目录抓取，顺带一起更新。
//
// 调度用「每分钟 tick + 按天标记」而不是 24 小时 setInterval：服务
// 重启、时钟漂移、进程休眠之后，到点补跑且当天不会重复。

import { state, persistImmediate } from './store.js'
import { refreshModels } from './proxy.js'
import { addLog } from './logger.js'

export const DEFAULT_AUTO_REFRESH_AT = '05:00'

/** 服务器本地时间的日期键：YYYY-MM-DD（toISOString 是 UTC，差 8 小时会串天） */
export function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 解析 "HH:MM"；非法值回落默认值，别让一个错配置把定时刷新整个关掉 */
export function parseHm(v, fallback = DEFAULT_AUTO_REFRESH_AT) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return parseHm(fallback, DEFAULT_AUTO_REFRESH_AT)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return parseHm(fallback, DEFAULT_AUTO_REFRESH_AT)
  return { h, m: min }
}

/**
 * 现在是否该跑自动刷新：已过到点时刻，且今天还没跑过。
 *
 * @param now 当前时间
 * @param cfg 配置项 auto_refresh_models_at（"HH:MM"）
 * @param lastDay state.model_refresh_last_day，上次成功触发那天的日期键
 */
export function autoRefreshDue(now = new Date(), cfg = state.auto_refresh_models_at, lastDay = state.model_refresh_last_day) {
  const { h, m } = parseHm(cfg)
  const after = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
  if (!after) return false
  return lastDay !== localDayKey(now)
}

/** 每分钟由 index.js 的定时器调用；幂等——同一天只会真正跑一次 */
export async function autoRefreshModelsTick(now = new Date()) {
  if (!autoRefreshDue(now)) return { ran: false }
  // 先落标记再开刷：这一轮刷得慢（平台多时几分钟），中途重启不会重跑
  state.model_refresh_last_day = localDayKey(now)
  state.model_refresh_last_at = Date.now()
  persistImmediate()

  let okCount = 0
  const failed = []
  for (const p of state.providers || []) {
    if (!p.enabled) continue
    try {
      const r = await refreshModels(p.id)
      if (r?.ok) okCount++
      else failed.push(`${p.name}：${r?.error || '未知错误'}`)
    } catch (err) {
      failed.push(`${p.name}：${err.message}`)
    }
  }
  const at = parseHm(state.auto_refresh_models_at)
  const hhmm = `${String(at.h).padStart(2, '0')}:${String(at.m).padStart(2, '0')}`
  addLog({
    type: 'system',
    detail: `${hhmm} 自动刷新模型：${okCount} 个平台成功` + (failed.length ? `，${failed.length} 个失败（${failed.join('；')}）` : '')
  })
  return { ran: true, okCount, failed }
}
