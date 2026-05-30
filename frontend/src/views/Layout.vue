<template>
  <LayoutPC v-if="!isMobile" />
  <LayoutMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import LayoutPC from '@/pc/layout/Layout.vue'
import LayoutMobile from '@/mobile/layout/Layout.vue'

const isMobile = ref(false)

const checkMobile = () => {
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})
</script>