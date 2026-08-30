<template>
  <NativeDrawer
    :model-value="visible"
    :title="document?.title || '文档详情'"
    :show-title="false"
    :top-offset="72"
    placement="right"
    size="460px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div v-if="document" class="document-detail">
      <div class="document-detail-hero">
        <span class="document-detail-icon" :class="`document-type-icon--${documentFileTone(document.filePath)}`" aria-hidden="true">
          <NativeIcon :name="documentFileIcon(document.filePath)" size="28" />
        </span>
        <div><strong>{{ document.title }}</strong><span>{{ extensionLabel }} · {{ formatFileSize(document.size) }}</span></div>
      </div>

      <section class="document-detail-section">
        <div class="document-detail-heading">
          <h4>资料索引</h4>
          <NativeTag :theme="statusTheme" variant="light">{{ statusLabel }}</NativeTag>
        </div>
        <p>{{ statusDescription }}</p>
        <NativeButton
          v-if="canWrite && !['ready', 'pending'].includes(document.indexStatus)"
          size="small"
          variant="outline"
          :loading="ragRefreshLoading"
          @click="emit('refresh-index', document)"
        >
          重新建立索引
        </NativeButton>
      </section>

      <section class="document-detail-section document-detail-grid">
        <span>所在分类</span><strong>{{ categoryLabel }}</strong>
        <span>当前版本</span><strong>v{{ document.version || 1 }}</strong>
        <span>标签</span><strong>{{ document.tags || '无标签' }}</strong>
        <span>更新时间</span><strong>{{ formatDateTime(document.updatedAt) }}</strong>
        <span>创建时间</span><strong>{{ formatDateTime(document.createdAt) }}</strong>
      </section>

      <section class="document-detail-section document-detail-actions">
        <div class="document-detail-heading"><h4>文档操作</h4><span>查看、版本与编辑</span></div>
        <div class="document-action-grid">
          <button type="button" class="document-action-card document-action-card--primary" @click="emit('preview', document)">
            <span><NativeIcon name="eye" size="20" /></span><div><strong>预览</strong><small>继续阅读内容</small></div>
          </button>
          <button type="button" class="document-action-card" @click="emit('download', document)">
            <span><NativeIcon name="download" size="20" /></span><div><strong>下载原件</strong><small>保存当前版本</small></div>
          </button>
          <button type="button" class="document-action-card" :disabled="!canWrite" @click="emit('upload-version', document)">
            <span><NativeIcon name="upload" size="20" /></span><div><strong>上传新版本</strong><small>保留版本历史</small></div>
          </button>
          <button type="button" class="document-action-card" @click="emit('versions', document)">
            <span><NativeIcon name="history" size="20" /></span><div><strong>版本与回收</strong><small>查看或恢复版本</small></div>
          </button>
          <button type="button" class="document-action-card" :disabled="!canWrite" @click="emit('edit-info', document)">
            <span><NativeIcon name="pencil" size="20" /></span><div><strong>编辑信息</strong><small>修改分类与标签</small></div>
          </button>
          <button v-if="canEditContent" type="button" class="document-action-card" :disabled="!canWrite" @click="emit('edit-content', document)">
            <span><NativeIcon name="file-text" size="20" /></span><div><strong>编辑正文</strong><small>创建新的文本版本</small></div>
          </button>
        </div>
      </section>
    </div>

    <template #footer>
      <NativePopconfirm
        v-if="document"
        content="文档将进入统一回收站，确定继续吗？"
        @confirm="emit('delete', document.id)"
      >
        <template #trigger><NativeButton theme="danger" variant="outline" :disabled="!canWrite">移入回收站</NativeButton></template>
      </NativePopconfirm>
      <NativeButton variant="outline" @click="emit('update:visible', false)">关闭</NativeButton>
    </template>
  </NativeDrawer>
</template>

<script setup>
import { computed } from 'vue'
import { NativeButton, NativeDrawer, NativeIcon, NativePopconfirm, NativeTag } from '@/components/native'
import { documentFileIcon, documentFileTone } from '@/utils/documentWorkbench'

const props = defineProps({
  visible: { type: Boolean, default: false },
  document: { type: Object, default: null },
  canWrite: { type: Boolean, default: false },
  canEditContent: { type: Boolean, default: false },
  ragRefreshLoading: { type: Boolean, default: false }
})
const emit = defineEmits([
  'update:visible', 'preview', 'download', 'upload-version', 'versions', 'edit-info',
  'edit-content', 'refresh-index', 'delete'
])

const extensionLabel = computed(() => props.document?.filePath?.split('.').pop()?.toUpperCase() || '文件')
const categoryLabel = computed(() => {
  if (!props.document?.category) return '未分类'
  return props.document.subcategory ? `${props.document.category} / ${props.document.subcategory}` : props.document.category
})
const statusLabel = computed(() => ({
  ready: '可问', partial: '部分可问', pending: '索引中', stale: '待刷新', failed: '索引失败', missing: '未索引', unknown: '状态未知'
})[props.document?.indexStatus] || '状态未知')
const statusTheme = computed(() => {
  const status = props.document?.indexStatus
  if (status === 'ready') return 'success'
  if (status === 'partial' || status === 'pending') return 'primary'
  if (status === 'stale' || status === 'missing') return 'warning'
  if (status === 'failed') return 'danger'
  return 'default'
})
const statusDescription = computed(() => ({
  ready: '正文和向量索引均已就绪，可在统一搜索中绑定此文档问答。',
  partial: '部分索引已可用，回答范围可能不完整。',
  pending: '索引任务已进入任务中心，完成后可绑定此文档问答。',
  stale: '文档已更新，当前索引等待刷新。',
  failed: '最近一次索引失败，可重新建立索引。',
  missing: '尚未为此文档建立资料索引。',
  unknown: '暂时无法读取索引状态，不影响文档预览和下载。'
})[props.document?.indexStatus] || '暂时无法读取索引状态。')

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '大小未知'
  const numericBytes = Number(bytes)
  if (!Number.isFinite(numericBytes) || numericBytes < 0) return '大小未知'
  if (numericBytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(numericBytes) / Math.log(1024)))
  return `${Math.round(numericBytes / (1024 ** index) * 100) / 100} ${units[index]}`
}
</script>

<style scoped>
.document-detail { display: flex; flex-direction: column; gap: 16px; }
.document-detail-hero { padding: 16px 48px 16px 0; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--color-border-subtle); }
.document-detail-hero > div { min-width: 0; display: grid; gap: 5px; }
.document-detail-hero strong { overflow-wrap: anywhere; color: var(--color-text-primary); font-size: 16px; }
.document-detail-hero span { color: var(--color-text-secondary); font-size: 13px; }
.document-detail-icon { width: 48px; height: 48px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: var(--radius-md); color: var(--color-primary); background: color-mix(in srgb, var(--color-primary-surface) 76%, var(--color-surface-raised)); }
.document-type-icon--pdf { color: var(--color-danger-text); background: var(--color-danger-surface); }
.document-type-icon--word { color: #3564b8; background: #edf4ff; }
.document-type-icon--sheet { color: var(--color-success-text); background: var(--color-success-surface); }
.document-type-icon--slides { color: var(--color-warning-text); background: var(--color-warning-surface); }
.document-type-icon--markdown { color: #6a4fb0; background: #f2efff; }
.document-type-icon--image { color: #087c8f; background: #e9f7f8; }
.document-type-icon--code { color: #4f6078; background: #edf0f5; }
.document-detail-section { padding: 15px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-md); background: var(--color-surface-subtle); }
.document-detail-section h4, .document-detail-section p { margin: 0; }
.document-detail-section p { margin-bottom: 10px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.65; }
.document-detail-heading { margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.document-detail-heading > span { color: var(--color-text-muted); font-size: 11px; }
.document-detail-grid { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 12px; font-size: 13px; }
.document-detail-grid > span { color: var(--color-text-muted); }
.document-detail-grid > strong { overflow-wrap: anywhere; color: var(--color-text-primary); }
.document-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.document-action-card { min-width: 0; padding: 11px; display: flex; align-items: center; gap: 10px; color: var(--color-text-primary); text-align: left; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-md); background: var(--color-surface-raised); cursor: pointer; transition: border-color .16s ease, background-color .16s ease, transform .16s ease; }
.document-action-card:hover:not(:disabled) { border-color: var(--color-primary-border); background: var(--color-primary-surface); transform: translateY(-1px); }
.document-action-card:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
.document-action-card:disabled { opacity: .48; cursor: not-allowed; }
.document-action-card > span { width: 34px; height: 34px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); color: var(--color-primary); background: var(--color-primary-surface); }
.document-action-card--primary { border-color: var(--color-primary-border); }
.document-action-card > div { min-width: 0; display: grid; gap: 2px; }
.document-action-card strong { font-size: 13px; white-space: nowrap; }
.document-action-card small { overflow: hidden; color: var(--color-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
</style>
