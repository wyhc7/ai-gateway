<template>
  <div class="seg" role="group" aria-label="主题切换">
    <button
      class="seg-btn"
      :class="{ on: theme === 'light' }"
      type="button"
      title="暖白"
      @click="setTheme('light')"
    >日</button>
    <button
      class="seg-btn"
      :class="{ on: theme === 'dark' }"
      type="button"
      title="深色"
      @click="setTheme('dark')"
    >夜</button>
  </div>
</template>

<script setup>
import { useTheme } from '../theme.js'

const { theme, setTheme } = useTheme()
</script>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--r-xs);
  overflow: hidden;
  background: var(--surface);
  flex-shrink: 0;
}

.seg-btn {
  width: 28px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--ink-3);
  font-family: var(--font-sans);
  font-size: 12.5px;
  cursor: pointer;
  transition: background-color 0.14s, color 0.14s;
}

.seg-btn + .seg-btn { border-left: 1px solid var(--rule-soft); }

.seg-btn:hover { color: var(--ink); background: var(--surface-2); }

.seg-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
</style>
