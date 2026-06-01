<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div 
        v-if="modelValue" 
        class="native-dialog-overlay" 
        @click.self="handleOverlayClick"
        role="dialog"
        :aria-modal="true"
        :aria-labelledby="titleId"
      >
        <div class="native-dialog" :style="{ width: typeof width === 'number' ? width + 'px' : width }">
          <div class="native-dialog__header">
            <span :id="titleId" class="native-dialog__title">{{ dialogTitle }}</span>
            <button 
              v-if="closeBtn" 
              class="native-dialog__close" 
              @click="handleClose"
              type="button"
              aria-label="关闭"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="native-dialog__body">
            <slot />
          </div>
          <div v-if="showFooterComputed" class="native-dialog__footer">
            <slot name="footer">
              <NativeButton theme="default" @click="handleCancel">{{ cancelText }}</NativeButton>
              <NativeButton 
                theme="primary" 
                :loading="confirmLoading" 
                :disabled="confirmDisabled"
                @click="handleConfirm"
              >
                {{ confirmText }}
              </NativeButton>
            </slot>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { watch, onMounted, onUnmounted, computed } from 'vue'
import NativeButton from './NativeButton.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  header: { type: String, default: '' },
  width: { type: [String, Number], default: '520px' },
  closeBtn: { type: Boolean, default: true },
  closeOnOverlayClick: { type: Boolean, default: true },
  closeOnEsc: { type: Boolean, default: true },
  footer: { type: Boolean, default: true },
  showFooter: { type: Boolean, default: true },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  confirmLoading: { type: Boolean, default: false },
  confirmDisabled: { type: Boolean, default: false },
  zIndex: { type: Number, default: 9999 }
})

const emit = defineEmits(['update:modelValue', 'close', 'confirm', 'cancel', 'closed'])

// 生成唯一标题ID用于 aria-labelledby
const titleId = computed(() => 'dialog-title-' + Math.random().toString(36).substr(2, 9))

// 兼容 footer 和 showFooter 属性
const showFooterComputed = computed(() => props.footer !== false && props.showFooter !== false)

// 兼容 title 和 header 属性
const dialogTitle = computed(() => props.title || props.header || '')

// 保存原始的 body overflow 值
let originalBodyOverflow = ''

function handleClose() {
  emit('update:modelValue', false)
  emit('close')
}

function handleOverlayClick() {
  if (props.closeOnOverlayClick) {
    handleClose()
  }
}

function handleConfirm() {
  emit('confirm')
}

function handleCancel() {
  emit('cancel')
  handleClose()
}

function handleEsc(e) {
  if (e.key === 'Escape' && props.modelValue && props.closeOnEsc) {
    handleClose()
  }
}

watch(() => props.modelValue, (val) => {
  if (val) {
    // 保存原始值
    originalBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    // 恢复原始值
    document.body.style.overflow = originalBodyOverflow
    emit('closed')
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc)
  // 确保卸载时恢复 body overflow
  document.body.style.overflow = originalBodyOverflow
})
</script>

<style scoped>
.native-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
  box-sizing: border-box;
}

.native-dialog {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  max-height: 90vh;
  max-width: calc(100vw - 40px);
  width: 100%;
  display: flex;
  flex-direction: column;
  margin: auto;
}

.native-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.native-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.native-dialog__close {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-dialog__close:hover {
  background: #f5f5f5;
  color: #666;
}

.native-dialog__close:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-dialog__body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.native-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.3s;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-active .native-dialog,
.dialog-fade-leave-active .native-dialog {
  transition: transform 0.3s, opacity 0.3s;
}

.dialog-fade-enter-from .native-dialog,
.dialog-fade-leave-to .native-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
