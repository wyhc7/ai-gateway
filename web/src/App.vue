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
          <template v-if="isAdmin">
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
          <RouterLink to="/image" @click="onNav" title="生图">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="M21 15.5l-4.5-4.5L6 21" />
            </svg>
            <span class="nav-text">生图</span>
          </RouterLink>
          <RouterLink to="/logs" @click="onNav" title="运行日志">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8M8 17h5" />
            </svg>
            <span class="nav-text">运行日志</span>
          </RouterLink>
          <RouterLink v-if="isAdmin" to="/accounts" @click="onNav" title="账号管理">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3.2 3.2 0 0 1 0 6.2" /><path d="M17.5 14.5a5.5 5.5 0 0 1 3 5.5" />
            </svg>
            <span class="nav-text">账号管理</span>
          </RouterLink>
          <RouterLink to="/update" @click="onNav" :title="updateAvailable ? `系统更新（有 ${updateCount} 个新提交）` : '系统更新'">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v11" /><path d="M7.5 9.5L12 14l4.5-4.5" /><path d="M4.5 20h15" />
            </svg>
            <span class="nav-text">系统更新</span>
            <span v-if="updateAvailable" class="nav-dot" aria-hidden="true"></span>
          </RouterLink>
          </template>

          <template v-else>
            <div class="nav-label">我的账户</div>
            <RouterLink to="/user" @click="onNav" title="我的仪表盘">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4" />
              </svg>
              <span class="nav-text">我的仪表盘</span>
            </RouterLink>
          </template>
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

          <button v-if="needsSetup && gateMode === 'open'" type="button" class="setup-entry" @click="openSetup">
            <span class="badge-dot amber" aria-hidden="true"></span>创建管理员账号
          </button>

          <div v-if="gateMode === 'open'" class="account-box">
            <el-dropdown trigger="click" @command="onAccountCommand">
              <button type="button" class="account-trigger" :aria-label="`账号菜单：${accountLabel}`">
                <span class="account-avatar" aria-hidden="true">{{ avatarText }}</span>
                <span class="account-name">{{ accountLabel }}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="password">修改密码</el-dropdown-item>
                  <el-dropdown-item command="switch">切换账号</el-dropdown-item>
                  <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>

          <ThemeToggle />
        </div>
        <!-- 未放行前不挂载任何管理视图：它们一挂载就会发 /api/status 之类的
             请求，匿名 401 会触发全局 gateway-unauthorized，把「初始化管理员」
             门顶成登录门，首次部署就再也设不了密码。 -->
        <RouterView v-if="gateMode === 'open'" />
      </main>
    </div>
  </el-config-provider>

  <!-- 登录 / 初始化门 -->
  <el-dialog
    v-model="gateVisible"
    :title="gateTitle"
    width="440px"
    :close-on-click-modal="false"
    :show-close="gateDismissible"
    append-to-body
  >
    <p class="gate-hint">{{ gateHint }}</p>

    <el-form label-position="top" @submit.prevent>
      <el-form-item label="用户名">
        <el-input
          v-model="gateForm.username"
          autocomplete="username"
          placeholder="2–32 位，中英文、数字、点、下划线或连字符"
          maxlength="32"
          @keyup.enter="submitGate"
        />
      </el-form-item>
      <el-form-item :label="gateMode === 'login' ? '密码' : '设置密码'">
        <el-input
          v-model="gateForm.password"
          type="password"
          :autocomplete="gateMode === 'login' ? 'current-password' : 'new-password'"
          :placeholder="`至少 ${passwordMin} 位`"
          show-password
          @keyup.enter="submitGate"
        />
      </el-form-item>
      <el-form-item v-if="gateMode === 'register'" label="确认密码">
        <el-input v-model="gateForm.confirm" type="password" autocomplete="new-password" placeholder="再输一次" show-password @keyup.enter="submitGate" />
      </el-form-item>
      <el-form-item v-if="gateMode === 'setup'" label="确认密码">
        <el-input v-model="gateForm.confirm" type="password" autocomplete="new-password" placeholder="再输一次" show-password @keyup.enter="submitGate" />
      </el-form-item>
      <el-form-item v-if="gateMode === 'setup'" label="管理密钥（认领凭证）">
        <el-input v-model="gateForm.adminKey" type="password" autocomplete="off" placeholder="见服务端启动日志或 config.json 的 admin_api_key" show-password @keyup.enter="submitGate" />
        <div class="field-note">首次创建必须用现有管理密钥认领，避免暴露在公网的实例被陌生人占为管理员。</div>
      </el-form-item>
    </el-form>

    <!-- 注册入口：只有服务端开了 registration.enabled 才出现 -->
    <p v-if="gateMode === 'login' && registrationOpen" class="fallback-line">
      <button type="button" class="link-btn" @click="switchToRegister">
        还没有账号？自助注册
      </button>
    </p>
    <p v-if="gateMode === 'register'" class="fallback-line">
      <button type="button" class="link-btn" @click="switchToLogin">
        已有账号？返回登录
      </button>
    </p>
    <div v-if="gateMode === 'register'" class="field-note reg-note">
      注册后余额为 0，需要管理员充值后才能调用接口；专属调用密钥在「我的仪表盘」里自助生成。
    </div>

    <p v-if="gateMode === 'login'" class="fallback-line">
      <button type="button" class="link-btn" @click="showFallback = !showFallback">
        {{ showFallback ? '收起管理密钥通道' : '忘记密码？用管理密钥进入' }}
      </button>
    </p>
    <div v-if="gateMode === 'login' && showFallback" class="fallback-box">
      <el-input v-model="gateForm.adminKey" type="password" placeholder="输入 X-Admin-Key 的值" show-password @keyup.enter="enterWithAdminKey" />
      <el-button class="fallback-go" @click="enterWithAdminKey">用管理密钥进入</el-button>
      <div class="field-note">管理密钥通道只用于应急与自动化脚本，进去后建议立刻在「账号管理」里补好账号。</div>
    </div>

    <p v-if="gateError" class="gate-error" role="alert">{{ gateError }}</p>

    <template #footer>
      <el-button v-if="gateDismissible" @click="gateVisible = false">稍后再说</el-button>
      <el-button type="primary" :loading="gateBusy" :disabled="!gateValid" @click="submitGate">
        {{ gateMode === 'setup' ? '创建管理员并登录' : (gateMode === 'register' ? '注册并登录' : '登录') }}
      </el-button>
    </template>
  </el-dialog>

  <!-- 修改自己的密码 -->
  <el-dialog v-model="passwordVisible" title="修改密码" width="420px" append-to-body>
    <p class="gate-hint">修改成功后，这个账号在其它设备上的登录状态会立即失效，当前会话自动续上。</p>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="当前密码">
        <el-input v-model="passwordForm.oldPassword" type="password" autocomplete="current-password" show-password />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="passwordForm.newPassword" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="passwordForm.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
    </el-form>
    <p v-if="passwordError" class="gate-error" role="alert">{{ passwordError }}</p>
    <template #footer>
      <el-button @click="passwordVisible = false">取消</el-button>
      <el-button type="primary" :loading="passwordBusy" @click="submitPassword">保存新密码</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useViewport } from './composables/useViewport.js'
import api, {
  getAdminKey, setAdminKey, clearAdminKey,
  getSessionToken, setSessionToken, clearSessionToken
} from './api.js'
import { isAdmin as sharedIsAdmin, setAuth, clearAuth } from './auth-state.js'
import ThemeToggle from './components/ThemeToggle.vue'

const { isMobile } = useViewport()
const route = useRoute()
const router = useRouter()

const collapsed = ref(localStorage.getItem('sidebar-collapsed') === '1')
const drawerOpen = ref(false)

// —— 登录门状态机 ——
// checking → open（已登录/管理密钥通道）| login（要输密码）| setup（首次建管理员）
const gateMode = ref('checking')
const gateVisible = ref(false)
const gateBusy = ref(false)
const gateError = ref('')
const gateDismissible = ref(false)
const showFallback = ref(false)
const needsSetup = ref(false)
// 服务端是否开放自助注册。默认 false——登录页在拿到 /api/auth/registration 之前
// 不显示注册入口，避免点进去才发现 403。
const registrationOpen = ref(false)
const passwordMin = ref(8)
const currentAccount = ref(null)
const currentVia = ref('')
const gateForm = ref({ username: '', password: '', confirm: '', adminKey: '' })

const passwordVisible = ref(false)
const passwordBusy = ref(false)
const passwordError = ref('')
const passwordForm = ref({ oldPassword: '', newPassword: '', confirm: '' })

const isAdmin = sharedIsAdmin
const accountLabel = computed(() => currentAccount.value?.username || '管理密钥通道')
const avatarText = computed(() => (currentAccount.value?.username || 'K').slice(0, 1).toUpperCase())

const gateTitle = computed(() => {
  if (gateMode.value === 'setup') return '初始化管理员账号'
  if (gateMode.value === 'register') return '注册账号'
  return '登录 AI 中转站'
})
const gateHint = computed(() => {
  if (gateMode.value === 'setup') return '这台网关还没有账号。先创建第一个管理员，之后可用用户名与密码登录。'
  if (gateMode.value === 'register') return '填一个用户名和密码即可开通。注册后进入「我的仪表盘」，等管理员充值后就能调用接口。'
  return '输入账号密码登录。管理员进入完整控制台，普通用户进入「我的仪表盘」；管理密钥仍可作为应急通道使用。'
})
const gateValid = computed(() => {
  const f = gateForm.value
  if (!f.username.trim() || f.password.length < passwordMin.value) return false
  if (gateMode.value === 'setup') return f.confirm === f.password && Boolean(f.adminKey.trim())
  if (gateMode.value === 'register') return f.confirm === f.password
  return true
})

function switchToRegister() {
  gateMode.value = 'register'
  gateError.value = ''
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
}

function switchToLogin() {
  gateMode.value = 'login'
  gateError.value = ''
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
}

// 侧边栏上的「有新版本」小红点。检查失败（离线、非 git 部署）静默忽略——
// 一个环境探测的结果不该打断控制台的正常使用。
const updateAvailable = ref(false)
const updateCount = ref(0)

async function checkForUpdate() {
  if (gateMode.value !== 'open') return
  try {
    const r = await api.checkUpdate(false)
    updateAvailable.value = Boolean(r?.ok && r.has_update)
    updateCount.value = r?.behind || 0
  } catch {
    /* 忽略：进「系统更新」页面时会给明确原因 */
  }
}

function enterConsole(account, via) {
  currentAccount.value = account || null
  currentVia.value = via
  setAuth(account, via)
  gateMode.value = 'open'
  gateVisible.value = false
  gateError.value = ''
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
  // 普通用户落地自己的仪表盘；管理员保持当前地址（书签深链不被强行改写）。
  const adminUser = via === 'admin-key' || account?.role === 'admin'
  if (!adminUser && route.path !== '/user') router.replace('/user')
  if (adminUser && route.meta?.userOnly) router.replace('/dashboard')
  if (adminUser) checkForUpdate()
}

// 页面加载：先问服务端「有没有账号」，再决定弹哪个门。
// 关键兼容点：localStorage 里已有 admin-key 的老部署（含 CI 冒烟脚本注入的）
// 即使还没建账号也照常进控制台，只是头部多一个「创建管理员账号」入口，
// 不会被一个强制模态框卡住。
async function bootstrap() {
  let status = { initialized: false, password_min_length: 8 }
  try {
    status = await api.authStatus()
  } catch {
    /* 网络异常：下面按本地凭据决定，随后的请求会再给明确错误 */
  }
  needsSetup.value = !status.initialized
  passwordMin.value = Number(status.password_min_length) || 8

  // 注册开关：失败就当关闭，绝不让登录页出现点了会 403 的入口
  try {
    registrationOpen.value = Boolean((await api.authRegistration())?.enabled)
  } catch {
    registrationOpen.value = false
  }

  if (getSessionToken()) {
    try {
      const me = await api.authMe()
      enterConsole(me.account, me.via || 'session')
      return
    } catch {
      clearSessionToken()
    }
  }

  if (getAdminKey()) {
    enterConsole(status.account || null, status.account ? 'session' : 'admin-key')
    return
  }

  gateMode.value = status.initialized ? 'login' : 'setup'
  gateDismissible.value = false
  gateVisible.value = true
}

function openSetup() {
  gateMode.value = 'setup'
  gateDismissible.value = true
  gateError.value = ''
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
  gateVisible.value = true
}

function onUnauthorized() {
  // 引导期（还没人建账号）任何 401 都不该把「初始化管理员」换成登录框，
  // 否则第一个管理员永远建不出来。管理视图此时也未挂载，401 只可能来自探测。
  if (gateMode.value === 'setup' || (gateMode.value !== 'open' && needsSetup.value)) return
  clearSessionToken()
  clearAuth()
  currentAccount.value = null
  currentVia.value = ''
  gateMode.value = 'login'
  gateDismissible.value = false
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
  gateError.value = '登录状态已失效，请重新登录。'
  gateVisible.value = true
}

function enterWithAdminKey() {
  const key = gateForm.value.adminKey.trim()
  if (!key) { gateError.value = '请先填入管理密钥'; return }
  setAdminKey(key)
  location.reload()
}

async function submitGate() {
  if (!gateValid.value || gateBusy.value) return
  const mode = gateMode.value
  gateBusy.value = true
  gateError.value = ''
  try {
    const out = mode === 'setup'
      ? await api.authSetup({
          username: gateForm.value.username.trim(),
          password: gateForm.value.password,
          admin_key: gateForm.value.adminKey.trim()
        })
      : mode === 'register'
        ? await api.authRegister({
            username: gateForm.value.username.trim(),
            password: gateForm.value.password
          })
        : await api.authLogin({
            username: gateForm.value.username.trim(),
            password: gateForm.value.password
          })
    setSessionToken(out.token)
    clearAdminKey()
    needsSetup.value = false
    enterConsole(out.account, 'session')
    ElMessage.success(
      mode === 'setup' ? '管理员已创建'
        : mode === 'register' ? `注册成功，欢迎 ${out.account.username}`
          : `欢迎回来，${out.account.username}`
    )
  } catch (e) {
    gateError.value = e?.message || '操作失败，请重试'
  } finally {
    gateBusy.value = false
  }
}

function openPassword() {
  if (!currentAccount.value) {
    ElMessage.warning('管理密钥通道没有账号密码，请先创建管理员账号')
    openSetup()
    return
  }
  passwordForm.value = { oldPassword: '', newPassword: '', confirm: '' }
  passwordError.value = ''
  passwordVisible.value = true
}

async function submitPassword() {
  const f = passwordForm.value
  passwordError.value = ''
  if (!f.oldPassword || f.newPassword.length < passwordMin.value) {
    passwordError.value = `新密码至少 ${passwordMin.value} 位，并请填写当前密码`
    return
  }
  if (f.newPassword !== f.confirm) { passwordError.value = '两次输入的新密码不一致'; return }
  passwordBusy.value = true
  try {
    const out = await api.authChangePassword({ old_password: f.oldPassword, new_password: f.newPassword })
    setSessionToken(out.token)
    currentAccount.value = out.account
    passwordVisible.value = false
    ElMessage.success('密码已更新，其它设备的登录状态已失效')
  } catch (e) {
    passwordError.value = e?.message || '修改失败'
  } finally {
    passwordBusy.value = false
  }
}

async function logout() {
  try {
    await ElMessageBox.confirm('退出后需要重新输入账号密码（或用管理密钥）才能进入控制台。', '退出登录', {
      type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try { await api.authLogout() } catch { /* 审计失败不拦登出 */ }
  clearSessionToken()
  clearAdminKey()
  clearAuth()
  currentAccount.value = null
  currentVia.value = ''
  gateMode.value = 'login'
  gateDismissible.value = false
  gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
  gateError.value = ''
  gateVisible.value = true
}

async function onAccountCommand(command) {
  if (command === 'password') openPassword()
  else if (command === 'switch') {
    try { await api.authLogout() } catch { /* ignore */ }
    clearSessionToken()
    clearAdminKey()
    clearAuth()
    currentAccount.value = null
    currentVia.value = ''
    gateMode.value = 'login'
    gateForm.value = { username: '', password: '', confirm: '', adminKey: '' }
    gateError.value = ''
    gateVisible.value = true
  } else if (command === 'logout') logout()
}

onMounted(() => {
  bootstrap()
  window.addEventListener('gateway-unauthorized', onUnauthorized)
  window.addEventListener('keydown', onKeydown)
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

<style scoped>
.setup-entry {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--warn);
  border-radius: var(--r-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
}
.setup-entry:hover { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-line); }

.account-box { flex-shrink: 0; }
.account-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12.5px;
  font-family: var(--font-sans);
  cursor: pointer;
}
.account-trigger:hover { border-color: var(--rule-strong); color: var(--ink); }
.account-avatar {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-xs);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
}
.account-name { max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.gate-hint { margin: 0 0 16px; font-size: 13px; line-height: 1.7; color: var(--ink-3); }
.field-note { margin-top: 5px; font-size: 11.5px; line-height: 1.6; color: var(--ink-4); }
.fallback-line { margin: 2px 0 0; }
.link-btn {
  border: none;
  background: none;
  padding: 2px 0;
  color: var(--info);
  font-size: 12.5px;
  font-family: var(--font-sans);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.fallback-box { margin-top: 10px; padding: 10px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--surface-2); }
.fallback-go { margin-top: 8px; width: 100%; }
.gate-error {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  line-height: 1.6;
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
}

@media (max-width: 767px) {
  .account-name { display: none; }
  .setup-entry { font-size: 11px; padding: 4px 7px; }
}
</style>
