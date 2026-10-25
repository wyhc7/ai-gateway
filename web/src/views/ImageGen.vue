<template>
  <div>
    <!-- 输入区 -->
    <div class="card">
      <div class="gen-head">
        <span class="section-title" style="margin: 0">生图</span>
        <span class="muted">
          模型 <span class="mono">gpt-image-2</span> ·
          剩余 <b class="num">{{ quota.total }}</b> 次 ·
          池内 {{ quota.accounts }} 个账号
        </span>
      </div>

      <el-input
        v-model="prompt"
        type="textarea"
        :rows="3"
        placeholder="描述你想要的画面，英文效果最好（中文容易触发内容审核）"
        @keydown.ctrl.enter.prevent="generate"
        @keydown.meta.enter.prevent="generate"
      />

      <div class="gen-controls">
        <div class="ctrl">
          <span class="ctrl-label">尺寸</span>
          <el-radio-group v-model="size" size="small">
            <el-radio-button label="1024x1024">方</el-radio-button>
            <el-radio-button label="1536x1024">横</el-radio-button>
            <el-radio-button label="1024x1536">竖</el-radio-button>
          </el-radio-group>
        </div>

        <div class="ctrl">
          <span class="ctrl-label">张数</span>
          <el-input-number v-model="count" :min="1" :max="4" size="small" controls-position="right" style="width: 90px" />
        </div>

        <div class="ctrl-grow"></div>

        <el-button :disabled="generating" @click="prompt = ''">清空</el-button>
        <el-button type="primary" :loading="generating" :disabled="!prompt.trim()" @click="generate">
          {{ generating ? `生成中 ${elapsed}s` : '生成' }}
        </el-button>
      </div>

      <div class="gen-hint muted">
        Ctrl+Enter 快速生成 · 实测每张 15~25 秒 · 一张消耗一次额度
        <span v-if="count > 1" class="warn">· {{ count }} 张会消耗 {{ count }} 次</span>
      </div>
    </div>

    <!-- 结果区 -->
    <div style="margin-top: 16px">
      <div class="section-title">
        结果
        <span v-if="results.length" class="muted" style="font-weight: 400; margin-left: 8px">
          {{ results.length }} 张 · 点击图片查看大图
        </span>
      </div>

      <div v-if="results.length === 0 && !generating" class="gen-empty">
        <span class="empty-mark">图</span>
        <span>输入提示词，点「生成」</span>
      </div>

      <div class="gen-grid">
        <div v-for="(r, i) in results" :key="r.id" class="gen-item">
          <div class="gen-img-wrap" @click="preview(r)">
            <img :src="r.url" :alt="r.prompt" loading="lazy" />
            <div class="gen-overlay">
              <span>{{ r.width }}×{{ r.height }}</span>
              <span>{{ r.kb }} KB</span>
            </div>
          </div>
          <div class="gen-meta">
            <div class="gen-prompt" :title="r.prompt">{{ r.prompt }}</div>
            <div class="gen-actions">
              <span class="muted num">{{ r.elapsed }}s</span>
              <el-button link size="small" @click="download(r)">下载</el-button>
              <el-button link size="small" @click="reuse(r)">复用</el-button>
              <el-button link size="small" @click="remove(i)">删除</el-button>
            </div>
          </div>
        </div>

        <!-- 生成中的占位 -->
        <div v-for="n in (generating ? pendingCount : 0)" :key="'p' + n" class="gen-item">
          <div class="gen-img-wrap gen-skeleton">
            <span class="typing">生成中</span>
          </div>
          <div class="gen-meta">
            <div class="gen-prompt muted">{{ pendingLabel }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 历史 -->
    <div v-if="history.length" style="margin-top: 16px">
      <div class="section-title">
        历史
        <span class="muted" style="font-weight: 400; margin-left: 8px">{{ history.length }} 条（仅本机浏览器）</span>
        <el-button link size="small" style="float: right" @click="clearHistory">清空历史</el-button>
      </div>
      <div class="hist-list">
        <div v-for="(h, i) in history.slice(0, 24)" :key="i" class="hist-item" @click="reuse(h)">
          <img :src="h.url" :alt="h.prompt" loading="lazy" />
          <div class="hist-prompt">{{ h.prompt }}</div>
        </div>
      </div>
    </div>

    <!-- 大图预览 -->
    <el-dialog v-model="previewVisible" width="82%" :show-close="true" append-to-body class="gen-dialog">
      <img v-if="previewItem" :src="previewItem.url" :alt="previewItem.prompt || '生成结果预览'" style="width: 100%; display: block; border-radius: 8px" />
      <div v-if="previewItem" class="preview-prompt mono">{{ previewItem.prompt }}</div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api.js'

const STORAGE_HISTORY = 'image-gen-history'
const HISTORY_MAX = 60

const prompt = ref('')
const size = ref('1024x1024')
const count = ref(1)
const generating = ref(false)
const elapsed = ref(0)
const results = ref([])
const history = ref([])
const gatewayKey = ref('')
const previewVisible = ref(false)
const previewItem = ref(null)
const quota = ref({ total: 0, accounts: 0 })

const pendingCount = computed(() => Math.max(1, count.value))
const pendingLabel = computed(() => prompt.value)

let timer = null
let uid = 0

// 计时器：让人看见"在动"。实测 15~25 秒，没有计时会以为卡死了。
function startTimer() {
  elapsed.value = 0
  timer = setInterval(() => { elapsed.value += 1 }, 1000)
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

onMounted(async () => {
  loadHistory()
  await Promise.all([loadGatewayKey(), loadQuota()])
})

onUnmounted(stopTimer)

async function loadGatewayKey() {
  try {
    const s = await api.getStatus()
    gatewayKey.value = s.gateway_api_key || ''
  } catch (e) {
    ElMessage.error(`拿不到网关 Key：${e.message}`)
  }
}

async function loadQuota() {
  try {
    const raw = await api.getChatgptAccounts()
    const list = raw.accounts || raw.items || []
    quota.value = {
      accounts: list.length,
      total: list.reduce((n, a) => n + (a.image_quota || 0), 0)
    }
  } catch {
    /* 额度查不到不影响生图，静默 */
  }
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]')
    history.value = Array.isArray(saved) ? saved : []
  } catch {
    history.value = []
  }
}

// 历史存 localStorage：只留 url + prompt + 尺寸。图片本身是 data URL，
// 一条 2 MB 上下，localStorage 上限约 5 MB，所以条数必须压住（60 条会爆）。
// 超了就按「先丢最旧的」截断，写不进去再砍半重试。
function saveHistory(list) {
  let items = list.slice(0, HISTORY_MAX)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      localStorage.setItem(STORAGE_HISTORY, JSON.stringify(items))
      history.value = items
      return
    } catch {
      items = items.slice(0, Math.floor(items.length / 2))
      if (items.length === 0) break
    }
  }
  // 实在存不下就只在内存里留一份，不打断使用
  history.value = list.slice(0, 12)
}

function pushResult(rec) {
  results.value.unshift(rec)
  saveHistory([rec, ...history.value].slice(0, HISTORY_MAX))
}

async function generate() {
  const text = prompt.value.trim()
  if (!text || generating.value) return
  if (!gatewayKey.value) {
    ElMessage.error('网关 Key 未就绪，请刷新页面')
    return
  }

  generating.value = true
  startTimer()

  const n = Math.max(1, Math.min(4, count.value))
  let ok = 0
  let lastErr = ''

  // 串行而非并行：上游按账号轮询，并发打过去更容易让某个号被判限流，
  // 总量反而更慢。一次一张、出完再下一张更稳。
  for (let i = 0; i < n; i += 1) {
    const t0 = Date.now()
    try {
      const resp = await fetch('/api/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gatewayKey.value}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: text, n: 1, size: size.value }),
        signal: AbortSignal.timeout(180_000)
      })

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`
        try {
          const j = await resp.json()
          detail = j?.error?.message || j?.error || detail
        } catch { /* ignore */ }
        throw new Error(detail)
      }

      const j = await resp.json()
      const b64 = j?.data?.[0]?.b64_json
      if (!b64) throw new Error('响应里没有 b64_json')

      // 实测成功是 1.3~3.3 MB；几百字节基本是错误页被当成了图
      const bytes = Math.floor((b64.length * 3) / 4)
      if (bytes < 1024) throw new Error(`图片只有 ${bytes} 字节，多半不是图`)

      const url = `data:image/png;base64,${b64}`
      const dim = await imageSize(url)
      uid += 1
      pushResult({
        id: `g${Date.now()}_${uid}`,
        url,
        prompt: text,
        size: size.value,
        width: dim.w,
        height: dim.h,
        kb: Math.round(bytes / 1024),
        elapsed: Math.round((Date.now() - t0) / 1000),
        at: Date.now()
      })
      ok += 1
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? '超时 180 秒没返回' : e.message
      break // 一张失败就停，别把剩下的额度也打水漂
    }
  }

  stopTimer()
  generating.value = false

  if (ok > 0) {
    ElMessage.success(`生成完成 ${ok} 张`)
    loadQuota()
  }
  if (ok < n) {
    ElMessage.error(lastErr || '生成失败')
  }
}

// 从 data URL 读真实像素尺寸：请求 1024x1024，上游实测返回 1254×1254，
// 界面上写真实值比写请求值有用。
function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 0, h: 0 })
    img.src = url
  })
}

function preview(r) {
  previewItem.value = r
  previewVisible.value = true
}

function download(r) {
  const a = document.createElement('a')
  a.href = r.url
  const stamp = new Date(r.at || Date.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  a.download = `gen-${stamp}-${r.width}x${r.height}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function reuse(r) {
  prompt.value = r.prompt
  size.value = r.size || '1024x1024'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function remove(i) {
  results.value.splice(i, 1)
}

function clearHistory() {
  history.value = []
  localStorage.removeItem(STORAGE_HISTORY)
  ElMessage.success('历史已清空')
}
</script>

<style scoped>
.gen-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.gen-controls {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ctrl-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.ctrl-grow {
  flex: 1 1 auto;
}

.gen-hint {
  margin-top: 8px;
  font-size: 12px;
}

.warn {
  color: var(--el-color-warning);
}

.gen-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 56px 0;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.gen-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.gen-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  overflow: hidden;
  background: var(--el-fill-color-blank);
}

.gen-img-wrap {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--el-fill-color-light);
  cursor: zoom-in;
  overflow: hidden;
}

.gen-img-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gen-overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  padding: 5px 8px;
  font-size: 11px;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
  opacity: 0;
  transition: opacity 0.15s;
}

.gen-img-wrap:hover .gen-overlay {
  opacity: 1;
}

.gen-skeleton {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}

.gen-meta {
  padding: 8px 10px 10px;
}

.gen-prompt {
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-regular);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 34px;
}

.gen-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
}

.gen-actions .num {
  margin-right: auto;
}

.hist-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.hist-item {
  cursor: pointer;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  position: relative;
}

.hist-item img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  display: block;
}

.hist-prompt {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 12px 6px 4px;
  font-size: 10px;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-prompt {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.typing::after {
  content: '';
  animation: dots 1.2s steps(4, end) infinite;
}

@keyframes dots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75% { content: '...'; }
}

/* 手机端：390px 下那一行「生图 · 模型 · 剩余 · 池内账号」会挤成一坨，
   按钮也会被挤到左下角。拆成三行，按钮仍靠右。 */
@media (max-width: 767px) {
  .gen-head { align-items: flex-start; gap: 4px; }
  .gen-head > .muted {
    flex: 1 1 100%;
    font-size: 11.5px;
    line-height: 1.6;
    margin-bottom: 6px;
  }
  .gen-controls { gap: 12px; }
  .ctrl-grow { display: none; }
  .gen-controls > .el-button:first-of-type { margin-left: auto; }
  .gen-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .gen-empty { padding: 40px 12px; }
  .hist-list { grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); }
}
</style>
