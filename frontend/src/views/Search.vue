<template>
  <div class="search-page">
    <section class="search-hero">
      <div>
        <h1>统一搜索</h1>
        <p>由 NAS 本机 SQLite FTS5 提供，PC Worker 离线也可搜索。</p>
      </div>
      <button class="secondary-button" :disabled="refreshing" @click="refreshIndex(false)">
        {{ refreshing ? '索引任务运行中…' : '刷新索引' }}
      </button>
    </section>

    <section v-if="indexStatus" class="status-strip" :class="`status-${indexStatus.status}`">
      <div>
        <strong>{{ indexStatusLabel }}</strong>
        <span v-if="indexStatus.lastCompletedAt">最近完成：{{ formatTime(indexStatus.lastCompletedAt) }}</span>
        <span>条目：{{ indexStatus.entryCount || 0 }}</span>
      </div>
      <div v-if="indexStatus.pcWorker?.status === 'offline'" class="offline-note">
        PC Worker 离线；关键词检索不受影响。
      </div>
      <button
        v-if="['missing', 'failed', 'partial'].includes(indexStatus.status)"
        class="inline-button"
        :disabled="refreshing"
        @click="refreshIndex(true)"
      >
        完整重建
      </button>
    </section>

    <form class="search-form" @submit.prevent="runSearch(true)">
      <div class="search-row">
        <input
          v-model.trim="filters.q"
          class="search-input"
          type="search"
          maxlength="256"
          placeholder="搜索标题、正文、章节、代码、作者或标签"
          autocomplete="off"
        />
        <button class="primary-button" type="submit" :disabled="loading || !filters.q">
          {{ loading ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <div class="scope-tabs" role="tablist" aria-label="搜索范围">
        <button
          v-for="option in scopeOptions"
          :key="option.value"
          type="button"
          role="tab"
          :aria-selected="filters.scope === option.value"
          :class="{ active: filters.scope === option.value }"
          @click="setScope(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <button class="filter-toggle" type="button" @click="showFilters = !showFilters">
        {{ showFilters ? '收起筛选' : '展开筛选' }}
      </button>
      <div v-if="showFilters" class="filter-grid">
        <label>
          <span>资源类型</span>
          <select v-model="filters.type">
            <option value="">全部</option>
            <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label><span>标签</span><input v-model.trim="filters.tag" placeholder="精确标签" /></label>
        <label><span>作者</span><input v-model.trim="filters.author" placeholder="精确作者" /></label>
        <label><span>状态</span><input v-model.trim="filters.status" placeholder="如 ready / draft" /></label>
        <label>
          <span>来源</span>
          <select v-model="filters.source">
            <option value="">全部</option>
            <option value="managed_storage">受管存储</option>
            <option value="legacy_record">旧资源记录</option>
            <option value="owner_note">个人笔记</option>
            <option value="git_nas">NAS 只读 Git</option>
            <option value="managed_git">受管 Git</option>
          </select>
        </label>
        <label><span>更新时间起</span><input v-model="filters.dateFrom" type="date" /></label>
        <label><span>更新时间止</span><input v-model="filters.dateTo" type="date" /></label>
        <button type="button" class="reset-button" @click="resetAdvancedFilters">清除筛选</button>
      </div>
    </form>

    <div v-if="feedback" class="feedback" role="status">
      <span>{{ feedback }}</span>
      <button v-if="errorCode === 'SEARCH_INDEX_MISSING'" @click="refreshIndex(true)">建立索引</button>
    </div>

    <section v-if="searched && !loading" class="results-section">
      <header class="results-heading">
        <div>
          <strong>{{ total }} 个结果</strong>
          <span v-if="result?.index?.status === 'partial'">索引不完整，部分资源仅含元数据。</span>
        </div>
        <span v-if="elapsedMs !== null">{{ elapsedMs }} ms</span>
      </header>

      <div v-if="filters.scope === 'external' && result?.externalDiscovery?.enabled === false" class="external-empty">
        外部发现未配置。阶段 6A 不会自动调用被冻结的外部资源站。
      </div>

      <div v-if="results.length === 0" class="empty-state">
        <strong>没有找到匹配资源</strong>
        <span>可以减少筛选条件、尝试完整关键词，或刷新索引后再试。</span>
      </div>

      <article v-for="item in results" :key="item.entryKey" class="result-card">
        <button class="result-main" @click="openResult(item)">
          <div class="result-title-row">
            <span class="type-badge">{{ typeLabel(item.resourceType) }}</span>
            <h2>{{ item.title }}</h2>
            <span v-if="item.indexStatus !== 'ready'" class="metadata-badge">仅元数据</span>
          </div>
          <p v-if="item.subtitle" class="result-subtitle">{{ item.subtitle }}</p>
          <p class="result-snippet">{{ item.snippet }}</p>
          <div class="result-meta">
            <span>{{ locatorLabel(item) }}</span>
            <span v-if="item.author">作者：{{ item.author }}</span>
            <span v-if="item.source?.label">来源：{{ item.source.label }}</span>
            <span v-if="item.matchedFields?.length">匹配：{{ item.matchedFields.join('、') }}</span>
          </div>
          <div v-if="item.tags?.length" class="tag-list">
            <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
          </div>
        </button>
      </article>

      <div v-if="total > results.length" class="pagination-row">
        <button :disabled="offset === 0" @click="previousPage">上一页</button>
        <span>第 {{ Math.floor(offset / pageSize) + 1 }} 页</span>
        <button :disabled="offset + pageSize >= total" @click="nextPage">下一页</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'

const router = useRouter()
const pageSize = 20
const loading = ref(false)
const refreshing = ref(false)
const searched = ref(false)
const showFilters = ref(false)
const result = ref(null)
const indexStatus = ref(null)
const feedback = ref('')
const errorCode = ref('')
const elapsedMs = ref(null)
const offset = ref(0)
let pollTimer = null

const filters = reactive({
  q: '', scope: 'owned', type: '', tag: '', author: '', status: '', source: '', dateFrom: '', dateTo: ''
})

const scopeOptions = [
  { value: 'owned', label: '我的资源' },
  { value: 'external', label: '外部发现' },
  { value: 'all', label: '综合结果' }
]
const typeOptions = [
  { value: 'document', label: '文档' },
  { value: 'ebook', label: '电子书' },
  { value: 'ebook_chapter', label: '电子书章节' },
  { value: 'code_repository', label: '代码仓库' },
  { value: 'code_file', label: '代码文件' },
  { value: 'note', label: '个人笔记' },
  { value: 'audio', label: '音频' }
]
const typeLabels = Object.freeze(Object.fromEntries(typeOptions.map((item) => [item.value, item.label])))
const results = computed(() => result.value?.data || [])
const total = computed(() => result.value?.total || 0)
const indexStatusLabel = computed(() => ({
  missing: '尚未建立搜索索引', empty: '搜索索引为空', rebuilding: '正在重建索引',
  ready: '索引可用', partial: '索引部分可用', failed: '索引刷新失败'
}[indexStatus.value?.status] || '索引状态未知'))

function buildParams() {
  const params = { q: filters.q, scope: filters.scope, limit: pageSize, offset: offset.value }
  for (const key of ['type', 'tag', 'author', 'status', 'source']) if (filters[key]) params[key] = filters[key]
  if (filters.dateFrom) params.dateFrom = `${filters.dateFrom}T00:00:00.000Z`
  if (filters.dateTo) params.dateTo = `${filters.dateTo}T23:59:59.999Z`
  return params
}

async function loadStatus() {
  try {
    const response = await api.search.status()
    indexStatus.value = response.data?.data || null
  } catch {
    indexStatus.value = { status: 'failed', entryCount: 0 }
  }
}

async function runSearch(resetPage = false) {
  if (!filters.q) return
  if (resetPage) offset.value = 0
  loading.value = true
  feedback.value = ''
  errorCode.value = ''
  const started = performance.now()
  try {
    const response = await api.search.global(buildParams())
    result.value = response.data
    indexStatus.value = response.data?.index || indexStatus.value
    searched.value = true
  } catch (error) {
    errorCode.value = error.response?.data?.code || 'SEARCH_INDEX_UNAVAILABLE'
    feedback.value = errorCode.value === 'SEARCH_INDEX_MISSING'
      ? '搜索索引尚未建立，请先执行完整重建。'
      : errorCode.value === 'SEARCH_INPUT_INVALID'
        ? '搜索词或筛选条件无效。'
        : '暂时无法搜索，请稍后重试。'
    result.value = null
    searched.value = true
  } finally {
    elapsedMs.value = Math.round(performance.now() - started)
    loading.value = false
  }
}

async function refreshIndex(rebuild) {
  if (refreshing.value) return
  refreshing.value = true
  feedback.value = ''
  try {
    const response = await api.search.refreshIndex({ rebuild, includeCodeFiles: true })
    const taskId = response.data?.data?.id
    if (!taskId) throw new Error('missing task id')
    feedback.value = '索引任务已进入 NAS 持久队列。'
    await pollTask(taskId)
  } catch (error) {
    if (error.response?.status === 409) feedback.value = '已有索引任务正在运行。'
    else feedback.value = '无法启动索引任务。'
    refreshing.value = false
  }
}

async function pollTask(taskId) {
  try {
    const response = await api.tasks.get(taskId)
    const task = response.data?.data
    if (!task) throw new Error('missing task')
    if (['pending', 'leased', 'running'].includes(task.status)) {
      pollTimer = window.setTimeout(() => pollTask(taskId), 1500)
      return
    }
    refreshing.value = false
    await loadStatus()
    if (task.status === 'succeeded') {
      feedback.value = '索引刷新完成。'
      if (filters.q) await runSearch(false)
    } else {
      feedback.value = `索引任务未完成：${task.errorCode || task.status}`
    }
  } catch {
    refreshing.value = false
    feedback.value = '索引任务状态暂时不可用，可在任务中心查看。'
  }
}

function setScope(value) {
  filters.scope = value
  if (searched.value && filters.q) runSearch(true)
}

function resetAdvancedFilters() {
  Object.assign(filters, { type: '', tag: '', author: '', status: '', source: '', dateFrom: '', dateTo: '' })
}

function openResult(item) {
  const locator = item.locator || {}
  const { route, ...query } = locator
  if (route) router.push({ path: route, query })
}

function locatorLabel(item) {
  const locator = item.locator || {}
  if (locator.path) return `${locator.path}${locator.line ? `:${locator.line}` : ''}`
  if (Number.isSafeInteger(locator.chapterIndex)) return `第 ${locator.chapterIndex + 1} 章`
  return '打开资源'
}

function typeLabel(type) { return typeLabels[type] || type }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
function previousPage() { offset.value = Math.max(0, offset.value - pageSize); runSearch(false) }
function nextPage() { offset.value += pageSize; runSearch(false) }

onMounted(loadStatus)
onBeforeUnmount(() => { if (pollTimer) window.clearTimeout(pollTimer) })
</script>

<style scoped>
.search-page { max-width: 1120px; margin: 0 auto; padding: 24px; color: #1f2937; }
.search-hero, .results-heading, .status-strip, .search-row, .result-title-row, .result-meta, .pagination-row { display: flex; align-items: center; }
.search-hero { justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.search-hero h1 { margin: 0 0 6px; font-size: 28px; }
.search-hero p { margin: 0; color: #64748b; }
.status-strip { flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px 16px; margin-bottom: 16px; border: 1px solid #dbeafe; border-radius: 10px; background: #eff6ff; }
.status-strip > div { display: flex; flex-wrap: wrap; gap: 12px; }
.status-partial, .status-failed, .status-missing { border-color: #fed7aa; background: #fff7ed; }
.offline-note { color: #475569; }
.search-form, .result-card { border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; box-shadow: 0 6px 24px rgba(15, 23, 42, .05); }
.search-form { padding: 18px; }
.search-row { gap: 10px; }
.search-input, .filter-grid input, .filter-grid select { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 9px; padding: 10px 12px; background: #fff; color: #1f2937; }
.search-input { min-height: 46px; font-size: 16px; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary-button, .secondary-button, .inline-button, .reset-button, .pagination-row button, .feedback button { border: 0; border-radius: 9px; padding: 10px 16px; }
.primary-button { min-width: 92px; min-height: 46px; background: #4f46e5; color: #fff; font-weight: 600; }
.secondary-button, .pagination-row button { background: #eef2ff; color: #4338ca; }
.inline-button, .reset-button, .feedback button { background: #fff; color: #c2410c; border: 1px solid #fdba74; }
.scope-tabs { display: flex; gap: 6px; margin-top: 14px; border-bottom: 1px solid #e2e8f0; }
.scope-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 9px 12px; background: transparent; color: #64748b; }
.scope-tabs button.active { border-color: #4f46e5; color: #4338ca; font-weight: 600; }
.filter-toggle { margin-top: 12px; padding: 0; border: 0; background: transparent; color: #4f46e5; }
.filter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.filter-grid label { display: flex; flex-direction: column; gap: 6px; color: #475569; font-size: 13px; }
.feedback, .external-empty, .empty-state { margin-top: 16px; padding: 16px; border-radius: 10px; background: #fff7ed; color: #9a3412; }
.feedback { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.results-section { margin-top: 20px; }
.results-heading { justify-content: space-between; margin-bottom: 12px; color: #64748b; }
.results-heading div { display: flex; gap: 12px; }
.result-card { margin-bottom: 12px; overflow: hidden; }
.result-main { width: 100%; padding: 18px; border: 0; background: transparent; text-align: left; color: inherit; }
.result-main:hover { background: #f8fafc; }
.result-title-row { gap: 10px; }
.result-title-row h2 { margin: 0; font-size: 18px; }
.type-badge, .metadata-badge, .tag-list span { display: inline-flex; border-radius: 999px; padding: 3px 8px; font-size: 12px; }
.type-badge { background: #eef2ff; color: #4338ca; }
.metadata-badge { background: #fff7ed; color: #c2410c; }
.result-subtitle { margin: 8px 0 0; color: #475569; }
.result-snippet { margin: 10px 0; color: #334155; white-space: pre-wrap; overflow-wrap: anywhere; }
.result-meta { flex-wrap: wrap; gap: 12px; color: #64748b; font-size: 13px; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tag-list span { background: #f1f5f9; color: #475569; }
.empty-state { display: flex; flex-direction: column; gap: 6px; background: #f8fafc; color: #64748b; text-align: center; }
.pagination-row { justify-content: center; gap: 14px; margin-top: 18px; }
@media (max-width: 768px) {
  .search-page { padding: 4px 0 24px; }
  .search-hero { align-items: flex-start; }
  .search-hero h1 { font-size: 22px; }
  .search-row { align-items: stretch; }
  .filter-grid { grid-template-columns: 1fr 1fr; }
  .status-strip, .feedback { align-items: flex-start; flex-direction: column; }
  .result-title-row { align-items: flex-start; flex-wrap: wrap; }
}
@media (max-width: 480px) {
  .search-hero, .search-row { flex-direction: column; }
  .search-hero .secondary-button, .primary-button { width: 100%; }
  .filter-grid { grid-template-columns: 1fr; }
  .scope-tabs button { flex: 1; padding-inline: 4px; }
}
</style>
