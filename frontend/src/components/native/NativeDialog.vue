<template>
  <DialogRoot
    :open="modelValue"
    :modal="true"
    :unmount-on-hide="destroyOnClose"
    @update:open="handleOpenChange"
  >
    <DialogPortal>
      <DialogOverlay
        class="native-dialog-overlay"
        :style="overlayStyle"
        @click="handleOverlayClick"
      />
      <DialogContent
        v-bind="contentAttrs"
        :class="['native-dialog', attrs.class]"
        :style="[dialogStyle, attrs.style]"
        @escape-key-down="handleEscapeKeyDown"
        @pointer-down-outside="handlePointerDownOutside"
      >
        <div class="native-dialog__header">
          <DialogTitle
            as="span"
            :class="['native-dialog__title', { 'native-dialog__title--sr-only': !dialogTitle }]"
          >
            {{ dialogTitle || '对话框' }}
          </DialogTitle>
          <button
            v-if="closeButtonVisible"
            class="native-dialog__close"
            type="button"
            aria-label="关闭"
            @click="handleClose"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div class="native-dialog__body">
          <slot />
          <template v-if="body && !$slots.default">{{ body }}</template>
        </div>

        <div v-if="showFooterComputed" class="native-dialog__footer">
          <slot name="footer">
            <NativeButton theme="default" @click="handleCancel">
              {{ cancelText }}
            </NativeButton>
            <NativeButton
              :theme="confirmButtonTheme"
              :loading="confirmLoading"
              :disabled="confirmDisabled"
              @click="handleConfirm"
            >
              {{ confirmButtonText }}
            </NativeButton>
          </slot>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup>
import { computed, useAttrs, watch } from 'vue'
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle
} from 'reka-ui'
import NativeButton from './NativeButton.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  header: { type: String, default: '' },
  body: { type: String, default: '' },
  width: { type: [String, Number], default: '520px' },
  closeBtn: { type: Boolean, default: true },
  showClose: { type: [Boolean, String], default: undefined },
  closeOnOverlayClick: { type: Boolean, default: true },
  closeOnEsc: { type: Boolean, default: true },
  closeOnEscKeydown: { type: [Boolean, String], default: undefined },
  destroyOnClose: { type: Boolean, default: true },
  footer: { type: Boolean, default: true },
  showFooter: { type: Boolean, default: true },
  confirmText: { type: String, default: '确定' },
  confirmBtn: { type: Object, default: null },
  cancelText: { type: String, default: '取消' },
  confirmLoading: { type: Boolean, default: false },
  confirmDisabled: { type: Boolean, default: false },
  zIndex: { type: Number, default: 10000 }
})

const emit = defineEmits(['update:modelValue', 'close', 'confirm', 'cancel', 'closed'])
const attrs = useAttrs()

const contentAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})
const showFooterComputed = computed(() => props.footer !== false && props.showFooter !== false)
const dialogTitle = computed(() => props.title || props.header || '')
const normalizeBooleanAlias = (value, fallback) => {
  if (value === undefined) return fallback
  return value !== false && value !== 'false'
}
const closeButtonVisible = computed(() => normalizeBooleanAlias(props.showClose, props.closeBtn))
const closeOnEscape = computed(() => normalizeBooleanAlias(props.closeOnEscKeydown, props.closeOnEsc))
const confirmButtonText = computed(() => props.confirmBtn?.content || props.confirmText)
const confirmButtonTheme = computed(() => props.confirmBtn?.theme || 'primary')
const overlayStyle = computed(() => ({ zIndex: props.zIndex }))
const dialogStyle = computed(() => ({
  width: typeof props.width === 'number' ? `${props.width}px` : props.width,
  zIndex: props.zIndex + 1
}))

function requestClose({ emitClose = true } = {}) {
  if (!props.modelValue) return
  emit('update:modelValue', false)
  if (emitClose) emit('close')
}

function handleOpenChange(open) {
  if (open || !props.modelValue) return
  requestClose()
}

function handleClose() {
  requestClose()
}

function handleConfirm() {
  emit('confirm')
}

function handleCancel() {
  emit('cancel')
  requestClose()
}

function handleEscapeKeyDown(event) {
  if (!closeOnEscape.value) event.preventDefault()
}

function handlePointerDownOutside(event) {
  if (!props.closeOnOverlayClick) event.preventDefault()
}

function handleOverlayClick() {
  if (props.closeOnOverlayClick) requestClose()
}

watch(() => props.modelValue, (open, wasOpen) => {
  if (!open && wasOpen) emit('closed')
})
</script>

<style scoped>
.native-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(23, 32, 51, 0.46);
  backdrop-filter: blur(2px);
}

.native-dialog-overlay[data-state='open'] {
  animation: native-dialog-overlay-in var(--motion-duration-standard) var(--motion-easing-standard);
}

.native-dialog-overlay[data-state='closed'] {
  animation: native-dialog-overlay-out var(--motion-duration-fast) var(--motion-easing-standard);
}

.native-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 40px);
  max-height: min(90vh, 900px);
  overflow: hidden;
  color: var(--color-text-primary);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  transform: translate(-50%, -50%);
}

.native-dialog[data-state='open'] {
  animation: native-dialog-content-in var(--motion-duration-standard) var(--motion-easing-emphasized);
}

.native-dialog[data-state='closed'] {
  animation: native-dialog-content-out var(--motion-duration-fast) var(--motion-easing-standard);
}

.native-dialog:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.native-dialog__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--color-border-subtle);
}

.native-dialog__title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.native-dialog__title--sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.native-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-right: calc(var(--space-2) * -1);
  padding: 0;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    color var(--motion-duration-fast) var(--motion-easing-standard),
    background-color var(--motion-duration-fast) var(--motion-easing-standard);
}

.native-dialog__close:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-subtle);
}

.native-dialog__close:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.native-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-5);
  overflow-y: auto;
  line-height: 1.6;
}

.native-dialog__footer {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface-raised);
  border-top: 1px solid var(--color-border-subtle);
}

@keyframes native-dialog-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes native-dialog-overlay-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes native-dialog-content-in {
  from { opacity: 0; transform: translate(-50%, -48%) scale(0.985); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes native-dialog-content-out {
  from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to { opacity: 0; transform: translate(-50%, -48%) scale(0.985); }
}

@media (max-width: 768px) {
  .native-dialog {
    top: auto;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100% !important;
    max-width: none;
    max-height: min(88dvh, 760px);
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    transform: none;
  }

  .native-dialog[data-state='open'] { animation-name: native-dialog-sheet-in; }
  .native-dialog[data-state='closed'] { animation-name: native-dialog-sheet-out; }

  .native-dialog__header {
    min-height: 56px;
    padding: 0 var(--space-4);
  }

  .native-dialog__close {
    width: 44px;
    height: 44px;
    margin-right: calc(var(--space-2) * -1);
  }

  .native-dialog__body { padding: var(--space-4); }

  .native-dialog__footer {
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom));
  }
}

@keyframes native-dialog-sheet-in {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes native-dialog-sheet-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(18px); }
}

@media (prefers-reduced-motion: reduce) {
  .native-dialog-overlay,
  .native-dialog {
    animation-duration: 1ms !important;
  }
}
</style>
