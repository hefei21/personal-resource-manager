<template>
  <NativeDrawer
    :model-value="visible"
    :title="book?.title || '书籍详情'"
    :show-title="false"
    :top-offset="72"
    placement="right"
    size="460px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div v-if="book" class="ebook-detail">
      <div class="ebook-detail__hero">
        <div class="ebook-detail__cover" :class="`ebook-detail__cover--${fileTone}`">
          <img v-if="book.coverImage" :src="coverUrl" :alt="book.title" @error="$event.currentTarget.style.display = 'none'" />
          <NativeIcon v-else :name="fileIcon" size="30" />
        </div>
        <div><strong>{{ book.title }}</strong><span>{{ book.author || '作者未知' }}</span><small>{{ fileLabel }} · {{ fileSizeLabel }}</small></div>
      </div>

      <section v-if="book.progress > 0 && canReadOnline" class="ebook-detail__continue">
        <div><strong>继续阅读</strong><span>{{ Math.round(book.progress) }}%</span></div>
        <span><i :style="{ width: `${Math.min(100, book.progress)}%` }" /></span>
        <small>{{ book.lastReadAt ? `上次阅读 ${formatDate(book.lastReadAt)}` : '已保存阅读位置' }}</small>
        <NativeButton theme="primary" @click="emit('read', book)">继续阅读</NativeButton>
      </section>

      <section class="ebook-detail__section ebook-detail__meta">
        <span>分类</span><strong>{{ book.categoryName || '未分类' }}</strong>
        <span>出版年份</span><strong>{{ book.year || '-' }}</strong>
        <span>出版社</span><strong>{{ book.publisher || '-' }}</strong>
        <span>ISBN</span><strong>{{ book.isbn || '-' }}</strong>
        <span>上传时间</span><strong>{{ formatDate(book.createdAt) }}</strong>
      </section>

      <section class="ebook-detail__section">
        <div class="ebook-detail__heading"><h4>资料索引</h4><NativeTag :theme="indexTheme" variant="light">{{ indexLabel }}</NativeTag></div>
        <p>{{ indexDescription }}</p>
      </section>

      <section v-if="metadataLabel" class="ebook-detail__section">
        <div class="ebook-detail__heading"><h4>书籍信息</h4><NativeTag :theme="metadataTheme" variant="light">{{ metadataLabel }}</NativeTag></div>
        <p>{{ metadataDescription }}</p>
      </section>

      <section v-if="book.description" class="ebook-detail__section">
        <div class="ebook-detail__heading"><h4>内容简介</h4></div>
        <p class="ebook-detail__description">{{ book.description }}</p>
      </section>

      <section class="ebook-detail__section">
        <div class="ebook-detail__heading"><h4>书籍操作</h4><span>阅读与管理</span></div>
        <div class="ebook-detail__actions">
          <button type="button" class="primary" :disabled="!canReadOnline" @click="emit('read', book)"><span><NativeIcon name="book-open" /></span><div><strong>{{ canReadOnline ? (book.progress > 0 ? '继续阅读' : '开始阅读') : '暂不支持在线阅读' }}</strong><small>{{ canReadOnline ? '自动同步双端进度' : '请下载原件后查看' }}</small></div></button>
          <button type="button" @click="emit('download', book)"><span><NativeIcon name="download" /></span><div><strong>下载原件</strong><small>保存当前书籍文件</small></div></button>
          <button type="button" :disabled="!canWrite" @click="emit('edit', book)"><span><NativeIcon name="pencil" /></span><div><strong>编辑信息</strong><small>修改元数据与分类</small></div></button>
          <button v-if="canReparse" type="button" :disabled="!canWrite || reparseLoading" @click="emit('reparse', book)"><span><NativeIcon name="arrow-clockwise" /></span><div><strong>重解析元数据</strong><small>重新读取 EPUB 信息</small></div></button>
        </div>
      </section>
    </div>
    <template #footer>
      <NativePopconfirm v-if="book" content="书籍将进入统一回收站，确定继续吗？" @confirm="emit('delete', book.id)">
        <template #trigger><NativeButton theme="danger" variant="outline" :disabled="!canWrite">移入回收站</NativeButton></template>
      </NativePopconfirm>
      <NativeButton variant="outline" @click="emit('update:visible', false)">关闭</NativeButton>
    </template>
  </NativeDrawer>
</template>

<script setup>
import { computed } from 'vue'
import { NativeButton, NativeDrawer, NativeIcon, NativePopconfirm, NativeTag } from '@/components/native'
import { authenticatedAssetUrl } from '@/utils/authentication'

const props = defineProps({
  visible: Boolean,
  book: { type: Object, default: null },
  canWrite: Boolean,
  reparseLoading: Boolean
})
const emit = defineEmits(['update:visible', 'read', 'download', 'edit', 'reparse', 'delete'])
const type = computed(() => String(props.book?.fileType || '').toLowerCase())
const fileLabel = computed(() => type.value.toUpperCase() || '电子书')
const fileIcon = computed(() => type.value === 'pdf' ? 'file-pdf' : type.value === 'txt' ? 'file-txt' : 'book-open')
const fileTone = computed(() => type.value === 'pdf' ? 'pdf' : type.value === 'txt' ? 'text' : 'book')
const coverUrl = computed(() => authenticatedAssetUrl(`/api/ebooks/${props.book?.id}/cover`))
const canReparse = computed(() => type.value === 'epub')
const canReadOnline = computed(() => ['epub', 'pdf', 'txt'].includes(type.value))
const fileSizeLabel = computed(() => formatFileSize(props.book?.fileSize))
const indexStatus = computed(() => props.book?.indexStatus || 'empty')
const indexLabel = computed(() => ({ ready: '可问', partial: '部分可问', pending: '索引中', stale: '待刷新', failed: '索引失败', empty: '未索引', missing: '未索引', unknown: '状态待确认' })[indexStatus.value] || '状态待确认')
const indexTheme = computed(() => ({ ready: 'success', partial: 'primary', pending: 'primary', stale: 'warning', failed: 'danger', empty: 'warning', missing: 'warning', unknown: 'default' })[indexStatus.value] || 'default')
const indexDescription = computed(() => ({
  ready: '正文索引已就绪，可在统一搜索中绑定这本书进行问答。',
  partial: '部分内容已经可检索，回答覆盖范围可能不完整。',
  pending: '索引任务正在处理，完成后即可绑定问答。',
  stale: '书籍内容状态已变化，索引等待刷新。',
  failed: '最近一次索引没有完成，可在任务中心查看原因。',
  empty: '尚未为这本书建立资料索引，不影响阅读和下载。',
  missing: '尚未为这本书建立资料索引，不影响阅读和下载。',
  unknown: '资料索引状态尚未完成校验，不影响阅读和下载。'
})[indexStatus.value] || '资料索引状态尚未完成校验，不影响阅读和下载。')
const metadataLabel = computed(() => metadataStatusLabel(props.book?.metadataStatus))
const metadataTheme = computed(() => props.book?.metadataStatus === 'failed' ? 'danger' : 'warning')
const metadataDescription = computed(() => ({
  pending: '元数据仍在后台解析，书籍已经可以阅读和下载。',
  partial: '只读取到部分书籍信息，可手动补充或重新解析。',
  failed: '最近一次元数据解析失败，可使用“重解析元数据”再次尝试。'
})[props.book?.metadataStatus] || '')

function metadataStatusLabel(status) {
  return ({ pending: '解析中', partial: '信息不完整', failed: '解析失败' })[status] || ''
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function formatFileSize(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${Math.round(bytes / (1024 ** index) * 100) / 100} ${units[index]}`
}
</script>

<style scoped>
.ebook-detail{display:flex;flex-direction:column;gap:16px}.ebook-detail__hero{display:flex;align-items:center;gap:14px;padding:16px 48px 18px 0;border-bottom:1px solid var(--color-border-subtle)}.ebook-detail__hero>div:last-child{min-width:0;display:grid;gap:4px}.ebook-detail__hero strong{overflow-wrap:anywhere;font-size:16px;color:var(--color-text-primary)}.ebook-detail__hero span,.ebook-detail__hero small{font-size:13px;color:var(--color-text-secondary)}.ebook-detail__cover{width:62px;height:78px;flex:0 0 auto;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid var(--color-primary-border);border-radius:8px;color:#5363d9;background:#eef0ff}.ebook-detail__cover--pdf{border-color:#f0c9d0;color:#b23b55;background:#fff0f2}.ebook-detail__cover--text{border-color:#d7dce5;color:#5d687b;background:#f0f2f6}.ebook-detail__cover img{width:100%;height:100%;object-fit:cover}.ebook-detail__continue,.ebook-detail__section{padding:15px;border:1px solid var(--color-border-subtle);border-radius:var(--radius-md);background:var(--color-surface-subtle)}.ebook-detail__continue{display:grid;grid-template-columns:1fr auto;gap:10px}.ebook-detail__continue>div{display:flex;justify-content:space-between;grid-column:1/-1}.ebook-detail__continue>span{height:5px;align-self:center;overflow:hidden;border-radius:99px;background:#dfe4ed}.ebook-detail__continue i{display:block;height:100%;background:var(--color-primary)}.ebook-detail__continue small{grid-column:1;color:var(--color-text-muted)}.ebook-detail__continue button{grid-column:2;grid-row:2/4}.ebook-detail__meta{display:grid;grid-template-columns:82px minmax(0,1fr);gap:12px;font-size:13px}.ebook-detail__meta>span{color:var(--color-text-muted)}.ebook-detail__meta>strong{overflow-wrap:anywhere}.ebook-detail__heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.ebook-detail__heading h4,.ebook-detail__section p{margin:0}.ebook-detail__heading>span{font-size:11px;color:var(--color-text-muted)}.ebook-detail__section p{font-size:13px;line-height:1.65;color:var(--color-text-secondary)}.ebook-detail__description{white-space:pre-wrap}.ebook-detail__actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.ebook-detail__actions button{min-width:0;padding:11px;display:flex;align-items:center;gap:10px;border:1px solid var(--color-border-subtle);border-radius:var(--radius-md);background:var(--color-surface-raised);color:var(--color-text-primary);text-align:left;cursor:pointer}.ebook-detail__actions button:hover:not(:disabled){border-color:var(--color-primary-border);background:var(--color-primary-surface)}.ebook-detail__actions button.primary{border-color:var(--color-primary-border)}.ebook-detail__actions button:disabled{opacity:.48;cursor:not-allowed}.ebook-detail__actions button>span{width:34px;height:34px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);color:var(--color-primary);background:var(--color-primary-surface)}.ebook-detail__actions button>div{min-width:0;display:grid;gap:2px}.ebook-detail__actions strong{font-size:13px;white-space:nowrap}.ebook-detail__actions small{overflow:hidden;font-size:11px;color:var(--color-text-muted);text-overflow:ellipsis;white-space:nowrap}
</style>
