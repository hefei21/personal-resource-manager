<template>
  <div class="native-list" :class="{ 'native-list--split': split, 'native-list--stripe': stripe }">
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
  background: #fff;
  border-radius: 6px;
}

.native-list__header {
  padding: 12px 16px;
  font-weight: 600;
  color: #333;
  border-bottom: 1px solid #e8e8e8;
}

.native-list__items {
  display: flex;
  flex-direction: column;
}

.native-list__footer {
  padding: 12px 16px;
  color: #666;
  border-top: 1px solid #e8e8e8;
}

/* 分割线样式 */
.native-list--split :deep(.native-list-item) {
  border-bottom: 1px solid #e8e8e8;
}

.native-list--split :deep(.native-list-item:last-child) {
  border-bottom: none;
}

/* 斑马纹样式 */
.native-list--stripe :deep(.native-list-item:nth-child(even)) {
  background: #fafafa;
}
</style>
