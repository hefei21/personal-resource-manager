<template>
  <label
    class="native-radio"
    :class="{
      'native-radio--checked': isChecked,
      'native-radio--disabled': isDisabled,
      'native-radio--filled': isFilledVariant,
      'native-radio--filled-checked': isFilledVariant && isChecked
    }"
    @click="handleChange"
    @keydown.enter.prevent="handleChange"
    @keydown.space.prevent="handleChange"
    tabindex="0"
    role="radio"
    :aria-checked="isChecked"
    :aria-disabled="isDisabled"
  >
    <input
      v-if="!isFilledVariant"
      type="radio"
      :name="name"
      :value="value"
      :checked="isChecked"
      :disabled="isDisabled"
      @change="handleChange"
      tabindex="-1"
    />
    <span v-if="!isFilledVariant" class="native-radio__input" aria-hidden="true">
      <span class="native-radio__inner"></span>
    </span>
    <span class="native-radio__label">
      <slot />
    </span>
  </label>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  value: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['change'])

// 从父组件注入
const radioGroup = inject('radioGroup', null)
const name = inject('radioName', '')

const isFilledVariant = computed(() => radioGroup?.variant === 'default-filled')

// 判断是否禁用（考虑父组件的禁用状态）
const isDisabled = computed(() => {
  if (props.disabled) return true
  if (radioGroup?.disabled) return true
  return false
})

// 使用注入的状态方法读取选中状态
const isChecked = computed(() => {
  if (radioGroup) {
    return radioGroup.modelValue === props.value
  }
  return false
})

function handleChange() {
  if (isDisabled.value) return
  if (radioGroup) {
    radioGroup.updateValue(props.value)
  }
  emit('change', props.value)
}

// 注册到父组件
onMounted(() => {
  if (radioGroup?.registerOption) {
    radioGroup.registerOption(props.value)
  }
})

onUnmounted(() => {
  if (radioGroup?.unregisterOption) {
    radioGroup.unregisterOption(props.value)
  }
})
</script>

<style scoped>
.native-radio {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  margin-right: 16px;
  outline: none;
}

.native-radio:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
  border-radius: 4px;
}

.native-radio input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.native-radio__input {
  position: relative;
  width: 16px;
  height: 16px;
  border: 2px solid #dcdcdc;
  border-radius: 50%;
  transition: all 0.2s;
  flex-shrink: 0;
}

.native-radio:hover:not(.native-radio--disabled) .native-radio__input {
  border-color: #0052d9;
}

.native-radio__inner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0);
  width: 8px;
  height: 8px;
  background: #0052d9;
  border-radius: 50%;
  transition: transform 0.2s;
}

.native-radio--checked .native-radio__input {
  border-color: #0052d9;
}

.native-radio--checked .native-radio__inner {
  transform: translate(-50%, -50%) scale(1);
}

.native-radio--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.native-radio--disabled .native-radio__input {
  border-color: #ddd;
  background: #f5f5f5;
}

.native-radio--disabled .native-radio__inner {
  background: #ccc;
}

.native-radio__label {
  color: #333;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.native-radio--disabled .native-radio__label {
  color: #999;
}

/* 按钮组样式 - 灰色背景未选中，白色背景选中 */
.native-radio--filled {
  margin-right: 0;
  padding: 8px 16px;
  background: #f3f3f3;
  border-right: 1px solid #e7e7e7;
  transition: all 0.2s;
  color: #333;
}

.native-radio--filled:last-child {
  border-right: none;
}

.native-radio--filled:hover:not(.native-radio--disabled) {
  background: #e7e7e7;
}

/* 选中状态：白色背景 */
.native-radio--filled.native-radio--filled-checked {
  background: #fff;
  box-shadow: inset 0 0 0 1px #dcdcdc;
}

.native-radio--filled.native-radio--filled-checked .native-radio__label {
  color: #333;
  font-weight: 500;
}

.native-radio--filled.native-radio--disabled {
  background: #f5f5f5;
  opacity: 0.6;
}
</style>
