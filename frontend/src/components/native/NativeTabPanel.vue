<template>
  <div v-show="isActive" class="native-tab-panel" role="tabpanel" :id="tabs?.panelId(name)" :aria-labelledby="tabs?.tabId(name)" tabindex="0">
    <slot></slot>
  </div>
</template>

<script setup>
import { inject, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  name: { type: String, required: true },
  icon: { type: String, default: '' },
  badge: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false }
})

const tabs = inject('nativeTabs', null)

const isActive = computed(() => {
  if (!tabs) {
    console.warn('[NativeTabPanel] tabs inject failed for:', props.name)
    return false
  }
  return tabs.activeName.value === props.name
})

onMounted(() => {
  tabs?.addTab(props)
})

onUnmounted(() => {
  tabs?.removeTab(props.name)
})
</script>

<style scoped>
.native-tab-panel {
  animation: fadeIn 0.3s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
