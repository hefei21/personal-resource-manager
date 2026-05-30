<template>
  <div 
    class="native-button-group" 
    :class="[
      `native-button-group--${size}`,
      { 'native-button-group--outline': outline }
    ]"
  >
    <button
      v-for="(item, index) in options"
      :key="getValue(item)"
      class="native-button-group__item"
      :class="{
        'native-button-group__item--active': isActive(item),
        'native-button-group__item--disabled': item.disabled || disabled
      }"
      :disabled="item.disabled || disabled"
      @click="select(item, index)"
    >
      <slot :item="item" :index="index" :active="isActive(item)">
        {{ getLabel(item) }}
      </slot>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  valueKey: { type: String, default: 'value' },
  labelKey: { type: String, default: 'label' },
  size: { type: String, default: 'medium' }, // small, medium, large
  disabled: { type: Boolean, default: false },
  outline: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

// 获取值
function getValue(item) {
  return typeof item === 'object' ? item[props.valueKey] : item
}

// 获取标签
function getLabel(item) {
  return typeof item === 'object' ? item[props.labelKey] : item
}

// 是否选中
function isActive(item) {
  const value = getValue(item)
  if (props.multiple) {
    return Array.isArray(props.modelValue) && props.modelValue.includes(value)
  }
  return props.modelValue === value
}

// 选择
function select(item, index) {
  if (item.disabled || props.disabled) return
  
  const value = getValue(item)
  
  if (props.multiple) {
    const values = Array.isArray(props.modelValue) ? [...props.modelValue] : []
    const idx = values.indexOf(value)
    if (idx > -1) {
      values.splice(idx, 1)
    } else {
      values.push(value)
    }
    emit('update:modelValue', values)
    emit('change', values, item, index)
  } else {
    emit('update:modelValue', value)
    emit('change', value, item, index)
  }
}
</script>

<style scoped>
.native-button-group {
  display: inline-flex;
  vertical-align: middle;
}

.native-button-group__item {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1;
  color: #333;
  background: #fff;
  border: 1px solid #dcdcdc;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.native-button-group__item:first-child {
  border-radius: 6px 0 0 6px;
}

.native-button-group__item:last-child {
  border-radius: 0 6px 6px 0;
}

.native-button-group__item:not(:first-child) {
  margin-left: -1px;
}

.native-button-group__item:hover:not(:disabled) {
  color: #0052d9;
  border-color: #0052d9;
  z-index: 1;
}

.native-button-group__item--active {
  color: #fff;
  background: #0052d9;
  border-color: #0052d9;
  z-index: 2;
}

.native-button-group__item--active:hover:not(:disabled) {
  color: #fff;
  background: #0043b5;
  border-color: #0043b5;
}

.native-button-group__item:disabled {
  color: #ccc;
  background: #f5f5f5;
  cursor: not-allowed;
}

/* 尺寸变体 */
.native-button-group--small .native-button-group__item {
  padding: 6px 12px;
  font-size: 13px;
}

.native-button-group--small .native-button-group__item:first-child {
  border-radius: 4px 0 0 4px;
}

.native-button-group--small .native-button-group__item:last-child {
  border-radius: 0 4px 4px 0;
}

.native-button-group--large .native-button-group__item {
  padding: 10px 20px;
  font-size: 15px;
}

.native-button-group--large .native-button-group__item:first-child {
  border-radius: 8px 0 0 8px;
}

.native-button-group--large .native-button-group__item:last-child {
  border-radius: 0 8px 8px 0;
}

/* outline 样式 */
.native-button-group--outline .native-button-group__item {
  background: transparent;
}

.native-button-group--outline .native-button-group__item--active {
  background: #0052d9;
}
</style>
