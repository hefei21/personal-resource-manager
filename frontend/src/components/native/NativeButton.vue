<template>
  <button
    :class="['native-btn', `native-btn--${theme}`, `native-btn--${size}`, { 'native-btn--loading': loading, 'native-btn--disabled': disabled, 'native-btn--outline': variant === 'outline', 'native-btn--text': variant === 'text', 'native-btn--circle': shape === 'circle', 'native-btn--has-icon': $slots.icon }]"
    :disabled="disabled || loading"
    :type="type"
    :aria-disabled="disabled || loading"
    :aria-busy="loading"
    @click="handleClick"
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

</script>

<style scoped>
.native-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-weight: 500;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    border-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    box-shadow var(--motion-duration-fast) var(--motion-easing-standard);
  white-space: nowrap;
  outline: none;
}

.native-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.native-btn--small { padding: var(--space-0-5) var(--space-2); font-size: 12px; height: 24px; }
.native-btn--medium { padding: var(--space-1) var(--space-3); font-size: 13px; height: 28px; }
.native-btn--large { padding: var(--space-1-5) var(--space-4); font-size: 14px; height: 32px; }

.native-btn--circle { border-radius: 50%; padding: 0; }
.native-btn--circle.native-btn--small { width: 28px; height: 28px; }
.native-btn--circle.native-btn--medium { width: 32px; height: 32px; }
.native-btn--circle.native-btn--large { width: 40px; height: 40px; }

.native-btn--default { background: var(--color-surface-raised); border-color: var(--color-border-default); color: var(--color-text-primary); }
.native-btn--default:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.native-btn--default.native-btn--outline { background: transparent; }

.native-btn--primary { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-text-inverse); }
.native-btn--primary:hover:not(:disabled) { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }
.native-btn--primary.native-btn--outline { background: transparent; color: var(--color-primary); }
.native-btn--primary.native-btn--outline:hover:not(:disabled) { background: var(--color-primary-surface); }

.native-btn--danger { background: var(--color-danger); border-color: var(--color-danger); color: var(--color-text-inverse); }
.native-btn--danger:hover:not(:disabled) { background: var(--color-danger-hover); border-color: var(--color-danger-hover); }
.native-btn--danger.native-btn--outline { background: transparent; color: var(--color-danger); }
.native-btn--danger.native-btn--outline:hover:not(:disabled) { background: var(--color-danger-surface); }

.native-btn--warning { background: var(--color-warning); border-color: var(--color-warning); color: var(--color-text-inverse); }
.native-btn--warning:hover:not(:disabled) { background: var(--color-warning-hover); border-color: var(--color-warning-hover); }
.native-btn--warning.native-btn--outline { background: transparent; color: var(--color-warning); }

.native-btn--success { background: var(--color-success); border-color: var(--color-success); color: var(--color-text-inverse); }
.native-btn--success:hover:not(:disabled) { background: var(--color-success-hover); border-color: var(--color-success-hover); }
.native-btn--success.native-btn--outline { background: transparent; color: var(--color-success); }
.native-btn--success.native-btn--outline:hover:not(:disabled) { background: var(--color-success-surface); }

/* text variant - 无边框，纯文本样式 */
.native-btn--text {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-secondary);
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}
.native-btn--text:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.04);
  color: var(--color-text-primary);
}

.native-btn--disabled,
.native-btn:disabled { opacity: var(--opacity-disabled); cursor: not-allowed; }

.native-btn__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--radius-pill);
  animation: spin var(--motion-duration-spinner) linear infinite;
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
  color: var(--color-text-inverse);
}
.native-btn--danger.native-btn--text .native-btn__icon,
.native-btn--danger.native-btn--text .native-btn__icon :deep(.native-icon),
.native-btn--danger.native-btn--outline .native-btn__icon,
.native-btn--danger.native-btn--outline .native-btn__icon :deep(.native-icon) {
  color: var(--color-danger);
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .native-btn__spinner {
    animation-duration: 1ms;
  }
}
</style>
