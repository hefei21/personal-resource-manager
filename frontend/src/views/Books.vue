<template>
  <!-- 移动端视图 -->
  <BooksMobile v-if="isMobile" />
  <!-- PC端视图 -->
  <BooksPC v-else />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import BooksMobile from '@/mobile/pages/BooksMobile.vue'
import BooksPC from '@/pc/pages/BooksPC.vue'

// 移动端检测
const isMobile = ref(false)

function checkMobile() {
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
