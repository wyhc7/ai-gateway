<template>
  <div class="pager">
    <span class="pager-info">
      共 <b class="num">{{ total }}</b> 条 · 第 <b class="num">{{ page }}</b>/<b class="num">{{ pages }}</b> 页
    </span>
    <div v-if="pages > 1" class="pager-ctrl">
      <button class="pg" :disabled="page <= 1" title="首页" @click="go(1)">&laquo;</button>
      <button class="pg" :disabled="page <= 1" title="上一页" @click="go(page - 1)">&lsaquo;</button>
      <template v-for="p in visible" :key="p">
        <span v-if="p === '…'" class="pg gap">…</span>
        <button v-else class="pg num" :class="{ on: p === page }" @click="go(p)">{{ p }}</button>
      </template>
      <button class="pg" :disabled="page >= pages" title="下一页" @click="go(page + 1)">&rsaquo;</button>
      <button class="pg" :disabled="page >= pages" title="末页" @click="go(pages)">&raquo;</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 }
})

const emit = defineEmits(['update:page'])

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))

const visible = computed(() => {
  const n = pages.value
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1)
  const cur = props.page
  const out = [1]
  let from = Math.max(2, cur - 1)
  let to = Math.min(n - 1, cur + 1)
  if (cur <= 3) { from = 2; to = 4 }
  if (cur >= n - 2) { from = n - 3; to = n - 1 }
  if (from > 2) out.push('…')
  for (let i = from; i <= to; i++) out.push(i)
  if (to < n - 1) out.push('…')
  out.push(n)
  return out
})

function go(p) {
  const target = Math.min(pages.value, Math.max(1, p))
  if (target !== props.page) emit('update:page', target)
}
</script>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px 2px;
}

.pager-info {
  font-size: 12px;
  color: var(--ink-3);
}
.pager-info b { color: var(--ink); font-weight: 600; }

.pager-ctrl { display: flex; gap: 4px; flex-wrap: wrap; }

.pg {
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.14s, background-color 0.14s, color 0.14s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pg:hover:not(:disabled):not(.on) {
  border-color: var(--rule-strong);
  background: var(--surface-2);
  color: var(--ink);
}

.pg:disabled { opacity: 0.4; cursor: not-allowed; }

.pg.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.pg.gap { border: none; background: transparent; color: var(--ink-4); cursor: default; }
</style>
