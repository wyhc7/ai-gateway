import { ref } from 'vue'

const STORAGE_KEY = 'gw-theme'

function systemPrefers() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* localStorage 不可用时回退到系统偏好 */
  }
  return null
}

function apply(next) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', next)
  root.classList.toggle('dark', next === 'dark')
}

const theme = ref('light')

function initTheme() {
  theme.value = readStored() || systemPrefers()
  apply(theme.value)
}

function setTheme(next) {
  if (next !== 'light' && next !== 'dark') return
  theme.value = next
  apply(next)
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 忽略写入失败 */
  }
}

function toggleTheme() {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
}

export function useTheme() {
  return { theme, initTheme, setTheme, toggleTheme }
}
