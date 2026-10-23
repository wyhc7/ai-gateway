<!--
  转换层账号管理（chatgpt2api 等）
  ---------------------------------------------------------------
  这个对话框解决的是最常见的误解：用户在「平台」页看到「转换层凭据 · 1」，
  以为加账号也是加 Key，结果被那一个 Key 卡住。

  两层凭据必须讲清楚：
    网关 Key（1 个）      → 网关访问转换层的凭据，全局一个
    转换层账号（N 个）    → 真正的 ChatGPT 账号池，在这里加

  加号走 OAuth PKCE：生成授权链接 → 用户在浏览器授权 → 粘回 callback URL。
  不能直接粘 access_token 就完事：裸 token 只活 10 天且没有 refresh_token，
  续不了期。OAuth 才拿得到 refresh_token（scope=offline_access）。
-->
<template>
  <el-dialog
    v-model="visible"
    title="ChatGPT 账号管理"
    width="820px"
    :close-on-click-modal="false"
    @closed="onClosed"
  >
    <div v-if="!bridgeProvider" class="ca-empty">
      <el-alert type="warning" :closable="false" show-icon>
        还没有转换层平台。请先到「添加订阅」用
        <strong>ChatGPT 网页版（chatgpt2api）· 生图</strong> 方案建一个平台，
        再回来加账号。
      </el-alert>
    </div>

    <template v-else>
      <!-- 分层说明：把「1 个 Key」和「N 个账号」的关系写在最上面 -->
      <div class="ca-layers">
        <div class="ca-layer">
          <span class="ca-layer-tag">网关凭据</span>
          <span class="ca-layer-body">
            {{ bridgeProvider.keys?.length || 0 }} 个 · 访问转换层用，<strong>全局一个就够</strong>
          </span>
        </div>
        <div class="ca-arrow">→</div>
        <div class="ca-layer is-main">
          <span class="ca-layer-tag">ChatGPT 账号池</span>
          <span class="ca-layer-body">
            {{ accounts.length }} 个 · 在这里加，<strong>加多少都不影响上面</strong>
          </span>
        </div>
      </div>

      <div class="ca-meta">
        转换层：<code>{{ bridgeInfo.base_url || bridgeProvider.base_url }}</code>
        <el-button text size="small" :loading="loading" @click="load">刷新</el-button>
      </div>

      <!-- 账号列表 -->
      <el-table v-if="accounts.length" :data="accounts" size="small" class="ca-table">
        <el-table-column prop="email" label="邮箱" min-width="220" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === '正常' ? 'success' : 'warning'" size="small">
              {{ row.status || '未知' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="额度" width="80" align="center">
          <template #default="{ row }">
            <span :class="{ 'ca-quota-low': row.quota !== null && row.quota <= 5 }">
              {{ row.quota === null ? '—' : row.quota }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="自动续期" width="110" align="center">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.refresh_token"
              placement="top"
              :content="row.access_expires_at
                ? `access_token 到期：${fmtTime(row.access_expires_at)}；过期前会自动用 refresh_token 换新`
                : '已持有 refresh_token，会自动续期'"
            >
              <el-tag type="success" size="small" effect="plain">已开启</el-tag>
            </el-tooltip>
            <el-tooltip
              v-else
              placement="top"
              content="没有 refresh_token，access_token 过期后需要重新授权。请用 OAuth 重新加一次这个账号"
            >
              <el-tag type="danger" size="small" effect="plain">未开启</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="到期" width="150">
          <template #default="{ row }">
            <span class="ca-muted">{{ row.access_expires_at ? fmtTime(row.access_expires_at) : '—' }}</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="ca-empty">
        <el-empty description="账号池是空的，下面的「OAuth 授权加号」开一个" :image-size="70" />
      </div>

      <!-- 加号区 -->
      <el-divider content-position="left">OAuth 授权加号（推荐）</el-divider>

      <el-steps :active="step" simple class="ca-steps">
        <el-step title="生成链接" />
        <el-step title="浏览器授权" />
        <el-step title="粘回 callback" />
      </el-steps>

      <div class="ca-flow">
        <el-form label-width="88px" size="small">
          <el-form-item label="账号邮箱提示">
            <el-input
              v-model="emailHint"
              placeholder="可选；填了会在授权页默认带出这个邮箱"
              clearable
            />
          </el-form-item>
        </el-form>

        <div class="ca-actions">
          <el-button type="primary" :loading="starting" @click="startOauth">
            {{ authorizeUrl ? '重新生成授权链接' : '生成授权链接' }}
          </el-button>
          <span v-if="authorizeUrl" class="ca-muted">
            有效期 {{ expiresIn }} 秒
          </span>
        </div>

        <template v-if="authorizeUrl">
          <div class="ca-field-label">第 1 步 · 在浏览器打开这条链接并点 Authorize</div>
          <div class="ca-urlbox">
            <a :href="authorizeUrl" target="_blank" rel="noopener noreferrer" class="ca-url">{{ authorizeUrl }}</a>
            <el-button text size="small" @click="copyUrl">复制</el-button>
          </div>
          <div class="ca-hint">
            必须用<strong>已经登录目标 ChatGPT 账号</strong>的浏览器打开。
            如果你的浏览器和这台服务器不在同一网络也没关系，链接是 auth.openai.com 的。
          </div>

          <div class="ca-field-label">第 2 步 · 授权后页面会跳到 platform.openai.com/auth/callback?...（打不开是正常的），把地址栏整条粘到下面</div>
          <el-input
            v-model="callback"
            type="textarea"
            :rows="3"
            placeholder="https://platform.openai.com/auth/callback?code=ac_...&state=..."
          />
          <div class="ca-actions">
            <el-button type="success" :loading="finishing" @click="finishOauth">完成加号</el-button>
            <el-button text @click="resetFlow">清空重来</el-button>
          </div>
        </template>
      </div>

      <el-collapse class="ca-collapse">
        <el-collapse-item title="备用：直接粘贴 access_token（不会自动续期）" name="manual">
          <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 10px">
            裸 access_token 只活 10 天，且<strong>拿不到 refresh_token</strong>，
            到期后要重新抓一次。只在临时试一下时用，长期请走上面的 OAuth。
          </el-alert>
          <el-input
            v-model="manualTokens"
            type="textarea"
            :rows="3"
            placeholder="eyJhbGciOi... 一行一个"
          />
          <div class="ca-actions">
            <el-button :loading="importing" @click="importManual">导入</el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  provider: { type: Object, default: null }
})
const emit = defineEmits(['update:modelValue', 'changed'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const bridgeProvider = computed(() => props.provider || null)
const providerId = computed(() => props.provider?.id || '')

const accounts = ref([])
const bridgeInfo = ref({})
const loading = ref(false)

const step = ref(0)
const emailHint = ref('')
const starting = ref(false)
const authorizeUrl = ref('')
const sessionId = ref('')
const expiresIn = ref('600')
const callback = ref('')
const finishing = ref(false)

const manualTokens = ref('')
const importing = ref(false)

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  if (!providerId.value) return
  loading.value = true
  try {
    const data = await api.getChatgptAccounts(providerId.value)
    accounts.value = data?.accounts || []
    bridgeInfo.value = data?.provider || {}
  } catch (e) {
    ElMessage.error(e?.message || '读取账号池失败')
    accounts.value = []
  } finally {
    loading.value = false
  }
}

async function startOauth() {
  starting.value = true
  try {
    const data = await api.startChatgptOauth(providerId.value, emailHint.value.trim())
    authorizeUrl.value = data?.authorize_url || ''
    sessionId.value = data?.session_id || ''
    expiresIn.value = data?.expires_in || '600'
    callback.value = ''
    step.value = 1
    if (!authorizeUrl.value) {
      ElMessage.error('转换层没返回授权链接')
    }
  } catch (e) {
    ElMessage.error(e?.message || '生成授权链接失败')
  } finally {
    starting.value = false
  }
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(authorizeUrl.value)
    ElMessage.success('已复制授权链接')
  } catch {
    ElMessage.warning('浏览器不让自动复制，请手动选中链接复制')
  }
}

async function finishOauth() {
  const cb = callback.value.trim()
  if (!cb) return ElMessage.warning('请先粘贴 callback URL')
  if (!cb.startsWith('https://platform.openai.com/auth/callback')) {
    return ElMessage.warning('callback 应以 https://platform.openai.com/auth/callback 开头')
  }
  finishing.value = true
  try {
    const data = await api.finishChatgptOauth(providerId.value, sessionId.value, cb)
    const list = data?.accounts || []
    const fresh = list.find((a) => a.refresh_token)
    ElMessage.success(fresh
      ? `加号成功：${fresh.email || '(未知邮箱)'}，已拿到 refresh_token，之后自动续期`
      : '加号成功')
    resetFlow()
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e?.message || '兑换 token 失败')
    step.value = 2
  } finally {
    finishing.value = false
  }
}

function resetFlow() {
  authorizeUrl.value = ''
  sessionId.value = ''
  callback.value = ''
  step.value = 0
}

async function importManual() {
  const tokens = manualTokens.value.split('\n').map((s) => s.trim()).filter(Boolean)
  if (!tokens.length) return ElMessage.warning('请先粘贴 access_token')
  importing.value = true
  try {
    const data = await api.importChatgptAccounts(providerId.value, tokens)
    ElMessage.success(`已导入 ${data?.added ?? tokens.length} 个账号（不会自动续期）`)
    manualTokens.value = ''
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e?.message || '导入失败')
  } finally {
    importing.value = false
  }
}

function onClosed() {
  resetFlow()
  accounts.value = []
}

// 每次打开都拉一次，避免显示别的平台残留的账号
async function open() {
  await load()
}
defineExpose({ open, load })
</script>

<style scoped>
.ca-layers {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #f7f8fa;
  border-radius: 8px;
  margin-bottom: 12px;
}
.ca-layer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ca-layer.is-main .ca-layer-tag {
  color: #1a7f37;
}
.ca-layer-tag {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
}
.ca-layer-body {
  font-size: 12px;
  color: #303133;
}
.ca-arrow {
  color: #c0c4cc;
  font-size: 16px;
}
.ca-meta {
  font-size: 12px;
  color: #909399;
  margin-bottom: 10px;
}
.ca-meta code {
  background: #f4f4f5;
  padding: 1px 6px;
  border-radius: 3px;
}
.ca-table {
  margin-bottom: 8px;
}
.ca-muted {
  color: #909399;
  font-size: 12px;
}
.ca-quota-low {
  color: #e6a23c;
  font-weight: 600;
}
.ca-empty {
  padding: 6px 0 12px;
}
.ca-steps {
  margin-bottom: 14px;
}
.ca-flow {
  padding: 4px 2px 0;
}
.ca-field-label {
  font-size: 12px;
  color: #606266;
  margin: 12px 0 6px;
}
.ca-urlbox {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  background: #fafafa;
  border: 1px solid #ebeef5;
  border-radius: 6px;
}
.ca-url {
  flex: 1;
  font-size: 12px;
  color: #409eff;
  word-break: break-all;
  text-decoration: none;
}
.ca-url:hover {
  text-decoration: underline;
}
.ca-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 6px;
  line-height: 1.7;
}
.ca-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0 4px;
}
.ca-collapse {
  margin-top: 16px;
}
</style>
