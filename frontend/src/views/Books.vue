<template>
  <!-- 移动端视图 -->
  <BooksMobile v-if="isMobile" />
  <!-- PC端视图 -->
  <BooksPC v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const BooksPC = defineAsyncComponent(() => import('@/pc/pages/BooksPC.vue'))
const BooksMobile = defineAsyncComponent(() => import('@/mobile/pages/BooksMobile.vue'))

const { isMobile } = useViewport()
</script>
