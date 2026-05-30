<template>
  <footer class="native-footer" :style="footerStyle">
    <slot></slot>
  </footer>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  height: { type: [String, Number], default: '60px' },
  background: { type: String, default: '' },
  color: { type: String, default: '' }
})

const footerStyle = computed(() => {
  const style = {}
  
  if (props.height) {
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height
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
.native-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  background: #fff;
  border-top: 1px solid #e8e8e8;
  flex-shrink: 0;
}
</style>
