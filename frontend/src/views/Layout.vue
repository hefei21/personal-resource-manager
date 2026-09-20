<template>
  <!-- Keep the route transition on a stable root when the responsive async shell changes. -->
  <div class="responsive-layout">
    <LayoutPC v-if="!isMobile" />
    <LayoutMobile v-else />
  </div>
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const LayoutPC = defineAsyncComponent(() => import('@/pc/layout/Layout.vue'))
const LayoutMobile = defineAsyncComponent(() => import('@/mobile/layout/Layout.vue'))

const { isMobile } = useViewport()
</script>
