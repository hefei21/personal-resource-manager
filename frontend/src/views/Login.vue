<template>
  <LoginPC v-if="!isMobile" />
  <LoginMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import LoginPC from '@/pc/pages/LoginPC.vue'
import LoginMobile from '@/mobile/pages/LoginMobile.vue'

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
