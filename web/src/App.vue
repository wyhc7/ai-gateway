<template>
  <el-config-provider :locale="zhCn">
    <div class="app-layout">
      <div v-if="isMobile && drawerOpen" class="mobile-mask" @click="drawerOpen = false"></div>

    <aside class="app-sidebar" :class="{ collapsed, mobile: isMobile, open: isMobile && drawerOpen }">
      <div class="brand">
        <span class="logo" @click="toggleBrand">AI</span>
        <span v-show="!collapsed || isMobile" class="brand-name">AI 中转站</span>
        <button v-if="!isMobile" class="collapse-btn" @click="collapsed = !collapsed" :title="collapsed ? '展开侧边栏' : '收起侧边栏'">
          <svg v-if="collapsed" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M14 8l-4 4 4 4" />
          </svg>
        </button>
        <button v-else class="collapse-btn" @click="drawerOpen = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <nav class="nav" v-show="!collapsed || isMobile">
        <div class="nav-label">控制台</div>
        <RouterLink to="/dashboard" @click="onNav">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
          </svg>
          仪表盘
        </RouterLink>
        <RouterLink to="/providers" @click="onNav">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.3 7l8.7 5 8.7-5" /><path d="M12 22V12" />
          </svg>
          平台管理
        </RouterLink>
        <RouterLink to="/test" @click="onNav">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          对话测试
        </RouterLink>
        <RouterLink to="/logs" @click="onNav">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
          运行日志
        </RouterLink>
      </nav>
      <div class="sidebar-footer" v-show="!collapsed || isMobile">
        多平台统一网关<br />自动故障切换 · 模型聚合
      </div>
    </aside>

    <main class="app-main" :class="{ collapsed }">
      <div class="page-head">
        <button v-if="isMobile" class="hamburger" @click="drawerOpen = true" aria-label="打开菜单">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <div class="page-head-text">
          <div class="page-title">{{ $route.meta.title }}</div>
          <div class="page-desc">{{ $route.meta.desc }}</div>
        </div>
      </div>
      <RouterView />
    </main>
    </div>
  </el-config-provider>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useViewport } from './composables/useViewport.js'

const { isMobile } = useViewport()
const route = useRoute()

const collapsed = ref(localStorage.getItem('sidebar-collapsed') === '1')
const drawerOpen = ref(false)

watch(collapsed, (v) => {
  localStorage.setItem('sidebar-collapsed', v ? '1' : '0')
})

watch(() => route.fullPath, () => {
  if (isMobile.value) drawerOpen.value = false
})

function toggleBrand() {
  if (isMobile.value) {
    drawerOpen.value = !drawerOpen.value
  } else {
    collapsed.value = !collapsed.value
  }
}

function onNav() {
  if (isMobile.value) drawerOpen.value = false
}
</script>
