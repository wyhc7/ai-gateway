import { createRouter, createWebHashHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Providers from './views/Providers.vue'
import TestChat from './views/TestChat.vue'
import Logs from './views/Logs.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: Dashboard, meta: { title: '仪表盘', desc: '平台运行总览、Key 健康状态与请求统计' } },
    { path: '/providers', component: Providers, meta: { title: '平台管理', desc: '配置平台、管理多 Key、自动拉取模型列表' } },
    { path: '/test', component: TestChat, meta: { title: '对话测试', desc: '选择平台与模型，实时验证转发与故障切换' } },
    { path: '/logs', component: Logs, meta: { title: '运行日志', desc: '实时查看最近请求日志，快速定位故障' } }
  ]
})

export default router
