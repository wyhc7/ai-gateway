<template>
  <div>
    <!-- 版本对照 -->
    <div class="card">
      <div class="ver-head">
        <div class="ver-side">
          <div class="label-micro">当前版本</div>
          <div class="ver-sha mono">{{ current.short || '—' }}</div>
          <div class="ver-line">{{ current.date ? fmtDate(current.date) : '—' }}</div>
          <div class="ver-subject" :title="current.subject">{{ current.subject || '—' }}</div>
        </div>

        <div class="ver-mid">
          <span :class="['badge', stateBadge]">
            <span class="badge-dot" :class="stateDot"></span>{{ stateLabel }}
          </span>
          <div v-if="behindCount > 0" class="ver-behind mono">落后 {{ behindCount }} 个提交</div>
        </div>

        <div class="ver-side ver-side-right">
          <div class="label-micro">最新版本</div>
          <div class="ver-sha mono">{{ latest.short || '—' }}</div>
          <div class="ver-line">{{ latest.date ? fmtDate(latest.date) : '—' }}</div>
          <div class="ver-subject" :title="latest.subject">{{ latest.subject || '—' }}</div>
        </div>
      </div>

      <div class="ver-foot">
        <span class="mono ver-foot-text">
          <template v-if="result?.repo_dir">{{ result.repo_dir }}</template>
          <template v-if="branch"> · {{ branch }}</template>
          <template v-if="checkedAt"> · 检查于 {{ checkedAt }}</template>
        </span>
        <el-button size="small" :loading="checking" @click="check(true)">检查更新</el-button>
      </div>
    </div>

    <!-- 检查不通过：把原因和该怎么做说清楚 -->
    <div v-if="result && result.ok === false" class="card notice notice-warn">
      <div class="notice-title">无法自动检查更新</div>
      <p class="notice-text">{{ result.message }}</p>
      <div v-if="result.reason === 'not-a-git-repo'" class="notice-code mono">
        curl -fsSL https://raw.githubusercontent.com/wyhc7/ai-gateway/main/deploy/linux/complete-deploy.sh | sudo bash -s -- --update
      </div>
    </div>

    <!-- 已是最新 -->
    <div v-else-if="result && result.ok && !result.has_update" class="card notice notice-ok">
      <div class="notice-title">已是最新版本</div>
      <p class="notice-text">
        当前代码与上游 <b class="mono">{{ branch }}</b> 分支一致，没有需要更新的内容。
      </p>
    </div>

    <!-- 有更新：更新内容 + 更新按钮 -->
    <template v-else-if="result && result.has_update">
      <!-- 合并成功但后续步骤失败：代码已经进来了，别再让人以为是「已是最新」 -->
      <div v-if="result.stale_deploy" class="card notice notice-warn" style="margin-top: 18px">
        <div class="notice-title">上次更新没有跑完</div>
        <p class="notice-text">
          代码已经合并到 <b class="mono">{{ result.current.short }}</b>，但后续步骤失败了，
          现在跑的还是旧产物。<b>点下面的按钮把没做完的补上即可</b>，不会重复合并，
          也不会丢掉已经合并的提交。
        </p>
      </div>

      <div class="card" style="margin-top: 18px">
        <div class="section-title">更新内容</div>

        <div class="areas">
          <span v-for="a in result.areas || []" :key="a.key" class="badge badge-blue">
            {{ a.label }} {{ a.count }} 个文件
          </span>
          <span class="areas-total mono">共 {{ result.files?.total || 0 }} 个文件变更</span>
        </div>

        <ol class="commits">
          <li v-for="c in result.commits || []" :key="c.revision" class="commit">
            <span class="commit-sha mono">{{ c.short }}</span>
            <span class="commit-subject">{{ c.subject }}</span>
            <span class="commit-meta mono">{{ c.author }} · {{ fmtDate(c.date) }}</span>
          </li>
        </ol>
        <div v-if="result.truncated" class="muted" style="margin-top: 8px">
          仅显示最近 {{ (result.commits || []).length }} 条提交。
        </div>

        <div v-if="(result.files?.paths || []).length" class="files">
          <button class="files-toggle" @click="showFiles = !showFiles">
            {{ showFiles ? '收起文件清单' : `展开文件清单（${result.files.paths.length}）` }}
          </button>
          <ul v-if="showFiles" class="file-list mono">
            <li v-for="p in result.files.paths" :key="p">{{ p }}</li>
          </ul>
        </div>
      </div>

      <div class="card" style="margin-top: 18px">
        <div class="section-title">执行更新</div>

        <p v-if="result.blocked_reason" class="notice-text notice-block">
          {{ result.blocked_reason }}
        </p>

        <div class="plan">
          <span class="label-micro">将要执行</span>
          <div class="plan-steps">
            <span class="plan-step">拉取代码</span>
            <span class="plan-step">快进合并</span>
            <span class="plan-step" :class="{ off: !result.plan?.installServer }">安装后端依赖</span>
            <span class="plan-step" :class="{ off: !result.plan?.installWeb }">安装前端依赖</span>
            <span class="plan-step" :class="{ off: !result.plan?.buildWeb }">构建管理界面</span>
            <span class="plan-step" :class="{ off: !result.restart?.auto }">重启服务</span>
          </div>
          <div class="muted plan-hint">
            置灰的步骤本次不会执行（对应目录没有改动）。更新过程不会覆盖服务器上的本地改动。
          </div>
        </div>

        <div class="apply-bar">
          <el-button
            type="primary"
            :disabled="!result.can_update || updating"
            :loading="updating"
            @click="apply"
          >{{ applyLabel }}</el-button>
          <span v-if="!result.can_update && !updating" class="muted">当前状态不允许自动更新，原因见上。</span>
          <span v-else-if="result.restart && !result.restart.auto" class="muted">
            已禁用自动重启（UPDATE_NO_RESTART=1），更新后需手动重启。
          </span>
        </div>
      </div>
    </template>

    <!-- 更新过程与结果 -->
    <div v-if="applyResult" class="card" style="margin-top: 18px">
      <div class="section-title">{{ applyTitle }}</div>
      <ul class="steps">
        <li v-for="(s, i) in applyResult.steps || []" :key="i" :class="['step', s.ok ? 'step-ok' : 'step-fail']">
          <span class="step-mark mono">{{ s.ok ? '✓' : '✕' }}</span>
          <span class="step-name">{{ s.name }}</span>
          <span class="step-detail mono">{{ s.detail }}</span>
        </li>
      </ul>

      <pre v-if="applyResult.ok === false" class="notice-text notice-block err-detail">{{ applyResult.message }}</pre>
      <p v-if="applyResult.ok === false && applyResult.merged_to" class="notice-text">
        代码已合并到 <b class="mono">{{ applyResult.merged_to }}</b>，只是后续步骤没跑完。
        修掉上面的问题后重新点「{{ isResume ? '补做部署' : '立即更新' }}」即可继续，不用担心重复合并。
      </p>

      <p v-if="restarting" class="notice-text">
        正在等待服务重启（{{ waitedSeconds }}s）… 重启期间本页面会短暂失去响应。
      </p>
      <p v-else-if="restarted" class="notice-text notice-ok-text">
        服务已重启，新版本 {{ applyResult.to }} 已生效。
      </p>
      <p v-else-if="restartTimedOut" class="notice-text notice-block">
        等待超时。请到服务器确认服务状态：<span class="mono">systemctl status {{ applyResult.restart?.unit || 'ai-gateway' }}</span>
      </p>

      <div v-if="applyResult.ok" class="apply-bar">
        <el-button size="small" @click="reloadPage">刷新页面</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'

const result = ref(null)
const checking = ref(false)
const checkedAt = ref('')
const showFiles = ref(false)

const updating = ref(false)
const applyResult = ref(null)
const restarting = ref(false)
const restarted = ref(false)
const restartTimedOut = ref(false)
const waitedSeconds = ref(0)

const current = computed(() => result.value?.current || {})
const latest = computed(() => result.value?.latest || {})
const branch = computed(() => result.value?.branch || '')
const behindCount = computed(() => result.value?.behind || 0)

const stateLabel = computed(() => {
  if (checking.value) return '检查中'
  if (!result.value) return '未检查'
  if (result.value.ok === false) return '检查失败'
  if (!result.value.has_update) return '已是最新'
  return result.value.can_update ? '有新版本' : '需人工处理'
})

const stateBadge = computed(() => {
  if (checking.value || !result.value) return 'badge-gray'
  if (result.value.ok === false) return 'badge-amber'
  if (!result.value.has_update) return 'badge-green'
  return result.value.can_update ? 'badge-red' : 'badge-amber'
})

const stateDot = computed(() => {
  if (checking.value || !result.value) return 'gray'
  if (result.value.ok === false) return 'amber'
  if (!result.value.has_update) return 'green'
  return result.value.can_update ? 'red' : 'amber'
})

const applyTitle = computed(() => {
  if (!applyResult.value) return ''
  if (restarting.value) return '更新中'
  if (applyResult.value.ok === false) return '更新失败'
  if (applyResult.value.up_to_date) return '无需更新'
  return applyResult.value.resumed ? '部署完成' : '更新完成'
})

// 合并成功但没部署完时，这次要做的只是「补做后续步骤」，按钮上就该这么说
const isResume = computed(() => Boolean(result.value?.stale_deploy && !result.value?.behind))

const applyLabel = computed(() => {
  if (updating.value) return '更新中…'
  return isResume.value ? '补做部署' : '立即更新'
})

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function check(force = false) {
  checking.value = true
  try {
    result.value = await api.checkUpdate(force)
    checkedAt.value = new Date().toLocaleTimeString('zh-CN')
    showFiles.value = false
  } catch (e) {
    ElMessage.error(e?.message || '检查更新失败')
  } finally {
    checking.value = false
  }
}

/** 当前进程的存活秒数。重启后这个值会变小，用它来判断「真的换了新进程」。 */
async function readUptime() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' })
    if (!r.ok) return null
    const d = await r.json()
    return Number.isFinite(Number(d?.uptime)) ? Number(d.uptime) : null
  } catch {
    return null
  }
}

/**
 * 等待重启完成。
 * 只看 /api/health 能不能通是不够的——重启刚下发时旧进程还在应答，
 * 会被误判成「已经回来了」。必须等到 uptime 比重启前更小，才证明是新进程。
 */
async function waitForRestart(prevUptime, maxMs = 120000) {
  const started = Date.now()
  await sleep(1200)
  while (Date.now() - started < maxMs) {
    waitedSeconds.value = Math.round((Date.now() - started) / 1000)
    const up = await readUptime()
    if (up !== null && (prevUptime === null || up < prevUptime)) return true
    await sleep(1500)
  }
  return false
}

async function apply() {
  try {
    await ElMessageBox.confirm(
      isResume.value
        ? '上次更新在合并之后中断了。这次会把没跑完的步骤（安装依赖 / 构建）补上，完成后重启服务。确定继续？'
        : `将从上游拉取 ${behindCount.value} 个提交的更新，并在完成后重启服务（期间管理界面会短暂中断）。确定继续？`,
      isResume.value ? '确认补做部署' : '确认更新',
      { confirmButtonText: isResume.value ? '开始补做' : '开始更新', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }

  const prevUptime = await readUptime()
  updating.value = true
  applyResult.value = null
  restarted.value = false
  restartTimedOut.value = false
  waitedSeconds.value = 0

  try {
    applyResult.value = await api.applyUpdate()
  } catch (e) {
    ElMessage.error(e?.message || '更新失败')
    updating.value = false
    return
  }
  updating.value = false

  if (!applyResult.value.ok) {
    ElMessage.error('更新失败，详情见下方步骤')
    // 失败可能发生在合并之后——那时代码已经进来了，状态变了，必须重新比对，
    // 否则界面还停在「有新版本」，下次点「立即更新」会报「已是最新」，
    // 而那个提交其实一直没部署上去。
    await check(true)
    return
  }
  if (applyResult.value.up_to_date) {
    ElMessage.success('已是最新版本')
    await check(true)
    return
  }

  ElMessage.success('代码已更新')
  if (applyResult.value.restart?.ok) {
    restarting.value = true
    const ok = await waitForRestart(prevUptime)
    restarting.value = false
    restarted.value = ok
    restartTimedOut.value = !ok
    if (ok) await check(true)
  } else {
    restartTimedOut.value = false
  }
}

function reloadPage() {
  location.reload()
}

onMounted(() => check(false))
</script>

<style scoped>
/* ---------- 版本对照 ---------- */
.ver-head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 20px;
  align-items: center;
}

.ver-side { min-width: 0; }
.ver-side-right { text-align: right; }

.ver-sha {
  font-size: 22px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -0.01em;
  line-height: 1.3;
}

.ver-line {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-4);
  margin-top: 1px;
}

.ver-subject {
  font-size: 12.5px;
  color: var(--ink-2);
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ver-mid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
}

.ver-behind {
  font-size: 10.5px;
  color: var(--accent);
}

.ver-foot {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ver-foot-text {
  font-size: 11px;
  color: var(--ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 提示块 ---------- */
.notice { margin-top: 18px; }

.notice-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}

.notice-text {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink-2);
  margin: 0;
}
.notice-text b { color: var(--ink); }

.notice-ok .notice-title { color: var(--ok); }
.notice-ok-text { color: var(--ok); }

.notice-warn .notice-title { color: var(--warn); }

.notice-block {
  color: var(--accent);
  margin-top: 10px;
}

.notice-code {
  margin-top: 10px;
  padding: 9px 11px;
  background: var(--paper-sunk);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-sm);
  font-size: 11.5px;
  color: var(--ink-2);
  word-break: break-all;
}

/* ---------- 更新内容 ---------- */
.areas {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
}

.areas-total {
  font-size: 11px;
  color: var(--ink-4);
  margin-left: 4px;
}

.commits {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--rule-soft);
}

.commit {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  gap: 12px;
  align-items: baseline;
  padding: 9px 2px;
  border-bottom: 1px solid var(--rule-soft);
}

.commit-sha {
  font-size: 11.5px;
  color: var(--accent);
}

.commit-subject {
  font-size: 13px;
  color: var(--ink);
  min-width: 0;
  word-break: break-word;
}

.commit-meta {
  font-size: 10.5px;
  color: var(--ink-4);
  white-space: nowrap;
}

.files { margin-top: 12px; }

.files-toggle {
  border: 1px solid var(--rule);
  background: var(--surface);
  color: var(--ink-3);
  border-radius: var(--r-xs);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.14s, border-color 0.14s;
}
.files-toggle:hover { color: var(--accent); border-color: var(--accent-line); }

.file-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 10px 12px;
  background: var(--paper-sunk);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-sm);
  font-size: 11.5px;
  color: var(--ink-2);
  max-height: 240px;
  overflow: auto;
}
.file-list li { padding: 1px 0; }

/* ---------- 执行更新 ---------- */
.plan { margin-bottom: 16px; }

.plan-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.plan-step {
  font-size: 11.5px;
  color: var(--ink-2);
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  padding: 2px 8px;
  background: var(--surface);
}

.plan-step.off {
  color: var(--ink-4);
  border-style: dashed;
  text-decoration: line-through;
  text-decoration-color: var(--ink-4);
}

.plan-hint {
  margin-top: 7px;
  font-size: 11px;
}

.apply-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* ---------- 步骤日志 ---------- */
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--rule-soft);
}

.step {
  display: grid;
  grid-template-columns: 18px 132px 1fr;
  gap: 10px;
  align-items: baseline;
  padding: 8px 2px;
  border-bottom: 1px solid var(--rule-soft);
  font-size: 12.5px;
}

.step-mark { font-size: 12px; }
.step-ok .step-mark { color: var(--ok); }
.step-fail .step-mark { color: var(--accent); }

.step-name { color: var(--ink); }
.step-detail {
  font-size: 11px;
  color: var(--ink-3);
  word-break: break-word;
  /* 失败详情是多行的命令输出，压成一行就看不出所以然了 */
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}
.step-fail .step-detail { color: var(--accent); }

/* 失败原因：npm / git 的原始输出，保留换行与缩进，过长可滚 */
.err-detail {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
  padding: 10px 12px;
  background: var(--surface-2);
  border-radius: var(--r-xs);
}

/* 这里的过渡只做颜色渐入，关掉不丢任何信息 */
@media (prefers-reduced-motion: reduce) {
  .files-toggle { transition: none; }
}

@media (max-width: 900px) {
  .ver-head { grid-template-columns: 1fr; gap: 14px; }
  .ver-side-right { text-align: left; }
  .ver-mid { flex-direction: row; justify-content: flex-start; padding: 0; }
  .commit { grid-template-columns: 64px 1fr; }
  .commit-meta { grid-column: 2; }
  .step { grid-template-columns: 18px 1fr; }
  .step-detail { grid-column: 2; }
}
</style>
