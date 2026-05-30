<template>
  <div class="native-input-wrapper">
    <input
      ref="inputRef"
      :class="['native-input', { 'native-input--clearable': clearable }]"
      :type="type"
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
  disabled: { type: Boolean, default: false }
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
  height: 32px;
  padding: 0 12px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  font-size: 14px;
  background: #fff;
  transition: all 0.2s;
  outline: none;
}

.native-input:focus {
  border-color: #0052d9;
  box-shadow: 0 0 0 2px rgba(0, 82, 217, 0.1);
}

.native-input:disabled {
  background: #f5f5f5;
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
  color: #999;
  cursor: pointer;
  border-radius: 50%;
  transition: all 0.2s;
  background: transparent;
  border: none;
  padding: 0;
}

.native-input__clear:hover {
  background: #f0f0f0;
  color: #666;
}

.native-input__clear:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-input__suffix {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  color: #999;
}
</style>
