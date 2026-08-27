<template>
  <LayoutPC v-if="!isMobile" />
  <LayoutMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const LayoutPC = defineAsyncComponent(() => import('@/pc/layout/Layout.vue'))
const LayoutMobile = defineAsyncComponent(() => import('@/mobile/layout/Layout.vue'))

const { isMobile } = useViewport()
</script>
