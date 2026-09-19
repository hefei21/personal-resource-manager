<template>
  <div class="code-mobile">
    <template v-if="!currentRepo">
      <form class="repo-search" @submit.prevent="loadRepos"><NativeInput v-model="keyword" aria-label="搜索代码仓库" placeholder="搜索代码仓库" clearable /><NativeButton variant="text" type="submit" aria-label="刷新仓库列表"><NativeIcon name="magnifying-glass" /></NativeButton></form>
      <div v-if="listError" class="feedback" role="alert">{{ listError }}<NativeButton variant="text" @click="loadRepos">重试列表</NativeButton></div>
      <p v-if="loading" class="feedback" role="status">正在加载仓库…</p>
      <article v-for="repo in repoList" :key="repo.id" class="repo-card">
        <button class="repo-open" @click="openRepo(repo)"><span class="repo-title"><NativeIcon name="git" /><strong>{{ repo.name }}</strong><NativeIcon name="chevron-right" /></span><span class="repo-desc">{{ repo.description || '暂无描述' }}</span><span class="repo-meta">{{ repositorySourceLabel(repo) }}<template v-if="repo.last_sync"> · {{ formatDate(repo.last_sync) }}</template></span></button>
        <RepositoryTaskStatus v-if="!isReadOnlyRepository(repo)" :task="tasks.latest(repo.id)" :error="tasks.errors.value.get(String(repo.id))" @refresh="tasks.refresh(repo.id)" />
      </article>
      <p v-if="!loading && !listError && !repoList.length" class="feedback">{{ keyword ? '没有匹配的仓库' : '尚未纳管代码仓库' }}</p>
    </template>
    <section v-else class="repo-detail">
      <header class="detail-header"><button class="icon-button" aria-label="返回仓库列表" @click="closeRepo"><NativeIcon name="arrow-left" /></button><div class="detail-title"><strong>{{ currentRepo.name }}</strong><span>{{ repositorySourceLabel(currentRepo) }}</span></div><button class="icon-button" aria-label="刷新当前视图" @click="refreshCurrent"><NativeIcon name="arrow-clockwise" /></button></header>
      <nav class="detail-tabs" aria-label="仓库内容"><button v-for="tab in tabs" :key="tab.value" :aria-current="activeTab === tab.value ? 'page' : undefined" @click="navigate({ tab: tab.value })">{{ tab.label }}</button></nav>
      <RepositorySearch v-if="activeTab === 'search'" :repository-id="currentRepo.id" @open="openSearchResult" />
      <div v-else class="detail-content" ref="contentPanel" @click="onMarkdownClick">
        <div v-if="busy[activeTab]" class="feedback" role="status">正在加载…</div>
        <div v-else-if="errors[activeTab]" class="feedback" role="alert">{{ errors[activeTab] }}<NativeButton variant="text" @click="refreshCurrent">重试加载</NativeButton></div>
        <template v-else-if="activeTab === 'readme'"><MdPreview v-if="readme" :model-value="readme" :sanitize="sanitizeRichHtml" :theme="theme" class="markdown-preview" /><p v-else class="feedback">该仓库暂无 README 文件</p></template>
        <template v-else-if="activeTab === 'files'">
          <nav class="path-nav" aria-label="文件位置"><button v-if="directory" @click="navigate({ dir: directory.split('/').slice(0, -1).join('/') })"><NativeIcon name="arrow-left" />上一级</button><span>{{ directory || '根目录' }}</span></nav>
          <button v-for="item in files" :key="item.path" class="file-item" @click="item.type === 'directory' ? navigate({ dir: item.path }) : openFile(item.path)"><NativeIcon :name="item.type === 'directory' ? 'folder' : 'file'" /><span>{{ item.name }}</span><NativeIcon v-if="item.type === 'directory'" name="chevron-right" /></button>
          <p v-if="!files.length" class="feedback">此目录暂无文件</p>
        </template>
        <template v-else-if="activeTab === 'commits'"><article v-for="commit in commits" :key="commit.hash" class="commit-item"><code>{{ commit.hash.slice(0, 12) }}</code><p>{{ commit.message }}</p><span>{{ commit.author }} · {{ commit.date }}</span></article><p v-if="!commits.length" class="feedback">暂无提交历史</p></template>
      </div>
    </section>
    <NativeDialog :model-value="Boolean(filePath && currentRepo)" :title="filePath.split('/').pop() || '文件预览'" :show-footer="false" class="mobile-code-preview" @update:model-value="value => !value && closeFile()">
      <div class="preview-meta">{{ filePath }}<template v-if="searchLine"> · 第 {{ searchLine }} 行</template><template v-if="route.query.commit"> · {{ String(route.query.commit).slice(0, 8) }}</template></div>
      <div ref="previewPanel" class="preview-content" @click="onMarkdownClick">
        <p v-if="previewLoading" class="feedback" role="status">正在加载文件…</p>
        <div v-else-if="previewError" class="feedback" role="alert"><span>{{ previewError }}</span><NativeButton variant="outline" @click="loadPreview">重新加载文件</NativeButton></div>
        <MdPreview v-else-if="file && isMarkdown && !searchLine" :model-value="file.content || ''" :sanitize="sanitizeRichHtml" :theme="theme" class="markdown-preview" />
        <CodeSourcePreview v-else-if="file && (file.type === 'text' || isMarkdown)" :content="file.content || ''" :html="escapeHtml(file.content || '')" :line="searchLine" />
        <p v-else-if="file" class="feedback">二进制文件，无法预览</p>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { NativeButton, NativeInput, NativeIcon, NativeDialog } from '@/components/native'
import RepositorySearch from '@/components/RepositorySearch.vue'
import RepositoryTaskStatus from '@/components/RepositoryTaskStatus.vue'
import CodeSourcePreview from '@/components/CodeSourcePreview.vue'
import { useRepositoryTasks } from '@/composables/useRepositoryTasks'
import { isReadOnlyRepository, repositorySourceLabel } from '@/utils/codeRepositoryCapabilities'
import { resolveRepositoryLink, scrollRepositoryAnchor } from '@/utils/repositoryNavigation'
import { sanitizeRichHtml, escapeHtml } from '@/utils/sanitizeHtml'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
const route = useRoute(), router = useRouter()
const repoList = ref([]), keyword = ref(''), loading = ref(false), listError = ref(''), currentRepo = ref(null)
const files = ref([]), readme = ref(''), commits = ref([]), contentPanel = ref(null), previewPanel = ref(null)
const busy = reactive({}), errors = reactive({}), file = ref(null), previewLoading = ref(false), previewError = ref('')
const tasks = useRepositoryTasks(() => loadRepos())
const tabs = [{ value: 'readme', label: 'README' }, { value: 'files', label: '文件' }, { value: 'search', label: '检索' }, { value: 'commits', label: '提交' }]
const activeTab = computed(() => tabs.some(tab => tab.value === route.query.tab) ? route.query.tab : 'readme')
const directory = computed(() => typeof route.query.dir === 'string' ? route.query.dir : '')
const filePath = computed(() => typeof route.query.path === 'string' ? route.query.path : '')
const searchLine = computed(() => { const value = Number(route.query.line); return Number.isSafeInteger(value) && value > 0 ? value : null })
const isMarkdown = computed(() => /\.(md|markdown)$/i.test(filePath.value))
const theme = ref(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
let disposed = false, listSequence = 0, navigation = 0, previewSequence = 0
const sequences = { readme: 0, files: 0, commits: 0 }
function navigate(patch) {
  const query = { ...route.query, ...patch }
  for (const key of Object.keys(query)) if (query[key] === null || query[key] === '') delete query[key]
  return router.push({ query })
}
function openRepo(repo) { navigate({ repositoryId: String(repo.id), path: null, line: null, commit: null, dir: null, tab: 'readme', codeQ: null, codeMode: null, codePage: null, anchor: null }) }
function closeRepo() { navigate({ repositoryId: null, path: null, line: null, commit: null, dir: null, tab: null, codeQ: null, codeMode: null, codePage: null, anchor: null }) }
function openFile(path, line = null, commit = null, anchor = null) { navigate({ path, line: line ? String(line) : null, commit, anchor, tab: 'files' }) }
function closeFile() { navigate({ path: null, line: null, commit: null, anchor: null }) }
function openSearchResult(locator) { openFile(locator.path, locator.line, locator.commit || null) }
async function loadRepos() {
  const request = ++listSequence; loading.value = true; listError.value = ''
  try {
    const response = await api.code.list({ keyword: keyword.value })
    if (disposed || request !== listSequence) return
    repoList.value = response.data.data || []
    for (const repo of repoList.value) if (!isReadOnlyRepository(repo)) tasks.refresh(repo.id)
  } catch { if (!disposed && request === listSequence) listError.value = '仓库列表加载失败，保留上次结果。' }
  finally { if (!disposed && request === listSequence) loading.value = false }
}
async function loadSection(section = activeTab.value) {
  if (!currentRepo.value || section === 'search') return
  const repoId = currentRepo.value.id, epoch = navigation, request = ++sequences[section]
  busy[section] = true; errors[section] = ''
  try {
    const response = section === 'files' ? await api.code.getTree(repoId, directory.value) : section === 'readme' ? await api.code.getReadme(repoId) : await api.code.getCommits(repoId, 30)
    if (disposed || epoch !== navigation || request !== sequences[section]) return
    if (section === 'files') files.value = response.data.data || []
    else if (section === 'readme') readme.value = response.data.data?.content || ''
    else commits.value = response.data.data || []
  } catch { if (!disposed && epoch === navigation && request === sequences[section]) errors[section] = '内容加载失败，请重试。' }
  finally { if (!disposed && epoch === navigation && request === sequences[section]) busy[section] = false }
}
function refreshCurrent() { if (currentRepo.value) { loadSection(); if (!isReadOnlyRepository(currentRepo.value)) tasks.refresh(currentRepo.value.id) } }
async function restoreRepository() {
  const epoch = ++navigation; previewSequence++
  currentRepo.value = null; files.value = []; readme.value = ''; commits.value = []; file.value = null
  const id = Number(route.query.repositoryId)
  if (!Number.isSafeInteger(id) || id <= 0) return
  try {
    const repo = repoList.value.find(item => Number(item.id) === id) || (await api.code.get(id)).data.data
    if (disposed || epoch !== navigation) return
    if (!repo) throw new Error('missing')
    currentRepo.value = repo
    loadSection(); loadPreview()
  } catch { if (!disposed && epoch === navigation) listError.value = '仓库暂不可用，请刷新后重试。' }
}
async function loadPreview() {
  const request = ++previewSequence, epoch = navigation
  file.value = null; previewError.value = ''; previewLoading.value = false
  if (!currentRepo.value || !filePath.value) return
  previewLoading.value = true
  try {
    const response = await api.code.getFile(currentRepo.value.id, filePath.value, typeof route.query.commit === 'string' ? route.query.commit : null)
    if (disposed || request !== previewSequence || epoch !== navigation) return
    file.value = response.data.data
  } catch (failure) {
    if (!disposed && request === previewSequence && epoch === navigation) previewError.value = failure.response?.data?.code === 'CODE_SNAPSHOT_STALE' ? '该引用对应的提交已过期，请重新检索后打开。' : '文件加载失败，请重试。'
  } finally {
    if (!disposed && request === previewSequence && epoch === navigation) {
      previewLoading.value = false
      await nextTick()
      if (request === previewSequence) scrollRepositoryAnchor(previewPanel.value, route.query.anchor)
    }
  }
}
function onMarkdownClick(event) {
  const link = event.target.closest?.('.markdown-preview a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href')
  if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return }
  const target = resolveRepositoryLink(href, filePath.value || 'README.md')
  if (!target) return
  if (target.sameFile) scrollRepositoryAnchor(event.currentTarget, target.anchor)
  else openFile(target.path, null, file.value?.commit || null, target.anchor)
}
function formatDate(value) { return new Date(value).toLocaleDateString('zh-CN') }
watch(() => route.query.repositoryId, restoreRepository)
watch(() => JSON.stringify([activeTab.value, directory.value]), () => loadSection())
watch(() => JSON.stringify([filePath.value, route.query.line, route.query.commit, route.query.anchor]), loadPreview)
onMounted(async () => { await loadRepos(); if (!disposed) restoreRepository() })
onBeforeUnmount(() => { disposed = true; navigation++; listSequence++; previewSequence++ })
</script>

<style scoped>
.code-mobile{min-height:70dvh;background:var(--color-surface-raised);color:var(--color-text-primary);padding:12px}.repo-search{display:flex;gap:8px;align-items:center;margin-bottom:12px}.repo-search :deep(.native-input){flex:1;min-width:0}.repo-card{border-bottom:1px solid var(--color-border-subtle);padding:14px 4px}.repo-open{display:flex;flex-direction:column;gap:8px;width:100%;background:none;border:0;color:inherit;text-align:left;cursor:pointer}.repo-title{display:flex;align-items:center;gap:10px;width:100%}.repo-title strong{flex:1;min-width:0;font-size:15px;overflow-wrap:anywhere}.repo-desc{font-size:14px;line-height:1.65;color:var(--color-text-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.repo-meta{font-size:12px;color:var(--color-text-secondary)}.detail-header{display:flex;align-items:center;gap:8px;padding-bottom:10px}.detail-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.detail-title strong{font-size:16px;overflow-wrap:anywhere}.detail-title span{font-size:12px;color:var(--color-text-secondary)}.icon-button{width:44px;height:44px;flex-shrink:0;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:inherit}.detail-tabs{display:flex;border-bottom:1px solid var(--color-border-default);margin-bottom:12px;gap:4px}.detail-tabs button{flex:1;min-height:44px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--color-text-secondary);font-size:14px}.detail-tabs button[aria-current]{color:var(--color-primary);border-bottom-color:var(--color-primary);font-weight:600}.feedback{font-size:14px;line-height:1.8;padding:24px 12px;display:flex;flex-direction:column;gap:12px;color:var(--color-text-secondary)}.path-nav{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--color-text-secondary);overflow-wrap:anywhere}.path-nav button{display:flex;align-items:center;gap:4px;min-height:44px;flex-shrink:0;border:0;background:none;color:inherit}.file-item{display:flex;width:100%;gap:12px;align-items:center;min-height:48px;padding:10px 4px;border:0;border-bottom:1px solid var(--color-border-subtle);background:transparent;color:inherit;text-align:left}.file-item span{flex:1;min-width:0;overflow-wrap:anywhere;font-size:14px}.commit-item{padding:16px 4px;border-bottom:1px solid var(--color-border-subtle)}.commit-item code{font-size:12px;color:var(--color-primary)}.commit-item p{font-size:14px;line-height:1.7;overflow-wrap:anywhere;margin:6px 0}.commit-item span{font-size:12px;color:var(--color-text-secondary)}.markdown-preview{background:var(--color-surface-raised);color:inherit}.detail-content :deep(.md-editor-preview-wrapper){padding:12px 0}.preview-meta{padding:8px 12px;font-size:12px;color:var(--color-text-secondary);overflow-wrap:anywhere;border-bottom:1px solid var(--color-border-subtle)}.preview-content{flex:1;min-height:0;overflow:auto}.preview-content :deep(.md-editor-preview-wrapper){padding:16px}.code-mobile button:focus-visible{outline:2px solid var(--color-primary);outline-offset:-2px}.code-mobile button:active{background:var(--color-surface-subtle)}
</style>
<style>
.native-dialog.mobile-code-preview{position:fixed;inset:0;width:100%!important;max-width:none!important;height:100dvh;max-height:100dvh!important;margin:0!important;border-radius:0;transform:none!important;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:border-box}.mobile-code-preview .native-dialog__header{flex-shrink:0;min-height:56px;box-sizing:border-box}.mobile-code-preview .native-dialog__title{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-code-preview .native-dialog__close{min-width:44px;min-height:44px}.mobile-code-preview .native-dialog__body{display:flex;flex-direction:column;padding:0;flex:1;min-height:0;overflow:hidden}
</style>
