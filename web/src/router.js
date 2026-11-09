import { createRouter, createWebHashHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Providers from './views/Providers.vue'
import ApiKeys from './views/ApiKeys.vue'
import TestChat from './views/TestChat.vue'
import ImageGen from './views/ImageGen.vue'
import Logs from './views/Logs.vue'
import SystemUpdate from './views/SystemUpdate.vue'
import Accounts from './views/Accounts.vue'
import UserDashboard from './views/UserDashboard.vue'
import { authState, isAdmin } from './auth-state.js'

// requiresAdmin：普通用户连组件都不挂载，避免管理页先发一批 /api/status 吃 403
// 闪一下还污染日志。userOnly：管理员点进用户面板直接回自己的仪表盘。
const admin = (component, title, desc, extra = {}) => ({ component, meta: { title, desc, requiresAdmin: true, ...extra } })

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', ...admin(Dashboard, '仪表盘', '平台运行总览、Key 健康状态与请求统计') },
    { path: '/providers', ...admin(Providers, '平台管理', '配置平台、管理多 Key、自动拉取模型列表') },
    { path: '/keys', ...admin(ApiKeys, '访问密钥', '给调用方发放 Key，并按模型粒度限制可用范围') },
    { path: '/test', ...admin(TestChat, '对话测试', '选择平台与模型，实时验证转发与故障切换') },
    { path: '/image', ...admin(ImageGen, '生图', '提示词直接出图，历史存本机') },
    { path: '/logs', ...admin(Logs, '运行日志', '最近请求日志，快速定位故障') },
    { path: '/accounts', ...admin(Accounts, '账号管理', '管理控制台账号、角色、余额充值与密码重置') },
    { path: '/update', ...admin(SystemUpdate, '系统更新', '比对上游仓库，查看更新内容并一键升级') },
    { path: '/user', component: UserDashboard, meta: { title: '我的仪表盘', desc: '剩余余额、调用密钥、接入信息与余额流水', userOnly: true } },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
})

// ready=false 时（引导期，登录门还盖着）一律放行：此时 <RouterView> 根本没挂载，
// 守卫拦不拦都无所谓。引导完成后 App.vue 会 setAuth 并按角色 push 到落地页。
router.beforeEach((to) => {
  if (!authState.ready) return true
  if (!isAdmin.value && to.meta.requiresAdmin) return { path: '/user' }
  if (isAdmin.value && to.meta.userOnly) return { path: '/dashboard' }
  return true
})

export default router
