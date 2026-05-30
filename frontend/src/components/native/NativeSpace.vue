<template>
  <div 
    class="native-space" 
    :class="{ 'native-space--wrap': wrap, 'native-space--vertical': direction === 'vertical' }"
    :style="spaceStyle"
  >
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  direction: { type: String, default: 'horizontal' }, // horizontal, vertical
  size: { type: [String, Number, Array], default: 8 },
  align: { type: String, default: 'center' }, // start, center, end, baseline, stretch
  wrap: { type: Boolean, default: false },
  fill: { type: Boolean, default: false }
})

const spaceStyle = computed(() => {
  let gapValue
  if (Array.isArray(props.size)) {
    gapValue = props.size.map(s => typeof s === 'number' ? `${s}px` : s).join(' ')
  } else {
    gapValue = typeof props.size === 'number' ? `${props.size}px` : props.size
  }
  
  return {
    gap: gapValue,
    alignItems: props.align,
    width: props.fill ? '100%' : undefined,
    flexWrap: props.wrap ? 'wrap' : 'nowrap'
  }
})
</script>

<style scoped>
.native-space {
  display: inline-flex;
  width: 100%;
}

.native-space--vertical {
  flex-direction: column;
}

.native-space--wrap {
  flex-wrap: wrap;
}
</style>
