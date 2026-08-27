<template>
  <DashboardPC v-if="!isMobile" />
  <DashboardMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const DashboardPC = defineAsyncComponent(() => import('@/pc/pages/DashboardPC.vue'))
const DashboardMobile = defineAsyncComponent(() => import('@/mobile/pages/DashboardMobile.vue'))

const { isMobile } = useViewport()
</script>
