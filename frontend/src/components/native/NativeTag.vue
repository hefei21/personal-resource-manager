<template>
  <span 
    class="native-tag" 
    :class="[`native-tag--${theme}`, `native-tag--${variant}`, { 'native-tag--closable': closable }]"
  >
    <slot />
    <button v-if="closable" type="button" class="native-tag__close" aria-label="移除标签" @click.stop="$emit('close')">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>
  </span>
</template>

<script setup>
defineProps({
  theme: { type: String, default: 'default' }, // default, primary, success, warning, danger
  variant: { type: String, default: 'light' }, // light, solid, outline
  closable: { type: Boolean, default: false }
})

defineEmits(['close'])
</script>

<style scoped>
.native-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  line-height: 1.5;
  cursor: default;
  transition: color var(--motion-duration-fast), background-color var(--motion-duration-fast), border-color var(--motion-duration-fast);
}

.native-tag--light.native-tag--default { background: var(--color-surface-subtle); color: var(--color-text-secondary); }
.native-tag--light.native-tag--primary { background: var(--color-primary-surface); color: var(--color-info-text); }
.native-tag--light.native-tag--success { background: var(--color-success-surface); color: var(--color-success-text); }
.native-tag--light.native-tag--warning { background: var(--color-warning-surface); color: var(--color-warning-text); }
.native-tag--light.native-tag--danger { background: var(--color-danger-surface); color: var(--color-danger-text); }

.native-tag--solid.native-tag--default { background: var(--color-text-secondary); color: var(--color-text-inverse); }
.native-tag--solid.native-tag--primary { background: var(--color-primary); color: var(--color-text-inverse); }
.native-tag--solid.native-tag--success { background: var(--color-success); color: var(--color-text-inverse); }
.native-tag--solid.native-tag--warning { background: var(--color-warning); color: var(--color-text-inverse); }
.native-tag--solid.native-tag--danger { background: var(--color-danger); color: var(--color-text-inverse); }

.native-tag--outline.native-tag--default { background: transparent; border: 1px solid var(--color-border-default); color: var(--color-text-secondary); }
.native-tag--outline.native-tag--primary { background: transparent; border: 1px solid var(--color-primary-border); color: var(--color-primary); }
.native-tag--outline.native-tag--success { background: transparent; border: 1px solid var(--color-success-border); color: var(--color-success-text); }
.native-tag--outline.native-tag--warning { background: transparent; border: 1px solid var(--color-warning-border); color: var(--color-warning-text); }
.native-tag--outline.native-tag--danger { background: transparent; border: 1px solid var(--color-danger-border); color: var(--color-danger-text); }

.native-tag__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.6;
  width: 18px;
  height: 18px;
  padding: 0;
  color: inherit;
  border: 0;
  border-radius: 50%;
  background: transparent;
  transition: opacity var(--motion-duration-fast), background-color var(--motion-duration-fast);
}

.native-tag__close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, .06);
}
.native-tag__close:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; opacity: 1; }

.native-tag--closable {
  padding-right: 6px;
}
</style>
