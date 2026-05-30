<template>
  <DashboardPC v-if="!isMobile" />
  <DashboardMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import DashboardPC from '@/pc/pages/DashboardPC.vue'
import DashboardMobile from '@/mobile/pages/DashboardMobile.vue'

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
