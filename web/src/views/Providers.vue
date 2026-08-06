<template>
  <div>
    <div style="display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-bottom: 16px">
      <el-button type="primary" @click="openCreateDialog">
        <svg style="margin-right: 5px" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        添加平台
      </el-button>
      <el-button type="success" plain @click="exportProviders">
        <svg style="margin-right: 5px" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
        导出
      </el-button>
      <el-button type="info" plain @click="triggerImport">
        <svg style="margin-right: 5px" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        导入
      </el-button>
      <input ref="importInput" type="file" accept=".json" style="display: none" @change="importProviders" />
    </div>

    <div v-loading="loading" style="display: flex; flex-direction: column; gap: 14px">
      <div v-if="!loading && providers.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.3 7l8.7 5 8.7-5" /><path d="M12 22V12" />
          </svg>
        </div>
        <div class="empty-title">还没有任何平台</div>
        <div class="empty-desc">点击「添加平台」，选择接口格式（OpenAI Chat / Responses / Anthropic），填入 API 地址与 Token 即可接入。<br />支持拉取模型列表、一个平台配置多个 Key，自动限流切换。</div>
        <el-button type="primary" @click="openCreateDialog">添加第一个平台</el-button>
      </div>
      <div v-for="p in providers" :key="p.id" class="provider-card">
        <div class="provider-head" @click="toggle(p)">
          <div :class="['provider-avatar', !p.enabled && 'offline']">{{ p.name.charAt(0).toUpperCase() }}</div>
          <div class="provider-info">
            <div class="name">
              {{ p.name }}
              <span class="badge badge-blue">{{ protocolLabel(p.protocol) }}</span>
              <span v-if="isCustomCallPlan(p)" class="badge badge-purple">自定义调用方案</span>
              <span :class="['badge', p.enabled ? 'badge-green' : 'badge-gray']">
                <span class="badge-dot" :class="p.enabled ? 'green' : 'gray'"></span>{{ p.enabled ? '启用' : '停用' }}
              </span>
              <span v-if="cooldownKeys(p).length > 0" class="badge badge-red">{{ cooldownKeys(p).length }} 个 Key 冷却中</span>
            </div>
            <div class="url">{{ p.base_url }}</div>
          </div>
          <div class="provider-stats">
            <div class="stat"><div class="num">{{ p.keys.length }}</div><div class="label">Key</div></div>
            <div class="stat"><div class="num">{{ p.models.length }}</div><div class="label">模型</div></div>
          </div>
          <el-icon style="color: var(--text-muted); transition: transform 0.2s; flex-shrink: 0" :style="{ transform: expandedId === p.id ? 'rotate(180deg)' : '' }">
            <ArrowDown />
          </el-icon>
        </div>

        <el-collapse-transition>
          <div v-show="expandedId === p.id" class="provider-expand" style="border-top: 1px solid var(--border-soft)">
            <el-row :gutter="20">
              <el-col :xs="24" :md="14">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
                  <span class="section-title" style="margin-bottom: 0">API Keys · {{ p.keys.length }}</span>
                  <el-button size="small" type="primary" plain @click="openAddKeyDialog(p)">添加 Key</el-button>
                </div>
                <div v-if="p.keys.length === 0" class="muted" style="padding: 14px 0">尚未配置 Key，点击右上角添加。</div>
                <div v-for="k in p.keys" :key="k.id" class="key-item">
                  <span class="badge-dot" :class="keyDot(k)"></span>
                  <span class="key-name">{{ k.name }}</span>
                  <span class="mask">{{ k.api_key }}</span>
                  <template v-if="isCooldown(k)">
                    <span class="badge badge-red">冷却中 {{ cooldownText(k) }}</span>
                    <el-tooltip :content="k.last_error || ''" placement="top">
                      <span class="badge badge-amber">{{ k.last_error }}</span>
                    </el-tooltip>
                    <el-button size="small" type="warning" plain @click="resetKey(p, k)">立即恢复</el-button>
                  </template>
                  <el-switch v-model="k.enabled" @change="toggleKey(p, k)" />
                  <el-button size="small" text type="primary" @click="openEditKeyDialog(p, k)">编辑</el-button>
                  <el-button size="small" text type="danger" @click="removeKey(p, k)">删除</el-button>
                </div>
              </el-col>

              <el-col :xs="24" :md="10">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
                  <span class="section-title" style="margin-bottom: 0">模型列表 · {{ p.models.length }}</span>
                  <el-button size="small" :loading="refreshingId === p.id" @click="refreshModels(p)">
                    <svg style="margin-right: 4px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                    刷新模型
                  </el-button>
                </div>
                <div v-if="p.models.length === 0" class="muted" style="padding: 14px 0">模型为空，点击"刷新模型"自动从平台拉取。</div>
                <div v-else class="model-list">
                  <div v-for="m in p.models" :key="m.id" class="model-item">
                    <span class="model-id">{{ m.id }}</span>
                    <span class="muted">{{ m.owned_by }}</span>
                  </div>
                </div>
                <div v-if="p.models_updated_at" class="muted" style="margin-top: 10px">最近更新：{{ formatTime(p.models_updated_at) }}</div>
              </el-col>
            </el-row>

            <div class="provider-actions">
              <span class="muted" style="margin-right: auto">平台开关：</span>
              <el-switch v-model="p.enabled" @change="toggleProvider(p)" />
              <el-button size="small" @click="openEditDialog(p)">编辑平台</el-button>
              <el-popconfirm title="确定删除该平台及其所有 Key？" @confirm="removeProvider(p)">
                <template #reference>
                  <el-button size="small" type="danger" plain>删除平台</el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </el-collapse-transition>
      </div>
    </div>

    <el-dialog v-model="providerDialog" :title="editingProvider ? '编辑平台' : '添加平台'" width="640px" top="5vh">
      <el-form label-position="top" style="padding-right: 6px">
        <div v-if="!editingProvider" style="margin-bottom: 18px">
          <div class="preset-label">常用平台模板（参考各平台调用方案，自动填充接口格式、鉴权与 API 地址）</div>
          <el-select v-model="presetId" placeholder="选择平台模板" clearable filterable style="width: 100%" @change="applyPreset">
            <el-option-group v-for="g in presetGroups" :key="g" :label="g">
              <el-option v-for="t in templatesInGroup(g)" :key="t.id" :label="t.name" :value="t.id" />
            </el-option-group>
          </el-select>
        </div>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="接口格式" required>
              <el-select v-model="providerForm.protocol" style="width: 100%" @change="onProtocolChange">
                <el-option label="OpenAI Chat" value="openai-chat" />
                <el-option label="OpenAI Responses" value="openai-responses" />
                <el-option label="Anthropic" value="anthropic" />
                <el-option label="自定义调用方案" value="custom" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="平台名称" required>
              <el-input v-model="providerForm.name" placeholder="例如：OpenAI / DeepSeek" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="模型 API 地址" required>
          <el-input v-model="providerForm.base_url" placeholder="https://api.openai.com/v1（填写到版本前缀，不含 /chat/completions 等接口路径）" />
        </el-form-item>
        <el-form-item :label="editingProvider ? 'API Token（留空则保持不变）' : 'API Token'" :required="!editingProvider">
          <el-input v-model="providerForm.api_key" placeholder="请输入 API Token" show-password />
        </el-form-item>

        <el-collapse v-model="advancedOpen" style="margin-bottom: 18px; border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden">
          <el-collapse-item name="advanced">
            <template #title>
              <span style="font-size: 13px">高级调用方案（鉴权 / 端点路径，留空 = 使用所选接口格式的默认配置）</span>
            </template>
            <div class="adv-grid">
              <el-form-item label="鉴权方式">
                <el-select v-model="providerForm.auth_type" placeholder="跟随接口格式默认" clearable style="width: 100%">
                  <el-option label="请求头（如 Authorization: Bearer）" value="header" />
                  <el-option label="URL 参数（如 ?api_key=xxx）" value="query" />
                  <el-option label="Anthropic 风格（x-api-key）" value="anthropic" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'header' || providerForm.auth_type === ''" label="鉴权 Header 名">
                <el-input v-model="providerForm.auth_header" placeholder="Authorization" />
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'header' || providerForm.auth_type === ''" label="Header 值前缀">
                <el-input v-model="providerForm.auth_prefix" placeholder="Bearer " />
              </el-form-item>
              <el-form-item v-if="providerForm.auth_type === 'query'" label="URL 参数名">
                <el-input v-model="providerForm.auth_query_param" placeholder="api_key" />
              </el-form-item>
              <el-form-item label="对话接口路径">
                <el-input v-model="providerForm.chat_path" placeholder="/chat/completions" />
              </el-form-item>
              <el-form-item label="模型列表路径">
                <el-input v-model="providerForm.models_path" placeholder="/models" />
              </el-form-item>
              <el-form-item label="模型列表方法">
                <el-select v-model="providerForm.models_method" placeholder="GET" clearable style="width: 100%">
                  <el-option label="GET" value="GET" />
                  <el-option label="POST" value="POST" />
                </el-select>
              </el-form-item>
            </div>
          </el-collapse-item>
        </el-collapse>

        <el-form-item label="模型名称">
          <el-input v-model="providerForm.model_names_text" type="textarea" :rows="3" placeholder="与服务商API一致，如 deepseek-chat、gpt-4o&#10;每行填写一个模型；点击「拉取列表」选择后自动填入此处" />
        </el-form-item>
        <div style="display: flex; align-items: flex-start; gap: 10px; margin-bottom: 20px">
          <el-button type="primary" plain :loading="previewing" @click="doPreview">
            <svg style="margin-right: 5px" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
            拉取列表
          </el-button>
          <span class="muted" style="font-size: 12px; line-height: 1.7; padding-top: 4px">输入 API Token 后可拉取可用模型列表选择，选择后填入「模型名称」；<br />拉取失败时按服务商文档手动填写。</span>
        </div>
        <el-form-item label="自定义请求头（可选）">
          <el-input v-model="providerForm.extra_headers_text" type="textarea" :rows="2" placeholder='JSON 格式，如 {"HTTP-Referer": "https://example.com"}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="providerDialog = false">取消</el-button>
        <el-button type="primary" @click="saveProvider">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewDialog" title="选择可用模型" width="560px" top="12vh">
      <el-select v-model="previewSelected" multiple filterable collapse-tags collapse-tags-tooltip placeholder="搜索并选择模型，选择结果将填入「模型名称」" style="width: 100%">
        <el-option v-for="m in previewList" :key="m.id" :label="m.id" :value="m.id" />
      </el-select>
      <div class="preview-summary">
        <div class="muted" style="margin-bottom: 6px">已选 {{ previewSelected.length }} / {{ previewList.length }} 个，将填入「模型名称」：</div>
        <div v-if="previewSelected.length === 0" class="muted">未选择任何模型</div>
        <div v-else class="preview-tags">
          <el-tag v-for="id in previewSelected" :key="id" size="small" closable @close="previewSelected = previewSelected.filter((x) => x !== id)" style="margin: 2px">
            {{ id }}
          </el-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="previewDialog = false">取消</el-button>
        <el-button type="primary" :disabled="previewSelected.length === 0" @click="applyPreviewModels">填充到模型名称</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="keyDialog" :title="editingKey ? '编辑 Key' : '添加 Key'" width="480px">
      <el-form label-width="90px">
        <el-form-item label="Key 名称">
          <el-input v-model="keyForm.name" placeholder="可选，用于区分多个 Key" />
        </el-form-item>
        <el-form-item :label="editingKey ? '新 Key（留空不变）' : 'API Key'" required>
          <el-input v-model="keyForm.api_key" placeholder="sk-..." show-password />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="keyForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="keyDialog = false">取消</el-button>
        <el-button type="primary" @click="saveKey">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import api, { notifyError } from '../api.js'

const providers = ref([])
const loading = ref(false)
const expandedId = ref(null)
const refreshingId = ref(null)
const now = ref(Date.now())
const importInput = ref(null)

const providerDialog = ref(false)
const editingProvider = ref(null)
const advancedOpen = ref([])
const emptyForm = () => ({
  protocol: 'openai-chat',
  name: '',
  base_url: '',
  api_key: '',
  model_names_text: '',
  extra_headers_text: '',
  auth_type: '',
  auth_header: '',
  auth_prefix: '',
  auth_query_param: '',
  chat_path: '',
  models_path: '',
  models_method: ''
})
const providerForm = ref(emptyForm())
const previewing = ref(false)
const previewDialog = ref(false)
const previewList = ref([])
const previewSelected = ref([])

const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic': 'Anthropic',
  'custom': '自定义'
}

function protocolLabel(proto) {
  return PROTOCOL_LABELS[proto] || 'OpenAI Chat'
}

function isCustomCallPlan(p) {
  return p.auth_type || p.auth_header || p.auth_prefix || p.auth_query_param || p.chat_path || p.models_path || p.models_method
}

const presetId = ref('')
const presets = ref([])
const presetGroups = computed(() => [...new Set(presets.value.map((t) => t.group))])

function templatesInGroup(group) {
  return presets.value.filter((t) => t.group === group)
}

async function loadTemplates() {
  try {
    const data = await api.getTemplates()
    presets.value = data.templates || []
  } catch {
    presets.value = []
  }
}

function applyPreset(id) {
  const t = presets.value.find((x) => x.id === id)
  if (!t) return
  providerForm.value.protocol = t.protocol || 'openai-chat'
  providerForm.value.base_url = t.base_url || ''
  providerForm.value.auth_type = t.auth_type || ''
  providerForm.value.auth_header = t.auth_header || ''
  providerForm.value.auth_prefix = t.auth_prefix !== undefined ? t.auth_prefix : ''
  providerForm.value.auth_query_param = t.auth_query_param || ''
  providerForm.value.chat_path = t.chat_path || ''
  providerForm.value.models_path = t.models_path || ''
  providerForm.value.models_method = t.models_method || ''
  providerForm.value.extra_headers_text = t.extra_headers ? JSON.stringify(t.extra_headers, null, 2) : ''
  if (!providerForm.value.name) providerForm.value.name = t.name
  if (t.auth_type || t.chat_path || t.models_path) advancedOpen.value = ['advanced']
}

function onProtocolChange() {
  if (providerForm.value.protocol !== 'custom') {
    providerForm.value.auth_type = ''
    providerForm.value.auth_header = ''
    providerForm.value.auth_prefix = ''
    providerForm.value.auth_query_param = ''
    providerForm.value.chat_path = ''
    providerForm.value.models_path = ''
    providerForm.value.models_method = ''
  }
}

const keyDialog = ref(false)
const editingKey = ref(null)
const keyForm = ref({ name: '', api_key: '', enabled: true })
const keyOwner = ref(null)

let timer = null

function toggle(p) {
  expandedId.value = expandedId.value === p.id ? null : p.id
}

function isCooldown(k) {
  return k.cooldown_until && k.cooldown_until > now.value
}

function cooldownKeys(p) {
  return p.keys.filter(isCooldown)
}

function keyDot(k) {
  if (!k.enabled) return 'gray'
  if (isCooldown(k)) return 'red'
  return 'green'
}

function cooldownText(k) {
  const ms = k.cooldown_until - now.value
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s >= 60) return `${Math.ceil(s / 60)} 分钟`
  return `${s} 秒`
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN')
}

async function load() {
  loading.value = true
  try {
    providers.value = await api.getProviders()
  } catch (e) {
    notifyError(e, '加载平台列表失败')
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  editingProvider.value = null
  advancedOpen.value = []
  providerForm.value = emptyForm()
  providerDialog.value = true
}

function openEditDialog(p) {
  editingProvider.value = p
  advancedOpen.value = []
  providerForm.value = {
    protocol: p.protocol || 'openai-chat',
    name: p.name,
    base_url: p.base_url,
    api_key: '',
    model_names_text: (p.models || []).map((m) => m.id).join('\n'),
    extra_headers_text: JSON.stringify(p.extra_headers || {}, null, 2),
    auth_type: p.auth_type || '',
    auth_header: p.auth_header || '',
    auth_prefix: p.auth_prefix !== undefined ? p.auth_prefix : '',
    auth_query_param: p.auth_query_param || '',
    chat_path: p.chat_path || '',
    models_path: p.models_path || '',
    models_method: p.models_method || ''
  }
  providerDialog.value = true
}

async function saveProvider() {
  if (!providerForm.value.name || !providerForm.value.base_url) {
    return ElMessage.warning('平台名称和模型 API 地址为必填项')
  }
  if (!editingProvider.value && !providerForm.value.api_key) {
    return ElMessage.warning('请输入 API Token')
  }
  let extra = {}
  if (providerForm.value.extra_headers_text.trim()) {
    try {
      extra = JSON.parse(providerForm.value.extra_headers_text)
    } catch {
      return ElMessage.warning('自定义请求头必须是合法 JSON')
    }
  }
  const model_names = providerForm.value.model_names_text.split('\n').map((s) => s.trim()).filter(Boolean)
  const payload = {
    name: providerForm.value.name,
    base_url: providerForm.value.base_url,
    protocol: providerForm.value.protocol,
    extra_headers: extra,
    model_names
  }
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'models_path', 'models_method']) {
    // 始终提交（含空字符串）：空值 = 清空自定义配置、回退到协议默认
    payload[field] = providerForm.value[field] || ''
  }
  if (!editingProvider.value && providerForm.value.api_key) {
    payload.api_key = providerForm.value.api_key
  }
  try {
    if (editingProvider.value) {
      await api.updateProvider(editingProvider.value.id, payload)
      ElMessage.success('平台已更新')
    } else {
      await api.createProvider(payload)
      ElMessage.success('平台已添加')
    }
    providerDialog.value = false
    await load()
  } catch (e) {
    notifyError(e, '保存平台失败')
  }
}

function parseExtraFromForm() {
  if (!providerForm.value.extra_headers_text.trim()) return {}
  try {
    return JSON.parse(providerForm.value.extra_headers_text)
  } catch {
    return {}
  }
}

async function doPreview() {
  const { base_url, api_key } = providerForm.value
  if (!base_url) return ElMessage.warning('请先填写模型 API 地址')
  if (!editingProvider.value && !api_key) return ElMessage.warning('请先填写 API Token')
  const payload = {
    base_url,
    protocol: providerForm.value.protocol,
    api_key,
    extra_headers: parseExtraFromForm()
  }
  for (const field of ['auth_type', 'auth_header', 'auth_prefix', 'auth_query_param', 'chat_path', 'models_path', 'models_method']) {
    if (providerForm.value[field]) payload[field] = providerForm.value[field]
  }
  if (editingProvider.value && !api_key) {
    delete payload.api_key
    payload.provider_id = editingProvider.value.id
  }
  previewing.value = true
  try {
    const result = await api.previewModels(payload)
    previewList.value = result.models
    previewSelected.value = []
    previewDialog.value = true
  } catch (e) {
    notifyError(e, '拉取模型列表失败')
  } finally {
    previewing.value = false
  }
}

function applyPreviewModels() {
  const current = providerForm.value.model_names_text.split('\n').map((s) => s.trim()).filter(Boolean)
  const merged = [...new Set([...current, ...previewSelected.value])]
  providerForm.value.model_names_text = merged.join('\n')
  previewDialog.value = false
  ElMessage.success(`已将 ${previewSelected.value.length} 个模型填入「模型名称」，可继续增删`)
}

async function removeProvider(p) {
  try {
    await api.deleteProvider(p.id)
    ElMessage.success('平台已删除')
    if (expandedId.value === p.id) expandedId.value = null
    await load()
  } catch (e) {
    notifyError(e, '删除平台失败')
  }
}

async function toggleProvider(p) {
  try {
    await api.updateProvider(p.id, { enabled: p.enabled })
  } catch (e) {
    p.enabled = !p.enabled
    notifyError(e, '更新失败')
  }
}

async function refreshModels(p) {
  refreshingId.value = p.id
  try {
    const result = await api.refreshModels(p.id)
    ElMessage.success(`已获取 ${result.count} 个模型`)
    await load()
  } catch (e) {
    notifyError(e, '刷新模型失败')
  } finally {
    refreshingId.value = null
  }
}

function openAddKeyDialog(p) {
  keyOwner.value = p
  editingKey.value = null
  keyForm.value = { name: '', api_key: '', enabled: true }
  keyDialog.value = true
}

function openEditKeyDialog(p, k) {
  keyOwner.value = p
  editingKey.value = k
  keyForm.value = { name: k.name, api_key: '', enabled: k.enabled }
  keyDialog.value = true
}

async function saveKey() {
  if (!keyForm.value.api_key && !editingKey.value) {
    return ElMessage.warning('API Key 不能为空')
  }
  try {
    if (editingKey.value) {
      await api.updateKey(keyOwner.value.id, editingKey.value.id, keyForm.value)
      ElMessage.success('Key 已更新')
    } else {
      await api.addKey(keyOwner.value.id, keyForm.value)
      ElMessage.success('Key 已添加')
    }
    keyDialog.value = false
    await load()
  } catch (e) {
    notifyError(e, '保存 Key 失败')
  }
}

async function toggleKey(p, k) {
  try {
    await api.updateKey(p.id, k.id, { enabled: k.enabled })
  } catch (e) {
    k.enabled = !k.enabled
    notifyError(e, '更新失败')
  }
}

async function removeKey(p, k) {
  try {
    await ElMessageBox.confirm(`确定删除 Key "${k.name}"？`, '删除确认', { type: 'warning' })
    await api.deleteKey(p.id, k.id)
    ElMessage.success('Key 已删除')
    await load()
  } catch (e) {
    if (e !== 'cancel' && e?.message !== 'cancel') notifyError(e, '删除失败')
  }
}

async function resetKey(p, k) {
  try {
    await api.resetKey(p.id, k.id)
    ElMessage.success('已恢复该 Key')
    await load()
  } catch (e) {
    notifyError(e, '恢复失败')
  }
}

async function exportProviders() {
  try {
    const blob = await api.exportProviders()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `providers_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出成功（含 Key 和模型）')
  } catch (e) {
    notifyError(e, '导出失败')
  }
}

function triggerImport() {
  importInput.value.click()
}

async function importProviders(event) {
  const file = event.target.files[0]
  if (!file) return

  try {
    const text = await file.text()
    const data = JSON.parse(text)
    if (!Array.isArray(data)) {
      throw new Error('文件格式错误：必须是平台数组')
    }

    let keyCount = 0
    for (const item of data) {
      if (!item.name || !item.base_url) {
        throw new Error('平台缺少必要字段：name 和 base_url')
      }
      if (Array.isArray(item.keys)) {
        keyCount += item.keys.length
      }
    }

    ElMessageBox.confirm(
      `确定导入 ${data.length} 个平台、${keyCount} 个 Key 吗？`,
      '确认导入',
      { type: 'warning' }
    ).then(async () => {
      const result = await api.importProviders(data)
      ElMessage.success(`成功导入 ${result.imported} 个平台`)
      await load()
    }).catch(() => {
      ElMessage.info('已取消导入')
    })
  } catch (e) {
    notifyError(e, '导入失败')
  }
  event.target.value = ''
}

onMounted(() => {
  load()
  loadTemplates()
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.preset-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.preview-summary {
  margin-top: 14px;
  background: var(--bg-850);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.provider-expand {
  padding: 20px;
}

.adv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
  padding-top: 4px;
}

.provider-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  justify-content: flex-end;
  align-items: center;
  flex-wrap: wrap;
}

@media (max-width: 767px) {
  .provider-expand {
    padding: 14px;
  }

  .adv-grid {
    grid-template-columns: 1fr;
  }

  .adv-grid .el-form-item {
    margin-bottom: 12px;
  }

  .provider-actions {
    gap: 8px;
  }

  .provider-actions .muted {
    flex-basis: 100%;
  }
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 60px 20px;
  background: var(--bg-800);
  border: 1px dashed var(--border);
  border-radius: 14px;
}

.empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: rgba(99, 102, 241, 0.12);
  color: #a5b4fc;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}

.empty-desc {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px;
}

.openai-hint {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  background: rgba(52, 211, 153, 0.08);
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 10px;
  padding: 10px 12px;
  color: #6ee7b7;
  font-size: 12.5px;
  line-height: 1.7;
}

.openai-hint code {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 0 5px;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
}

.model-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
}

.model-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 13px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12.5px;
  align-items: center;
}

.model-item:last-child {
  border-bottom: none;
}

.model-item:hover {
  background: var(--bg-850);
}

.model-id {
  word-break: break-all;
  font-family: ui-monospace, monospace;
  color: var(--text-main);
}

.model-item .muted {
  flex-shrink: 0;
}
</style>
