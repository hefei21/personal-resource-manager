<template>
  <div class="native-empty">
    <div class="native-empty__icon">
      <slot name="icon">
        <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
        </svg>
      </slot>
    </div>
    <p class="native-empty__description">{{ description }}</p>
    <div v-if="$slots.action" class="native-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
defineProps({
  description: { type: String, default: '暂无数据' }
})
</script>

<style scoped>
.native-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #999;
}

.native-empty__icon {
  margin-bottom: 16px;
  opacity: 0.6;
}

.native-empty__description {
  font-size: 14px;
  color: #666;
  margin: 0;
  text-align: center;
}

.native-empty__action {
  margin-top: 16px;
}
</style>
