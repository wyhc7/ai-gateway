<template>
  <button
    class="rail"
    :class="{ on: modelValue, sm: small }"
    role="switch"
    type="button"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="label || (modelValue ? '开启' : '关闭')"
    :disabled="disabled"
    @click="onClick"
  >
    <span class="rail-knob" />
  </button>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  small: { type: Boolean, default: false },
  label: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'change'])

function onClick() {
  if (props.disabled) return
  const next = !props.modelValue
  emit('update:modelValue', next)
  emit('change', next)
}
</script>

<style scoped>
.rail {
  position: relative;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--rule-strong);
  border-radius: var(--r-xs);
  background: var(--surface-2);
  cursor: pointer;
  transition: background-color 0.16s, border-color 0.16s;
}

.rail.sm { width: 28px; height: 15px; }

.rail:disabled { opacity: 0.45; cursor: not-allowed; }

.rail-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 1px;
  background: var(--ink-4);
  transition: transform 0.16s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.16s;
}

.rail.sm .rail-knob { width: 9px; height: 9px; }

.rail.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.rail.on .rail-knob {
  background: var(--accent);
  transform: translateX(16px);
}
.rail.sm.on .rail-knob { transform: translateX(13px); }

@media (prefers-reduced-motion: reduce) {
  .rail, .rail-knob { transition: none; }
}
</style>
