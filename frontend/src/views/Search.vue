<template>
  <div class="search-page">
    <section class="search-hero">
      <div>
        <p>由 NAS 本机 SQLite FTS5 与 commit 绑定符号索引提供，PC Worker 离线也可搜索。</p>
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
        <span v-if="indexStatus.symbols">符号：{{ indexStatus.symbols.symbolCount || 0 }}</span>
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
      <button v-if="errorCode === 'SEARCH_INDEX_MISSING'" @click="refreshIndex(true)">建立索引</button>
    </div>

    <section v-if="mode === 'ask' && askState !== 'idle'" class="answer-panel" aria-live="polite">
      <header class="answer-heading">
        <div>
          <strong>资料回答</strong>
          <span>{{ askModeLabel }}</span>
        </div>
        <button v-if="askLoading" class="inline-button" type="button" @click="cancelAsk">取消</button>
      </header>

      <div v-if="askLoading" class="answer-loading" role="status">
        正在检查权限、检索资料并整理引用…
      </div>
      <div v-else-if="askState === 'error'" class="answer-feedback" role="alert">
        {{ askFeedback }}
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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'

const router = useRouter()
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
const askState = ref('idle')
const askResult = ref(null)
const askFeedback = ref('')
const askQueryId = ref('')
let pollTimer = null
let ragPollTimer = null
let askGeneration = 0

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
const askLoading = computed(() => ['submitting', 'polling'].includes(askState.value))
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
  if (askState.value === 'cancelled') return '已取消'
  if (askResult.value?.degraded) return '本机检索降级'
  if (askResult.value?.abstained) return '证据不足，已拒答'
  return '引用式回答'
})
const askCitations = computed(() => askResult.value?.citations || [])

const ASK_REASON_LABELS = Object.freeze({
  no_evidence: '当前资料不足以支持可靠回答。',
  evidence_conflict: '资料之间存在冲突，暂不生成未经确认的结论。',
  worker_offline: '回答模型当前离线，已保留可用的检索引用。',
  model_unavailable: '回答模型当前不可用，已保留可用的检索引用。',
  index_missing: '资料索引尚未建立，请先刷新索引。',
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
  // The current Owner query contract accepts only q/query and a bounded limit.
  // Visibility and lifecycle filtering remain authoritative on the NAS.
  return { q: filters.q, limit: 10 }
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

function submitForm() {
  if (mode.value === 'ask') runAsk()
  else runSearch(true)
}

function stopRagPolling() {
  if (ragPollTimer) window.clearTimeout(ragPollTimer)
  ragPollTimer = null
}

function setMode(nextMode) {
  if (nextMode === mode.value) return
  askGeneration += 1
  if (mode.value === 'ask' && askQueryId.value) {
    const queryId = askQueryId.value
    stopRagPolling()
    askQueryId.value = ''
    api.rag.cancelQuery(queryId).catch(() => {})
  }
  mode.value = nextMode
  feedback.value = ''
  if (nextMode === 'ask') {
    searched.value = false
    result.value = null
    askState.value = 'idle'
    askResult.value = null
    askFeedback.value = ''
    loadRagStatus()
  } else {
    askState.value = 'idle'
    askResult.value = null
    askFeedback.value = ''
  }
}

function askErrorLabel(error) {
  const status = error.response?.status
  if (status === 401 || status === 403) return '当前账号没有问资料权限。'
  if (status === 404) return '问资料接口尚未启用，仍可使用关键词搜索。'
  const code = safeText(error.response?.data?.code, 80)
  return ASK_ERROR_LABELS[code] || (!error.response ? '问资料服务暂时不可达，可切换到关键词搜索。' : '问资料暂时失败，请稍后重试。')
}

function finishAsk(value) {
  stopRagPolling()
  askQueryId.value = ''
  askResult.value = normalizeAskResult(value)
  askState.value = askResult.value.degraded ? 'degraded' : askResult.value.abstained ? 'abstained' : 'answered'
}

function scheduleRagPoll(generation) {
  stopRagPolling()
  ragPollTimer = window.setTimeout(() => pollAsk(generation), 1200)
}

async function pollAsk(generation = askGeneration) {
  if (generation !== askGeneration) return
  const queryId = askQueryId.value
  if (!queryId) return
  try {
    const response = await api.rag.getQuery(queryId)
    const data = response.data?.data
    if (!data) throw new Error('missing query result')
    if (['pending', 'queued', 'leased', 'running'].includes(data.status)) {
      askState.value = 'polling'
      scheduleRagPoll(generation)
      return
    }
    if (['cancelled', 'canceled'].includes(data.status)) {
      stopRagPolling()
      askQueryId.value = ''
      askState.value = 'cancelled'
      askResult.value = null
      return
    }
    if (['failed', 'error'].includes(data.status)) {
      throw Object.assign(new Error('rag query failed'), { response: { data: { code: data.errorCode || 'RAG_QUERY_FAILED' } } })
    }
    finishAsk(data)
  } catch (error) {
    if (generation !== askGeneration) return
    stopRagPolling()
    askQueryId.value = ''
    askState.value = 'error'
    askFeedback.value = askErrorLabel(error)
  }
}

async function runAsk() {
  if (!filters.q || askLoading.value) return
  const generation = ++askGeneration
  stopRagPolling()
  askState.value = 'submitting'
  askResult.value = null
  askFeedback.value = ''
  try {
    const response = await api.rag.createQuery(buildRagPayload())
    if (generation !== askGeneration) return
    const data = response.data?.data
    if (data?.answer !== undefined || data?.abstained !== undefined || data?.citations) {
      finishAsk(data)
      return
    }
    const queryId = data?.id ?? data?.queryId ?? data?.runId
    if (queryId === undefined || queryId === null || String(queryId).trim() === '') throw new Error('missing query id')
    askQueryId.value = String(queryId)
    askState.value = 'polling'
    await pollAsk(generation)
  } catch (error) {
    if (generation !== askGeneration) return
    stopRagPolling()
    askQueryId.value = ''
    askState.value = 'error'
    askFeedback.value = askErrorLabel(error)
  }
}

async function cancelAsk() {
  askGeneration += 1
  const queryId = askQueryId.value
  stopRagPolling()
  askQueryId.value = ''
  askState.value = 'cancelled'
  askResult.value = null
  if (queryId) await api.rag.cancelQuery(queryId).catch(() => {})
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

onMounted(loadStatus)
onBeforeUnmount(() => {
  if (pollTimer) window.clearTimeout(pollTimer)
  stopRagPolling()
})
</script>

<style scoped>
.search-page { max-width: 1120px; margin: 0 auto; padding: 24px; color: #1f2937; }
.search-hero, .results-heading, .status-strip, .search-row, .result-title-row, .result-meta, .pagination-row { display: flex; align-items: center; }
.search-hero { justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.search-hero p { margin: 0; color: #64748b; }
.status-strip { flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px 16px; margin-bottom: 16px; border: 1px solid #dbeafe; border-radius: 10px; background: #eff6ff; }
.status-strip > div { display: flex; flex-wrap: wrap; gap: 12px; }
.status-partial, .status-failed, .status-missing { border-color: #fed7aa; background: #fff7ed; }
.offline-note { color: #475569; }
.search-form, .result-card { border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; box-shadow: 0 6px 24px rgba(15, 23, 42, .05); }
.search-form { padding: 18px; }
.search-row { gap: 10px; }
.mode-tabs { display: inline-flex; gap: 4px; padding: 4px; margin-bottom: 10px; border-radius: 10px; background: #f1f5f9; }
.mode-tabs button { border: 0; border-radius: 7px; padding: 8px 18px; background: transparent; color: #64748b; }
.mode-tabs button.active { background: #fff; color: #4338ca; box-shadow: 0 1px 4px rgba(15, 23, 42, .12); font-weight: 600; }
.mode-hint { margin: 0 0 12px; color: #64748b; font-size: 13px; line-height: 1.5; }
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
.rag-status-strip { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-top: 16px; padding: 12px 16px; border: 1px solid #dbeafe; border-radius: 10px; background: #eff6ff; color: #334155; }
.rag-status-strip > div { display: flex; flex-wrap: wrap; gap: 12px; }
.rag-status-degraded { border-color: #fed7aa; background: #fff7ed; }
.rag-status-unavailable { border-color: #fecaca; background: #fef2f2; }
.answer-panel { margin-top: 20px; padding: 18px; border: 1px solid #c7d2fe; border-radius: 14px; background: #fff; box-shadow: 0 6px 24px rgba(15, 23, 42, .05); }
.answer-heading, .citation-title-row { display: flex; align-items: center; gap: 10px; }
.answer-heading { justify-content: space-between; margin-bottom: 16px; color: #334155; }
.answer-heading > div { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.answer-heading > div span { color: #64748b; font-size: 13px; }
.answer-loading, .answer-feedback, .answer-degraded, .answer-abstained, .citation-empty { padding: 14px; border-radius: 10px; }
.answer-loading { background: #eff6ff; color: #1d4ed8; }
.answer-feedback { background: #fff7ed; color: #9a3412; }
.answer-degraded { margin-bottom: 14px; background: #fff7ed; color: #9a3412; }
.answer-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; color: #1f2937; }
.answer-abstained { display: flex; flex-direction: column; gap: 6px; background: #f8fafc; color: #475569; }
.answer-abstained strong { color: #334155; }
.citation-section { margin-top: 20px; }
.citation-section h3 { margin: 0 0 10px; font-size: 16px; color: #334155; }
.citation-card { margin-top: 10px; padding: 13px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
.citation-title-row { flex-wrap: wrap; }
.citation-label { display: inline-flex; min-width: 28px; justify-content: center; border-radius: 999px; padding: 3px 7px; background: #e0e7ff; color: #4338ca; font-size: 12px; font-weight: 700; }
.citation-title-row strong { flex: 1; min-width: 180px; color: #334155; }
.citation-link { border: 0; padding: 4px 0; background: transparent; color: #4338ca; font-size: 13px; cursor: pointer; }
.citation-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 7px; color: #64748b; font-size: 13px; }
.citation-card blockquote { margin: 10px 0 0; padding-left: 12px; border-left: 3px solid #c7d2fe; color: #475569; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.citation-empty { margin-top: 16px; background: #f8fafc; color: #64748b; }
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
  .search-row { align-items: stretch; }
  .filter-grid { grid-template-columns: 1fr 1fr; }
  .status-strip, .feedback, .rag-status-strip { align-items: flex-start; flex-direction: column; }
  .result-title-row { align-items: flex-start; flex-wrap: wrap; }
  .answer-heading { align-items: flex-start; }
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
