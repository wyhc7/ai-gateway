<template>
  <div class="card credits-panel">
    <div class="credits-head">
      <div>
        <div class="section-title" style="margin: 0">
          订阅积分
          <span class="muted" style="font-weight: 400; font-size: 12px; margin-left: 8px">
            {{ groups.length }} 个平台 · {{ totalKeys }} 个账号
          </span>
        </div>
        <div class="credits-sub muted">
          按量计费的平台余额，模型按各自的倍率扣减
          <span v-if="freshAt"> · 数据 {{ freshAt }}</span>
        </div>
      </div>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 总览：一个大数字 + 一条总进度 -->
    <div class="credits-total">
      <div class="total-main">
        <div class="total-num num">{{ fmt(total.remain) }}</div>
        <div class="total-label">剩余积分</div>
      </div>
      <div class="total-side">
        <div class="total-bar">
          <div class="total-bar-fill" :style="{ width: pct(total.remain, total.size) }"></div>
        </div>
        <div class="total-meta mono">
          已用 <b>{{ fmt(total.used) }}</b> / 总量 <b>{{ fmt(total.size) }}</b>
          · 剩余 <b>{{ pct(total.remain, total.size) }}</b>
        </div>
      </div>
    </div>

    <!-- 按平台分组 -->
    <div v-if="!loading && groups.length === 0" class="credits-empty muted">
      没有接入按量计费的平台（WorkBuddy / CodeBuddy 等）
    </div>

    <div class="plat-list">
      <div v-for="g in groups" :key="g.id" class="plat">
        <div class="plat-head" @click="toggle(g.id)">
          <span class="plat-arrow" :class="{ open: openId === g.id }">▸</span>
          <span class="plat-name">{{ g.name }}</span>
          <span class="plat-tag mono" :class="{ off: !g.enabled }">{{ g.enabled ? '启用' : '停用' }}</span>
          <span class="plat-count muted">{{ g.keys.length }} 个号</span>
          <span class="plat-spacer"></span>
          <span class="plat-remain num">{{ fmt(g.remain) }}</span>
          <span class="plat-size muted">/ {{ fmt(g.size) }}</span>
          <div class="plat-bar">
            <div class="plat-bar-fill" :class="levelClass(g.remain, g.size)" :style="{ width: pct(g.remain, g.size) }"></div>
          </div>
        </div>

        <div v-if="openId === g.id" class="plat-body">
          <table class="cred-table">
            <thead>
              <tr>
                <th>账号</th>
                <th class="right">剩余</th>
                <th class="right">已用</th>
                <th class="right">总量</th>
                <th>余量</th>
                <th class="right">更新</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in g.keys" :key="k.id">
                <td>
                  <span class="cred-name">{{ k.nickname || k.name || shortId(k.id) }}</span>
                  <span v-if="!k.enabled" class="badge-off">停用</span>
                  <span v-else-if="k.expiring" class="badge-warn">凭据将过期</span>
                </td>
                <td class="right num" :class="{ low: k.remain < 100 }">{{ fmt(k.remain) }}</td>
                <td class="right num muted">{{ fmt(k.used) }}</td>
                <td class="right num muted">{{ fmt(k.size) }}</td>
                <td>
                  <div class="mini-bar">
                    <div class="mini-bar-fill" :class="levelClass(k.remain, k.size)" :style="{ width: pct(k.remain, k.size) }"></div>
                  </div>
                </td>
                <td class="right muted mono tiny">{{ k.at }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="g.expiring" class="plat-note warn">
            有 {{ g.expiring }} 个账号的访问凭据将在 1 小时内过期，网关会自动续期；失败会写进该账号的 last_error。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'

const loading = ref(false)
const providers = ref([])
const openId = ref(null)

// 认哪些平台：只有订阅/积分计费型才参与汇总。
// 用 type/name/base_url 一起判 —— 历史数据里 type 有缺失的情况（早期导入的 WorkBuddy
// 平台 type 就是 undefined），只认 type 会漏掉整个平台。
function isCreditsProvider(p) {
  const hay = `${p.type || ''} ${p.provider || ''} ${p.name || ''} ${p.base_url || ''}`.toLowerCase()
  return /workbuddy|codebuddy/.test(hay)
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function shortId(id) {
  const s = String(id || '')
  return s.length > 8 ? `${s.slice(0, 8)}…` : s
}

function fmt(n) {
  return toNum(n).toLocaleString('en-US')
}

function pct(remain, size) {
  const r = toNum(remain)
  const s = toNum(size)
  if (s <= 0) return '0%'
  return `${Math.min(100, Math.max(0, (r / s) * 100)).toFixed(1)}%`
}

// 余量分级：<10% 红、<30% 黄、其余正常色。让人一眼看到哪个号快空了。
function levelClass(remain, size) {
  const r = toNum(remain)
  const s = toNum(size)
  if (s <= 0) return 'lv-none'
  const p = r / s
  if (p < 0.1) return 'lv-low'
  if (p < 0.3) return 'lv-mid'
  return 'lv-ok'
}

const groups = computed(() => {
  return providers.value
    .filter(isCreditsProvider)
    .map((p) => {
      const keys = (p.keys || [])
        .filter((k) => k.credits_size != null || k.credits_remain != null)
        .map((k) => ({
          id: k.id,
          name: k.name,
          nickname: k.nickname || '',
          enabled: k.enabled !== false,
          remain: toNum(k.credits_remain),
          used: toNum(k.credits_used),
          size: toNum(k.credits_size),
          expiring: k.credential_state === 'expiring' || k.credential_state === 'missing',
          at: fmtTime(k.credits_at),
          rawAt: toNum(k.credits_at)
        }))
      const remain = keys.reduce((n, k) => n + k.remain, 0)
      const used = keys.reduce((n, k) => n + k.used, 0)
      const size = keys.reduce((n, k) => n + k.size, 0)
      return {
        id: p.id,
        name: p.name,
        enabled: p.enabled !== false,
        keys,
        remain,
        used,
        size,
        expiring: keys.filter((k) => k.expiring).length
      }
    })
    .filter((g) => g.keys.length > 0)
    .sort((a, b) => b.remain - a.remain)
})

const total = computed(() => {
  const gs = groups.value
  return {
    remain: gs.reduce((n, g) => n + g.remain, 0),
    used: gs.reduce((n, g) => n + g.used, 0),
    size: gs.reduce((n, g) => n + g.size, 0)
  }
})

const totalKeys = computed(() => groups.value.reduce((n, g) => n + g.keys.length, 0))

// 数据新鲜度：取所有账号 credits_at 里最新的那个。让人知道这个数是不是刚刷的。
const freshAt = computed(() => {
  let latest = 0
  for (const g of groups.value) {
    for (const k of g.keys) {
      if (k.rawAt > latest) latest = k.rawAt
    }
  }
  if (!latest) return ''
  const min = Math.round((Date.now() - latest) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
})

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return '—'
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function toggle(id) {
  openId.value = openId.value === id ? null : id
}

async function load() {
  loading.value = true
  try {
    // /api/providers 目前返回裸数组；早先的接口形态里有过 {providers:[...]}，
    // 两种都吃，免得接口一改这里就静默空表。
    const raw = await api.getProviders()
    providers.value = Array.isArray(raw) ? raw : raw?.providers || []
  } catch (e) {
    ElMessage.error(`读取积分失败：${e.message}`)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.credits-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.credits-sub {
  font-size: 12px;
  margin-top: 4px;
}

/* 总览 */
.credits-total {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.total-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 0 0 auto;
}

.total-num {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.5px;
  line-height: 1;
}

.total-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.total-side {
  flex: 1 1 220px;
  min-width: 180px;
}

.total-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--el-border-color-lighter);
  overflow: hidden;
}

.total-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #3b82f6, #22c55e);
  transition: width 0.4s ease;
}

.total-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 平台行 */
.plat-list {
  border-top: 1px solid var(--el-border-color-lighter);
}

.plat + .plat {
  border-top: 1px solid var(--el-border-color-lighter);
}

.plat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 2px;
  cursor: pointer;
  user-select: none;
}

.plat-head:hover {
  background: var(--el-fill-color-lighter);
}

.plat-arrow {
  width: 12px;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  transition: transform 0.15s;
  flex: 0 0 auto;
}

.plat-arrow.open {
  transform: rotate(90deg);
}

.plat-name {
  font-size: 13px;
  font-weight: 500;
  flex: 0 0 auto;
}

.plat-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
  flex: 0 0 auto;
}

.plat-tag.off {
  background: var(--el-fill-color);
  color: var(--el-text-color-placeholder);
}

.plat-count {
  font-size: 11px;
  flex: 0 0 auto;
}

.plat-spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.plat-remain {
  font-size: 14px;
  font-weight: 600;
  flex: 0 0 auto;
}

.plat-size {
  font-size: 11px;
  flex: 0 0 auto;
}

.plat-bar {
  flex: 0 0 72px;
  height: 5px;
  border-radius: 3px;
  background: var(--el-border-color-lighter);
  overflow: hidden;
}

.plat-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.plat-bar-fill.lv-ok {
  background: var(--el-color-success);
}

.plat-bar-fill.lv-mid {
  background: var(--el-color-warning);
}

.plat-bar-fill.lv-low {
  background: var(--el-color-danger);
}

.plat-bar-fill.lv-none {
  background: var(--el-border-color);
}

/* 明细表 */
.plat-body {
  padding: 4px 0 14px;
}

.cred-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.cred-table th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  padding: 6px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  white-space: nowrap;
}

.cred-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--el-fill-color-lighter);
  vertical-align: middle;
}

.cred-table tr:last-child td {
  border-bottom: none;
}

.cred-table .right {
  text-align: right;
}

.cred-table .num {
  font-variant-numeric: tabular-nums;
}

.cred-table .num.low {
  color: var(--el-color-danger);
  font-weight: 600;
}

.tiny {
  font-size: 11px;
}

.cred-name {
  color: var(--el-text-color-regular);
}

.badge-off,
.badge-warn {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
}

.badge-off {
  background: var(--el-fill-color);
  color: var(--el-text-color-placeholder);
}

.badge-warn {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.mini-bar {
  width: 68px;
  height: 4px;
  border-radius: 2px;
  background: var(--el-border-color-lighter);
  overflow: hidden;
}

.mini-bar-fill {
  height: 100%;
  border-radius: 2px;
}

.mini-bar-fill.lv-ok {
  background: var(--el-color-success);
}

.mini-bar-fill.lv-mid {
  background: var(--el-color-warning);
}

.mini-bar-fill.lv-low {
  background: var(--el-color-danger);
}

.mini-bar-fill.lv-none {
  background: var(--el-border-color);
}

.plat-note {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.5;
}

.warn {
  color: var(--el-color-warning);
}

.credits-empty {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
}
</style>
