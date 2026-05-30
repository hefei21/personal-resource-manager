<template>
  <div class="native-col" :style="colStyle">
    <slot />
  </div>
</template>

<script setup>
import { computed, inject } from 'vue'

const props = defineProps({
  span: { type: [Number, String], default: 12 }
})

const gutter = inject('rowGutter', 0)

const colStyle = computed(() => ({
  flex: `0 0 ${(props.span / 12) * 100}%`,
  maxWidth: `${(props.span / 12) * 100}%`,
  paddingLeft: gutter ? `${gutter / 2}px` : 0,
  paddingRight: gutter ? `${gutter / 2}px` : 0,
  boxSizing: 'border-box'
}))
</script>

<style scoped>
.native-col {
  display: block;
}
</style>
