<template>
  <BookmarksPC v-if="!isMobile" />
  <BookmarksMobile v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import BookmarksPC from '@/pc/pages/BookmarksPC.vue'
import BookmarksMobile from '@/mobile/pages/BookmarksMobile.vue'

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
