<template>
  <aside class="native-aside" :style="asideStyle">
    <slot></slot>
  </aside>
</template>

<script setup>
import { computed, inject, onMounted } from 'vue'

const props = defineProps({
  width: { type: [String, Number], default: '200px' },
  fixed: { type: Boolean, default: false },
  background: { type: String, default: '' }
})

const layout = inject('nativeLayout', null)

const asideStyle = computed(() => {
  const style = {}
  
  if (props.width) {
    style.width = typeof props.width === 'number' ? `${props.width}px` : props.width
  }
  
  if (props.fixed) {
    style.position = 'fixed'
    style.left = '0'
    style.top = '0'
    style.bottom = '0'
    style.zIndex = '100'
  }
  
  if (props.background) {
    style.background = props.background
  }
  
  return style
})

onMounted(() => {
  if (layout) {
    layout.setHasAside(true)
  }
})
</script>

<style scoped>
.native-aside {
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid #e8e8e8;
  overflow-y: auto;
}
</style>
