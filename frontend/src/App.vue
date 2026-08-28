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
  font-family: var(--font-family-sans);
  background-color: var(--color-surface-page);
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  line-height: var(--line-height-body);
}

#app {
  min-height: 100vh;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--motion-duration-fast) var(--motion-easing-standard);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
