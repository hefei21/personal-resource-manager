<template>
  <NativeDialog
    :model-value="visible"
    :title="single ? '更改文档信息' : '批量编辑文档'"
    width="600px"
    @update:model-value="emit('update:visible', $event)"
    @confirm="emit('confirm')"
  >
    <NativeForm>
      <NativeFormItem label="分类">
        <NativeTreeSelect
          :model-value="categoryId"
          :data="categories"
          placeholder="选择分类（留空则不修改）"
          clearable
          @update:model-value="emit('update:categoryId', $event)"
        />
      </NativeFormItem>
      <NativeFormItem label="标签">
        <NativeInput
          :model-value="tags"
          placeholder="输入标签，用逗号分隔（留空则不修改）"
          @update:model-value="emit('update:tags', $event)"
        />
      </NativeFormItem>
    </NativeForm>
    <p class="metadata-hint">提示：只有填写了内容的字段才会被更新，留空的字段保持原值。</p>
  </NativeDialog>
</template>

<script setup>
import { NativeDialog, NativeForm, NativeFormItem, NativeInput, NativeTreeSelect } from '@/components/native'

defineProps({
  visible: { type: Boolean, default: false },
  single: { type: Boolean, default: false },
  categoryId: { type: [Number, String], default: '' },
  tags: { type: String, default: '' },
  categories: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:visible', 'update:categoryId', 'update:tags', 'confirm'])
</script>

<style scoped>
.metadata-hint { margin: 10px 0 0; color: var(--color-text-muted); font-size: 12px; }
</style>
