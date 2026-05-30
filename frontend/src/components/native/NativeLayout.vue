<template>
  <div class="native-layout" :class="{ 'native-layout--has-aside': hasAside }">
    <slot></slot>
  </div>
</template>

<script setup>
import { ref, provide, onMounted, onUnmounted } from 'vue'

const hasAside = ref(false)

// 提供给子组件
provide('nativeLayout', {
  hasAside,
  setHasAside
})

function setHasAside(value) {
  hasAside.value = value
}
</script>

<style scoped>
.native-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 100vh;
}

.native-layout--has-aside {
  flex-direction: row;
}
</style>
