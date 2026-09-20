<template>
  <div class="theme-control" :class="{ 'theme-control--compact': compact }" role="group" aria-label="外观设置">
    <span v-if="!compact">外观</span>
    <NativeSelect :model-value="preference" :options="options" aria-label="应用主题" @update:model-value="setTheme" />
    <small v-if="!compact">跟随系统时自动切换；阅读器纸张设置不受影响。</small>
  </div>
</template>
<script setup>
import { NativeSelect } from '@/components/native'
import { useAppTheme } from '@/composables/useAppTheme'
defineProps({ compact: Boolean })
const { preference, setTheme } = useAppTheme()
const options = [{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]
</script>
<style scoped>
.theme-control {
  display: grid;
  gap: 10px;
  margin-bottom: 20px;
  padding: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
}
.theme-control > span { font-size: 14px; font-weight: 600; }
.theme-control small { font-size: 12px; color: var(--color-text-secondary); line-height: 1.6; }
.theme-control--compact { width: 124px; padding: 0; border: 0; margin: 0; background: transparent; }
</style>
