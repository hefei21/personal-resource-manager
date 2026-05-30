<template>
  <header class="native-header" :style="headerStyle">
    <slot></slot>
  </header>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  height: { type: [String, Number], default: '60px' },
  fixed: { type: Boolean, default: false },
  background: { type: String, default: '' },
  color: { type: String, default: '' }
})

const headerStyle = computed(() => {
  const style = {}
  
  if (props.height) {
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height
  }
  
  if (props.fixed) {
    style.position = 'fixed'
    style.top = '0'
    style.left = '0'
    style.right = '0'
    style.zIndex = '1000'
  }
  
  if (props.background) {
    style.background = props.background
  }
  
  if (props.color) {
    style.color = props.color
  }
  
  return style
})
</script>

<style scoped>
.native-header {
  display: flex;
  align-items: center;
  padding: 0 20px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
}
</style>
