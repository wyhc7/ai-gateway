<template>
  <div>
    <div class="tool-row">
      <span class="label-micro">{{ keys.length }} 把访问密钥</span>
      <div class="tool-actions">
        <el-button plain @click="copyText(ownerKey, '主密钥')">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
          复制主密钥
        </el-button>
        <el-button type="primary" @click="openCreate">
          <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          创建密钥
        </el-button>
      </div>
    </div>

    <!-- 主密钥说明：它不受任何模型限制，与下面的受限密钥必须区分清楚，
         否则用户会以为「给同事发了 Key」却忘了那把其实是管理员主密钥 -->
    <div class="owner-panel panel-tick">
      <div class="owner-row">
        <div>
          <div class="owner-title">主密钥<span class="badge badge-amber" style="margin-left: 8px">不受限</span></div>
          <div class="owner-desc">部署时自动生成，等同管理员，可用任意模型。对外分发请改用下面创建的子密钥。</div>
        </div>
        <code class="owner-key mono">{{ maskSecret(ownerKey) }}</code>
      </div>
      <div class="owner-row" style="margin-top: 10px">
        <div class="owner-desc">
          对接地址：<code class="mono">{{ baseUrl }}</code>（第三方客户端也可填 <code class="mono">{{ origin }}/v1</code>）
        </div>
      </div>
    </div>

    <div v-loading="loading">
      <div v-if="!loading && keys.length === 0" class="empty-state">
        <div class="empty-mark">Key</div>
        <div class="empty-title">还没有为客户端创建密钥</div>
        <div class="empty-desc">
          创建后把 Key 交给调用方，并限定它能用哪些模型。<br />
          模型范围支持精确名（<code class="mono">gpt-4o</code>）与通配（<code class="mono">gpt-*</code>、<code class="mono">*-free</code>、<code class="mono">*</code>），留空表示不限制。
        </div>
        <el-button type="primary" @click="openCreate">创建第一个密钥</el-button>
      </div>

      <div v-else class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 132px">名称</th>
              <th style="width: 160px">密钥</th>
              <th>模型范围</th>
              <th style="width: 124px">状态</th>
              <th style="width: 108px">用量</th>
              <th style="width: 112px">最近使用</th>
              <th style="width: 250px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id">
              <td>
                <div class="k-name ellipsis" :title="k.name">{{ k.name }}</div>
                <div v-if="k.note" class="k-note ellipsis" :title="k.note">{{ k.note }}</div>
              </td>
              <td><code class="mono k-secret">{{ k.key_preview }}</code></td>
              <td>
                <template v-if="k.model_scope === 'all'">
                  <span class="badge badge-blue">全部模型</span>
                </template>
                <template v-else>
                  <span class="badge badge-purple">{{ k.allowed_models.length }} 条规则</span>
                  <div class="rules">
                    <code v-for="r in k.allowed_models.slice(0, 4)" :key="r" class="mono rule-chip">{{ r }}</code>
                    <span v-if="k.allowed_models.length > 4" class="muted">+{{ k.allowed_models.length - 4 }}</span>
                  </div>
                </template>
                <div v-if="k.denied_models.length" class="rules">
                  <span class="muted">排除</span>
                  <code v-for="r in k.denied_models.slice(0, 3)" :key="r" class="mono rule-chip rule-deny">{{ r }}</code>
                </div>
              </td>
              <td>
                <span :class="['badge', stateBadge(k).cls]">
                  <span class="badge-dot" :class="stateBadge(k).dot"></span>{{ stateBadge(k).text }}
                </span>
                <div v-if="k.expires_at" class="k-note">{{ formatDate(k.expires_at) }} 到期</div>
              </td>
              <td>
                <div class="num">{{ k.usage.requests }} 次</div>
                <div class="k-note num">{{ k.usage.tokens.toLocaleString() }} tok<span v-if="k.usage.failed"> · 失败 {{ k.usage.failed }}</span></div>
              </td>
              <td class="k-note">{{ k.last_used_at ? formatTime(k.last_used_at) : '从未使用' }}</td>
              <td>
                <div class="row-actions">
                  <el-button size="small" plain @click="openEdit(k)">编辑</el-button>
                  <el-button size="small" plain @click="toggleEnabled(k)">{{ k.enabled ? '停用' : '启用' }}</el-button>
                  <el-button size="small" plain @click="rotate(k)">轮换</el-button>
                  <el-button size="small" plain type="danger" @click="remove(k)">删除</el-button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 创建 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="editing ? '编辑访问密钥' : '创建访问密钥'" width="620px" top="5vh" append-to-body>
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如：给小王 · 只用便宜模型" maxlength="60" />
        </el-form-item>

        <el-form-item>
          <template #label>
            <span>可用模型</span>
            <span class="muted" style="margin-left: 8px">留空 = 不限制；支持 * 通配，可从平台模型里直接选</span>
          </template>
          <el-select
            v-model="form.allowed_models"
            multiple
            filterable
            allow-create
            default-first-option
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="6"
            placeholder="不限制（可用全部模型）"
            style="width: 100%"
          >
            <el-option-group
              v-for="g in groupedModels"
              :key="g.provider_name"
              :label="`${g.provider_name}（${g.models.length}）`"
            >
              <el-option v-for="m in g.models" :key="m.id" :label="m.id" :value="m.id" />
            </el-option-group>
          </el-select>
          <div class="preset-row">
            <el-button size="small" plain @click="form.allowed_models = []">全部模型</el-button>
            <el-button size="small" plain @click="applyPreset('*-free')">只看免费模型</el-button>
            <el-button size="small" plain @click="applyPreset('gpt-*')">只用 gpt-*</el-button>
            <el-button size="small" plain @click="applyPresetFromEnabled()">当前平台全部模型</el-button>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span>排除模型</span>
            <span class="muted" style="margin-left: 8px">优先级高于「可用模型」，用于在放开一批后单独禁掉某个</span>
          </template>
          <el-select
            v-model="form.denied_models"
            multiple
            filterable
            allow-create
            default-first-option
            collapse-tags
            placeholder="不排除任何模型"
            style="width: 100%"
          >
            <el-option-group
              v-for="g in groupedModels"
              :key="g.provider_name"
              :label="g.provider_name"
            >
              <el-option v-for="m in g.models" :key="m.id" :label="m.id" :value="m.id" />
            </el-option-group>
          </el-select>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" placeholder="选填，例如分配给谁、用途" />
        </el-form-item>

        <el-form-item label="到期时间">
          <el-date-picker
            v-model="form.expiresAt"
            type="datetime"
            placeholder="留空表示永不过期"
            style="width: 100%"
            clearable
          />
        </el-form-item>

        <el-form-item label="状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ editing ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>

    <!-- 明文只显示一次 -->
    <el-dialog v-model="secretVisible" title="密钥创建成功" width="560px" :close-on-click-modal="false" append-to-body>
      <div class="secret-warn">
        完整密钥<strong>只显示这一次</strong>（服务端只存摘要）。请立即复制保存；丢失后只能「轮换」换一把新的。
      </div>
      <div class="secret-box">
        <code class="mono">{{ revealedToken }}</code>
      </div>
      <template #footer>
        <el-button type="primary" @click="copyText(revealedToken, '密钥')">复制密钥</el-button>
        <el-button @click="secretVisible = false">我已保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { notifyError } from '../api.js'

const loading = ref(false)
const saving = ref(false)
const keys = ref([])
const availableModels = ref([])
const ownerKey = ref('')
const baseUrl = ref('')

const dialogVisible = ref(false)
const secretVisible = ref(false)
const revealedToken = ref('')
const editing = ref(null)

const form = ref({ name: '', allowed_models: [], denied_models: [], note: '', expiresAt: null, enabled: true })

const origin = computed(() => {
  try {
    return new URL(baseUrl.value).origin
  } catch {
    return ''
  }
})

// 按平台分组展示，用户选模型时能看出这个名字来自哪个平台
const groupedModels = computed(() => {
  const map = new Map()
  for (const m of availableModels.value) {
    const name = m.provider_name || '未命名平台'
    if (!map.has(name)) map.set(name, { provider_name: name, models: [] })
    map.get(name).models.push(m)
  }
  return [...map.values()]
})

function stateBadge(k) {
  if (k.state === 'disabled') return { text: '已停用', cls: 'badge-gray', dot: 'gray' }
  if (k.state === 'expired') return { text: '已过期', cls: 'badge-red', dot: 'red' }
  return { text: '启用中', cls: 'badge-green', dot: 'green' }
}

function maskSecret(v) {
  if (!v) return '—'
  return v.length <= 12 ? '******' : `${v.slice(0, 6)}…${v.slice(-4)}`
}

function formatTime(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDate(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function copyText(text, label) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`${label}已复制`)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选择复制')
  }
}

async function load() {
  loading.value = true
  try {
    const data = await api.getApiKeys()
    keys.value = data.keys || []
    availableModels.value = data.available_models || []
    ownerKey.value = data.owner_key || ''
    baseUrl.value = data.base_url || ''
  } catch (e) {
    notifyError(e, '加载访问密钥失败')
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.value = { name: '', allowed_models: [], denied_models: [], note: '', expiresAt: null, enabled: true }
}

function openCreate() {
  editing.value = null
  resetForm()
  dialogVisible.value = true
}

function openEdit(k) {
  editing.value = k
  form.value = {
    name: k.name,
    allowed_models: [...k.allowed_models],
    denied_models: [...k.denied_models],
    note: k.note || '',
    expiresAt: k.expires_at ? new Date(k.expires_at) : null,
    enabled: k.enabled
  }
  dialogVisible.value = true
}

function applyPreset(rule) {
  const set = new Set(form.value.allowed_models)
  set.add(rule)
  form.value.allowed_models = [...set]
}

function applyPresetFromEnabled() {
  form.value.allowed_models = availableModels.value
    .filter((m) => m.enabled)
    .map((m) => m.id)
}

async function submit() {
  saving.value = true
  const payload = {
    name: form.value.name.trim(),
    allowed_models: form.value.allowed_models,
    denied_models: form.value.denied_models,
    note: form.value.note,
    enabled: form.value.enabled,
    expires_at: form.value.expiresAt ? form.value.expiresAt.getTime() : 0
  }
  try {
    if (editing.value) {
      await api.updateApiKey(editing.value.id, payload)
      ElMessage.success('已保存')
    } else {
      const out = await api.createApiKey(payload)
      revealedToken.value = out.token
      secretVisible.value = true
    }
    dialogVisible.value = false
    await load()
  } catch (e) {
    notifyError(e, '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(k) {
  try {
    await api.updateApiKey(k.id, { enabled: !k.enabled })
    await load()
  } catch (e) {
    notifyError(e)
  }
}

async function rotate(k) {
  try {
    await ElMessageBox.confirm(
      `轮换后旧密钥立即失效，使用「${k.name}」的调用方需要换成新密钥。模型范围与用量统计保留。`,
      '轮换密钥',
      { type: 'warning', confirmButtonText: '轮换', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    const out = await api.rotateApiKey(k.id)
    revealedToken.value = out.token
    secretVisible.value = true
    await load()
  } catch (e) {
    notifyError(e, '轮换失败')
  }
}

async function remove(k) {
  try {
    await ElMessageBox.confirm(`删除后使用「${k.name}」的调用方会立即收到 401，确定删除？`, '删除密钥', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await api.deleteApiKey(k.id)
    ElMessage.success('已删除')
    await load()
  } catch (e) {
    notifyError(e, '删除失败')
  }
}

onMounted(load)
</script>

<style scoped>
/* 这张表列多，必须给出真实的最小宽度：靠 width:100% 让浏览器自行压缩的话，
   「操作」列会被压到放不下四个按钮，行高立刻变得参差不齐。
   宁可窄屏横向滚动（.table-scroll 就是干这个的）。 */
.data-table { min-width: 1040px; }

.tool-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.tool-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.owner-panel {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.owner-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.owner-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  display: flex;
  align-items: center;
}
.owner-desc {
  font-size: 12.5px;
  color: var(--ink-3);
  line-height: 1.7;
  margin-top: 3px;
}
.owner-key {
  font-size: 12.5px;
  color: var(--ink-2);
  background: var(--paper-sunk);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-xs);
  padding: 4px 8px;
}

.k-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.k-note { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; white-space: nowrap; }
.k-secret { font-size: 12px; color: var(--ink-2); }

.rules {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 5px;
}
.rule-chip {
  font-size: 11px;
  background: var(--surface-2);
  border: 1px solid var(--rule-soft);
  border-radius: var(--r-xs);
  padding: 1px 5px;
  color: var(--ink-2);
  /* 模型名普遍偏长（nemotron-3.5-lightning-free），不截断的话规则一多
     整个表格的行高会被撑成两行，一屏看不到几条 */
  display: inline-block;
  max-width: 156px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.rule-deny {
  border-color: var(--accent-line);
  color: var(--accent);
}

/* 四个操作按钮必须排在一行：换行会把整张表的行高撑高一截，浏览时很碎 */
.row-actions { display: flex; gap: 6px; flex-wrap: nowrap; }
.row-actions .el-button + .el-button { margin-left: 0; }
.row-actions .el-button { padding: 5px 9px; }

.preset-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.preset-row .el-button + .el-button { margin-left: 0; }

.secret-warn {
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink-2);
  background: var(--warn-soft);
  border-left: 2px solid var(--warn);
  padding: 9px 13px;
  border-radius: 0 4px 4px 0;
  margin-bottom: 12px;
}
.secret-box {
  background: var(--paper-sunk);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  padding: 12px;
  word-break: break-all;
  font-size: 13px;
  color: var(--ink);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 56px 20px;
  background: var(--surface);
  border: 1px dashed var(--rule-strong);
  border-radius: var(--r);
}
.empty-mark {
  width: 46px;
  height: 46px;
  border: 1.5px dashed var(--rule-strong);
  border-radius: var(--r-sm);
  color: var(--ink-4);
  font-family: var(--font-mono);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.empty-title { font-size: 15.5px; font-weight: 600; margin-bottom: 8px; color: var(--ink); }
.empty-desc {
  color: var(--ink-3);
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px;
}

@media (max-width: 767px) {
  .tool-row { flex-wrap: wrap; }
  .tool-actions { margin-left: 0; flex-basis: 100%; }
  .tool-actions .el-button { flex: 1; }
}
</style>
