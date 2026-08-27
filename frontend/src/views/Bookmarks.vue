<template>
  <BookmarksPC v-if="!isMobile" />
  <BookmarksMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const BookmarksPC = defineAsyncComponent(() => import('@/pc/pages/BookmarksPC.vue'))
const BookmarksMobile = defineAsyncComponent(() => import('@/mobile/pages/BookmarksMobile.vue'))

const { isMobile } = useViewport()
</script>
