<template>
  <div 
    class="native-tag-input" 
    :class="{ 
      'native-tag-input--focused': isFocused, 
      'native-tag-input--disabled': disabled,
      'native-tag-input--error': error
    }"
    @click="focusInput"
  >
    <!-- 标签列表 -->
    <span 
      v-for="(tag, index) in tags" 
      :key="index"
      class="native-tag-input__tag"
      :class="{ 'native-tag-input__tag--closable': !disabled }"
    >
      {{ tag }}
      <span v-if="!disabled" class="native-tag-input__close" @click.stop="removeTag(index)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </span>
    </span>
    
    <!-- 输入框 -->
    <input
      ref="inputRef"
      v-model="inputValue"
      class="native-tag-input__input"
      :placeholder="tags.length === 0 ? placeholder : ''"
      :disabled="disabled"
      @focus="isFocused = true"
      @blur="handleBlur"
      @keydown.enter.prevent="addTag"
      @keydown.backspace="handleBackspace"
    />
    
    <!-- 数量限制提示 -->
    <span v-if="maxTags > 0" class="native-tag-input__count">
      {{ tags.length }}/{{ maxTags }}
    </span>
  </div>
  
  <!-- 错误提示 -->
  <div v-if="error && errorMessage" class="native-tag-input__error-msg">
    {{ errorMessage }}
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请输入标签' },
  disabled: { type: Boolean, default: false },
  maxTags: { type: Number, default: 0 },
  maxLength: { type: Number, default: 0 },
  allowDuplicate: { type: Boolean, default: false },
  separator: { type: String, default: '' },
  createTagOnBlur: { type: Boolean, default: false },
  validator: { type: Function, default: null },
  error: { type: Boolean, default: false },
  errorMessage: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'change', 'exceed', 'input'])

const inputRef = ref(null)
const inputValue = ref('')
const isFocused = ref(false)

const tags = computed({
  get: () => props.modelValue,
  set: (val) => {
    emit('update:modelValue', val)
    emit('change', val)
  }
})

// 聚焦输入框
function focusInput() {
  if (!props.disabled) {
    inputRef.value.focus()
  }
}

// 添加标签
function addTag() {
  const value = inputValue.value.trim()
  if (!value) return
  
  // 检查分隔符，支持一次添加多个标签
  const newTags = props.separator 
    ? value.split(props.separator).map(t => t.trim()).filter(t => t)
    : [value]
  
  for (const tag of newTags) {
    // 检查长度限制
    if (props.maxLength > 0 && tag.length > props.maxLength) {
      continue
    }
    
    // 检查重复
    if (!props.allowDuplicate && tags.value.includes(tag)) {
      continue
    }
    
    // 自定义验证
    if (props.validator && !props.validator(tag)) {
      continue
    }
    
    // 检查数量限制
    if (props.maxTags > 0 && tags.value.length >= props.maxTags) {
      emit('exceed', tag, tags.value)
      break
    }
    
    tags.value = [...tags.value, tag]
  }
  
  inputValue.value = ''
}

// 移除标签
function removeTag(index) {
  if (props.disabled) return
  const newTags = [...tags.value]
  newTags.splice(index, 1)
  tags.value = newTags
}

// 处理失焦
function handleBlur() {
  isFocused.value = false
  if (props.createTagOnBlur && inputValue.value.trim()) {
    addTag()
  }
}

// 处理退格键
function handleBackspace(e) {
  if (inputValue.value === '' && tags.value.length > 0) {
    removeTag(tags.value.length - 1)
  }
}

// 监听输入
watch(inputValue, (val) => {
  emit('input', val)
})

// 暴露方法
defineExpose({
  focus: focusInput,
  blur: () => inputRef.value?.blur(),
  clear: () => {
    tags.value = []
    inputValue.value = ''
  }
})
</script>

<style scoped>
.native-tag-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  min-height: 36px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  background: #fff;
  cursor: text;
  transition: all 0.2s;
}

.native-tag-input:hover:not(.native-tag-input--disabled) {
  border-color: #0052d9;
}

.native-tag-input--focused {
  border-color: #0052d9;
  box-shadow: 0 0 0 2px rgba(0, 82, 217, 0.1);
}

.native-tag-input--disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.native-tag-input--error {
  border-color: #ff4d4f;
}

.native-tag-input--error:hover,
.native-tag-input--error.native-tag-input--focused {
  border-color: #ff4d4f;
  box-shadow: 0 0 0 2px rgba(255, 77, 79, 0.1);
}

.native-tag-input__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: #e8f4ff;
  color: #0052d9;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
}

.native-tag-input__tag--closable {
  padding-right: 4px;
}

.native-tag-input__close {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-tag-input__close:hover {
  opacity: 1;
}

.native-tag-input__input {
  flex: 1;
  min-width: 80px;
  border: none;
  background: transparent;
  font-size: 14px;
  color: #333;
  outline: none;
  padding: 4px 0;
}

.native-tag-input__input::placeholder {
  color: #999;
}

.native-tag-input__input:disabled {
  cursor: not-allowed;
}

.native-tag-input__count {
  font-size: 12px;
  color: #999;
  margin-left: auto;
}

.native-tag-input__error-msg {
  margin-top: 4px;
  font-size: 12px;
  color: #ff4d4f;
}
</style>
