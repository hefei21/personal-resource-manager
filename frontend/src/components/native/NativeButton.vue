<template>
  <button
    :class="['native-btn', `native-btn--${theme}`, `native-btn--${size}`, { 'native-btn--loading': loading, 'native-btn--disabled': disabled, 'native-btn--outline': variant === 'outline', 'native-btn--text': variant === 'text', 'native-btn--circle': shape === 'circle', 'native-btn--has-icon': $slots.icon }]"
    :disabled="disabled || loading"
    :type="type"
    :aria-disabled="disabled || loading"
    :aria-busy="loading"
    @click="handleClick"
    @keydown.enter="handleKeydown"
    @keydown.space.prevent="handleKeydown"
  >
    <span v-if="loading" class="native-btn__spinner" aria-hidden="true"></span>
    <span v-if="$slots.icon && !loading" class="native-btn__icon" :style="{ '--icon-size': iconSize }">
      <slot name="icon" />
    </span>
    <slot />
  </button>
</template>

<script setup>
const props = defineProps({
  theme: { type: String, default: 'default' },
  size: { type: String, default: 'medium' },
  variant: { type: String, default: 'base' },
  shape: { type: String, default: 'rectangle' },
  type: { type: String, default: 'button' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  iconSize: { type: String, default: '1em' }
})

const emit = defineEmits(['click'])

function handleClick(e) {
  if (!props.disabled && !props.loading) {
    emit('click', e)
  }
}

function handleKeydown(e) {
  if (!props.disabled && !props.loading) {
    emit('click', e)
  }
}
</script>

<style scoped>
.native-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
  white-space: nowrap;
  outline: none;
}

.native-btn:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-btn--small { padding: 2px 8px; font-size: 12px; height: 24px; }
.native-btn--medium { padding: 4px 12px; font-size: 13px; height: 28px; }
.native-btn--large { padding: 6px 16px; font-size: 14px; height: 32px; }

.native-btn--circle { border-radius: 50%; padding: 0; }
.native-btn--circle.native-btn--small { width: 28px; height: 28px; }
.native-btn--circle.native-btn--medium { width: 32px; height: 32px; }
.native-btn--circle.native-btn--large { width: 40px; height: 40px; }

.native-btn--default { background: #fff; border-color: #dcdcdc; color: #333; }
.native-btn--default:hover:not(:disabled) { border-color: #0052d9; color: #0052d9; }
.native-btn--default.native-btn--outline { background: transparent; }

.native-btn--primary { background: #0052d9; border-color: #0052d9; color: #fff; }
.native-btn--primary:hover:not(:disabled) { background: #366ef4; border-color: #366ef4; }
.native-btn--primary.native-btn--outline { background: transparent; color: #0052d9; }
.native-btn--primary.native-btn--outline:hover:not(:disabled) { background: #f0f7ff; }

.native-btn--danger { background: #e34d59; border-color: #e34d59; color: #fff; }
.native-btn--danger:hover:not(:disabled) { background: #f36c78; border-color: #f36c78; }
.native-btn--danger.native-btn--outline { background: transparent; color: #e34d59; }
.native-btn--danger.native-btn--outline:hover:not(:disabled) { background: #fff0f0; }

.native-btn--warning { background: #ed7b2f; border-color: #ed7b2f; color: #fff; }
.native-btn--warning:hover:not(:disabled) { background: #f2a356; border-color: #f2a356; }
.native-btn--warning.native-btn--outline { background: transparent; color: #ed7b2f; }

.native-btn--success { background: #00a870; border-color: #00a870; color: #fff; }
.native-btn--success:hover:not(:disabled) { background: #00c585; border-color: #00c585; }
.native-btn--success.native-btn--outline { background: transparent; color: #00a870; }
.native-btn--success.native-btn--outline:hover:not(:disabled) { background: #e8f8f0; }

/* text variant - 无边框，纯文本样式 */
.native-btn--text {
  background: transparent;
  border-color: transparent;
  color: #666;
  padding-left: 8px;
  padding-right: 8px;
}
.native-btn--text:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.04);
  color: #333;
}

.native-btn--disabled,
.native-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.native-btn__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.native-btn__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: inherit;
}

.native-btn__icon :deep(svg),
.native-btn__icon :deep(.native-icon) {
  width: var(--icon-size, 1em);
  height: var(--icon-size, 1em);
  font-size: var(--icon-size, 1em);
}

/* danger 主题按钮的图标颜色 */
.native-btn--danger .native-btn__icon,
.native-btn--danger .native-btn__icon :deep(.native-icon) {
  color: #fff;
}
.native-btn--danger.native-btn--text .native-btn__icon,
.native-btn--danger.native-btn--text .native-btn__icon :deep(.native-icon),
.native-btn--danger.native-btn--outline .native-btn__icon,
.native-btn--danger.native-btn--outline .native-btn__icon :deep(.native-icon) {
  color: #e34d59;
}

@keyframes spin { to { transform: rotate(360deg); } }
</style>
