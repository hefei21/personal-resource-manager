<template>
  <GamesPC v-if="!isMobile" />
  <GamesMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import GamesPC from '@/pc/pages/GamesPC.vue'
import GamesMobile from '@/mobile/pages/GamesMobile.vue'

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
