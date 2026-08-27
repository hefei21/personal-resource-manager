<template>
  <GamesPC v-if="!isMobile" />
  <GamesMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const GamesPC = defineAsyncComponent(() => import('@/pc/pages/GamesPC.vue'))
const GamesMobile = defineAsyncComponent(() => import('@/mobile/pages/GamesMobile.vue'))

const { isMobile } = useViewport()
</script>
