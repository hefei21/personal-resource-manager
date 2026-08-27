<template>
  <LoginPC v-if="!isMobile" />
  <LoginMobile v-else />
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useViewport } from '@/composables/useViewport'

const LoginPC = defineAsyncComponent(() => import('@/pc/pages/LoginPC.vue'))
const LoginMobile = defineAsyncComponent(() => import('@/mobile/pages/LoginMobile.vue'))

const { isMobile } = useViewport()
</script>
