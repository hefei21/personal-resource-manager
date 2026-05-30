<template>
  <textarea
    class="native-textarea"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :maxlength="maxlength"
    @input="$emit('update:modelValue', $event.target.value)"
    @blur="$emit('blur', $event)"
    @focus="$emit('focus', $event)"
  ></textarea>
  <div v-if="maxlength && showCount" class="native-textarea__count">
    {{ modelValue?.length || 0 }}/{{ maxlength }}
  </div>
</template>

<script setup>
defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 3 },
  disabled: { type: Boolean, default: false },
  maxlength: { type: Number, default: null },
  showCount: { type: Boolean, default: true }
})

defineEmits(['update:modelValue', 'blur', 'focus'])
</script>

<style scoped>
.native-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;
  transition: border-color 0.2s;
  font-family: inherit;
}

.native-textarea:focus {
  outline: none;
  border-color: #0052d9;
}

.native-textarea:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.native-textarea__count {
  text-align: right;
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}
</style>
