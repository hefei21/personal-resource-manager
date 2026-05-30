<template>
  <div v-show="isActive" class="native-tab-panel">
    <slot></slot>
  </div>
</template>

<script setup>
import { inject, computed, onMounted, onUnmounted, getCurrentInstance, ref } from 'vue'

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

const instance = getCurrentInstance()

onMounted(() => {
  tabs.addTab({
    label: props.label,
    name: props.name,
    icon: props.icon,
    badge: props.badge,
    disabled: props.disabled,
    uid: instance.uid
  })
})

onUnmounted(() => {
  tabs.removeTab(props.name)
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
