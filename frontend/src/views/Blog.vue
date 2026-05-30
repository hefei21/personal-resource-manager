<template>
  <BlogPC v-if="!isMobile" />
  <BlogMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import BlogPC from '@/pc/pages/BlogPC.vue'
import BlogMobile from '@/mobile/pages/BlogMobile.vue'

// 初始化时检查窗口宽度，避免闪烁
const getIsMobile = () => {
  if (typeof window === 'undefined') return false
  return window.innerWidth <= 768
}

const isMobile = ref(getIsMobile())

const checkMobile = () => {
  isMobile.value = getIsMobile()
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})
</script>
