<template>
  <router-view v-slot="{ Component }">
    <transition name="fade" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
</template>

<script setup>
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: var(--color-surface-page);
  color: var(--color-text-primary);
  transition:
    background-color var(--motion-duration-standard) var(--motion-easing-standard),
    color var(--motion-duration-standard) var(--motion-easing-standard);
}

#app {
  min-height: 100vh;
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity var(--motion-duration-standard) var(--motion-easing-standard),
    transform var(--motion-duration-standard) var(--motion-easing-standard);
}

.fade-enter-from {
  opacity: 0;
  transform: translateX(20px);
}

.fade-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-from,
  .fade-leave-to {
    transform: none;
  }
}
</style>
