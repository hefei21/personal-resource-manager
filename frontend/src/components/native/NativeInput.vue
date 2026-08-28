<template>
  <div class="native-input-wrapper">
    <input
      ref="inputRef"
      :class="['native-input', { 'native-input--clearable': clearable }]"
      :type="type"
      :id="id"
      :name="name"
      :autocomplete="autocomplete"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-disabled="disabled"
      :aria-placeholder="placeholder"
      @input="handleInput"
      @keyup.enter="handleEnter"
      @focus="handleFocus"
      @blur="handleBlur"
    />
    <button 
      v-if="clearable && modelValue" 
      class="native-input__clear" 
      @click="handleClear"
      type="button"
      aria-label="清除"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>
    <span v-if="$slots.suffix" class="native-input__suffix">
      <slot name="suffix" />
    </span>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  clearable: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  id: { type: String, default: undefined },
  name: { type: String, default: undefined },
  autocomplete: { type: String, default: undefined }
})

const emit = defineEmits(['update:modelValue', 'enter', 'clear', 'focus', 'blur'])

// 内部 input ref
const inputRef = ref(null)

// 暴露 focus 方法
function focus() {
  inputRef.value?.focus()
}

function blur() {
  inputRef.value?.blur()
}

defineExpose({
  focus,
  blur
})

function handleInput(e) {
  emit('update:modelValue', e.target.value)
}

function handleEnter(e) {
  emit('enter', e)
}

function handleClear() {
  emit('update:modelValue', '')
  emit('clear')
}

function handleFocus(e) {
  emit('focus', e)
}

function handleBlur(e) {
  emit('blur', e)
}
</script>

<style scoped>
.native-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.native-input {
  width: 100%;
  height: var(--control-height-md);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font: inherit;
  background: var(--color-surface-raised);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-standard), box-shadow var(--motion-duration-fast) var(--motion-easing-standard);
  outline: none;
}

.native-input:focus {
  border-color: var(--color-focus-ring);
  box-shadow: 0 0 0 3px var(--color-primary-surface);
}

.native-input:disabled {
  color: var(--color-text-disabled);
  background: var(--color-surface-subtle);
  cursor: not-allowed;
}

.native-input--clearable { padding-right: 32px; }

.native-input__clear {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 50%;
  transition: color var(--motion-duration-fast) var(--motion-easing-standard), background-color var(--motion-duration-fast) var(--motion-easing-standard);
  background: transparent;
  border: none;
  padding: 0;
}

.native-input__clear:hover {
  background: var(--color-surface-subtle);
  color: var(--color-text-primary);
}

.native-input__clear:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.native-input__suffix {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  color: var(--color-text-muted);
}

@media (max-width: 768px) {
  .native-input { height: var(--control-height-touch); font-size: 16px; }
  .native-input__clear { width: 32px; height: 32px; }
}
</style>
