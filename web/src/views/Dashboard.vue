<template>
  <div>
    <el-row :gutter="16">
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(99,102,241,0.15); color: #a5b4fc">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.stats?.totalRequests ?? 0) }}</div>
            <div class="stat-label">总请求数</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(52,211,153,0.15); color: #34d399">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.stats?.totalSuccess ?? 0) }}</div>
            <div class="stat-label">成功请求</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(248,113,113,0.15); color: #f87171">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.stats?.totalFailed ?? 0) }}</div>
            <div class="stat-label">失败请求</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(251,191,36,0.15); color: #fbbf24">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M21 8v13H3V8" /><path d="M12 16l-3-3 3-3" /><path d="M9 13h6" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.stats?.totalFailovers ?? 0) }}</div>
            <div class="stat-label">自动切换</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(139,92,246,0.15); color: #c4b5fd">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ status.overview?.totalProviders ?? 0 }}</div>
            <div class="stat-label">平台数</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(45,212,191,0.15); color: #5eead4">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><path d="M7 7h.01" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.stats?.todayRequests ?? 0) }}</div>
            <div class="stat-label">今日请求</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(244,114,182,0.15); color: #f472b6">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" /><path d="M4 6v12c0 1.1.9 2 2 2h14v-4" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" /></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.overview?.todayTokens ?? 0) }}</div>
            <div class="stat-label">今日 Token</div>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <div class="stat-card">
          <div class="stat-icon" style="background: rgba(128,222,234,0.15); color: #80d4ea">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="8" r="4"/><circle cx="18" cy="8" r="4"/><circle cx="14" cy="16" r="4"/><circle cx="10" cy="16" r="4"/><path d="M6 12v4"/><path d="M18 12v4"/></svg>
          </div>
          <div>
            <div class="stat-num">{{ fmtNum(status.overview?.totalTokens ?? 0) }}</div>
            <div class="stat-label">总计 Token</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <div class="card" style="margin-top: 18px">
      <div class="section-title">对接方式</div>
      <p class="muted" style="margin-bottom: 12px">完全兼容 OpenAI API 协议，任何 OpenAI SDK 或 HTTP 客户端均可直接接入：</p>
      <div class="conn-grid">
        <div class="conn-item">
          <div class="conn-label">Base URL</div>
          <div class="conn-value mono ellipsis">{{ baseUrl }}</div>
          <button class="copy-mini" @click="copyText(baseUrl)">复制</button>
        </div>
        <div class="conn-item">
          <div class="conn-label">API Key</div>
          <div class="conn-value mono ellipsis" :title="gatewayKey">{{ gatewayKey || '加载中…' }}</div>
          <button class="copy-mini" @click="copyText(gatewayKey)">复制</button>
        </div>
        <div class="conn-item">
          <div class="conn-label">模型</div>
          <div class="conn-value">平台已拉取的模型 ID，如 gpt-4o-mini</div>
        </div>
      </div>
    </div>

    <div class="overview-bar">
      <div class="ov-item">
        <span class="ov-num">{{ status.overview?.enabledProviders ?? 0 }}</span>
        <span class="ov-label">启用平台</span>
      </div>
      <div class="ov-item">
        <span class="ov-num">{{ status.overview?.totalModels ?? 0 }}</span>
        <span class="ov-label">模型总数</span>
      </div>
      <div class="ov-item">
        <span class="ov-num">{{ status.overview?.totalKeys ?? 0 }}</span>
        <span class="ov-label">Key 总数</span>
      </div>
      <div class="ov-item">
        <span :class="['ov-num', (status.overview?.cooldownKeys ?? 0) > 0 ? 'ov-warn' : '']">{{ status.overview?.cooldownKeys ?? 0 }}</span>
        <span class="ov-label">冷却中 Key</span>
      </div>
      <div class="ov-item">
        <span class="ov-num">{{ todayRate }}</span>
        <span class="ov-label">今日成功率</span>
      </div>
      <div class="ov-refresh">
        最后更新 {{ lastUpdated }}
        <el-button size="small" text type="primary" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="card" style="margin-top: 18px">
      <div class="section-title">平台运行状态</div>
      <div class="table-scroll">
        <el-table :data="status.providers || []" style="width: 100%" :header-cell-style="{ background: 'transparent' }">
          <el-table-column prop="name" label="平台" min-width="150">
            <template #default="{ row }">
              <span style="font-weight: 500">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="协议" width="150">
            <template #default="{ row }">
              <span class="badge badge-blue">{{ protocolLabel(row.protocol) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <span :class="['badge', row.enabled ? 'badge-green' : 'badge-gray']">
                <span class="badge-dot" :class="row.enabled ? 'green' : 'gray'"></span>{{ row.enabled ? '启用' : '停用' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="keyCount" label="Key" width="70" align="center" />
          <el-table-column prop="modelCount" label="模型" width="70" align="center" />
          <el-table-column label="请求" width="130">
            <template #default="{ row }">
              <span class="req-count">{{ row.stats?.requests ?? 0 }}</span>
              <span :class="rateClass(row)">{{ rateOf(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Token" width="120">
            <template #default="{ row }">
              <span class="muted">{{ fmtNum(row.stats?.tokens ?? 0) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Key 健康状态" min-width="200">
            <template #default="{ row }">
              <div style="display: flex; flex-wrap: wrap; gap: 6px">
                <span v-for="k in row.keys" :key="k.id" :class="['badge', keyBadge(k)]">
                  <span class="badge-dot" :class="keyDot(k)"></span>{{ k.name }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="模型更新" width="150">
            <template #default="{ row }">
              <span class="muted">{{ row.models_updated_at ? formatTime(row.models_updated_at) : '未拉取' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import api, { notifyError } from '../api.js'

const status = ref({})
const gatewayKey = ref('')
const lastUpdated = ref('')

const baseUrl = `${location.origin}/api/v1`

const todayRate = computed(() => {
  const { todayRequests = 0, todaySuccess = 0 } = status.value.stats || {}
  if (todayRequests === 0) return '—'
  return `${Math.round((todaySuccess / todayRequests) * 100)}%`
})

function rateOf(row) {
  const s = row.stats || {}
  if (!s.requests) return '—'
  return `${Math.round(((s.success || 0) / s.requests) * 100)}%`
}

function rateClass(row) {
  const s = row.stats || {}
  if (!s.requests) return 'rate muted'
  return ((s.success || 0) / s.requests) < 0.8 ? 'rate rate-fail' : 'rate'
}

function fmtNum(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

function keyBadge(k) {
  if (!k.enabled) return 'badge-gray'
  if (k.status && k.status.cooldown) return 'badge-red'
  return 'badge-green'
}

function keyDot(k) {
  if (!k.enabled) return 'gray'
  if (k.status && k.status.cooldown) return 'red'
  return 'green'
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN')
}

function copyText(text) {
  if (!navigator.clipboard) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    ElMessage.success('已复制')
    return
  }
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success('已复制')
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}

const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-openai': 'Anthropic（OpenAI 兼容）',
  'anthropic': 'Anthropic 原生',
  'custom': '自定义'
}

function protocolLabel(proto) {
  return PROTOCOL_LABELS[proto] || 'OpenAI Chat'
}

async function load() {
  try {
    const [statusData, gatewayData] = await Promise.all([api.getStatus(), api.getGateway()])
    status.value = statusData
    gatewayKey.value = gatewayData.api_key
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN')
  } catch (e) {
    notifyError(e, '加载状态失败')
  }
}

let timer = null

onMounted(() => {
  load()
  timer = setInterval(load, 10000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.stat-card {
  background: var(--bg-800);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.stat-icon {
  width: 40px;
  height: 40px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-num {
  font-size: 23px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.stat-label {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 1px;
}

.overview-bar {
  display: flex;
  align-items: center;
  gap: 28px;
  flex-wrap: wrap;
  background: var(--bg-800);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 20px;
  margin-top: 2px;
}

.ov-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ov-num {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.ov-num.ov-warn {
  color: var(--red);
}

.ov-label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.ov-refresh {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.table-scroll .el-table {
  min-width: 700px;
}

.req-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-right: 6px;
}

.rate {
  font-size: 11.5px;
  color: var(--green);
}

.rate.rate-fail {
  color: var(--red);
}

.rate.muted {
  color: var(--text-muted);
}

.conn-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.conn-item {
  background: var(--bg-850);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 12px 14px;
  min-width: 0;
}

.conn-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.conn-value {
  font-size: 13px;
  color: var(--text-main);
  word-break: break-all;
}

.conn-value.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-mini {
  margin-top: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-mini:hover {
  color: var(--text-main);
  border-color: #33333d;
}

.mono {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}

.code-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.code-tab {
  border: 1px solid var(--border);
  background: var(--bg-850);
  color: var(--text-secondary);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.15s;
}

.code-tab:hover {
  color: var(--text-main);
  border-color: #33333d;
}

.code-tab.active {
  background: rgba(99, 102, 241, 0.16);
  border-color: rgba(99, 102, 241, 0.4);
  color: #c7c9ff;
}

.copy-btn {
  margin-left: auto;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-btn:hover {
  color: var(--text-main);
  border-color: #33333d;
}

.code-block-code {
  margin-bottom: 4px;
}

@media (max-width: 767px) {
  .conn-grid {
    grid-template-columns: 1fr;
  }

  .copy-btn {
    margin-left: 0;
  }

  .overview-bar {
    gap: 18px;
    padding: 12px 16px;
  }

  .ov-refresh {
    margin-left: 0;
    flex-basis: 100%;
  }

  .stat-num {
    font-size: 20px;
  }
}
</style>
