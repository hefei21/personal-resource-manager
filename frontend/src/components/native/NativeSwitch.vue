<template>
  <div
    class="native-switch"
    :class="{
      'native-switch--checked': modelValue,
      'native-switch--disabled': disabled,
      'native-switch--small': size === 'small',
      'native-switch--large': size === 'large'
    }"
    role="switch"
    :aria-checked="modelValue"
    :aria-disabled="disabled"
    tabindex="0"
    @click="toggle"
    @keydown.enter.prevent="toggle"
    @keydown.space.prevent="toggle"
  >
    <div class="native-switch__handle" aria-hidden="true">
      <div v-if="loading" class="native-switch__loading"></div>
    </div>
    <div v-if="label" class="native-switch__label">{{ label }}</div>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  size: { type: String, default: 'medium' }, // small, medium, large
  label: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'change'])

function toggle() {
  if (props.disabled || props.loading) return
  const newValue = !props.modelValue
  emit('update:modelValue', newValue)
  emit('change', newValue)
}
</script>

<style scoped>
.native-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  outline: none;
}

.native-switch:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
  border-radius: 4px;
}

.native-switch__handle {
  position: relative;
  width: 44px;
  height: 24px;
  background: #dcdcdc;
  border-radius: 12px;
  transition: background 0.3s;
  flex-shrink: 0;
}

.native-switch__handle::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.3s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.native-switch--checked .native-switch__handle {
  background: #0052d9;
}

.native-switch--checked .native-switch__handle::before {
  transform: translateX(20px);
}

.native-switch--small .native-switch__handle {
  width: 36px;
  height: 20px;
  border-radius: 10px;
}

.native-switch--small .native-switch__handle::before {
  width: 16px;
  height: 16px;
}

.native-switch--small.native-switch--checked .native-switch__handle::before {
  transform: translateX(16px);
}

.native-switch--large .native-switch__handle {
  width: 52px;
  height: 28px;
  border-radius: 14px;
}

.native-switch--large .native-switch__handle::before {
  width: 24px;
  height: 24px;
}

.native-switch--large.native-switch--checked .native-switch__handle::before {
  transform: translateX(24px);
}

.native-switch--disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.native-switch__label {
  font-size: 14px;
  color: #333;
}

.native-switch__loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
</style>
