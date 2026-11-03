<template>
  <PopoverRoot v-model:open="visible">
    <span class="native-popconfirm">
      <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    </span>
    <PopoverPortal>
      <PopoverContent
        class="native-popconfirm__popup"
        :class="`native-popconfirm--${placement}`"
        :side="placement"
        :side-offset="8"
        :collision-padding="10"
        :style="{ zIndex }"
        aria-label="确认操作"
        @open-auto-focus="focusConfirmation"
      >
        <div class="native-popconfirm__content">
          <NativeIcon v-if="showIcon" class="native-popconfirm__icon" :name="theme === 'danger' ? 'warning' : 'info'" size="20" aria-hidden="true" />
          <div class="native-popconfirm__message"><slot>{{ content }}</slot></div>
        </div>
        <div class="native-popconfirm__actions">
          <button type="button" class="native-popconfirm__btn native-popconfirm__btn--cancel" @click="handleCancel">{{ cancelText }}</button>
          <button ref="confirmBtnRef" type="button" class="native-popconfirm__btn native-popconfirm__btn--confirm" :class="`native-popconfirm__btn--${theme}`" @click="handleConfirm">{{ confirmText }}</button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup>
import { ref, watch } from 'vue'
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui'
import NativeIcon from './NativeIcon.vue'
defineProps({
  content: { type: String, default: '确认执行此操作？' },
  theme: { type: String, default: 'default' },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  placement: { type: String, default: 'top' },
  showIcon: { type: Boolean, default: true },
  zIndex: { type: Number, default: 10001 }
})
const emit = defineEmits(['confirm', 'cancel', 'close'])
const visible = ref(false)
const confirmBtnRef = ref(null)
function focusConfirmation(event) {
  event.preventDefault()
  confirmBtnRef.value?.focus()
}
function handleConfirm() { emit('confirm'); visible.value = false }
function handleCancel() { emit('cancel'); visible.value = false }
watch(visible, (open, wasOpen) => { if (!open && wasOpen) emit('close') })
</script>

<style scoped>
.native-popconfirm {
  position: relative;
  display: inline-block;
}

:global(.native-popconfirm__popup) {
  pointer-events: auto;
  background: var(--color-surface-raised);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  padding: 12px 16px;
  min-width: 200px;
}

.native-popconfirm__content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}

.native-popconfirm__icon {
  flex-shrink: 0;
  color: var(--color-warning-solid);
}

.native-popconfirm__message {
  font-size: 14px;
  color: var(--color-text-primary);
  line-height: 1.5;
}

.native-popconfirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.native-popconfirm__btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid var(--color-border-default);
  background: var(--color-surface-raised);
  outline: none;
}

.native-popconfirm__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.native-popconfirm__btn--cancel {
  color: var(--color-text-secondary);
}

.native-popconfirm__btn--cancel:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.native-popconfirm__btn--confirm {
  background: var(--color-primary-solid);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
}

.native-popconfirm__btn--confirm:hover {
  background: var(--color-primary-solid);
  border-color: var(--color-primary);
}

.native-popconfirm__btn--warning {
  background: var(--color-warning-solid);
  border-color: var(--color-warning-solid);
}

.native-popconfirm__btn--warning:hover {
  background: var(--color-warning-solid);
  border-color: var(--color-warning-solid);
}

.native-popconfirm__btn--danger {
  background: var(--color-danger-solid);
  border-color: var(--color-danger-solid);
}

.native-popconfirm__btn--danger:hover {
  background: var(--color-danger-solid);
  border-color: var(--color-danger-solid);
}

</style>
