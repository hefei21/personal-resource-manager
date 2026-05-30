<template>
  <div class="native-card" :class="{ 'native-card--hover': hover || hoverShadow }">
    <div v-if="$slots.header || title" class="native-card__header">
      <slot name="header">
        <span class="native-card__title">{{ title }}</span>
      </slot>
    </div>
    <div class="native-card__body">
      <slot />
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  hover: { type: Boolean, default: false },
  hoverShadow: { type: Boolean, default: false }
})
</script>

<style scoped>
.native-card {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s;
  border: 1px solid #e8e8e8;
  width: 100%;
}

.native-card--hover:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

.native-card__header {
  padding: 16px 20px;
  background: #fff;
  border-radius: 8px 8px 0 0;
}

.native-card__title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.native-card__body {
  padding: 20px;
}
</style>
