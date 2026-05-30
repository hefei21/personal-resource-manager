<template>
  <CodePC v-if="!isMobile" />
  <CodeMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import CodePC from '@/pc/pages/CodePC.vue'
import CodeMobile from '@/mobile/pages/CodeMobile.vue'

const isMobile = ref(false)

function checkDevice() {
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  checkDevice()
  window.addEventListener('resize', checkDevice)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkDevice)
})
</script>
