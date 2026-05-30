<template>
  <label
    class="native-checkbox"
    :class="{
      'native-checkbox--checked': modelValue,
      'native-checkbox--indeterminate': indeterminate,
      'native-checkbox--disabled': disabled
    }"
    role="checkbox"
    :aria-checked="indeterminate ? 'mixed' : modelValue"
    :aria-disabled="disabled"
    tabindex="0"
    @keydown.enter.prevent="toggle"
    @keydown.space.prevent="toggle"
  >
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="handleChange"
      class="native-checkbox__input"
      tabindex="-1"
      ref="checkboxRef"
    />
    <span class="native-checkbox__box" aria-hidden="true">
      <!-- 全选状态 -->
      <svg v-if="modelValue && !indeterminate" viewBox="0 0 24 24" width="14" height="14">
        <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
      <!-- 半选状态 -->
      <svg v-else-if="indeterminate" viewBox="0 0 24 24" width="14" height="14">
        <rect x="4" y="10" width="16" height="4" rx="1" fill="currentColor"/>
      </svg>
    </span>
    <span v-if="$slots.default" class="native-checkbox__label">
      <slot />
    </span>
  </label>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  indeterminate: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const checkboxRef = ref(null)

// 同步 indeterminate 到原生 input
watch(() => props.indeterminate, (val) => {
  if (checkboxRef.value) {
    checkboxRef.value.indeterminate = val
  }
})

onMounted(() => {
  if (checkboxRef.value) {
    checkboxRef.value.indeterminate = props.indeterminate
  }
})

const emit = defineEmits(['update:modelValue', 'change'])

function handleChange(e) {
  const checked = e.target.checked
  emit('update:modelValue', checked)
  emit('change', checked)
}

function toggle() {
  if (props.disabled) return
  const newValue = !props.modelValue
  emit('update:modelValue', newValue)
  emit('change', newValue)
}
</script>

<style scoped>
.native-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  outline: none;
}

.native-checkbox:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
  border-radius: 4px;
}

.native-checkbox--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.native-checkbox__input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.native-checkbox__box {
  width: 16px;
  height: 16px;
  border: 2px solid #dcdcdc;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  color: #fff;
  flex-shrink: 0;
}

.native-checkbox:hover:not(.native-checkbox--disabled) .native-checkbox__box {
  border-color: #0052d9;
}

.native-checkbox--checked .native-checkbox__box {
  background: #0052d9;
  border-color: #0052d9;
}

.native-checkbox--indeterminate .native-checkbox__box {
  background: #0052d9;
  border-color: #0052d9;
}

.native-checkbox__label {
  font-size: 14px;
  color: #333;
}
</style>
