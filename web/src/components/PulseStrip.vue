<template>
  <div class="pulse">
    <div class="pulse-track">
      <template v-if="bars.length">
        <span
          v-for="(b, i) in bars"
          :key="i"
          class="pulse-bar"
          :class="{ fail: b.fail, low: b.h < 20 }"
          :style="{ height: b.h + '%' }"
          :title="b.title"
        />
      </template>
      <template v-else>
        <span v-for="i in count" :key="'idle' + i" class="pulse-bar idle" />
      </template>
    </div>
    <div class="pulse-baseline"></div>
    <div class="pulse-axis">
      <span>更早</span>
      <span class="pulse-mid">{{ bars.length }} / {{ count }} 采样</span>
      <span>现在</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** /api/logs 返回值，最新在前 */
  logs: { type: Array, default: () => [] },
  count: { type: Number, default: 64 },
  /** 归一化用的耗时上限（毫秒） */
  ceiling: { type: Number, default: 30000 }
})

const MAX_SCALE = Math.log10(1 + 30000)

function normalize(ms) {
  if (ms == null || ms < 0) return 8
  const v = Math.log10(1 + ms) / MAX_SCALE
  return Math.round(Math.max(0.08, Math.min(1, v)) * 100)
}

function isFail(row) {
  if (row.error) return true
  if (row.ok === false) return true
  const s = Number(row.status)
  return s >= 400
}

function shortLabel(row) {
  if (row.type === 'api') return `${row.method || ''} ${row.path || ''}`.trim()
  if (row.type === 'system') return row.detail || '系统事件'
  return row.model || '—'
}

const bars = computed(() => {
  const list = props.logs.slice(0, props.count)
  // 反转为「早 → 晚」，让最新的一次落在最右端
  return list.slice().reverse().map((row) => {
    const fail = isFail(row)
    return {
      h: normalize(row.duration_ms),
      fail,
      title: `${row.time || ''} · ${shortLabel(row)} · ${row.duration_ms != null ? row.duration_ms + 'ms' : '—'} · ${row.status ?? '—'}${fail && row.error ? ' · ' + row.error : ''}`
    }
  })
})
</script>

<style scoped>
.pulse { width: 100%; }

.pulse-track {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 56px;
}

.pulse-bar {
  flex: 1 1 0;
  min-width: 2px;
  background: var(--ink-3);
  border-radius: 1px 1px 0 0;
  transition: height 0.28s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s;
}

/* 失败 = 朱砂，全高不打折，一眼可见 */
.pulse-bar.fail {
  background: var(--accent);
  min-height: 34%;
}

.pulse-bar.low { background: var(--ink-4); }

.pulse-bar.idle {
  height: 1px;
  background: var(--rule-strong);
  border-radius: 0;
}

.pulse-baseline {
  height: 1px;
  background: var(--rule);
  margin-top: 3px;
}

.pulse-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--ink-4);
}

.pulse-mid { color: var(--ink-3); }

@media (prefers-reduced-motion: reduce) {
  .pulse-bar { transition: none; }
}
</style>
