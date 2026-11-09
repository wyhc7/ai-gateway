// 登录身份的单一真源：App.vue 的门状态机写入，router 的守卫与侧栏读取。
//
// 之所以从 App.vue 里抽出来：普通用户只能进「我的仪表盘」，这道限制必须
// 在路由跳转前生效。若等组件挂载再重定向，管理页会先发一批 /api/status
// 之类的请求吃 403，闪一下还污染日志。守卫读这个 reactive 单例即可，
// 不用把 router 反向依赖到 App.vue 上。
import { reactive, computed } from 'vue'

export const authState = reactive({
  ready: false,      // 引导已完成，角色信息可用；false 时守卫一律放行
  account: null,     // serializeAccount 的结果（含 role）
  via: ''            // 'session' | 'admin-key'
})

export const isAdmin = computed(() =>
  authState.via === 'admin-key' || authState.account?.role === 'admin'
)

export function setAuth(account, via) {
  authState.account = account || null
  authState.via = via || ''
  authState.ready = true
}

export function clearAuth() {
  authState.account = null
  authState.via = ''
  authState.ready = false
}
