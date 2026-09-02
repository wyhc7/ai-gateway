import { createApp } from 'vue'
import { ElLoading } from 'element-plus'
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/main.css'
import './styles.css'
import App from './App.vue'
import router from './router.js'
import { useTheme } from './theme.js'

// 主题必须在挂载前定好，否则首帧会闪
useTheme().initTheme()

const app = createApp(App)
app.directive('loading', ElLoading.directive)
app.use(router)
app.mount('#app')
