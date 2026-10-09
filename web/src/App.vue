<template>
  <el-config-provider :locale="zhCn">
    <div class="app-layout">
      <!-- 移动端抽屉遮罩：纯鼠标便利，键盘用户走旁边的关闭按钮与 Esc，故对辅助技术隐藏 -->
      <div v-if="isMobile && drawerOpen" class="mobile-mask" role="presentation" aria-hidden="true" @click="drawerOpen = false"></div>

      <aside class="app-sidebar" :class="{ collapsed, mobile: isMobile, open: isMobile && drawerOpen }">
        <div class="brand">
          <button type="button" class="logo" :title="brandActionLabel" :aria-label="brandActionLabel" @click="toggleBrand">AI</button>
          <span class="brand-text">
            <span class="brand-name">AI 中转站</span>
            <span class="brand-sub">Gateway Console</span>
          </span>
          <button v-if="!isMobile" class="collapse-btn" @click="collapsed = !collapsed" :title="collapsed ? '展开侧边栏' : '收起侧边栏'">
            <svg v-if="collapsed" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M14 8l-4 4 4 4" />
            </svg>
          </button>
          <button v-else class="collapse-btn" @click="drawerOpen = false">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav class="nav">
          <div class="nav-label">控制台</div>
          <RouterLink to="/dashboard" @click="onNav" title="仪表盘">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
            </svg>
            <span class="nav-text">仪表盘</span>
          </RouterLink>
          <RouterLink to="/providers" @click="onNav" title="平台管理">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <path d="M3.3 7l8.7 5 8.7-5" /><path d="M12 22V12" />
            </svg>
            <span class="nav-text">平台管理</span>
          </RouterLink>
          <RouterLink to="/keys" @click="onNav" title="访问密钥">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="7.5" cy="15.5" r="4" /><path d="M10.5 12.5L20 3M17 6l3 3M14 9l2.5 2.5" />
            </svg>
            <span class="nav-text">访问密钥</span>
          </RouterLink>
          <RouterLink to="/test" @click="onNav" title="对话测试">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span class="nav-text">对话测试</span>
          </RouterLink>
          <RouterLink to="/logs" @click="onNav" title="运行日志">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8M8 17h5" />
            </svg>
            <span class="nav-text">运行日志</span>
          </RouterLink>
          <RouterLink to="/update" @click="onNav" :title="updateAvailable ? `系统更新（有 ${updateCount} 个新提交）` : '系统更新'">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v11" /><path d="M7.5 9.5L12 14l4.5-4.5" /><path d="M4.5 20h15" />
            </svg>
            <span class="nav-text">系统更新</span>
            <span v-if="updateAvailable" class="nav-dot" aria-hidden="true"></span>
          </RouterLink>
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-foot-line">多平台统一网关</div>
          <div class="sidebar-foot-line">自动故障切换 · 模型聚合</div>
        </div>
      </aside>

      <main class="app-main" :class="{ collapsed }">
        <div class="page-head">
          <button v-if="isMobile" class="hamburger" @click="drawerOpen = true" aria-label="打开菜单">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <div class="page-head-text">
            <div class="page-title">{{ $route.meta.title }}</div>
            <div class="page-desc">{{ $route.meta.desc }}</div>
          </div>
          <ThemeToggle />
        </div>
        <RouterView />
      </main>
    </div>
  </el-config-provider>

  <el-dialog
    v-model="showLogin"
    title="管理密钥"
    width="420px"
    :close-on-click-modal="false"
    :show-close="false"
    append-to-body
  >
    <p style="margin: 0 0 14px; font-size: 13px; line-height: 1.7; color: var(--ink-3);">
      管理接口已启用鉴权。请输入管理密钥（见服务端启动日志，或配置文件 config.json 的 admin_api_key 字段）。
    </p>
    <el-input
      v-model="loginKey"
      type="password"
      placeholder="请输入管理密钥"
      show-password
      @keyup.enter="confirmLogin"
    />
    <template #footer>
      <el-button type="primary" :disabled="!loginKey.trim()" @click="confirmLogin">进入管理界面</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useViewport } from './composables/useViewport.js'
import api, { getAdminKey, setAdminKey } from './api.js'
import ThemeToggle from './components/ThemeToggle.vue'

const { isMobile } = useViewport()
const route = useRoute()

const collapsed = ref(localStorage.getItem('sidebar-collapsed') === '1')
const drawerOpen = ref(false)

const showLogin = ref(false)
const loginKey = ref('')

// 侧边栏上的「有新版本」小红点。检查失败（离线、非 git 部署）静默忽略——
// 一个环境探测的结果不该打断控制台的正常使用。
const updateAvailable = ref(false)
const updateCount = ref(0)

async function checkForUpdate() {
  if (!getAdminKey()) return
  try {
    const r = await api.checkUpdate(false)
    updateAvailable.value = Boolean(r?.ok && r.has_update)
    updateCount.value = r?.behind || 0
  } catch {
    /* 忽略：进「系统更新」页面时会给明确原因 */
  }
}

function onUnauthorized() {
  loginKey.value = getAdminKey()
  showLogin.value = true
}

function confirmLogin() {
  const key = loginKey.value.trim()
  if (!key) return
  setAdminKey(key)
  showLogin.value = false
  location.reload()
}

onMounted(() => {
  if (!getAdminKey()) showLogin.value = true
  window.addEventListener('gateway-unauthorized', onUnauthorized)
  window.addEventListener('keydown', onKeydown)
  checkForUpdate()
})

onBeforeUnmount(() => {
  window.removeEventListener('gateway-unauthorized', onUnauthorized)
  window.removeEventListener('keydown', onKeydown)
})

watch(collapsed, (v) => {
  localStorage.setItem('sidebar-collapsed', v ? '1' : '0')
})

watch(() => route.fullPath, () => {
  if (isMobile.value) drawerOpen.value = false
})

// 品牌标记和它旁边的收起按钮做的是同一件事，所以用同一套措辞，
// 避免同一个动作在无障碍树里出现两种说法。
const brandActionLabel = computed(() => {
  if (isMobile.value) return drawerOpen.value ? '关闭菜单' : '打开菜单'
  return collapsed.value ? '展开侧边栏' : '收起侧边栏'
})

function toggleBrand() {
  if (isMobile.value) {
    drawerOpen.value = !drawerOpen.value
  } else {
    collapsed.value = !collapsed.value
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && isMobile.value && drawerOpen.value) drawerOpen.value = false
}

function onNav() {
  if (isMobile.value) drawerOpen.value = false
}
</script>
