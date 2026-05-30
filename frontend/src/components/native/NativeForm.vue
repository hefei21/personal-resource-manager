<template>
  <form class="native-form" :class="[`native-form--${layout}`]" @submit.prevent="handleSubmit">
    <slot />
  </form>
</template>

<script setup>
import { provide, reactive, computed } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  rules: { type: Object, default: () => ({}) },
  layout: { type: String, default: 'horizontal' }, // horizontal, vertical, inline
  labelWidth: { type: [String, Number], default: '80px' },
  labelAlign: { type: String, default: 'right' }, // left, right, center
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['submit', 'validate'])

// 错误状态
const errors = reactive({})

// 提供给子组件的上下文
const formContext = computed(() => ({
  layout: props.layout,
  labelWidth: props.labelWidth,
  labelAlign: props.labelAlign,
  disabled: props.disabled,
  errors,
  validateField,
  clearValidate
}))

provide('nativeForm', formContext.value)

// 验证单个字段
async function validateField(fieldName) {
  const fieldRules = props.rules[fieldName]
  if (!fieldRules || fieldRules.length === 0) return true
  
  const value = props.modelValue[fieldName]
  
  for (const rule of fieldRules) {
    // 必填验证
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors[fieldName] = rule.message || '此字段为必填项'
      return false
    }
    
    // 最小长度验证
    if (rule.min !== undefined && value && value.length < rule.min) {
      errors[fieldName] = rule.message || `最少需要 ${rule.min} 个字符`
      return false
    }
    
    // 最大长度验证
    if (rule.max !== undefined && value && value.length > rule.max) {
      errors[fieldName] = rule.message || `最多允许 ${rule.max} 个字符`
      return false
    }
    
    // 正则验证
    if (rule.pattern && value && !rule.pattern.test(value)) {
      errors[fieldName] = rule.message || '格式不正确'
      return false
    }
    
    // 自定义验证函数
    if (rule.validator && typeof rule.validator === 'function') {
      try {
        const result = await rule.validator(value, props.modelValue)
        if (result !== true) {
          errors[fieldName] = result || rule.message || '验证失败'
          return false
        }
      } catch (e) {
        errors[fieldName] = e.message || '验证失败'
        return false
      }
    }
  }
  
  // 验证通过，清除错误
  delete errors[fieldName]
  return true
}

// 验证所有字段
async function validate() {
  const fields = Object.keys(props.rules)
  const results = await Promise.all(fields.map(field => validateField(field)))
  const isValid = results.every(result => result)
  emit('validate', isValid, errors)
  return isValid
}

// 清除验证状态
function clearValidate(fieldName) {
  if (fieldName) {
    delete errors[fieldName]
  } else {
    Object.keys(errors).forEach(key => delete errors[key])
  }
}

// 提交处理
async function handleSubmit() {
  const isValid = await validate()
  if (isValid) {
    emit('submit', props.modelValue)
  }
}

// 暴露方法
defineExpose({
  validate,
  validateField,
  clearValidate
})
</script>

<style scoped>
.native-form {
  width: 100%;
}

.native-form--inline {
  display: flex;
  flex-wrap: wrap;
  gap: 0 16px;
}

.native-form--inline :deep(.native-form-item) {
  margin-bottom: 16px;
}
</style>
