<template>
  <DocumentsPC v-if="!isMobile" />
  <DocumentsMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import DocumentsPC from '@/pc/pages/DocumentsPC.vue'
import DocumentsMobile from '@/mobile/pages/DocumentsMobile.vue'

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
