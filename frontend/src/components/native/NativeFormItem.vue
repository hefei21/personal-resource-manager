<template>
  <div 
    class="native-form-item" 
    :class="{ 
      'native-form-item--required': isRequired,
      'native-form-item--error': hasError,
      'native-form-item--inline': inline,
      'native-form-item--vertical': layout === 'vertical'
    }"
  >
    <label v-if="label || $slots.label" :id="labelId" :for="firstControlId" class="native-form-item__label" :style="labelStyle">
      <slot name="label">{{ label }}</slot>
      <span v-if="isRequired" class="required-mark" aria-hidden="true">*</span>
    </label>
    <div class="native-form-item__content">
      <slot />
      <transition name="fade">
        <div v-if="errorMessage" :id="`${feedbackId}-error`" class="native-form-item__error" role="alert">
          {{ errorMessage }}
        </div>
        <div v-else-if="tips" :id="`${feedbackId}-tips`" class="native-form-item__tips">
          {{ tips }}
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, provide, ref, useId, useSlots } from 'vue'

const props = defineProps({
  label: { type: String, default: '' },
  name: { type: String, default: '' },
  required: { type: Boolean, default: false },
  rules: { type: Array, default: () => [] },
  tips: { type: String, default: '' },
  labelWidth: { type: [String, Number], default: '' },
  labelAlign: { type: String, default: '' },
  layout: { type: String, default: '' } // horizontal, vertical
})

// 注入表单上下文
const formContext = inject('nativeForm', {
  layout: 'horizontal',
  labelWidth: '80px',
  labelAlign: 'right',
  errors: {}
})

// 是否内联
const inline = computed(() => formContext.layout === 'inline')

// 当前布局
const layout = computed(() => props.layout || formContext.layout)

// 标签样式
const labelStyle = computed(() => {
  const style = {}
  const width = props.labelWidth || formContext.labelWidth
  const align = props.labelAlign || formContext.labelAlign
  
  if (width && layout.value !== 'vertical') {
    style.width = typeof width === 'number' ? `${width}px` : width
  }
  if (align) {
    style.textAlign = align
  }
  return style
})

// 是否必填
const isRequired = computed(() => {
  if (props.required) return true
  return [...props.rules, ...(formContext.rules?.[props.name] || [])].some(rule => rule.required)
})

// 错误信息
const errorMessage = computed(() => {
  if (props.name && formContext.errors) {
    return formContext.errors[props.name]
  }
  return ''
})

// 是否有错误
const hasError = computed(() => !!errorMessage.value)
const itemId = `native-form-item-${useId()}`
const slots = useSlots()
const labelId = computed(() => props.label || slots.label ? `${itemId}-label` : undefined)
const feedbackId = `${itemId}-feedback`
const firstControlId = ref()
const controls = new Set()
provide('nativeFormItem', {
  labelId,
  descriptionId: computed(() => errorMessage.value ? `${feedbackId}-error` : props.tips ? `${feedbackId}-tips` : undefined),
  invalid: hasError,
  required: isRequired,
  register(id) {
    controls.add(id)
    firstControlId.value = controls.values().next().value
    return () => {
      controls.delete(id)
      firstControlId.value = controls.values().next().value
    }
  }
})
</script>

<style scoped>
.native-form-item {
  display: flex;
  align-items: flex-start;
  margin-bottom: 20px;
}

.native-form-item--inline {
  display: inline-flex;
  margin-right: 16px;
  margin-bottom: 0;
}

.native-form-item--vertical {
  flex-direction: column;
}

.native-form-item__label {
  flex-shrink: 0;
  padding: 8px 12px 8px 0;
  font-size: 14px;
  color: var(--color-text-primary);
  line-height: 1.5;
}

.native-form-item--vertical .native-form-item__label {
  padding: 0 0 8px 0;
}

.native-form-item--vertical .native-form-item__content {
  width: 100%;
  flex: auto;
}

.required-mark {
  color: var(--color-danger);
  margin-left: 4px;
}

.native-form-item__content {
  flex: 1;
  min-width: 0;
  position: relative;
}

.native-form-item__error {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-danger);
  line-height: 1.5;
}

.native-form-item__tips {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.native-form-item--error :deep(.native-input__input),
.native-form-item--error :deep(.native-select__trigger) {
  border-color: var(--color-danger);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 响应式 */
@media (max-width: 768px) {
  .native-form-item {
    flex-direction: column;
  }
  
  .native-form-item__label {
    width: auto !important;
    padding: 0 0 8px 0;
  }
  .native-form-item__content {
    width: 100%;
    flex: auto;
  }
}
</style>
