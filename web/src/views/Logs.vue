<template>
  <div>
    <!-- 工具栏 -->
    <div class="card toolbar-card">
      <div class="toolbar">
        <el-select v-model="filters.type" placeholder="类型" class="toolbar-item" style="flex: 0 0 120px" @change="loadLogs">
          <el-option label="全部类型" value="all" />
          <el-option label="对话" value="chat" />
          <el-option label="API" value="api" />
          <el-option label="系统" value="system" />
        </el-select>
        <el-select v-model="filters.status" placeholder="状态码" clearable class="toolbar-item" style="flex: 0 0 140px" @change="loadLogs">
          <el-option label="✅ 成功 (2xx)" value="2xx" />
          <el-option label="⚠️ 客户端错误 (4xx)" value="4xx" />
          <el-option label="❌ 服务端错误 (5xx)" value="5xx" />
          <el-option label="🟣 系统 (0)" value="0" />
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
        <el-select v-model="limit" style="flex: 0 0 100px" @change="loadLogs">
          <el-option :value="50" label="50 条" />
          <el-option :value="100" label="100 条" />
          <el-option :value="200" label="200 条" />
          <el-option :value="500" label="500 条" />
        </el-select>
        <div class="auto-refresh">
          <span class="muted">自动刷新</span>
          <el-switch v-model="autoRefresh" @change="onAutoRefreshChange" />
        </div>
        <el-button type="primary" :loading="loading" @click="loadLogs">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          刷新
        </el-button>
      </div>
      <div class="toolbar-stats muted">
        <span>共 {{ logs.length }} 条记录（最近 {{ limit }} 条）</span>
        <span v-if="autoRefresh" class="live-dot"><i class="dot"></i>每 3 秒自动刷新</span>
      </div>
    </div>

    <!-- 日志表格 -->
    <div class="card" style="margin-top: 16px; padding: 8px">
      <el-table :data="logs" style="width: 100%" size="small" :header-cell-style="{ background: 'var(--bg-850)', color: 'var(--text-secondary)', fontWeight: 600 }" empty-text="暂无日志">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">
            <span class="mono">{{ row.time }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <span :class="['badge', typeBadge(row.type)]">{{ typeLabel(row.type) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span :class="['badge', statusBadge(row.status)]">{{ statusText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="模型 / 路径" min-width="220">
          <template #default="{ row }">
            <template v-if="row.type === 'chat'">
              <div class="mono ellipsis" :title="row.model">{{ row.model || '—' }}</div>
              <div v-if="row.stream" class="muted" style="font-size: 11px">流式</div>
            </template>
            <template v-else-if="row.type === 'api'">
              <div class="mono ellipsis" :title="`${row.method} ${row.path}`">{{ row.method }} {{ row.path }}</div>
            </template>
            <template v-else>
              <div class="mono ellipsis">系统事件</div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="平台" min-width="110">
          <template #default="{ row }">
            <span class="ellipsis" :title="row.provider_name">{{ row.provider_name || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Key" min-width="90">
          <template #default="{ row }">
            <span class="mono muted ellipsis" :title="row.key">{{ row.key || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="90" align="right">
          <template #default="{ row }">
            <span :class="durationClass(row.duration_ms)">{{ fmtDuration(row.duration_ms) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="详情 / 错误" min-width="260">
          <template #default="{ row }">
            <div v-if="row.error" class="err-text ellipsis" :title="row.error">{{ row.error }}</div>
            <div v-else-if="row.detail" class="muted ellipsis" :title="row.detail">{{ row.detail }}</div>
            <div v-else-if="row.ok === false" class="err-text ellipsis">请求失败</div>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'

const logs = ref([])
const loading = ref(false)
const autoRefresh = ref(true)
const limit = ref(100)
const filters = reactive({ type: 'all', status: '', q: '' })

let timer = null

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
  if (s >= 400 && s < 500) return `${s} ✗`
  if (s >= 500) return `${s} ✗`
  return String(row.status || '—')
}

function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function durationClass(ms) {
  if (ms == null) return 'muted'
  if (ms > 10000) return 'err-text'
  if (ms > 3000) return 'warn-text'
  return 'muted'
}

async function loadLogs() {
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: String(limit.value) })
    if (filters.type && filters.type !== 'all') params.set('type', filters.type)
    if (filters.status) params.set('status', filters.status)
    if (filters.q && filters.q.trim()) params.set('q', filters.q.trim())
    const resp = await fetch(`/api/logs?${params.toString()}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    logs.value = data.logs || []
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
  timer = setInterval(loadLogs, 3000)
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
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
}

.live-dot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--green);
}

.live-dot .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}

.ellipsis {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.err-text {
  color: var(--red);
  font-size: 12.5px;
}

.warn-text {
  color: var(--amber);
}

.search-hint {
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}

.auto-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

@media (max-width: 767px) {
  .toolbar-item {
    flex: 1 1 45% !important;
    min-width: 0;
  }

  .auto-refresh {
    margin-left: 0;
  }
}
</style>