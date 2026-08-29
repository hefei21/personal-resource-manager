<template>
  <div class="trash-page">
    <div class="trash-intro">
      <div>
        <p>集中管理文档、电子书和音频的删除与恢复；文档历史版本仍在文档详情中管理。</p>
        <span>系统不会在此页面自动永久删除资源。到期条目只会标记为可清理。</span>
      </div>
      <NativeButton variant="outline" :loading="loading" @click="loadTrash">
        <template #icon><NativeIcon name="arrow-clockwise" /></template>
        刷新
      </NativeButton>
    </div>

    <div class="trash-summary" aria-label="回收站摘要">
      <NativeCard v-for="card in summaryCards" :key="card.key" class="summary-card">
        <span>{{ card.label }}</span>
        <strong>{{ card.value }}</strong>
        <small>{{ card.description }}</small>
      </NativeCard>
    </div>

    <NativeCard class="trash-filter-card">
      <form class="trash-filters" @submit.prevent="applyFilters">
        <label>
          <span>资源类型</span>
          <NativeSelect v-model="filters.type" :options="typeOptions" @change="handleTypeChange" />
        </label>
        <label class="trash-search-field">
          <span>关键词</span>
          <NativeInput v-model="filters.q" placeholder="标题、作者、艺术家或原位置" clearable @enter="applyFilters" />
        </label>
        <label>
          <span>到期状态</span>
          <NativeSelect v-model="filters.expiry" :options="expiryOptions" />
        </label>
        <label>
          <span>原位置</span>
          <NativeSelect v-model="filters.source" :options="sourceOptions" placeholder="全部位置" clearable />
        </label>
        <label>
          <span>删除起始日</span>
          <NativeInput v-model="filters.deletedAfter" type="date" />
        </label>
        <label>
          <span>删除截止日</span>
          <NativeInput v-model="filters.deletedBefore" type="date" />
        </label>
        <label>
          <span>排序</span>
          <NativeSelect v-model="filters.sort" :options="sortOptions" />
        </label>
        <div class="trash-filter-actions">
          <NativeButton theme="primary" type="submit">筛选</NativeButton>
          <NativeButton variant="outline" type="button" @click="resetFilters">重置</NativeButton>
        </div>
      </form>
    </NativeCard>

    <NativeAlert v-if="loadError" theme="error" title="统一回收站暂时不可用">
      {{ loadError }}
    </NativeAlert>

    <NativeAlert v-if="batchFailures.length" theme="warning" title="部分资源未能恢复">
      <ul class="batch-failure-list">
        <li v-for="failure in batchFailures" :key="failure.key">
          {{ failure.title }}：{{ failure.message }}
        </li>
      </ul>
    </NativeAlert>

    <NativeCard class="trash-list-card">
      <div v-if="!isMobile && items.length" class="trash-list-toolbar">
        <NativeCheckbox
          :model-value="allRestorableSelected"
          :indeterminate="someRestorableSelected"
          :disabled="restorablePageItems.length === 0"
          @update:model-value="toggleSelectPage"
        >
          选择本页可恢复条目
        </NativeCheckbox>
        <div class="trash-list-toolbar-actions">
          <span>已选 {{ selectedKeys.length }} 项</span>
          <NativeButton
            theme="primary"
            size="small"
            :disabled="selectedKeys.length === 0"
            :loading="batchRestoring"
            @click="restoreSelected"
          >
            批量恢复
          </NativeButton>
        </div>
      </div>

      <NativeLoading v-if="loading && items.length === 0" center text="加载回收站中..." />
      <NativeEmpty v-else-if="items.length === 0" :description="loadError ? '无法加载回收站' : '没有符合条件的回收站条目'">
        <template #action>
          <NativeButton v-if="loadError" size="small" @click="loadTrash">重新加载</NativeButton>
        </template>
      </NativeEmpty>
      <div v-else class="trash-list" role="list">
        <article v-for="item in items" :key="item.key" class="trash-item" role="listitem">
          <NativeCheckbox
            v-if="!isMobile"
            :model-value="selectedKeys.includes(item.key)"
            :disabled="!item.canRestore"
            :aria-label="`选择 ${item.title}`"
            @update:model-value="(checked) => toggleItem(item, checked)"
          />
          <div class="trash-item-icon" aria-hidden="true">
            <NativeIcon :name="resourceIcon(item.resourceType)" size="22" />
          </div>
          <div class="trash-item-main">
            <div class="trash-item-title-row">
              <strong>{{ item.title }}</strong>
              <NativeTag theme="primary" variant="light" size="small">{{ resourceLabel(item.resourceType) }}</NativeTag>
              <NativeTag :theme="statusTheme(item)" variant="light" size="small">{{ statusLabel(item) }}</NativeTag>
            </div>
            <span v-if="item.subtitle" class="trash-item-subtitle">{{ item.subtitle }}</span>
            <dl class="trash-item-meta">
              <div><dt>原位置</dt><dd>{{ item.originalLocation || '未分类 / 未记录' }}</dd></div>
              <div><dt>移入时间</dt><dd>{{ formatDate(item.deletedAt) }}</dd></div>
              <div><dt>{{ item.isExpired ? '已到清理时间' : '保留至' }}</dt><dd>{{ formatDate(item.purgeAfter) }}</dd></div>
            </dl>
            <p v-if="item.issueCode" class="trash-item-issue">{{ issueMessage(item.issueCode) }}</p>
          </div>
          <div class="trash-item-actions">
            <NativeButton
              theme="primary"
              size="small"
              :disabled="!canWrite || !item.canRestore"
              :loading="isActionLoading(item.key, 'restore')"
              @click="restoreOne(item)"
            >
              恢复
            </NativeButton>
            <NativeButton
              v-if="!isMobile"
              theme="danger"
              variant="outline"
              size="small"
              :disabled="!canWrite || !item.canPermanentlyDelete"
              @click="requestPermanentDelete(item)"
            >
              永久删除
            </NativeButton>
          </div>
        </article>
      </div>

      <div v-if="pagination.total > pagination.pageSize" class="trash-pagination">
        <NativePagination
          :current="pagination.page"
          :page-size="pagination.pageSize"
          :total="pagination.total"
          :page-size-options="[10, 20, 50]"
          @change="handlePageChange"
        />
      </div>
    </NativeCard>

    <NativeDialog
      v-model="permanentDialogVisible"
      title="永久删除资源"
      confirm-text="永久删除"
      :confirm-loading="permanentDeleting"
      :confirm-disabled="!pendingPermanentItem"
      :close-on-overlay-click="!permanentDeleting"
      @confirm="confirmPermanentDelete"
    >
      <div class="permanent-warning">
        <p>即将永久删除“{{ pendingPermanentItem?.title }}”。</p>
        <p>这会清理权威资源记录及未被其他资源引用的原始内容，操作不可撤销。</p>
        <p v-if="pendingPermanentItem?.resourceType === 'document'">该文档的历史版本也会同时清理。</p>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { useViewport } from '@/composables/useViewport'
import {
  NativeAlert,
  NativeButton,
  NativeCard,
  NativeCheckbox,
  NativeDialog,
  NativeEmpty,
  NativeIcon,
  NativeInput,
  NativeLoading,
  NativePagination,
  NativeSelect,
  NativeTag
} from '@/components/native'

const SUPPORTED_TYPES = new Set(['all', 'document', 'ebook', 'music'])
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { canWrite } = usePermission()
const { isMobile } = useViewport()

const loading = ref(false)
const loadError = ref('')
const items = ref([])
const summary = ref({ total: 0, filteredTotal: 0, expired: 0, restorable: 0, byType: {}, sources: [] })
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const filters = reactive({
  type: normalizedRouteType(route.query.type),
  q: '',
  expiry: 'all',
  source: '',
  deletedAfter: '',
  deletedBefore: '',
  sort: 'deleted_desc'
})
const selectedKeys = ref([])
const actionLoading = ref(new Set())
const batchRestoring = ref(false)
const batchFailures = ref([])
const permanentDialogVisible = ref(false)
const pendingPermanentItem = ref(null)
const permanentDeleting = ref(false)

const typeOptions = computed(() => [
  { value: 'all', label: `全部（${summary.value.total || 0}）` },
  { value: 'document', label: `文档（${summary.value.byType?.document || 0}）` },
  { value: 'ebook', label: `电子书（${summary.value.byType?.ebook || 0}）` },
  { value: 'music', label: `音频（${summary.value.byType?.music || 0}）` }
])
const expiryOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'protected', label: '保留期内' },
  { value: 'expired', label: '已到清理时间' }
]
const sortOptions = [
  { value: 'deleted_desc', label: '最近删除' },
  { value: 'deleted_asc', label: '最早删除' },
  { value: 'purge_asc', label: '最早到期' }
]
const sourceOptions = computed(() => (summary.value.sources || []).map((value) => ({ value, label: value })))
const summaryCards = computed(() => [
  { key: 'total', label: '全部资源', value: summary.value.total || 0, description: '文档、电子书与音频' },
  { key: 'restorable', label: '可恢复', value: summary.value.restorable || 0, description: '可安全执行恢复' },
  { key: 'expired', label: '已到清理时间', value: summary.value.expired || 0, description: '不会自动永久删除' },
  { key: 'filtered', label: '当前结果', value: summary.value.filteredTotal || 0, description: '符合当前筛选' }
])
const itemByKey = computed(() => new Map(items.value.map((item) => [item.key, item])))
const restorablePageItems = computed(() => items.value.filter((item) => item.canRestore))
const allRestorableSelected = computed(() => restorablePageItems.value.length > 0 &&
  restorablePageItems.value.every((item) => selectedKeys.value.includes(item.key)))
const someRestorableSelected = computed(() => !allRestorableSelected.value &&
  restorablePageItems.value.some((item) => selectedKeys.value.includes(item.key)))

function normalizedRouteType(value) {
  return typeof value === 'string' && SUPPORTED_TYPES.has(value) ? value : 'all'
}

function queryParams() {
  return {
    type: filters.type,
    q: filters.q || undefined,
    expiry: filters.expiry,
    source: filters.source || undefined,
    deletedAfter: localDateBoundary(filters.deletedAfter),
    deletedBefore: localDateBoundary(filters.deletedBefore, true),
    sort: filters.sort,
    page: pagination.page,
    pageSize: pagination.pageSize
  }
}

function localDateBoundary(value, endOfDay = false) {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  )
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

async function loadTrash() {
  loading.value = true
  loadError.value = ''
  try {
    const response = await api.trash.list(queryParams())
    const data = response.data?.data || {}
    items.value = Array.isArray(data.items) ? data.items : []
    summary.value = data.summary || summary.value
    Object.assign(pagination, data.pagination || { page: 1, pageSize: pagination.pageSize, total: 0 })
    selectedKeys.value = selectedKeys.value.filter((key) => itemByKey.value.has(key))
  } catch (error) {
    items.value = []
    pagination.total = 0
    loadError.value = error.response?.data?.message || '请检查网络或稍后重试'
  } finally {
    loading.value = false
  }
}

async function handleTypeChange(value) {
  filters.type = normalizedRouteType(value)
  pagination.page = 1
  await router.replace({ query: { ...route.query, type: filters.type === 'all' ? undefined : filters.type } })
  await loadTrash()
}

async function applyFilters() {
  pagination.page = 1
  batchFailures.value = []
  await loadTrash()
}

async function resetFilters() {
  Object.assign(filters, {
    type: normalizedRouteType(route.query.type),
    q: '',
    expiry: 'all',
    source: '',
    deletedAfter: '',
    deletedBefore: '',
    sort: 'deleted_desc'
  })
  pagination.page = 1
  batchFailures.value = []
  await loadTrash()
}

async function handlePageChange({ current, pageSize }) {
  pagination.page = current
  pagination.pageSize = pageSize
  selectedKeys.value = []
  await loadTrash()
}

function resourceLabel(type) {
  return ({ document: '文档', ebook: '电子书', music: '音频' })[type] || '资源'
}

function resourceIcon(type) {
  return ({ document: 'files', ebook: 'book-open', music: 'waveform' })[type] || 'file'
}

function statusLabel(item) {
  if (item.state === 'purging') return '清理待完成'
  if (item.state === 'error' || item.issueCode) return '需要处理'
  return item.isExpired ? '已到清理时间' : '保留期内'
}

function statusTheme(item) {
  if (item.state === 'error' || item.issueCode) return 'danger'
  if (item.state === 'purging' || item.isExpired) return 'warning'
  return 'success'
}

function issueMessage(code) {
  return ({
    RESOURCE_TRASH_METADATA_INVALID: '回收状态损坏，请先检查一致性后再操作。',
    RESOURCE_TRASH_RECORD_MISSING: '资源记录缺失，无法恢复；可在 PC 端重试永久清理。'
  })[code] || '该条目需要进一步检查。'
}

function formatDate(value) {
  if (!value) return '未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间异常' : date.toLocaleString('zh-CN', { hour12: false })
}

function toggleItem(item, checked) {
  const keys = new Set(selectedKeys.value)
  if (checked && item.canRestore) keys.add(item.key)
  else keys.delete(item.key)
  selectedKeys.value = [...keys]
}

function toggleSelectPage(checked) {
  const keys = new Set(selectedKeys.value)
  for (const item of restorablePageItems.value) {
    if (checked) keys.add(item.key)
    else keys.delete(item.key)
  }
  selectedKeys.value = [...keys]
}

function setActionLoading(key, action, active) {
  const next = new Set(actionLoading.value)
  const actionKey = `${action}:${key}`
  if (active) next.add(actionKey)
  else next.delete(actionKey)
  actionLoading.value = next
}

function isActionLoading(key, action) {
  return actionLoading.value.has(`${action}:${key}`)
}

async function restoreOne(item) {
  if (!item.canRestore || isActionLoading(item.key, 'restore')) return
  setActionLoading(item.key, 'restore', true)
  batchFailures.value = []
  try {
    const response = await api.trash.restore(item.resourceType, item.resourceId)
    toast.success(response.data?.message || '资源已恢复')
    selectedKeys.value = selectedKeys.value.filter((key) => key !== item.key)
    await loadTrash()
  } catch (error) {
    toast.error(error.response?.data?.message || '恢复资源失败')
  } finally {
    setActionLoading(item.key, 'restore', false)
  }
}

async function restoreSelected() {
  const selected = selectedKeys.value.map((key) => itemByKey.value.get(key)).filter((item) => item?.canRestore)
  if (selected.length === 0 || batchRestoring.value) return
  batchRestoring.value = true
  batchFailures.value = []
  try {
    const response = await api.trash.batchRestore(selected.map((item) => ({
      resourceType: item.resourceType,
      resourceId: item.resourceId
    })))
    const data = response.data?.data || {}
    const failures = (data.results || []).filter((item) => !item.success).map((failure) => ({
      ...failure,
      title: itemByKey.value.get(failure.key)?.title || failure.key
    }))
    batchFailures.value = failures
    const succeeded = data.summary?.succeeded || 0
    if (failures.length) toast.warning(`已恢复 ${succeeded} 项，${failures.length} 项需要处理`)
    else toast.success(`已恢复 ${succeeded} 项资源`)
    selectedKeys.value = failures.map((failure) => failure.key)
    await loadTrash()
  } catch (error) {
    toast.error(error.response?.data?.message || '批量恢复失败')
  } finally {
    batchRestoring.value = false
  }
}

function requestPermanentDelete(item) {
  pendingPermanentItem.value = item
  permanentDialogVisible.value = true
}

async function confirmPermanentDelete() {
  const item = pendingPermanentItem.value
  if (!item || permanentDeleting.value) return
  permanentDeleting.value = true
  try {
    await api.trash.permanentlyDelete(item.resourceType, item.resourceId)
    permanentDialogVisible.value = false
    pendingPermanentItem.value = null
    selectedKeys.value = selectedKeys.value.filter((key) => key !== item.key)
    toast.success('资源已永久删除')
    await loadTrash()
  } catch (error) {
    toast.error(error.response?.data?.message || '永久删除资源失败')
  } finally {
    permanentDeleting.value = false
  }
}

watch(() => route.query.type, async (value) => {
  const normalized = normalizedRouteType(value)
  if (normalized === filters.type) return
  filters.type = normalized
  pagination.page = 1
  selectedKeys.value = []
  await loadTrash()
})

watch(isMobile, (mobile) => {
  if (mobile) {
    selectedKeys.value = []
    permanentDialogVisible.value = false
    pendingPermanentItem.value = null
  }
})

onMounted(loadTrash)
</script>

<style scoped>
.trash-page {
  display: grid;
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
  gap: 18px;
}

.trash-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.trash-intro p {
  margin: 0 0 6px;
  color: var(--color-text-primary);
  font-size: 15px;
}

.trash-intro span,
.summary-card small,
.trash-item-subtitle {
  color: var(--color-text-secondary);
}

.trash-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.summary-card :deep(.native-card__body) {
  display: grid;
  gap: 7px;
  padding: 18px 20px;
}

.summary-card span {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.summary-card strong {
  color: var(--color-text-primary);
  font-size: 28px;
  line-height: 1;
}

.summary-card small {
  font-size: 12px;
}

.trash-filter-card :deep(.native-card__body) {
  padding: 18px 20px;
}

.trash-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(150px, 1fr));
  gap: 14px;
  align-items: end;
}

.trash-filters label {
  display: grid;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.trash-search-field {
  grid-column: span 2;
}

.trash-filter-actions {
  display: flex;
  gap: 8px;
}

.trash-list-card :deep(.native-card__body) {
  padding: 0;
}

.trash-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 58px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-soft, #f7f8fb);
}

.trash-list-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.trash-list-card > :deep(.native-loading),
.trash-list-card > :deep(.native-empty) {
  min-height: 260px;
  padding: 48px 20px;
}

.trash-list {
  display: grid;
}

.trash-item {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  gap: 14px;
  align-items: flex-start;
  padding: 20px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.trash-item:last-child {
  border-bottom: 0;
}

.trash-item-icon {
  display: grid;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--color-primary-soft, #eef0ff);
  color: var(--color-primary);
  place-items: center;
}

.trash-item-main {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.trash-item-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.trash-item-title-row strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.trash-item-subtitle {
  font-size: 13px;
}

.trash-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
}

.trash-item-meta div {
  display: flex;
  gap: 6px;
  font-size: 12px;
}

.trash-item-meta dt {
  color: var(--color-text-muted);
}

.trash-item-meta dd {
  margin: 0;
  color: var(--color-text-secondary);
}

.trash-item-issue {
  margin: 0;
  color: var(--color-danger, #b42318);
  font-size: 12px;
}

.trash-item-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.trash-pagination {
  padding: 0 20px;
  border-top: 1px solid var(--color-border-subtle);
}

.batch-failure-list {
  margin: 8px 0 0;
  padding-left: 20px;
}

.permanent-warning p {
  margin: 0 0 10px;
  line-height: 1.65;
}

.permanent-warning p:nth-child(n + 2) {
  color: var(--color-danger, #b42318);
}

@media (max-width: 1000px) {
  .trash-summary,
  .trash-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .trash-page {
    gap: 14px;
  }

  .trash-intro {
    align-items: stretch;
    flex-direction: column;
  }

  .trash-intro .native-btn {
    align-self: flex-start;
  }

  .trash-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .summary-card :deep(.native-card__body) {
    padding: 14px;
  }

  .summary-card strong {
    font-size: 23px;
  }

  .trash-filters {
    grid-template-columns: 1fr;
  }

  .trash-search-field {
    grid-column: auto;
  }

  .trash-filter-actions .native-btn {
    flex: 1;
  }

  .trash-item {
    grid-template-columns: auto minmax(0, 1fr);
    padding: 16px;
  }

  .trash-item-main,
  .trash-item-actions {
    grid-column: 2;
  }

  .trash-item-meta {
    display: grid;
    gap: 5px;
  }

  .trash-item-actions {
    justify-content: flex-end;
  }

  .trash-pagination {
    padding: 0 12px;
    overflow-x: auto;
  }
}
</style>
