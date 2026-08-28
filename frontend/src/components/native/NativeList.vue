<template>
  <div class="native-list" :class="[`native-list--${size}`, { 'native-list--split': split, 'native-list--stripe': stripe }]">
    <div v-if="header || $slots.header" class="native-list__header">
      <slot name="header">{{ header }}</slot>
    </div>
    
    <div class="native-list__items">
      <slot></slot>
    </div>
    
    <div v-if="footer || $slots.footer" class="native-list__footer">
      <slot name="footer">{{ footer }}</slot>
    </div>
  </div>
</template>

<script setup>
defineProps({
  header: { type: String, default: '' },
  footer: { type: String, default: '' },
  split: { type: Boolean, default: true },
  stripe: { type: Boolean, default: false },
  size: { type: String, default: 'medium' } // small, medium, large
})
</script>

<style scoped>
.native-list {
  background: var(--color-surface-raised);
  border-radius: var(--radius-sm);
}

.native-list__header {
  padding: 12px 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-border-subtle);
}

.native-list__items {
  display: flex;
  flex-direction: column;
}

.native-list__footer {
  padding: 12px 16px;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--color-border-subtle);
}

/* 分割线样式 */
.native-list--split :deep(.native-list-item) {
  border-bottom: 1px solid var(--color-border-subtle);
}

.native-list--split :deep(.native-list-item:last-child) {
  border-bottom: none;
}

/* 斑马纹样式 */
.native-list--stripe :deep(.native-list-item:nth-child(even)) {
  background: var(--color-surface-page);
}

.native-list--small :deep(.native-list-item) { padding: var(--space-2) var(--space-3); }
.native-list--large :deep(.native-list-item) { padding: var(--space-4) var(--space-5); }
</style>
