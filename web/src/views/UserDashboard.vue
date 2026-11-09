<template>
  <div v-loading="loading" class="user-dash">
    <!-- 余额台账：整页主角，数字用等宽字，发丝线分格，不用渐变卡片 -->
    <div class="card panel-tick balance-hero">
      <div class="balance-grid">
        <div class="balance-cell">
          <div class="label-micro">剩余余额 · Available balance</div>
          <div class="balance-num num" :class="{ alarm: data.balance && data.balance.micro <= 0 }">
            {{ data.balance ? data.balance.value : '0' }}<span class="balance-unit">{{ data.balance?.unit || '点' }}</span>
          </div>
          <div class="balance-sub mono">
            账户 <b>{{ data.account?.username || '—' }}</b> · {{ data.balance?.currency || 'POINT' }}
          </div>
        </div>
        <div class="balance-cell balance-cell-pricing">
          <div class="label-micro">当前计价 · Pricing</div>
          <div class="pricing-line mono">{{ data.pricing?.price_per_1k_tokens_display || '— / 1K tokens' }}</div>
          <div class="pricing-line mono">{{ data.pricing?.request_fee_display || '— / 次' }}</div>
          <div class="pricing-foot">按实际 token 用量结算，失败请求不扣费；余额为 0 时调用会被拦下。</div>
        </div>
        <div class="balance-cell balance-cell-meta">
          <div class="label-micro">调用状态 · Call status</div>
          <div class="status-block">
            <span :class="['badge', callReady ? 'badge-green' : 'badge-gray']">
              <span class="badge-dot" :class="callReady ? 'green' : 'gray'"></span>{{ callReady ? '可调用' : '待开通' }}
            </span>
          </div>
          <div class="pricing-foot">需要同时具备：已充值余额 + 一把有效调用密钥。</div>
        </div>
      </div>
    </div>

    <!-- 指标台账：与管理员仪表盘同一套发丝线网格 -->
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">累计请求</div>
        <div class="metric-value num">{{ fmt(data.usage?.requests) }}</div>
        <div class="metric-foot mono">当前密钥</div>
      </div>
      <div class="metric">
        <div class="metric-label">失败请求</div>
        <div class="metric-value num" :class="{ alarm: (data.usage?.failed || 0) > 0 }">{{ fmt(data.usage?.failed) }}</div>
        <div class="metric-foot mono">含上游与网关错误</div>
      </div>
      <div class="metric">
        <div class="metric-label">累计 Token</div>
        <div class="metric-value num">{{ fmt(data.usage?.tokens) }}</div>
        <div class="metric-foot mono">计费依据</div>
      </div>
      <div class="metric">
        <div class="metric-label">可用模型</div>
        <div class="metric-value num">{{ fmt(data.total_models) }}</div>
        <div class="metric-foot mono">平台已启用</div>
      </div>
    </div>

    <!-- 调用密钥：最初无密钥 → 空态；有密钥 → 遮罩 + 一次明文 -->
    <div class="section-head">
      <div class="section-title">调用密钥</div>
      <span class="label-micro">{{ data.key ? '1 / 1 把' : '0 / 1 把' }}</span>
    </div>

    <div v-if="!data.key" class="card empty-key">
      <div class="empty-mark">KEY</div>
      <div class="empty-title">还没有调用密钥</div>
      <p class="empty-desc">
        新账号初始没有密钥，这是有意的：先确认余额，再由你自己生成一把专属密钥。<br />
        生成后明文<strong>只显示这一次</strong>，服务端只保存 SHA-256 摘要，丢了只能轮换。
      </p>
      <el-button type="primary" :loading="keyBusy" @click="generateKey">生成我的调用密钥</el-button>
    </div>

    <div v-else class="card key-card">
      <div class="key-row">
        <div class="key-field">
          <div class="conn-label">密钥名称</div>
          <div class="conn-value">{{ data.key.name }}</div>
        </div>
        <div class="key-field">
          <div class="conn-label">可辨识前缀</div>
          <div class="conn-value mono">{{ data.key.key_preview }}</div>
        </div>
        <div class="key-field">
          <div class="conn-label">状态</div>
          <div>
            <span :class="['badge', data.key.state === 'active' ? 'badge-green' : 'badge-gray']">
              <span class="badge-dot" :class="data.key.state === 'active' ? 'green' : 'gray'"></span>{{ stateLabel(data.key.state) }}
            </span>
          </div>
        </div>
        <div class="key-field">
          <div class="conn-label">创建时间</div>
          <div class="conn-value mono">{{ formatTime(data.key.created_at) }}</div>
        </div>
      </div>
      <div class="key-actions">
        <el-button plain size="small" :loading="keyBusy" @click="rotateKey">轮换密钥</el-button>
        <el-button plain size="small" type="danger" :loading="keyBusy" @click="removeKey">删除密钥</el-button>
        <button type="button" class="link-btn" @click="refresh">刷新数据</button>
      </div>
      <p class="key-note">轮换或删除后，旧密钥立即失效；轮换会返回一把新的明文密钥。</p>
    </div>

    <!-- 明文只出现一次的对话框：不落 localStorage、不复制进日志 -->
    <el-dialog v-model="tokenVisible" title="保存这把调用密钥" width="520px" :close-on-click-modal="false" append-to-body>
      <p class="gate-hint">明文只显示这一次。关掉对话框后就再也取不到，请现在复制并存入你的密码管理器。</p>
      <div class="token-box mono">{{ oneTimeToken }}</div>
      <div class="token-actions">
        <el-button type="primary" plain @click="copyText(oneTimeToken)">复制密钥</el-button>
        <el-button @click="tokenVisible = false">我已保存</el-button>
      </div>
    </el-dialog>

    <!-- 接入必需信息：Base URL / 协议 / 模型 / 示例命令 -->
    <div class="section-head">
      <div class="section-title">接入必需信息</div>
      <span class="label-micro">OpenAI 兼容</span>
    </div>
    <div class="card">
      <div class="conn-grid">
        <div class="conn-item">
          <div class="conn-label">Base URL（推荐）</div>
          <div class="conn-value mono ellipsis" :title="data.base_url">{{ data.base_url || '—' }}</div>
          <button type="button" class="copy-mini" @click="copyText(data.base_url)">复制</button>
        </div>
        <div class="conn-item">
          <div class="conn-label">Base URL（备用）</div>
          <div class="conn-value mono ellipsis" :title="data.api_v1_url">{{ data.api_v1_url || '—' }}</div>
          <button type="button" class="copy-mini" @click="copyText(data.api_v1_url)">复制</button>
        </div>
        <div class="conn-item">
          <div class="conn-label">我的 API Key</div>
          <div class="conn-value mono ellipsis">{{ data.key ? data.key.key_preview : '未生成 · 见上方空态' }}</div>
          <button v-if="oneTimeToken" type="button" class="copy-mini" @click="copyText(oneTimeToken)">复制明文</button>
        </div>
        <div class="conn-item">
          <div class="conn-label">协议</div>
          <div class="conn-value">{{ data.protocol || 'OpenAI 兼容' }}</div>
        </div>
      </div>

      <div class="sample-block">
        <div class="conn-label">最小调用示例（把 <code class="mono">$GW_KEY</code> 换成刚保存的明文）</div>
        <pre class="sample-code mono">{{ curlSample }}</pre>
        <button type="button" class="copy-mini sample-copy" @click="copyText(curlSample)">复制命令</button>
      </div>

      <div v-if="data.available_models?.length" class="model-strip">
        <span class="label-micro">可用模型</span>
        <span v-for="m in data.available_models.slice(0, 12)" :key="m" class="model-chip mono">{{ m }}</span>
        <span v-if="data.available_models.length > 12" class="model-chip mono">+{{ data.available_models.length - 12 }}</span>
      </div>
      <div v-else class="muted model-empty">管理员还没有启用任何平台/模型，余额与密钥就绪后请联系管理员配置上游。</div>
    </div>

    <!-- 余额流水：倒序台账，空态也是真设计 -->
    <div class="section-head">
      <div class="section-title">余额流水</div>
      <span class="label-micro">最近 {{ data.ledger?.length || 0 }} 条</span>
    </div>
    <div class="card ledger-card">
      <div v-if="!data.ledger?.length" class="empty-state">
        <div class="empty-mark">LEDGER</div>
        <div class="empty-title">还没有余额变动</div>
        <div class="empty-desc">管理员充值、以及每次 API 调用扣费，都会在这里留一条可核对的记录。</div>
      </div>
      <div v-else class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 150px">时间</th>
              <th style="width: 110px">类型</th>
              <th class="right" style="width: 150px">变动</th>
              <th class="right" style="width: 150px">变动后余额</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in data.ledger" :key="e.id">
              <td class="mono cell-dim">{{ formatTime(e.at) }}</td>
              <td><span :class="['badge', ledgerBadge(e.type)]">{{ ledgerLabel(e.type) }}</span></td>
              <td class="right mono" :class="e.delta_micro > 0 ? 'credit' : 'debit'">{{ e.delta_display }}</td>
              <td class="right mono cell-dim">{{ e.balance_display }}</td>
              <td>
                <span class="cell-dim">{{ e.note || '—' }}</span>
                <span v-if="e.model" class="cell-dim"> · {{ e.model }}</span>
                <span v-if="e.actor" class="cell-dim"> · 操作人 {{ e.actor }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { notifyError } from '../api.js'

const loading = ref(false)
const keyBusy = ref(false)
const loadError = ref('')
const data = ref({
  account: null,
  balance: null,
  key: null,
  key_state: 'empty',
  usage: { requests: 0, failed: 0, tokens: 0 },
  base_url: '',
  api_v1_url: '',
  protocol: '',
  available_models: [],
  total_models: 0,
  pricing: null,
  ledger: [],
  micros_per_unit: 1_000_000
})

const tokenVisible = ref(false)
const oneTimeToken = ref('')

const callReady = computed(() => Boolean(data.value.key && data.value.key.state === 'active' && (data.value.balance?.micro || 0) > 0))
const curlSample = computed(() => {
  const model = data.value.available_models?.[0] || '<MODEL_ID>'
  return `curl ${data.value.base_url || '<BASE_URL>'}/chat/completions \\\n  -H "Authorization: Bearer $GW_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`
})

function fmt(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0)
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function stateLabel(s) {
  return { active: '生效中', disabled: '已停用', expired: '已过期' }[s] || s || '未知'
}

function ledgerLabel(t) {
  return { topup: '充值', consume: '调用扣费', adjust: '调整' }[t] || t
}

function ledgerBadge(t) {
  return t === 'topup' ? 'badge-green' : (t === 'consume' ? 'badge-purple' : 'badge-gray')
}

async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(String(text))
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选中复制')
  }
}

function applyPayload(payload) {
  if (payload && typeof payload === 'object') data.value = { ...data.value, ...payload }
}

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    applyPayload(await api.getUserDashboard())
  } catch (e) {
    loadError.value = e?.message || '加载仪表盘失败'
    if (e?.status !== 401) notifyError(e, '加载仪表盘失败')
  } finally {
    loading.value = false
  }
}

async function generateKey() {
  keyBusy.value = true
  try {
    const out = await api.createUserKey({})
    oneTimeToken.value = out.token || ''
    applyPayload(out.dashboard)
    tokenVisible.value = true
    ElMessage.success('调用密钥已生成，请立即保存明文')
  } catch (e) {
    notifyError(e, '生成密钥失败')
  } finally {
    keyBusy.value = false
  }
}

async function rotateKey() {
  if (!data.value.key) return
  try {
    await ElMessageBox.confirm('轮换后旧密钥立即失效，正在使用它的客户端会立刻报 401。确定继续？', '轮换调用密钥', {
      type: 'warning', confirmButtonText: '轮换并生成新密钥', cancelButtonText: '取消'
    })
  } catch {
    return
  }
  keyBusy.value = true
  try {
    const out = await api.rotateUserKey(data.value.key.id)
    oneTimeToken.value = out.token || ''
    applyPayload(out.dashboard)
    tokenVisible.value = true
    ElMessage.success('已轮换，请保存新的明文密钥')
  } catch (e) {
    notifyError(e, '轮换失败')
  } finally {
    keyBusy.value = false
  }
}

async function removeKey() {
  if (!data.value.key) return
  try {
    await ElMessageBox.confirm('删除后这把密钥立即失效，余额与流水会保留。需要时可以在空态里重新生成。', '删除调用密钥', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch {
    return
  }
  keyBusy.value = true
  try {
    const out = await api.deleteUserKey(data.value.key.id)
    oneTimeToken.value = ''
    applyPayload(out.dashboard)
    ElMessage.success('调用密钥已删除')
  } catch (e) {
    notifyError(e, '删除失败')
  } finally {
    keyBusy.value = false
  }
}

let timer = null
onMounted(() => {
  refresh()
  // 余额随调用实时变化，10 秒轻轮询；明文对话框开着时不抢焦点、不覆盖一次明文
  timer = setInterval(() => { if (!tokenVisible.value) refresh() }, 10000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
/* 方向：精密仪表 · 暖白。发丝线分格 + 等宽数字 + 朱砂唯一强调色。
   复用 styles.css 的 --paper / --ink / --accent / .card / .data-table / .badge 等全局 token。 */
.user-dash { padding-bottom: 8px; }

.balance-hero { padding: 0; }
.balance-grid {
  display: grid;
  grid-template-columns: 1.35fr 1fr 1fr;
  gap: 0;
}
.balance-cell {
  padding: 20px 22px 18px;
  border-right: 1px solid var(--rule-soft);
  min-width: 0;
}
.balance-cell:last-child { border-right: none; }
.balance-num {
  margin-top: 10px;
  font-size: 38px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.03em;
  color: var(--ink);
}
.balance-unit {
  margin-left: 8px;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--ink-3);
  font-family: var(--font-sans);
}
.balance-sub { margin-top: 8px; font-size: 11.5px; color: var(--ink-3); }
.balance-sub b { color: var(--ink-2); font-weight: 600; }
.pricing-line { margin-top: 10px; font-size: 13px; color: var(--ink-2); line-height: 1.5; }
.pricing-foot { margin-top: 10px; font-size: 11.5px; line-height: 1.7; color: var(--ink-3); }
.status-block { margin-top: 12px; }

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
.metric-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--ink-3); }
.metric-value { margin-top: 6px; font-size: 24px; font-weight: 650; line-height: 1.2; color: var(--ink); letter-spacing: -0.02em; }
.metric-foot { margin-top: 5px; font-size: 11px; color: var(--ink-3); }

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 24px 0 10px;
}

.empty-key {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 34px 22px 30px;
  border-style: dashed;
}
.empty-mark {
  min-width: 52px;
  height: 40px;
  padding: 0 10px;
  border: 1.5px dashed var(--rule-strong);
  border-radius: var(--r-sm);
  color: var(--ink-4);
  font-family: var(--font-mono);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.empty-title { font-size: 15.5px; font-weight: 600; margin-bottom: 8px; color: var(--ink); }
.empty-desc { color: var(--ink-3); font-size: 12.5px; line-height: 1.85; margin: 0 0 18px; max-width: 560px; }
.empty-desc strong { color: var(--ink-2); font-weight: 600; }

.key-card { padding: 16px 18px; }
.key-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 0.8fr 1fr;
  gap: 16px;
}
.key-field { min-width: 0; }
.conn-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; }
.conn-value { font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
.key-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule-soft); flex-wrap: wrap; }
.key-actions .el-button + .el-button { margin-left: 0; }
.link-btn {
  margin-left: 4px;
  border: none;
  background: none;
  padding: 6px 4px;
  color: var(--info);
  font-size: 12.5px;
  font-family: var(--font-sans);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.key-note { margin: 10px 0 0; font-size: 11.5px; color: var(--ink-3); line-height: 1.7; }

.token-box {
  padding: 14px 16px;
  background: var(--paper-sunk);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--ink);
  overflow-wrap: anywhere;
  user-select: all;
}
.token-actions { display: flex; gap: 8px; margin-top: 14px; }
.token-actions .el-button + .el-button { margin-left: 0; }

.conn-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: var(--r-sm); overflow: hidden; }
.conn-item { position: relative; background: var(--surface); padding: 12px 14px 14px; min-width: 0; }
.conn-item .conn-value { padding-right: 52px; }
.copy-mini {
  position: absolute;
  right: 12px;
  top: 12px;
  min-height: 24px;
  padding: 2px 7px;
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  background: var(--surface);
  color: var(--ink-3);
  font-size: 11px;
  font-family: var(--font-sans);
  cursor: pointer;
}
.copy-mini:hover { color: var(--accent); border-color: var(--accent-line); }

.sample-block { position: relative; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule-soft); }
.sample-code {
  margin: 8px 0 0;
  padding: 12px 14px;
  background: var(--paper-sunk);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  font-size: 12px;
  line-height: 1.75;
  color: var(--ink-2);
  overflow-x: auto;
  white-space: pre;
}
.sample-copy { position: static; display: inline-block; margin-top: 10px; }
.model-strip { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule-soft); }
.model-chip {
  padding: 3px 8px;
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  background: var(--surface-2);
  font-size: 11px;
  color: var(--ink-2);
}
.model-empty { margin: 16px 0 0; line-height: 1.7; }

.ledger-card { padding: 0; overflow: hidden; }
.ledger-card .data-table { min-width: 640px; }
.ledger-card .empty-state { border: none; padding: 36px 20px; }
.cell-dim { color: var(--ink-3); font-size: 12px; }
.credit { color: var(--ok); font-weight: 600; }
.debit { color: var(--accent); font-weight: 600; }
.gate-hint { margin: 0 0 16px; font-size: 13px; line-height: 1.75; color: var(--ink-3); }
.form-error {
  margin: 14px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  line-height: 1.6;
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
}

/* 尊重系统减弱动效：把唯一的 hover 过渡关掉，不影响任何状态可读性 */
@media (prefers-reduced-motion: reduce) {
  .metric { transition: none !important; }
  .metric:hover { background: var(--surface); }
}

@media (max-width: 1100px) {
  .balance-grid { grid-template-columns: 1fr 1fr; }
  .balance-cell:nth-child(2) { border-right: none; }
  .balance-cell:nth-child(3) { border-top: 1px solid var(--rule-soft); grid-column: 1 / -1; }
  .key-row { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 767px) {
  .balance-grid { grid-template-columns: 1fr; }
  .balance-cell { border-right: none; border-bottom: 1px solid var(--rule-soft); }
  .balance-cell:nth-child(3) { border-top: none; grid-column: auto; }
  .balance-cell:last-child { border-bottom: none; }
  .balance-num { font-size: 30px; }
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
  .metric-value { font-size: 19px; }
  .conn-grid { grid-template-columns: 1fr; }
  .key-row { grid-template-columns: 1fr; gap: 12px; }
  .section-head { margin-top: 20px; }
}
</style>
