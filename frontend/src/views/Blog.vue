<template>
  <BlogPC v-if="!isMobile" />
  <BlogMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const BlogPC = defineAsyncComponent(() => import('@/pc/pages/BlogPC.vue'))
const BlogMobile = defineAsyncComponent(() => import('@/mobile/pages/BlogMobile.vue'))

const { isMobile } = useViewport()
</script>
