<template>
  <CodePC v-if="!isMobile" />
  <CodeMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const CodePC = defineAsyncComponent(() => import('@/pc/pages/CodePC.vue'))
const CodeMobile = defineAsyncComponent(() => import('@/mobile/pages/CodeMobile.vue'))

const { isMobile } = useViewport()
</script>
