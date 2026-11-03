<template>
  <div 
    ref="groupRef"
    class="native-radio-group" 
    :class="{ 'native-radio-group--filled': variant === 'default-filled' }"
    role="radiogroup"
    :aria-label="ariaLabel"
    @keydown="handleKeydown"
  >
    <slot />
  </div>
</template>

<script setup>
import { provide, ref, watch, onMounted, nextTick } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  variant: { type: String, default: '' }, // 'default-filled' 表示按钮组样式
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'change'])

// 内部状态
const internalValue = ref(props.modelValue)
const groupRef = ref(null)
const optionValues = ref([])

// 监听外部值变化
watch(() => props.modelValue, (newVal) => {
  internalValue.value = newVal
})

// 注册选项值（由子组件调用）
function registerOption(value) {
  if (!optionValues.value.includes(value)) {
    optionValues.value.push(value)
  }
}

// 取消注册选项值
function unregisterOption(value) {
  const index = optionValues.value.indexOf(value)
  if (index > -1) {
    optionValues.value.splice(index, 1)
  }
}

// 方向键导航
function handleKeydown(e) {
  if (props.disabled || optionValues.value.length === 0) return
  
  const currentIndex = optionValues.value.indexOf(internalValue.value)
  const radios = [...(groupRef.value?.querySelectorAll('.native-radio') || [])]
  const enabled = optionValues.value.map((_, index) => radios[index]?.getAttribute('aria-disabled') === 'true' ? -1 : index).filter(index => index >= 0)
  if (!enabled.length) return
  const position = enabled.indexOf(currentIndex)
  let newIndex = currentIndex
  
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      e.preventDefault()
      newIndex = enabled[(position - 1 + enabled.length) % enabled.length]
      break
    case 'ArrowDown':
    case 'ArrowRight':
      e.preventDefault()
      newIndex = enabled[(position + 1) % enabled.length]
      break
    case 'Home':
      e.preventDefault()
      newIndex = enabled[0]
      break
    case 'End':
      e.preventDefault()
      newIndex = enabled.at(-1)
      break
    default:
      return
  }
  
  if (newIndex !== currentIndex) {
    const newValue = optionValues.value[newIndex]
    updateValue(newValue)
    
    // 聚焦到新选中的 radio
    nextTick(() => {
      const radios = groupRef.value?.querySelectorAll('.native-radio')
      if (radios && radios[newIndex]) {
        radios[newIndex].focus()
      }
    })
  }
}

function updateValue(value) {
  if (props.disabled || value === internalValue.value) return
  internalValue.value = value
  emit('update:modelValue', value)
  emit('change', value)
}

// 提供给子组件
const radioGroupState = {
  get modelValue() {
    return internalValue.value
  },
  get variant() { return props.variant },
  get disabled() { return props.disabled },
  updateValue,
  registerOption,
  unregisterOption
}

provide('radioGroup', radioGroupState)
provide('radioName', 'radio-' + Math.random().toString(36).substr(2, 9))
</script>

<style scoped>
.native-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.native-radio-group--filled {
  gap: 0;
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  overflow: hidden;
}
</style>
