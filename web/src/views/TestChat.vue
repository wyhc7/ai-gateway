<template>
  <div>
    <div class="card toolbar-card">
      <div class="toolbar">
        <el-select v-model="providerId" placeholder="选择平台（可选）" clearable class="toolbar-select" style="flex: 0 0 200px" @change="onProviderChange">
          <el-option v-for="p in providers" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-select v-model="model" placeholder="选择模型" filterable class="toolbar-select" style="flex: 1 1 260px; min-width: 160px" :loading="loadingModels">
          <el-option v-for="m in filteredModels" :key="m.key" :label="m.label" :value="m.value">
            <span style="float: left">{{ m.label }}</span>
          </el-option>
        </el-select>
        <div class="temp-wrap">
          <span class="temp-label">温度</span>
          <el-slider v-model="temperature" class="temp-slider" :min="0" :max="2" :step="0.1" />
          <span class="temp-val">{{ temperature.toFixed(1) }}</span>
        </div>
        <el-button type="primary" :loading="sending" :disabled="!model || !input" @click="send" class="send-btn">
          <svg style="margin-right: 5px" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>
          发送
        </el-button>
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="chat-box" ref="chatBox">
        <div v-for="(m, i) in messages" :key="i" :class="['msg', m.role === 'user' ? 'user' : m.role === 'meta' ? 'meta' : 'assistant']">{{ m.content }}</div>
        <div v-if="sending" class="msg assistant" style="color: var(--text-muted)">正在生成<span class="typing-dots">...</span></div>
      </div>
      <el-input
        v-model="input"
        type="textarea"
        :rows="2"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        style="margin-top: 14px"
        @keydown.enter.exact.prevent="send"
      />
      <div class="muted" style="margin-top: 6px; display: flex; justify-content: space-between">
        <span>所有请求通过网关转发，触发故障时自动切换可用 Key</span>
        <span v-if="model">{{ model }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import api, { notifyError } from '../api.js'

const providers = ref([])
const providerId = ref(null)
const allModels = ref([])
const model = ref(null)
const temperature = ref(0.7)
const input = ref('')
const sending = ref(false)
const loadingModels = ref(false)
const messages = ref([])
const chatBox = ref(null)
const gatewayKey = ref('')

const filteredModels = computed(() => {
  const list = providerId.value ? allModels.value.filter((m) => m.provider === providerId.value) : allModels.value
  return list.map((m) => ({
    key: `${m.provider}-${m.id}`,
    label: providerId.value ? m.id : `${m.id} · ${m.provider_name}`,
    value: providerId.value ? m.id : `provider:${m.provider}/${m.id}`
  }))
})

async function loadModels() {
  loadingModels.value = true
  try {
    const resp = await fetch('/api/v1/models', {
      headers: gatewayKey.value ? { Authorization: `Bearer ${gatewayKey.value}` } : {}
    })
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`
      try {
        const data = await resp.json()
        msg = data?.error?.message || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const data = await resp.json()
    allModels.value = data.data || []
  } catch (e) {
    notifyError(e, '加载模型失败')
  } finally {
    loadingModels.value = false
  }
}

function onProviderChange() {
  if (providerId.value) {
    const first = allModels.value.find((m) => m.provider === providerId.value)
    model.value = first ? first.id : null
  } else {
    model.value = allModels.value[0] ? `provider:${allModels.value[0].provider}/${allModels.value[0].id}` : null
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || !model.value) return
  messages.value.push({ role: 'user', content: text })
  input.value = ''
  sending.value = true
  scrollBottom()
  try {
    const payload = {
      model: model.value,
      messages: messages.value.filter((m) => m.role !== 'meta'),
      temperature: Number(temperature.value),
      stream: true
    }
    const resp = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayKey.value ? { Authorization: `Bearer ${gatewayKey.value}` } : {})
      },
      body: JSON.stringify(payload)
    })
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`
      try {
        const data = await resp.json()
        msg = data?.error?.message || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      const lines = acc.split('\n')
      acc = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content || ''
          if (delta) {
            const last = messages.value[messages.value.length - 1]
            if (last?.role === 'assistant') {
              last.content += delta
            } else {
              messages.value.push({ role: 'assistant', content: delta })
            }
            scrollBottom()
          }
        } catch { /* ignore partial */ }
      }
    }
  } catch (e) {
    messages.value.push({ role: 'meta', content: `请求失败：${e.message}` })
  } finally {
    sending.value = false
    scrollBottom()
  }
}

function scrollBottom() {
  nextTick(() => {
    if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight
  })
}

onMounted(async () => {
  try {
    const gateway = await api.getGateway()
    gatewayKey.value = gateway.api_key
  } catch (e) {
    notifyError(e, '加载网关配置失败')
  }
  try {
    providers.value = await api.getProviders()
  } catch (e) {
    notifyError(e, '加载平台失败')
  }
  await loadModels()
})
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}

.temp-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.temp-slider {
  flex: 1 1 120px;
  min-width: 100px;
  max-width: 160px;
}

.send-btn {
  margin-left: auto;
}

@media (max-width: 767px) {
  .toolbar-select {
    flex: 1 1 100% !important;
    min-width: 0;
  }

  .temp-wrap {
    flex: 1 1 100%;
  }

  .temp-slider {
    flex: 1;
    max-width: none;
  }

  .send-btn {
    margin-left: 0;
    flex: 1 1 100%;
  }
}

.temp-label {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.temp-val {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  width: 28px;
}

.typing-dots::after {
  content: '';
  animation: dots 1.2s steps(4, end) infinite;
}

@keyframes dots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75% { content: '...'; }
}
</style>
