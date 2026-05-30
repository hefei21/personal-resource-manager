<template>
  <main class="native-content" :style="contentStyle">
    <slot></slot>
  </main>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  padding: { type: [String, Number], default: '20px' },
  background: { type: String, default: '#f5f5f5' }
})

const contentStyle = computed(() => {
  const style = {}
  
  if (props.padding) {
    style.padding = typeof props.padding === 'number' ? `${props.padding}px` : props.padding
  }
  
  if (props.background) {
    style.background = props.background
  }
  
  return style
})
</script>

<style scoped>
.native-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
