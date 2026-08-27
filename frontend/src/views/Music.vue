<template>
  <MusicPC v-if="!isMobile" />
  <MusicMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const MusicPC = defineAsyncComponent(() => import('@/pc/pages/MusicPC.vue'))
const MusicMobile = defineAsyncComponent(() => import('@/mobile/pages/MusicMobile.vue'))

const { isMobile } = useViewport()
</script>
