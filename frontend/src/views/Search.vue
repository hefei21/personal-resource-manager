<template>
  <div class="search-page">
    <section class="search-hero">
      <div>
        <p>由 NAS 本机 SQLite FTS5 与 commit 绑定符号索引提供，PC Worker 离线也可搜索。</p>
      </div>
      <button v-if="!isMobile" class="secondary-button" :disabled="refreshing" @click="refreshIndex(false)">
        {{ refreshing ? '索引任务运行中…' : '刷新索引' }}
      </button>
    </section>

    <section v-if="indexStatus" class="status-strip" :class="`status-${indexStatus.status}`">
      <div>
        <strong>{{ indexStatusLabel }}</strong>
        <span v-if="indexStatus.lastCompletedAt">最近完成：{{ formatTime(indexStatus.lastCompletedAt) }}</span>
        <span>条目：{{ indexStatus.entryCount || 0 }}</span>
        <span v-if="indexStatus.symbols">符号：{{ indexStatus.symbols.symbolCount || 0 }}</span>
      </div>
      <div v-if="indexStatus.pcWorker?.status === 'offline'" class="offline-note">
        PC Worker 离线；关键词检索不受影响。
      </div>
      <button
        v-if="!isMobile && ['missing', 'failed', 'partial'].includes(indexStatus.status)"
        class="inline-button"
        :disabled="refreshing"
        @click="refreshIndex(true)"
      >
        完整重建
      </button>
    </section>

    <form class="search-form" @submit.prevent="submitForm">
      <div class="mode-tabs" role="tablist" aria-label="资料操作模式">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'search'"
          :class="{ active: mode === 'search' }"
          @click="setMode('search')"
        >
          搜索
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'ask'"
          :class="{ active: mode === 'ask' }"
          @click="setMode('ask')"
        >
          问资料
        </button>
      </div>
      <p v-if="mode === 'ask'" class="mode-hint">
        只使用当前 Owner 可见资料回答；证据不足时会明确拒答，PC Worker 离线时保留可打开的引用式结果。
      </p>
      <div v-if="mode === 'ask'" class="ask-scope-panel">
        <label class="ask-source-field">
          <span>回答范围</span>
          <select v-model="askSourceKey" aria-label="回答范围" :disabled="coverageLoading || askLoading" @change="resetAskForScopeChange">
            <option value="">全部已索引资料</option>
            <option v-if="askSourceKey && !selectedAskSource" :value="askSourceKey" disabled>所选资料正在读取或已不可用</option>
            <optgroup v-for="group in askSourceGroups" :key="group.type" :label="group.label">
              <option v-for="item in group.items" :key="item.key" :value="item.key">
                {{ item.title }} · {{ ragCoverageStatusLabel(item.status) }}
              </option>
            </optgroup>
          </select>
        </label>
        <div class="ask-scope-summary">
          <template v-if="selectedAskSource">
            <strong>{{ selectedAskSource.title }}</strong>
            <span :class="`coverage-${selectedAskSource.status}`">
              {{ selectedAskSource.chunkCount }} 个文本块 · {{ ragCoverageStatusLabel(selectedAskSource.status) }}
            </span>
          </template>
          <template v-else-if="ragCoverage?.summary">
            <strong>{{ ragCoverage.summary.indexed || 0 }} / {{ ragCoverage.summary.total || 0 }} 项已进入 RAG</strong>
            <span>询问某一本书或某份文档时，建议先绑定具体资源。</span>
          </template>
          <span v-else>{{ coverageLoading ? '正在读取 RAG 覆盖状态…' : '暂时无法读取 RAG 覆盖状态。' }}</span>
        </div>
        <button
          v-if="!isMobile || selectedAskSource"
          type="button"
          class="secondary-button rag-refresh-button"
          :class="{ 'desktop-only': !selectedAskSource }"
          :disabled="ragRefreshing || coverageLoading"
          @click="refreshRagIndex"
        >
          {{ ragRefreshing ? 'RAG 索引任务运行中…' : (selectedAskSource ? '更新此资源索引' : '刷新全部 RAG') }}
        </button>
      </div>
      <div v-if="mode === 'ask' && selectedAskSource?.type === 'ebook'" class="ask-chapter-panel">
        <label class="ask-source-field">
          <span>书内范围</span>
          <select v-model="selectedSection" aria-label="书内范围" :disabled="sectionsLoading || askLoading" @change="resetAskForScopeChange">
            <option value="">整本书（默认）</option>
            <option v-if="selectedSection && !sectionOptions.some(item => item.key === selectedSection)" :value="selectedSection" disabled>已选章节失效，请重新选择</option>
            <option v-for="item in sectionOptions" :key="item.key" :value="item.key">限定章节 · {{ item.label }}</option>
          </select>
        </label>
        <button v-if="currentReaderSection" type="button" class="secondary-button" :disabled="askLoading || sectionsLoading" @click="selectedSection = currentReaderSection.key; resetAskForScopeChange()">限定当前章节</button>
        <button type="button" class="secondary-button" :disabled="askLoading || sectionsLoading" @click="resetAskForScopeChange(); sections.retry()">刷新章节</button>
        <span class="chapter-scope-hint">{{ selectedSection ? '仅从所选章节查找证据。跨章比较请切回整本书。' : '问题提到章节名不会自动缩小范围。' }}</span>
        <span v-if="sectionsLoading" role="status">正在读取章节…</span>
        <span v-else-if="sectionsError" role="alert">{{ sectionsError }}</span>
        <span v-else-if="!sectionOptions.length" class="chapter-scope-hint">当前索引没有可选择的章节，仍可检索整本书。</span>
      </div>
      <p v-if="mode === 'ask' && ragRefreshFeedback" class="rag-refresh-feedback" role="status">
        {{ ragRefreshFeedback }}
      </p>
      <div class="search-row">
        <input
          v-model.trim="filters.q"
          class="search-input"
          type="search"
          maxlength="256"
          :placeholder="mode === 'ask' ? '例如：如何恢复搜索索引？' : '搜索标题、正文、章节、代码、作者或标签'"
          autocomplete="off"
        />
        <button class="primary-button" type="submit" :disabled="loading || askLoading || !filters.q">
          {{ mode === 'ask' ? (askLoading ? '准备回答…' : '提问') : (loading ? '搜索中…' : '搜索') }}
        </button>
      </div>

      <div v-if="mode === 'search'" class="scope-tabs" role="tablist" aria-label="搜索范围">
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

      <button v-if="mode === 'search'" class="filter-toggle" type="button" @click="showFilters = !showFilters">
        {{ showFilters ? '收起筛选' : '展开筛选' }}
      </button>
      <div v-if="mode === 'search' && showFilters" class="filter-grid">
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

    <div v-if="mode === 'ask' && ragStatus" class="rag-status-strip" :class="`rag-status-${ragStatusKind}`" role="status">
      <div>
        <strong>{{ ragStatusLabel }}</strong>
        <span>{{ ragStatusDetail }}</span>
      </div>
      <span v-if="ragStatusWorkerOffline" class="offline-note">PC Worker 离线；回答会退化为本机检索引用。</span>
    </div>

    <div v-if="mode === 'search' && feedback" class="feedback" role="status">
      <span>{{ feedback }}</span>
      <button v-if="!isMobile && errorCode === 'SEARCH_INDEX_MISSING'" @click="refreshIndex(true)">建立索引</button>
    </div>

    <section v-if="mode === 'ask' && askState !== 'idle'" class="answer-panel" aria-live="polite">
      <header class="answer-heading">
        <div>
          <strong>资料回答</strong>
          <span>{{ askModeLabel }}</span>
        </div>
        <button v-if="askState === 'submitting' || (askQueryId && askCancellable)" class="inline-button" type="button" :disabled="askState === 'cancelling'" @click="cancelAsk">{{ askState === 'cancelling' ? '取消中…' : '取消' }}</button>
      </header>

      <div v-if="askLoading" class="answer-loading" role="status">
        {{ askState === 'cancelling' ? '正在确认取消…' : askState === 'submitting' ? '正在检查资料范围并提交问题…' : askPhase === 'queued' ? '问题已进入队列，等待 Worker 处理…' : '正在整理回答和引用…' }}
      </div>
      <div v-else-if="['error', 'paused'].includes(askState)" class="answer-feedback" role="alert">
        {{ askFeedback }}
        <button v-if="askState === 'paused'" type="button" class="inline-button" @click="ask.resume">继续查询</button>
      </div>
      <div v-else-if="askState === 'cancelled'" class="answer-feedback" role="status">
        已取消本次提问；原有关键词搜索仍可继续使用。
      </div>
      <template v-else>
        <div v-if="askResult?.degraded" class="answer-degraded" role="status">
          {{ askResult.degradedLabel }}
        </div>
        <div v-if="askResult?.answer" class="answer-text">
          {{ askResult.answer }}
        </div>
        <div v-else class="answer-abstained" role="status">
          <strong>暂不回答</strong>
          <span>{{ askResult?.reasonLabel || '当前证据不足，未生成未经支持的结论。' }}</span>
        </div>

        <section v-if="askCitations.length" class="citation-section" aria-label="回答引用">
          <h3>引用资料</h3>
          <article v-for="citation in askCitations" :key="citation.label" class="citation-card">
            <div class="citation-title-row">
              <span class="citation-label">{{ citation.label }}</span>
              <strong>{{ citation.title }}</strong>
              <button v-if="citation.openUrl" type="button" class="citation-link" @click="openCitation(citation)">打开来源</button>
            </div>
            <div class="citation-meta">
              <span v-if="citation.section">章节：{{ citation.section }}</span>
              <span v-if="citation.version">版本：{{ citation.version }}</span>
            </div>
            <blockquote v-if="citation.excerpt">{{ citation.excerpt }}</blockquote>
          </article>
        </section>
        <div v-else class="citation-empty">本次回答没有返回可展示的引用。</div>
      </template>
    </section>

    <section v-if="mode === 'search' && searched && !loading" class="results-section">
      <header class="results-heading">
        <div>
          <strong>{{ errorCode ? '上次成功的搜索结果' : `${total} 个结果` }}</strong>
          <span v-if="result?.index?.status === 'partial'">索引不完整，部分资源仅含元数据。</span>
        </div>
        <span v-if="elapsedMs !== null">{{ elapsedMs }} ms</span>
      </header>

      <div v-if="filters.scope === 'external' && result?.externalDiscovery?.enabled === false" class="external-empty">
        外部发现未配置。阶段 6A 不会自动调用被冻结的外部资源站。
      </div>

      <div v-if="!errorCode && results.length === 0" class="empty-state">
        <strong>没有找到匹配资源</strong>
        <span>可以减少筛选条件、尝试完整关键词，或刷新索引后再试。</span>
      </div>

      <article v-for="item in results" :key="item.entryKey" class="result-card">
        <button class="result-main" @click="openResult(item)">
          <div class="result-title-row">
            <span class="type-badge">{{ typeLabel(item.resourceType) }}</span>
            <h2>{{ item.title }}</h2>
            <span v-if="item.indexStatus !== 'ready'" class="metadata-badge">{{ itemStatusLabel(item.indexStatus) }}</span>
          </div>
          <p v-if="item.subtitle" class="result-subtitle">{{ item.subtitle }}</p>
          <p class="result-snippet">{{ item.snippet }}</p>
          <div class="result-meta">
            <span>{{ locatorLabel(item) }}</span>
            <span v-if="item.author">作者：{{ item.author }}</span>
            <span v-if="item.source?.label">来源：{{ item.source.label }}</span>
            <span v-if="item.locator?.commit">提交：{{ item.locator.commit.slice(0, 12) }}</span>
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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { useRagQuery } from '@/composables/useRagQuery'
import { useRagSections } from '@/composables/useRagSections'
import { useViewport } from '@/composables/useViewport'

const router = useRouter()
const route = useRoute()
const { isMobile } = useViewport()
const pageSize = 20
const mode = ref('search')
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
const ragStatus = ref(null)
const ragCoverage = ref(null)
const coverageLoading = ref(false)
const ragRefreshing = ref(false)
const ragRefreshFeedback = ref('')
const readerBookId = /^\d+$/u.test(String(route.query.bookId || '')) && Number(route.query.bookId) > 0 ? Number(route.query.bookId) : null
const askSourceKey = ref(readerBookId ? `ebook:${readerBookId}` : '')
const readerSource = ref(null)
const sections = useRagSections({ api: api.rag })
const { options: sectionOptions, selected: selectedSection, loading: sectionsLoading, error: sectionsError } = sections
const currentReaderSection = computed(() => {
  if (askSourceKey.value !== `ebook:${readerBookId}` || !/^\d+$/u.test(String(route.query.readerChapter ?? ''))) return null
  return sectionOptions.value.find(item => item.chapterIndex === Number(route.query.readerChapter)) || null
})
watch(askSourceKey, key => {
  resetAskForScopeChange()
  void sections.load(key.startsWith('ebook:') ? Number(key.slice(6)) : null)
})
const ask = useRagQuery({ api: api.rag, errorLabel: askErrorLabel, normalizeResult: normalizeAskResult })
const { state: askState, result: askResult, feedback: askFeedback, loading: askLoading,
  queryId: askQueryId, cancellable: askCancellable, phase: askPhase } = ask
let pollTimer = null
let ragIndexPollTimer = null
let pageDisposed = false
let searchGeneration = 0

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
const ragStatusKind = computed(() => {
  const status = String(ragStatus.value?.status || '').toLowerCase()
  if (['ready', 'available'].includes(status)) return 'ready'
  if (['offline', 'degraded', 'partial'].includes(status) || ragStatus.value?.pcWorker?.status === 'offline') return 'degraded'
  if (['missing', 'failed', 'unavailable'].includes(status)) return 'unavailable'
  return 'unknown'
})
const ragStatusLabel = computed(() => ({
  ready: '问资料可用', degraded: '问资料可降级', unavailable: '问资料暂不可用', unknown: '问资料状态未知'
}[ragStatusKind.value]))
const ragStatusDetail = computed(() => {
  if (ragStatusKind.value === 'degraded') return '将优先使用 NAS 本机检索并保留引用。'
  if (ragStatusKind.value === 'unavailable') return '可以继续使用关键词搜索，服务恢复后再提问。'
  if (ragStatusKind.value === 'ready') return '回答只使用当前权限范围内的资料。'
  return '提交后会再次检查索引、权限和生成能力。'
})
const ragStatusWorkerOffline = computed(() => ragStatus.value?.pcWorker?.status === 'offline')
const askModeLabel = computed(() => {
  if (askLoading.value) return '正在检索资料'
  if (askState.value === 'error') return '请求失败'
  if (askState.value === 'paused') return '查询已暂停'
  if (askState.value === 'cancelled') return '已取消'
  if (askResult.value?.degraded) return '本机检索降级'
  if (askResult.value?.abstained) return '证据不足，已拒答'
  return '引用式回答'
})
const askCitations = computed(() => askResult.value?.citations || [])
const askSourceItems = computed(() => {
  const items = [...(ragCoverage.value?.data || [])]
  if (readerSource.value && !items.some(item => item.source.type === 'ebook' && item.source.id === readerBookId)) items.push(readerSource.value)
  return items.map((item) => ({
  key: `${item.source.type}:${item.source.id}`,
  type: item.source.type,
  id: item.source.id,
  title: item.source.title,
  status: item.status,
  chunkCount: item.chunkCount || 0,
  embeddingStatus: item.embeddingStatus || 'missing'
  }))
})
const askSourceGroups = computed(() => [
  { type: 'document', label: '文档', items: askSourceItems.value.filter((item) => item.type === 'document') },
  { type: 'ebook', label: '电子书', items: askSourceItems.value.filter((item) => item.type === 'ebook') },
  { type: 'code_repository', label: '代码仓库', items: askSourceItems.value.filter((item) => item.type === 'code_repository') }
].filter((group) => group.items.length > 0))
const selectedAskSource = computed(() => askSourceItems.value.find((item) => item.key === askSourceKey.value) || null)

const ASK_REASON_LABELS = Object.freeze({
  no_evidence: '当前资料不足以支持可靠回答。',
  evidence_conflict: '资料之间存在冲突，暂不生成未经确认的结论。',
  worker_offline: '回答模型当前离线，已保留可用的检索引用。',
  model_unavailable: '回答模型当前不可用，已保留可用的检索引用。',
  index_missing: '资料索引尚未建立，请先刷新索引。',
  source_not_indexed: '所选资源尚未进入 RAG，请先为它建立索引。',
  source_index_pending: '所选资源的 RAG 索引正在生成，请稍后再问。',
  source_index_failed: '所选资源的 RAG 索引生成失败，可重试索引并在任务中心查看原因。',
  source_index_stale: '所选资源已有更新，当前 RAG 快照已过期，请刷新索引。',
  source_ambiguous: '问题中匹配到多个同名或同系列资源，请先在“回答范围”中选择具体一项。',
  cancelled: '本次提问已取消。'
})
const ASK_ERROR_LABELS = Object.freeze({
  RAG_QUERY_INVALID: '问题或筛选条件无效。',
  RAG_INDEX_MISSING: '资料索引尚未建立，请先刷新索引。',
  RAG_QUERY_UNAVAILABLE: '问资料服务暂时不可用。',
  RAG_QUERY_FAILED: '问资料任务未完成，请稍后重试。',
  RAG_QUERY_FORBIDDEN: '当前账号没有问资料权限。'
})

function buildParams() {
  const params = { q: filters.q, scope: filters.scope, limit: pageSize, offset: offset.value }
  for (const key of ['type', 'tag', 'author', 'status', 'source']) if (filters[key]) params[key] = filters[key]
  if (filters.dateFrom) params.dateFrom = `${filters.dateFrom}T00:00:00.000Z`
  if (filters.dateTo) params.dateTo = `${filters.dateTo}T23:59:59.999Z`
  return params
}

function buildRagPayload() {
  const payload = { q: filters.q, limit: 10 }
  if (selectedAskSource.value) {
    payload.source = { type: selectedAskSource.value.type, id: selectedAskSource.value.id }
  }
  if (selectedSection.value) payload.section = selectedSection.value
  return payload
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function safeCitationUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/')) return ''
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return ''
  }
}

function normalizeCitation(value, index) {
  if (!value || typeof value !== 'object') return null
  const title = safeText(value.title || value.sourceLabel, 160) || `资料来源 ${index + 1}`
  return Object.freeze({
    label: `C${index + 1}`,
    title,
    section: safeText(value.section || value.chapter || value.chapterTitle || value.locationLabel, 160),
    version: safeText(value.versionLabel || value.version, 100),
    excerpt: safeText(value.excerpt || value.snippet, 480),
    openUrl: safeCitationUrl(value.openUrl || value.href)
  })
}

function normalizeAskResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {}
  const answer = safeText(source.answer, 12000)
  const reasonCode = safeText(source.reasonCode, 80).toLowerCase()
  const citations = Array.isArray(source.citations)
    ? source.citations.map(normalizeCitation).filter(Boolean).slice(0, 8)
    : []
  const abstained = Boolean(source.abstained) || !answer
  const degraded = Boolean(source.degraded || source.fallback || source.mode === 'fts')
  return Object.freeze({
    answer,
    abstained,
    degraded,
    degradedLabel: degraded ? '当前使用本机检索降级；生成模型或向量能力不可用，以下引用仍受权限过滤。' : '',
    reasonLabel: ASK_REASON_LABELS[reasonCode] || (abstained ? '当前证据不足，未生成未经支持的结论。' : ''),
    citations: Object.freeze(citations)
  })
}

async function loadStatus() {
  try {
    const response = await api.search.status()
    indexStatus.value = response.data?.data || null
  } catch {
    indexStatus.value = { status: 'failed', entryCount: 0 }
  }
}

async function loadRagStatus() {
  try {
    const response = await api.rag.status()
    ragStatus.value = response.data?.data || null
  } catch (error) {
    ragStatus.value = {
      status: error.response?.status === 404 ? 'unavailable' : 'failed',
      pcWorker: { status: 'unknown' }
    }
  }
}

async function loadRagCoverage() {
  coverageLoading.value = true
  try {
    const response = await api.rag.coverage({ limit: 200 })
    ragCoverage.value = response.data?.data || null
    // A missing/failed source list must not silently turn a bound question global.
    // Coverage is paged: a reader-bound book may be outside the first page.
    if (readerBookId && !askSourceItems.value.some(item => item.key === `ebook:${readerBookId}`)) {
      const [detail, status] = await Promise.all([api.books.getDetail(readerBookId), api.rag.sourceStatus('ebook', readerBookId)])
      const book = detail.data?.data
      if (!pageDisposed && Number(book?.id) === readerBookId) readerSource.value = {
        source: { type: 'ebook', id: readerBookId, title: book.title },
        status: status.data?.data?.sourceState?.status || 'missing', chunkCount: status.data?.data?.chunks?.count || 0
      }
    }
  } catch {
    ragCoverage.value = null
  } finally {
    coverageLoading.value = false
  }
}

function ragCoverageStatusLabel(status) {
  return ({
    ready: '可问', partial: '部分可问', pending: '索引中', stale: '待更新',
    failed: '索引失败', missing: '未索引'
  })[status] || '状态未知'
}

function resetAskForScopeChange() {
  ask.reset()
  ragRefreshFeedback.value = ''
}

function submitForm() {
  if (mode.value === 'ask') runAsk()
  else runSearch(true)
}

function setMode(nextMode) {
  if (nextMode === mode.value) return
  ask.reset()
  mode.value = nextMode
  feedback.value = ''
  if (nextMode === 'ask') {
    searched.value = false
    result.value = null
    askState.value = 'idle'
    askResult.value = null
    askFeedback.value = ''
    loadRagStatus()
    loadRagCoverage()
  } else {
    askState.value = 'idle'
    askResult.value = null
    askFeedback.value = ''
  }
}

async function refreshRagIndex() {
  if (ragRefreshing.value || (isMobile.value && !selectedAskSource.value)) return
  ragRefreshing.value = true
  ragRefreshFeedback.value = ''
  const source = selectedAskSource.value
  const input = source
    ? { source: { type: source.type, id: source.id }, filter: { sourceIds: [source.id] }, rebuild: true }
    : { rebuild: false }
  try {
    const response = await api.rag.refreshIndex(input)
    const taskId = response.data?.data?.id
    if (!taskId) throw new Error('missing task id')
    ragRefreshFeedback.value = source
      ? `“${source.title}”的 RAG 索引任务已进入 NAS 持久队列。`
      : 'RAG 增量索引任务已进入 NAS 持久队列。'
    await pollRagIndexTask(taskId)
  } catch (error) {
    ragRefreshing.value = false
    ragRefreshFeedback.value = error.response?.status === 409
      ? '已有 RAG 索引任务正在运行。'
      : '无法启动 RAG 索引任务。'
  }
}

async function pollRagIndexTask(taskId) {
  if (pageDisposed) return
  try {
    const response = await api.tasks.get(taskId)
    if (pageDisposed) return
    const task = response.data?.data
    if (!task) throw new Error('missing task')
    if (['pending', 'leased', 'running'].includes(task.status)) {
      ragIndexPollTimer = window.setTimeout(() => pollRagIndexTask(taskId), 1500)
      return
    }
    ragRefreshing.value = false
    await Promise.all([loadRagCoverage(), loadRagStatus()])
    ragRefreshFeedback.value = task.status === 'succeeded'
      ? task.result?.status === 'partial'
        ? 'RAG 基础索引已生成，但部分内容存在警告；可在任务中心查看详情。'
        : 'RAG 索引刷新完成。'
      : `RAG 索引任务未完成：${task.errorCode || task.status}`
  } catch {
    ragRefreshing.value = false
    ragRefreshFeedback.value = 'RAG 索引任务状态暂时不可用，可在任务中心查看。'
  }
}

function askErrorLabel(error) {
  const status = error.response?.status
  const code = safeText(error.response?.data?.code, 80)
  if (code === 'RAG_SOURCE_NOT_FOUND') return '所选资料已不可用，请重新选择回答范围。'
  if (status === 401 || status === 403) return '当前账号没有问资料权限。'
  if (status === 404) return '问资料接口尚未启用，仍可使用关键词搜索。'
  if (code === 'RAG_SECTION_STALE') return '章节索引已有变化，请重新读取目录并选择范围；本次没有扩大为整本书。'
  return ASK_ERROR_LABELS[code] || (!error.response ? '问资料服务暂时不可达，可切换到关键词搜索。' : '问资料暂时失败，请稍后重试。')
}

async function runAsk() {
  if (!filters.q || askLoading.value) return
  if (askSourceKey.value && !selectedAskSource.value) {
    askFeedback.value = '所选资料不可用，请重新选择回答范围。'
    return
  }
  if (selectedSection.value && (sectionsLoading.value || !sectionOptions.value.some(item => item.key === selectedSection.value))) {
    askFeedback.value = '请先重新读取目录并确认章节范围。'
    return
  }
  await ask.submit(buildRagPayload())
}

async function cancelAsk() { await ask.cancel() }

async function runSearch(resetPage = false) {
  if (!filters.q || pageDisposed) return
  const generation = ++searchGeneration
  if (resetPage) offset.value = 0
  loading.value = true
  feedback.value = ''
  errorCode.value = ''
  const started = performance.now()
  try {
    const response = await api.search.global(buildParams())
    if (pageDisposed || generation !== searchGeneration) return
    result.value = response.data
    indexStatus.value = response.data?.index || indexStatus.value
    searched.value = true
  } catch (error) {
    if (pageDisposed || generation !== searchGeneration) return
    errorCode.value = error.response?.data?.code || 'SEARCH_INDEX_UNAVAILABLE'
    feedback.value = errorCode.value === 'SEARCH_INDEX_MISSING'
      ? '搜索索引尚未建立，请先执行完整重建。'
      : errorCode.value === 'SEARCH_INPUT_INVALID'
        ? '搜索词或筛选条件无效。'
        : '暂时无法搜索，请稍后重试。'
    searched.value = true
  } finally {
    if (!pageDisposed && generation === searchGeneration) {
      elapsedMs.value = Math.round(performance.now() - started)
      loading.value = false
    }
  }
}

async function refreshIndex(rebuild) {
  if (refreshing.value || isMobile.value) return
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
  if (pageDisposed) return
  try {
    const response = await api.tasks.get(taskId)
    if (pageDisposed) return
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
  if (mode.value === 'search' && searched.value && filters.q) runSearch(true)
}

function resetAdvancedFilters() {
  Object.assign(filters, { type: '', tag: '', author: '', status: '', source: '', dateFrom: '', dateTo: '' })
}

function openResult(item) {
  const locator = item.locator || {}
  const { route, ...query } = locator
  if (route) router.push({ path: route, query })
}

function openCitation(citation) {
  if (!citation?.openUrl) return
  router.push(citation.openUrl).catch(() => {})
}

function locatorLabel(item) {
  const locator = item.locator || {}
  if (locator.path) return `${locator.path}${locator.line ? `:${locator.line}` : ''}`
  if (Number.isSafeInteger(locator.chapterIndex)) return `第 ${locator.chapterIndex + 1} 章`
  return '打开资源'
}

function typeLabel(type) { return typeLabels[type] || type }
function itemStatusLabel(status) {
  return ({ stale: '索引已过期', partial: '部分索引', metadata_only: '仅元数据' })[status] || status
}
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
function previousPage() { offset.value = Math.max(0, offset.value - pageSize); runSearch(false) }
function nextPage() { offset.value += pageSize; runSearch(false) }

onMounted(() => {
  loadStatus()
  if (route.query.mode === 'ask') setMode('ask')
  if (readerBookId) void sections.load(readerBookId)
})
onBeforeUnmount(() => {
  pageDisposed = true
  searchGeneration += 1
  if (pollTimer) window.clearTimeout(pollTimer)
  if (ragIndexPollTimer) window.clearTimeout(ragIndexPollTimer)
  ask.dispose()
  sections.dispose()
})
</script>

<style scoped>
.search-page { max-width: 1120px; margin: 0 auto; padding: 24px; color: var(--color-text-primary); }
.ask-chapter-panel { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 14px; margin-bottom: 16px; }
.ask-chapter-panel .ask-source-field { flex: 1 1 260px; min-width: 0; }
.ask-chapter-panel select { max-width: 100%; }
.chapter-scope-hint { flex: 1 1 100%; color: var(--color-text-secondary); font-size: 13px; }
.search-hero, .results-heading, .status-strip, .search-row, .result-title-row, .result-meta, .pagination-row { display: flex; align-items: center; }
.search-hero { justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.search-hero p { margin: 0; color: var(--color-text-secondary); }
.status-strip { flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px 16px; margin-bottom: 16px; border: 1px solid var(--color-primary-border); border-radius: 10px; background: var(--color-primary-surface); }
.status-strip > div { display: flex; flex-wrap: wrap; gap: 12px; }
.status-partial, .status-failed, .status-missing { border-color: var(--color-warning-border); background: var(--color-warning-surface); }
.offline-note { color: var(--color-text-secondary); }
.search-form, .result-card { border: 1px solid var(--color-border-subtle); border-radius: 14px; background: var(--color-surface-raised); box-shadow: 0 6px 24px rgba(15, 23, 42, .05); }
.search-form { padding: 18px; }
.search-row { gap: 10px; }
.mode-tabs { display: inline-flex; gap: 4px; padding: 4px; margin-bottom: 10px; border-radius: 10px; background: var(--color-surface-subtle); }
.mode-tabs button { border: 0; border-radius: 7px; padding: 8px 18px; background: transparent; color: var(--color-text-secondary); }
.mode-tabs button.active { background: var(--color-surface-raised); color: var(--color-primary); box-shadow: 0 1px 4px rgba(15, 23, 42, .12); font-weight: 600; }
.mode-hint { margin: 0 0 12px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; }
.ask-scope-panel { display: grid; grid-template-columns: minmax(220px, 1.1fr) minmax(260px, 1.5fr) auto; gap: 12px; align-items: end; margin-bottom: 14px; padding: 13px; border: 1px solid #dbe3f0; border-radius: 11px; background: var(--color-surface-subtle); }
.ask-source-field { display: flex; flex-direction: column; gap: 6px; color: var(--color-text-secondary); font-size: 13px; }
.ask-source-field select { width: 100%; min-height: 42px; box-sizing: border-box; border: 1px solid var(--color-border-default); border-radius: 9px; padding: 8px 10px; background: var(--color-surface-raised); color: var(--color-text-primary); }
.ask-scope-summary { display: flex; min-height: 42px; flex-direction: column; justify-content: center; gap: 4px; color: var(--color-text-secondary); font-size: 13px; }
.ask-scope-summary strong { color: var(--color-text-primary); }
.coverage-ready { color: var(--color-success-text); }
.coverage-partial, .coverage-pending, .coverage-stale, .coverage-failed, .coverage-missing { color: var(--color-warning-text); }
.rag-refresh-button { min-height: 42px; white-space: nowrap; }
.rag-refresh-feedback { margin: -4px 0 12px; color: var(--color-text-secondary); font-size: 13px; }
.search-input, .filter-grid input, .filter-grid select { width: 100%; box-sizing: border-box; border: 1px solid var(--color-border-default); border-radius: 9px; padding: 10px 12px; background: var(--color-surface-raised); color: var(--color-text-primary); }
.search-input { min-height: 46px; font-size: 16px; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary-button, .secondary-button, .inline-button, .reset-button, .pagination-row button, .feedback button { border: 0; border-radius: 9px; padding: 10px 16px; }
.primary-button { min-width: 92px; min-height: 46px; background: var(--color-primary-solid); color: var(--color-text-inverse); font-weight: 600; }
.secondary-button, .pagination-row button { background: var(--color-primary-surface); color: var(--color-primary); }
.inline-button, .reset-button, .feedback button { background: var(--color-surface-raised); color: var(--color-warning-text); border: 1px solid #fdba74; }
.scope-tabs { display: flex; gap: 6px; margin-top: 14px; border-bottom: 1px solid var(--color-border-subtle); }
.scope-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 9px 12px; background: transparent; color: var(--color-text-secondary); }
.scope-tabs button.active { border-color: var(--color-primary); color: var(--color-primary); font-weight: 600; }
.filter-toggle { margin-top: 12px; padding: 0; border: 0; background: transparent; color: var(--color-primary); }
.filter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.filter-grid label { display: flex; flex-direction: column; gap: 6px; color: var(--color-text-secondary); font-size: 13px; }
.feedback, .external-empty, .empty-state { margin-top: 16px; padding: 16px; border-radius: 10px; background: var(--color-warning-surface); color: var(--color-warning-text); }
.feedback { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.rag-status-strip { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-top: 16px; padding: 12px 16px; border: 1px solid var(--color-primary-border); border-radius: 10px; background: var(--color-primary-surface); color: var(--color-text-primary); }
.rag-status-strip > div { display: flex; flex-wrap: wrap; gap: 12px; }
.rag-status-degraded { border-color: var(--color-warning-border); background: var(--color-warning-surface); }
.rag-status-unavailable { border-color: var(--color-danger-border); background: var(--color-danger-surface); }
.answer-panel { margin-top: 20px; padding: 18px; border: 1px solid var(--color-primary-border); border-radius: 14px; background: var(--color-surface-raised); box-shadow: 0 6px 24px rgba(15, 23, 42, .05); }
.answer-heading, .citation-title-row { display: flex; align-items: center; gap: 10px; }
.answer-heading { justify-content: space-between; margin-bottom: 16px; color: var(--color-text-primary); }
.answer-heading > div { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.answer-heading > div span { color: var(--color-text-secondary); font-size: 13px; }
.answer-loading, .answer-feedback, .answer-degraded, .answer-abstained, .citation-empty { padding: 14px; border-radius: 10px; }
.answer-loading { background: var(--color-primary-surface); color: var(--color-info-text); }
.answer-feedback { background: var(--color-warning-surface); color: var(--color-warning-text); }
.answer-degraded { margin-bottom: 14px; background: var(--color-warning-surface); color: var(--color-warning-text); }
.answer-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; color: var(--color-text-primary); }
.answer-abstained { display: flex; flex-direction: column; gap: 6px; background: var(--color-surface-subtle); color: var(--color-text-secondary); }
.answer-abstained strong { color: var(--color-text-primary); }
.citation-section { margin-top: 20px; }
.citation-section h3 { margin: 0 0 10px; font-size: 16px; color: var(--color-text-primary); }
.citation-card { margin-top: 10px; padding: 13px 14px; border: 1px solid var(--color-border-subtle); border-radius: 10px; background: var(--color-surface-subtle); }
.citation-title-row { flex-wrap: wrap; }
.citation-label { display: inline-flex; min-width: 28px; justify-content: center; border-radius: 999px; padding: 3px 7px; background: var(--color-primary-surface); color: var(--color-primary); font-size: 12px; font-weight: 700; }
.citation-title-row strong { flex: 1; min-width: 180px; color: var(--color-text-primary); }
.citation-link { border: 0; padding: 4px 0; background: transparent; color: var(--color-primary); font-size: 13px; cursor: pointer; }
.citation-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 7px; color: var(--color-text-secondary); font-size: 13px; }
.citation-card blockquote { margin: 10px 0 0; padding-left: 12px; border-left: 3px solid var(--color-primary-border); color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.citation-empty { margin-top: 16px; background: var(--color-surface-subtle); color: var(--color-text-secondary); }
.results-section { margin-top: 20px; }
.results-heading { justify-content: space-between; margin-bottom: 12px; color: var(--color-text-secondary); }
.results-heading div { display: flex; gap: 12px; }
.result-card { margin-bottom: 12px; overflow: hidden; }
.result-main { width: 100%; padding: 18px; border: 0; background: transparent; text-align: left; color: inherit; }
.result-main:hover { background: var(--color-surface-subtle); }
.result-title-row { gap: 10px; }
.result-title-row h2 { margin: 0; font-size: 18px; }
.type-badge, .metadata-badge, .tag-list span { display: inline-flex; border-radius: 999px; padding: 3px 8px; font-size: 12px; }
.type-badge { background: var(--color-primary-surface); color: var(--color-primary); }
.metadata-badge { background: var(--color-warning-surface); color: var(--color-warning-text); }
.result-subtitle { margin: 8px 0 0; color: var(--color-text-secondary); }
.result-snippet { margin: 10px 0; color: var(--color-text-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.result-meta { flex-wrap: wrap; gap: 12px; color: var(--color-text-secondary); font-size: 13px; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tag-list span { background: var(--color-surface-subtle); color: var(--color-text-secondary); }
.empty-state { display: flex; flex-direction: column; gap: 6px; background: var(--color-surface-subtle); color: var(--color-text-secondary); text-align: center; }
.pagination-row { justify-content: center; gap: 14px; margin-top: 18px; }
@media (max-width: 768px) {
  .search-page { padding: 4px 0 24px; }
  .search-hero { align-items: flex-start; }
  .search-row { align-items: stretch; }
  .filter-grid { grid-template-columns: 1fr 1fr; }
  .status-strip, .feedback, .rag-status-strip { align-items: flex-start; flex-direction: column; }
  .result-title-row { align-items: flex-start; flex-wrap: wrap; }
  .answer-heading { align-items: flex-start; }
  .ask-scope-panel { grid-template-columns: 1fr; align-items: stretch; }
  .ask-scope-panel .desktop-only { display: none; }
}
@media (max-width: 480px) {
  .search-hero, .search-row { flex-direction: column; }
  .search-hero .secondary-button, .primary-button { width: 100%; }
  .filter-grid { grid-template-columns: 1fr; }
  .scope-tabs button { flex: 1; padding-inline: 4px; }
  .mode-tabs { display: flex; width: 100%; }
  .mode-tabs button { flex: 1; }
  .answer-panel { padding: 14px; }
  .citation-title-row strong { min-width: 0; }
}
</style>
