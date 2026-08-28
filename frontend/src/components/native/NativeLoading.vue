<template>
  <div class="native-loading" :class="{ 'native-loading--center': center }" role="status" aria-live="polite">
    <div class="native-loading__spinner" :style="{ width: sizeMap[size], height: sizeMap[size] }" aria-hidden="true"></div>
    <span v-if="text" class="native-loading__text">{{ text }}</span>
  </div>
</template>

<script setup>
const props = defineProps({
  size: { type: String, default: 'medium' }, // small, medium, large
  text: { type: String, default: '' },
  center: { type: Boolean, default: false }
})

const sizeMap = {
  small: '16px',
  medium: '24px',
  large: '32px'
}
</script>

<style scoped>
.native-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.native-loading--center {
  display: flex;
  justify-content: center;
  width: 100%;
}

.native-loading__spinner {
  border: 2px solid #e0e0e0;
  border-top-color: var(--color-primary, #5967d9);
  border-radius: 50%;
  animation: spin var(--motion-duration-spinner, 800ms) linear infinite;
}

.native-loading__text {
  font-size: 14px;
  color: var(--color-text-secondary);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
