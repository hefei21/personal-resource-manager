<template>
  <div class="native-loading" :class="{ 'native-loading--center': center }">
    <div class="native-loading__spinner" :style="{ width: sizeMap[size], height: sizeMap[size] }"></div>
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
  border-top-color: #667eea;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.native-loading__text {
  font-size: 14px;
  color: #666;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
