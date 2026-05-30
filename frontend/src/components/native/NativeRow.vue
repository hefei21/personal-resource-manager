<template>
  <div class="native-row" :style="rowStyle">
    <slot />
  </div>
</template>

<script setup>
import { computed, provide } from 'vue'

const props = defineProps({
  gutter: { type: [Number, String], default: 0 }
})

const rowStyle = computed(() => ({
  marginLeft: props.gutter ? `-${props.gutter / 2}px` : 0,
  marginRight: props.gutter ? `-${props.gutter / 2}px` : 0
}))

provide('rowGutter', props.gutter)
</script>

<style scoped>
.native-row {
  display: flex;
  flex-wrap: wrap;
}
</style>
