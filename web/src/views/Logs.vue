<template>
  <div>
    <!-- 工具栏 -->
    <div class="card">
      <div class="toolbar">
        <el-select v-model="filters.type" placeholder="类型" class="toolbar-item" style="flex: 0 0 116px" @change="loadLogs">
          <el-option label="全部类型" value="all" />
          <el-option label="对话" value="chat" />
          <el-option label="API" value="api" />
          <el-option label="系统" value="system" />
        </el-select>
        <el-select v-model="filters.status" placeholder="状态码" clearable class="toolbar-item" style="flex: 0 0 150px" @change="loadLogs">
          <el-option label="成功 (2xx)" value="2xx" />
          <el-option label="客户端错误 (4xx)" value="4xx" />
          <el-option label="服务端错误 (5xx)" value="5xx" />
          <el-option label="系统 (0)" value="0" />
        </el-select>
        <el-input
          v-model="filters.q"
          placeholder="搜索模型 / 平台 / Key / 错误信息"
          clearable
          class="toolbar-item"
          style="flex: 1 1 220px; min-width: 160px"
          @keyup.enter="loadLogs"
          @clear="loadLogs"
        >
          <template #suffix><span class="search-hint">Enter</span></template>
        </el-input>
        <el-select v-model="limit" style="flex: 0 0 104px" @change="loadLogs">
          <el-option :value="50" label="50 条" />
          <el-option :value="100" label="100 条" />
          <el-option :value="200" label="200 条" />
          <el-option :value="500" label="500 条" />
        </el-select>
        <div class="auto-refresh">
          <span class="muted">自动刷新</span>
          <SwitchRail v-model="autoRefresh" small @change="onAutoRefreshChange" />
        </div>
        <el-button type="primary" :loading="loading" @click="loadLogs">
          <svg style="margin-right: 5px" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          刷新
        </el-button>
      </div>

      <div class="toolbar-stats">
        <span class="stat-chip">
          <span class="label-micro">命中</span>
          <b class="num">{{ logs.length }}</b>
        </span>
        <span class="stat-chip">
          <span class="label-micro">失败</span>
          <b class="num" :class="{ alarm: failCount > 0 }">{{ failCount }}</b>
        </span>
        <span class="stat-chip">
          <span class="label-micro">失败率</span>
          <b class="num" :class="{ alarm: failRate > 20 }">{{ logs.length ? failRate + '%' : '—' }}</b>
        </span>
        <span v-if="autoRefresh" class="live-tag">
          <i class="dot"></i>每 10 秒自动刷新
        </span>
      </div>
    </div>

    <!-- 日志表 -->
    <div style="margin-top: 16px">
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 152px">时间</th>
              <th style="width: 72px">类型</th>
              <th style="width: 84px">状态</th>
              <th style="min-width: 210px">模型 / 路径</th>
              <th style="min-width: 104px">平台</th>
              <th style="min-width: 90px">Key</th>
              <th class="right" style="width: 84px">耗时</th>
              <th style="min-width: 240px">详情 / 错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in pagedLogs" :key="row.id || i">
              <td class="mono time-cell">{{ row.time }}</td>
              <td><span :class="['badge', typeBadge(row.type)]">{{ typeLabel(row.type) }}</span></td>
              <td><span :class="['badge', statusBadge(row.status)]">{{ statusText(row) }}</span></td>
              <td>
                <template v-if="row.type === 'chat'">
                  <div class="mono ellipsis" :title="row.model">{{ row.model || '—' }}</div>
                  <div v-if="row.stream" class="sub-line">流式</div>
                </template>
                <template v-else-if="row.type === 'api'">
                  <div class="mono ellipsis" :title="`${row.method} ${row.path}`">{{ row.method }} {{ row.path }}</div>
                </template>
                <template v-else>
                  <div class="mono ellipsis">系统事件</div>
                </template>
              </td>
              <td><span class="ellipsis" :title="row.provider_name">{{ row.provider_name || '—' }}</span></td>
              <td><span class="mono muted-cell ellipsis" :title="row.key">{{ row.key || '—' }}</span></td>
              <td class="right"><span :class="durationClass(row.duration_ms)">{{ fmtDuration(row.duration_ms) }}</span></td>
              <td>
                <div v-if="row.error" class="err-text ellipsis" :title="row.error">{{ row.error }}</div>
                <div v-else-if="row.detail" class="muted-cell ellipsis" :title="row.detail">{{ row.detail }}</div>
                <div v-else-if="row.ok === false" class="err-text ellipsis">请求失败</div>
                <span v-else class="muted-cell">—</span>
              </td>
            </tr>
            <tr v-if="logs.length === 0">
              <td colspan="8" class="table-empty">暂无日志</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Pager :total="logs.length" :page="page" :page-size="PAGE_SIZE" @update:page="page = $event" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api.js'
import SwitchRail from '../components/SwitchRail.vue'
import Pager from '../components/Pager.vue'

const PAGE_SIZE = 20

const logs = ref([])
const loading = ref(false)
const autoRefresh = ref(true)
const limit = ref(100)
const page = ref(1)
const filters = reactive({ type: 'all', status: '', q: '' })

let timer = null

const pagedLogs = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return logs.value.slice(start, start + PAGE_SIZE)
})

const failCount = computed(
  () => logs.value.filter((r) => r.error || r.ok === false || Number(r.status) >= 400).length
)

const failRate = computed(() => {
  if (!logs.value.length) return 0
  return Math.round((failCount.value / logs.value.length) * 100)
})

function typeLabel(t) {
  return { chat: '对话', api: 'API', system: '系统' }[t] || t || '—'
}

function typeBadge(t) {
  if (t === 'chat') return 'badge-blue'
  if (t === 'api') return 'badge-purple'
  return 'badge-gray'
}

function statusBadge(status) {
  const s = Number(status)
  if (s === 0) return 'badge-gray'
  if (s >= 200 && s < 300) return 'badge-green'
  if (s >= 300 && s < 400) return 'badge-blue'
  if (s >= 400 && s < 500) return 'badge-amber'
  if (s >= 500) return 'badge-red'
  return 'badge-gray'
}

function statusText(row) {
  if (row.status === 0 || row.status === '0') return 'SYS'
  const s = Number(row.status)
  if (s >= 200 && s < 300) return `${s} ✓`
  if (s >= 400) return `${s} ✗`
  return String(row.status || '—')
}

function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function durationClass(ms) {
  if (ms == null) return 'muted-cell'
  if (ms > 10000) return 'err-text'
  if (ms > 3000) return 'warn-text'
  return 'mono muted-cell'
}

async function loadLogs() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: String(limit.value) })
    if (filters.type && filters.type !== 'all') params.set('type', filters.type)
    if (filters.status) params.set('status', filters.status)
    if (filters.q && filters.q.trim()) params.set('q', filters.q.trim())
    const data = await api.getLogs(params.toString())
    logs.value = data.logs || []
    page.value = 1
  } catch (e) {
    ElMessage.error(`加载日志失败：${e.message}`)
  } finally {
    loading.value = false
  }
}

function onAutoRefreshChange(val) {
  if (val) startTimer()
  else stopTimer()
}

function startTimer() {
  stopTimer()
  // 与后端 10 秒批量落盘保持一致
  timer = setInterval(loadLogs, 10000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  loadLogs()
  if (autoRefresh.value) startTimer()
})

onBeforeUnmount(stopTimer)
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.toolbar-stats {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--rule-soft);
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
}

.stat-chip { display: inline-flex; align-items: baseline; gap: 6px; }
.stat-chip b { font-size: 13px; color: var(--ink); font-weight: 600; }

.live-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ok);
}
.live-tag .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  animation: pulse 1.8s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@media (prefers-reduced-motion: reduce) {
  .live-tag .dot { animation: none; }
}

.time-cell { font-size: 11.5px; color: var(--ink-3); white-space: nowrap; }
.sub-line { font-size: 10.5px; color: var(--ink-4); }
.muted-cell { color: var(--ink-3); font-size: 12px; }
.err-text { color: var(--accent); font-size: 12px; }
.warn-text { color: var(--warn); font-size: 12px; }

.search-hint {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--ink-4);
  user-select: none;
}

.auto-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

@media (max-width: 767px) {
  .toolbar-item { flex: 1 1 45% !important; min-width: 0; }
  .auto-refresh { margin-left: 0; }
}
</style>
