<template>
  <div>
    <!-- 实时脉搏：整个页面的主角 -->
    <div class="card panel-tick hero">
      <div class="hero-grid">
        <div class="hero-cell">
          <div class="label-micro">今日请求</div>
          <div class="hero-num num">{{ fmtFull(stats.todayRequests) }}</div>
          <div class="hero-sub mono">
            成功率 <b>{{ todayRate }}</b> · 失败 <b :class="{ alarm: (stats.todayFailed || 0) > 0 }">{{ fmtFull(stats.todayFailed) }}</b>
          </div>
        </div>

        <div class="hero-pulse">
          <div class="hero-pulse-head">
            <span class="label-micro">实时脉搏 · 最近 {{ PULSE_COUNT }} 次请求</span>
            <span class="label-micro pulse-legend">
              <i class="swatch swatch-fail"></i>失败
              <i class="swatch swatch-ok"></i>成功
            </span>
          </div>
          <PulseStrip :logs="pulseLogs" :count="PULSE_COUNT" />
        </div>

        <div class="hero-cell hero-cell-right">
          <div class="label-micro">近 60 秒 · 请求</div>
          <div class="hero-num num">{{ recentCount }}</div>
          <div class="hero-sub mono">次请求</div>
        </div>
      </div>
    </div>

    <!-- 指标台账：靠发丝线分格，不靠色块卡片 -->
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">总请求数</div>
        <div class="metric-value num">{{ fmtNum(stats.totalRequests) }}</div>
        <div class="metric-foot mono">累计</div>
      </div>
      <div class="metric">
        <div class="metric-label">成功请求</div>
        <div class="metric-value num">{{ fmtNum(stats.totalSuccess) }}</div>
        <div class="metric-foot mono">成功率 {{ overallRate }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">失败请求</div>
        <div class="metric-value num" :class="{ alarm: (stats.totalFailed || 0) > 0 }">{{ fmtNum(stats.totalFailed) }}</div>
        <div class="metric-foot mono">含上游与网关错误</div>
      </div>
      <div class="metric">
        <div class="metric-label">自动切换</div>
        <div class="metric-value num">{{ fmtNum(stats.totalFailovers) }}</div>
        <div class="metric-foot mono">Key / 平台故障接管</div>
      </div>
      <div class="metric">
        <div class="metric-label">平台</div>
        <div class="metric-value num">{{ overview.enabledProviders ?? 0 }}<span class="metric-unit">/{{ overview.totalProviders ?? 0 }}</span></div>
        <div class="metric-foot mono">启用 / 总数</div>
      </div>
      <div class="metric">
        <div class="metric-label">模型总数</div>
        <div class="metric-value num">{{ fmtNum(overview.totalModels) }}</div>
        <div class="metric-foot mono">去重前聚合</div>
      </div>
      <div class="metric">
        <div class="metric-label">Key</div>
        <div class="metric-value num" :class="{ alarm: (overview.cooldownKeys || 0) > 0 }">{{ fmtNum(overview.totalKeys) }}</div>
        <div class="metric-foot mono">
          冷却 <b :class="{ alarm: (overview.cooldownKeys || 0) > 0 }">{{ overview.cooldownKeys ?? 0 }}</b>
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">Token</div>
        <div class="metric-value num">{{ fmtNum(overview.todayTokens) }}</div>
        <div class="metric-foot mono">今日 · 累计 {{ fmtNum(overview.totalTokens) }}</div>
      </div>
    </div>

    <div class="card" style="margin-top: 18px">
      <div class="section-title">对接方式</div>
      <p class="muted" style="margin-bottom: 12px">完全兼容 OpenAI API 协议，任何 OpenAI SDK 或 HTTP 客户端均可直接接入：</p>
      <div class="conn-grid">
        <div class="conn-item">
          <div class="conn-label">Base URL</div>
          <div class="conn-value mono ellipsis" :title="baseUrl">{{ baseUrl }}</div>
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

    <div style="margin-top: 18px">
      <div class="section-title">平台运行状态</div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>平台</th>
              <th>协议</th>
              <th>状态</th>
              <th class="right">Key</th>
              <th class="right">模型</th>
              <th class="right">请求</th>
              <th class="right">Token</th>
              <th style="width: 152px">Key 健康</th>
              <th>模型更新</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in providers" :key="row.id">
              <tr>
              <td class="cell-strong">{{ row.name }}</td>
              <td><span class="badge badge-blue">{{ protocolLabel(row.protocol) }}</span></td>
              <td>
                <span :class="['badge', row.enabled ? 'badge-green' : 'badge-gray']">
                  <span class="badge-dot" :class="row.enabled ? 'green' : 'gray'"></span>{{ row.enabled ? '启用' : '停用' }}
                </span>
              </td>
              <td class="right num">{{ row.keyCount ?? (row.keys || []).length }}</td>
              <td class="right num">{{ row.modelCount ?? (row.models || []).length }}</td>
              <td class="right">
                <span class="num cell-strong">{{ fmtNum(row.stats?.requests ?? 0) }}</span>
                <span :class="rateClass(row)">{{ rateOf(row) }}</span>
              </td>
              <td class="right num muted-cell">{{ fmtNum(row.stats?.tokens ?? 0) }}</td>
              <td>
                <button
                  v-if="(keyStatsMap[row.id]?.total ?? 0) > 0"
                  class="key-summary"
                  :class="{ alarm: keyStatsMap[row.id].bad > 0, open: expandedKeys === row.id }"
                  :title="keySummaryTitle(row)"
                  @click="toggleKeys(row.id)"
                >
                  <span class="num">{{ keyStatsMap[row.id].ok }}</span><span class="slash">/</span><span class="num dim">{{ keyStatsMap[row.id].total }}</span>
                  <span class="key-bar">
                    <i class="ok" :style="{ flex: keyStatsMap[row.id].ok }"></i>
                    <i class="bad" :style="{ flex: keyStatsMap[row.id].bad }"></i>
                  </span>
                  <svg class="chev-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <span v-else class="muted-cell">—</span>
              </td>
              <td class="muted-cell">{{ row.models_updated_at ? formatTime(row.models_updated_at) : '未拉取' }}</td>
            </tr>
            <tr v-if="expandedKeys === row.id" class="key-detail-row">
              <td colspan="9">
                <div class="key-detail">
                  <div class="key-detail-head">
                    <span class="label-micro">正常 <b class="num">{{ keyStatsMap[row.id].ok }}</b></span>
                    <span class="label-micro">冷却 <b class="num" :class="{ alarm: keyStatsMap[row.id].cool > 0 }">{{ keyStatsMap[row.id].cool }}</b></span>
                    <span class="label-micro">停用 <b class="num">{{ keyStatsMap[row.id].off }}</b></span>
                    <span class="label-micro key-detail-hint">点击汇总可收起</span>
                  </div>
                  <div class="key-health">
                    <span v-for="k in row.keys" :key="k.id" :class="['badge', keyBadge(k)]">
                      <span class="badge-dot" :class="keyDot(k)"></span>{{ k.name }}
                    </span>
                  </div>
                </div>
              </td>
            </tr>
            </template>
            <tr v-if="providers.length === 0">
              <td colspan="9" class="table-empty">暂无平台，前往「平台管理」添加。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="foot-bar">
      <span class="mono">最后更新 {{ lastUpdated || '—' }}</span>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'
import PulseStrip from '../components/PulseStrip.vue'

const PULSE_COUNT = 64

const status = ref({})
const gatewayKey = ref('')
const lastUpdated = ref('')
const loading = ref(false)
const pulseLogs = ref([])

const baseUrl = `${location.origin}/api/v1`

const stats = computed(() => status.value.stats || {})
const overview = computed(() => status.value.overview || {})
const providers = computed(() => status.value.providers || [])

/** 每个平台的 Key 健康汇总：ok 正常 / cool 冷却中 / off 停用 / bad 非正常合计 */
const keyStatsMap = computed(() => {
  const map = {}
  for (const p of providers.value) {
    const keys = p.keys || []
    let ok = 0
    let cool = 0
    let off = 0
    for (const k of keys) {
      if (!k.enabled) off++
      else if (k.status && k.status.cooldown) cool++
      else ok++
    }
    map[p.id] = { ok, cool, off, bad: cool + off, total: keys.length }
  }
  return map
})

const expandedKeys = ref(null)

function toggleKeys(id) {
  expandedKeys.value = expandedKeys.value === id ? null : id
}

function keySummaryTitle(row) {
  const s = keyStatsMap.value[row.id]
  if (!s || !s.total) return '未配置 Key'
  const parts = [`${s.ok} 正常 / ${s.total} 个 Key`]
  if (s.cool) parts.push(`${s.cool} 冷却中`)
  if (s.off) parts.push(`${s.off} 已停用`)
  parts.push(expandedKeys.value === row.id ? '点击收起' : '点击展开')
  return parts.join(' · ')
}

const todayRate = computed(() => {
  const { todayRequests = 0, todaySuccess = 0 } = stats.value
  if (!todayRequests) return '—'
  return `${Math.round((todaySuccess / todayRequests) * 100)}%`
})

const overallRate = computed(() => {
  const { totalRequests = 0, totalSuccess = 0 } = stats.value
  if (!totalRequests) return '—'
  return `${Math.round((totalSuccess / totalRequests) * 100)}%`
})

/** 最近 60 秒内的真实代理请求数：只算 type==='chat' 的日志，与管理 API 轮询日志分离，口径对齐今日请求 */
const recentCount = computed(() => {
  const cutoff = Date.now() - 60_000
  return pulseLogs.value.filter((r) => {
    if (r.type !== 'chat') return false
    const t = Date.parse(String(r.time || '').replace(' ', 'T'))
    return Number.isFinite(t) && t >= cutoff
  }).length
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
  if (n == null) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

function fmtFull(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('en-US')
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
  if (!text) return
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
  anthropic: 'Anthropic 原生',
  custom: '自定义'
}

function protocolLabel(proto) {
  return PROTOCOL_LABELS[proto] || 'OpenAI Chat'
}

async function load() {
  loading.value = true
  try {
    const [statusData, gatewayData] = await Promise.all([api.getStatus(), api.getGateway()])
    status.value = statusData
    gatewayKey.value = gatewayData.api_key
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN')
  } catch (e) {
    ElMessage.error(e?.message || '加载状态失败')
  } finally {
    loading.value = false
  }
  // 脉搏条单独取，失败不影响主面板
  try {
    const data = await api.getLogs(`limit=${PULSE_COUNT}`)
    pulseLogs.value = (data.logs || []).filter((l) => l.type === 'chat')
  } catch {
    /* 日志拉不动就维持上一次的采样 */
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
/* ---------- 实时脉搏 hero ---------- */
.hero {
  padding: 18px 20px 16px;
}

.hero-grid {
  display: grid;
  grid-template-columns: 180px 1fr 130px;
  gap: 20px;
  align-items: stretch;
}

.hero-cell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding-right: 20px;
  border-right: 1px solid var(--rule-soft);
}

.hero-cell-right {
  padding-right: 0;
  padding-left: 20px;
  border-right: none;
  border-left: 1px solid var(--rule-soft);
  text-align: right;
}

.hero-num {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
  letter-spacing: -0.02em;
}

.hero-sub {
  font-size: 11px;
  color: var(--ink-3);
}
.hero-sub b { color: var(--ink); font-weight: 600; }

.hero-pulse { min-width: 0; }

.hero-pulse-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.pulse-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pulse-legend .swatch {
  width: 7px;
  height: 7px;
  border-radius: 1px;
  display: inline-block;
  margin-left: 6px;
}
.pulse-legend .swatch-fail { background: var(--accent); }
.pulse-legend .swatch-ok { background: var(--ink-3); }

/* ---------- 指标台账 ---------- */
.metric-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: var(--r);
  overflow: hidden;
}

.metric {
  background: var(--surface);
  padding: 13px 16px 12px;
  transition: background-color 0.15s;
}
.metric:hover { background: var(--surface-2); }

.metric-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.metric-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.25;
  margin-top: 3px;
  letter-spacing: -0.02em;
}

.metric-unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-4);
  margin-left: 1px;
}

.metric-foot {
  font-size: 10.5px;
  color: var(--ink-4);
  margin-top: 2px;
}
.metric-foot b { color: var(--ink-2); font-weight: 600; }

/* ---------- 对接方式 ---------- */
.conn-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.conn-item {
  background: var(--paper-sunk);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  min-width: 0;
}

.conn-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 5px;
}

.conn-value { font-size: 13px; color: var(--ink); word-break: break-all; }

.copy-mini {
  margin-top: 8px;
  border: 1px solid var(--rule);
  background: var(--surface);
  color: var(--ink-3);
  border-radius: var(--r-xs);
  padding: 2px 9px;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.14s, border-color 0.14s;
}
.copy-mini:hover { color: var(--accent); border-color: var(--accent-line); }

/* ---------- 表格内小零件 ---------- */
.key-health { display: flex; flex-wrap: wrap; gap: 5px; }
.rate { font-size: 11px; color: var(--ok); margin-left: 6px; font-family: var(--font-mono); }
.rate.rate-fail { color: var(--accent); }
.rate.muted { color: var(--ink-4); }
.muted-cell { color: var(--ink-3); font-size: 12px; }

/* ---------- Key 健康汇总（点击展开） ---------- */
.key-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 7px;
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.14s, background-color 0.14s, color 0.14s;
}
.key-summary:hover { border-color: var(--rule-strong); background: var(--surface-2); }
.key-summary.open { border-color: var(--accent-line); }
.key-summary.alarm { color: var(--accent); background: var(--accent-tint); border-color: var(--accent-line); }

.key-summary .slash { color: var(--ink-4); }
.key-summary .dim { color: var(--ink-4); }
.key-summary.alarm .slash,
.key-summary.alarm .dim { color: var(--accent); opacity: 0.65; }

.chev-mini {
  width: 11px;
  height: 11px;
  color: var(--ink-4);
  flex-shrink: 0;
  transition: transform 0.18s ease;
}
.key-summary.open .chev-mini { transform: rotate(180deg); color: var(--accent); }

/* 正常 / 异常 比例条，按 flex 分配宽度 */
.key-bar {
  display: inline-flex;
  width: 38px;
  height: 3px;
  border-radius: 1px;
  overflow: hidden;
  background: var(--rule);
  flex-shrink: 0;
}
.key-bar i { display: block; height: 100%; }
.key-bar .ok { background: var(--ink-3); }
.key-bar .bad { background: var(--accent); }

.key-detail-row td {
  background: var(--paper-sunk);
  padding: 12px 14px;
}
.key-detail-row:hover td { background: var(--paper-sunk); }

.key-detail { display: flex; flex-direction: column; gap: 9px; }
.key-detail-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.key-detail-head b { color: var(--ink); font-weight: 600; font-size: 11.5px; }
.key-detail-hint { margin-left: auto; color: var(--ink-4); }

.foot-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  font-size: 11px;
  color: var(--ink-4);
}

@media (max-width: 1100px) {
  .metric-grid { grid-template-columns: repeat(3, 1fr); }
}

@media (max-width: 900px) {
  .hero-grid { grid-template-columns: 1fr 1fr; }
  .hero-pulse { grid-column: 1 / -1; order: 3; padding-top: 4px; border-top: 1px solid var(--rule-soft); }
  .hero-cell-right { padding-right: 20px; padding-left: 0; border-left: none; border-right: 1px solid var(--rule-soft); }
}

@media (max-width: 767px) {
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
  .conn-grid { grid-template-columns: 1fr; }
  .hero { padding: 14px; }
  .hero-num { font-size: 24px; }
  .metric-value { font-size: 19px; }
}
</style>
