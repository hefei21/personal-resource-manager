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
  background: var(--color-surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-standard), box-shadow var(--motion-duration-fast) var(--motion-easing-standard);
  border: 1px solid var(--color-border-subtle);
  width: 100%;
}

.native-card--hover:hover {
  border-color: var(--color-border-default);
  box-shadow: var(--shadow-md);
}

.native-card__header {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border-subtle);
}

.native-card__title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
}

.native-card__body {
  padding: var(--space-5);
}
</style>
