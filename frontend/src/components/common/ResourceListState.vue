<template>
  <div class="resource-list-state" :class="`is-${state}`">
    <NativeLoading
      v-if="state === 'loading'"
      center
      size="large"
      :text="loadingText"
    />
    <NativeEmpty v-else :description="state === 'error' ? errorText : emptyText">
      <template v-if="$slots.icon" #icon><slot name="icon" /></template>
      <template v-if="state === 'error' || $slots['empty-action']" #action>
        <NativeButton v-if="state === 'error'" theme="primary" variant="outline" @click="$emit('retry')">
          重试
        </NativeButton>
        <slot v-else name="empty-action" />
      </template>
    </NativeEmpty>
  </div>
</template>

<script setup>
import { NativeButton, NativeEmpty, NativeLoading } from '@/components/native'

defineProps({
  state: { type: String, required: true },
  loadingText: { type: String, default: '加载中...' },
  emptyText: { type: String, default: '暂无数据' },
  errorText: { type: String, default: '加载失败，请稍后重试' }
})

defineEmits(['retry'])
</script>

<style scoped>
.resource-list-state {
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
}

.resource-list-state :deep(.native-empty),
.resource-list-state :deep(.native-loading) {
  width: 100%;
}
</style>
