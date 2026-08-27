<template>
  <DocumentsPC v-if="!isMobile" />
  <DocumentsMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const DocumentsPC = defineAsyncComponent(() => import('@/pc/pages/DocumentsPC.vue'))
const DocumentsMobile = defineAsyncComponent(() => import('@/mobile/pages/DocumentsMobile.vue'))

const { isMobile } = useViewport()
</script>
