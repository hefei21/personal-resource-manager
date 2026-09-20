<template>
  <div class="code">
    <!-- 列表视图 -->
    <div v-if="!currentRepo">
      <NativeCard class="toolbar">
        <NativeSpace>
          <NativeInput
            v-model="searchKeyword"
            placeholder="搜索代码仓库..."
            style="width: 300px"
            @enter="loadRepos"
          >
            <template #suffix-icon>
              <NativeIcon name="magnifying-glass" />
            </template>
          </NativeInput>
          <NativeButton variant="outline" :loading="loading" @click="loadRepos">刷新列表</NativeButton>
          <NativeButton theme="primary" @click="showAddDialog" :disabled="isGuest">
            <template #icon><NativeIcon name="plus" /></template>
            添加仓库
          </NativeButton>
        </NativeSpace>
      </NativeCard>

      <NativeCard style="margin-top: 16px; min-height: 200px;">
        <div v-if="listError" class="code-feedback" role="alert"><span>{{ listError }}{{ repoList.length ? '，当前保留上次加载的结果。' : '。' }}</span><NativeButton size="small" variant="outline" @click="loadRepos">重试列表</NativeButton></div>
        <div v-else-if="loading && repoList.length" class="code-feedback" role="status">正在更新仓库列表…</div>
        <!-- 加载状态 -->
        <div v-if="loading && !repoList.length" class="content-loading">
          <NativeLoading size="small" />
        </div>
        <template v-else>
          <NativeList v-if="repoList && repoList.length > 0" :split="true">
            <NativeListItem v-for="repo in repoList" :key="repo.id">
              <div class="repo-item">
                <div class="repo-info" role="button" tabindex="0" @click="openRepo(repo)" @keydown.enter="openRepo(repo)" @keydown.space.prevent="openRepo(repo)">
                  <div class="repo-name">
                    <NativeIcon name="git" />
                    {{ repo.name }}
                    <NativeTag v-if="isReadOnlyRepository(repo)" theme="success" variant="light">NAS 只读</NativeTag>
                    <NativeTag v-else-if="isCloning(repo.id)" theme="warning" variant="light">克隆中 {{ cloneProgress(repo.id) }}%</NativeTag>
                    <NativeTag v-else-if="!repo.last_sync && !tasks.latest(repo.id)" theme="warning" variant="light">尚未完成克隆</NativeTag>
                  </div>
                  <div class="repo-desc">{{ repo.description || '暂无描述' }}</div>
                  <div v-if="isCloning(repo.id)" class="clone-progress-bar">
                    <div class="clone-progress-fill" :style="{ width: cloneProgress(repo.id) + '%' }"></div>
                  </div>
                  <div class="repo-meta">
                    <span>{{ repositorySourceLabel(repo) }}</span>
                    <span v-if="repo.last_sync">同步: {{ formatDate(repo.last_sync) }}</span>
                  </div>
                  <div v-if="repo.size !== undefined || (repo.languages && repo.languages.length > 0)" class="repo-stats">
                    <span v-if="repo.languages && repo.languages.length > 0" class="repo-langs">
                      <span v-for="(lang, idx) in repo.languages.slice(0, 3)" :key="idx" class="lang-tag">
                        {{ lang.name }} {{ lang.percentage }}%
                      </span>
                    </span>
                    <span v-if="repo.size !== undefined" class="repo-size">{{ formatSize(repo.size) }}</span>
                  </div>
                </div>
                <RepositoryTaskStatus v-if="!isReadOnlyRepository(repo)" :task="tasks.latest(repo.id)" :error="tasks.errors.value.get(String(repo.id))" :allow-reclone="!isGuest" @refresh="tasks.refresh(repo.id)" @reclone="recloneRepo(repo)" />
                <div v-if="!isReadOnlyRepository(repo)" class="repo-actions">
                  <NativeButton theme="default" size="small" aria-label="编辑仓库" @click.stop="editRepo(repo)" :disabled="isCloning(repo.id) || isSyncing(repo.id) || isGuest">
                    <template #icon><NativeIcon name="pencil" /></template>
                  </NativeButton>
                  <NativeButton theme="default" size="small" aria-label="同步仓库" @click.stop="syncRepo(repo)" :disabled="isCloning(repo.id) || isSyncing(repo.id) || isGuest">
                    <template #icon><NativeIcon name="arrow-clockwise" /></template>
                  </NativeButton>
                  <NativePopconfirm content="确定删除吗？这将同时删除本地代码文件。" @confirm="deleteRepo(repo.id)">
                    <template #trigger>
                      <NativeButton theme="default" size="small" class="btn-delete" aria-label="删除仓库" :disabled="isGuest || isCloning(repo.id) || isSyncing(repo.id)">
                        <template #icon><NativeIcon name="trash" color="var(--color-danger)" /></template>
                      </NativeButton>
                    </template>
                  </NativePopconfirm>
                </div>
              </div>
            </NativeListItem>
          </NativeList>
          <div v-else class="empty-wrapper">
            <NativeEmpty :description="listError ? '暂时无法获取仓库' : searchKeyword ? '没有找到匹配的仓库' : '暂无代码仓库，请添加一个仓库'" />
          </div>
        </template>
      </NativeCard>
    </div>

    <!-- 仓库详情浏览视图 -->
    <div v-else class="repo-browser">
      <div class="browser-header">
        <div class="browser-header-left">
          <NativeButton theme="default" @click="closeRepo">
            <template #icon><NativeIcon name="arrow-left" /></template>
            返回列表
          </NativeButton>
        </div>
        <div class="browser-title">
          <NativeIcon name="git" />
          {{ currentRepo.name }}
          <NativeTag v-if="isReadOnlyRepository(currentRepo)" theme="success" variant="light">NAS 只读</NativeTag>
        </div>
        <div class="browser-header-right">
          <NativeButton theme="default" size="small" @click="refreshRepo" v-if="!isGuest">
            <template #icon><NativeIcon name="arrow-clockwise" /></template>
            刷新
          </NativeButton>
          <NativePopconfirm v-if="!isReadOnlyRepository(currentRepo)" content="确定删除吗？这将同时删除本地代码文件。" @confirm="deleteRepo(currentRepo.id)">
            <template #trigger>
              <NativeButton theme="default" size="small" class="btn-delete" :disabled="isGuest">
                <template #icon><NativeIcon name="trash" color="var(--color-danger)" /></template>
                删除
              </NativeButton>
            </template>
          </NativePopconfirm>
        </div>
      </div>

      <NativeLayout class="browser-layout">
        <!-- 左侧文件树 -->
        <NativeAside class="file-sidebar">
          <div class="sidebar-header">文件目录</div>
          <div v-if="treeError" class="code-feedback" role="alert"><span>{{ treeError }}</span><NativeButton size="small" variant="text" @click="loadFileTree">重试目录</NativeButton></div>
          <div v-if="fileTreeLoading" class="sidebar-loading">
            <NativeLoading size="small" />
          </div>
          <div v-else-if="fileTree.length === 0 && !treeError" class="sidebar-empty">
            <NativeEmpty description="暂无文件" />
          </div>
          <NativeTree
            v-else
            :key="currentRepo.id"
            :data="fileTree"
            :expand-all="false"
            key-field="path"
            label-field="name"
            children-field="children"
            :activable="true"
            :selected-keys="requestedFile ? [requestedFile.path] : []"
            lazy
            :load="loadTreeNode"
            @select="onTreeSelect"
          >
            <template #node="{ node, selected }">
              <span class="tree-node-label" :class="{ 'is-selected': selected }">
                <NativeIcon :name="node.type === 'directory' ? 'folder' : 'file'" class="tree-node-icon" />
                {{ node.name }}
              </span>
            </template>
          </NativeTree>
        </NativeAside>

        <!-- 右侧内容区 -->
        <NativeContent class="content-area" padding="0" background="var(--color-surface-raised)">
          <NativeTabs :model-value="activeTab" @update:model-value="changeTab">
            <NativeTabPanel name="files" label="文件">
              <!-- 文件预览区域 -->
              <div class="file-preview-area">
                <!-- 文件头部：显示文件名和关闭按钮 -->
                <div v-if="currentFile" class="file-header">
                  <span class="file-title">
                    <NativeIcon :name="isMarkdownFile(currentFile.name) ? 'file-text' : 'file'" />
                    {{ currentFile.path || currentFile.name }}
                    <span v-if="currentFile.searchLine" class="search-line-badge">第 {{ currentFile.searchLine }} 行</span>
                    <span v-if="currentFile.commit" class="search-line-badge">提交 {{ currentFile.commit.slice(0, 12) }}</span>
                  </span>
                  <NativeButton size="small" theme="default" variant="text" @click="closeFile">
                    <template #icon><NativeIcon name="x" /></template>
                  </NativeButton>
                </div>
                <div v-else class="file-header">
                  <span class="file-title">
                    <NativeIcon name="file-text" />
                    README
                  </span>
                </div>
                
                <!-- 文件内容 -->
                <div ref="fileContentPanel" class="file-content">
                  <!-- 加载中 -->
                  <div v-if="fileLoading || (!currentFile && !fileError && readmeLoading)" class="file-loading">
                    <NativeLoading size="medium" />
                    <span class="loading-text">加载中...</span>
                  </div>
                  <div v-else-if="fileError" class="code-feedback code-feedback--file" role="alert"><strong>{{ fileError }}</strong><span>{{ requestedFile?.path }}</span><NativeButton variant="outline" @click="retryFile">重新加载文件</NativeButton><NativeButton variant="text" @click="closeFile">返回 README</NativeButton></div>
                  <!-- 当前选择的文件 -->
                  <template v-else-if="currentFile">
                    <!-- Markdown 文件预览 -->
                    <MdPreview
                      v-if="isMarkdownFile(currentFile.name) && !currentFile.searchLine"
                      :modelValue="currentFile.content"
                      :sanitize="sanitizeRichHtml"
                      :theme="editorTheme"
                      :previewTheme="previewTheme"
                      :codeTheme="codeTheme"
                      class="markdown-preview"
                    />
                    <!-- 文本/代码文件预览（带语法高亮） -->
                    <CodeSourcePreview v-else-if="currentFile.type === 'text' || isMarkdownFile(currentFile.name)" :content="currentFile.content" :html="highlightedCode" :line="currentFile.searchLine" />
                    <!-- 二进制文件 -->
                    <div v-else class="binary-file">
                      <NativeIcon name="file" size="48" />
                      <p>二进制文件，无法预览</p>
                      <p class="file-size">大小: {{ formatSize(currentFile.size || 0) }}</p>
                    </div>
                  </template>
                  <!-- 默认显示 README -->
                  <template v-else>
                    <div v-if="readmeError" class="code-feedback" role="alert"><span>{{ readmeError }}</span><NativeButton variant="outline" @click="loadReadme">重试 README</NativeButton></div>
                    <MdPreview
                      v-else-if="readmeContent"
                      :modelValue="readmeContent"
                      :sanitize="sanitizeRichHtml"
                      :theme="editorTheme"
                      :previewTheme="previewTheme"
                      :codeTheme="codeTheme"
                      class="markdown-preview"
                    />
                    <NativeEmpty v-else description="该仓库暂无 README 文件" />
                  </template>
                </div>
              </div>
            </NativeTabPanel>
            <NativeTabPanel name="search" label="仓库内搜索"><RepositorySearch :key="currentRepo.id" :repository-id="currentRepo.id" @open="openSearchResult" /></NativeTabPanel>
            <NativeTabPanel name="commits" label="提交历史">
              <div class="commits-panel">
                <div v-if="commitsError" class="code-feedback" role="alert"><span>{{ commitsError }}</span><NativeButton size="small" variant="outline" @click="loadCommits">重试历史</NativeButton></div>
                <NativeList v-if="commits.length > 0" :split="true">
                  <NativeListItem v-for="commit in commits" :key="commit.hash" class="commit-list-item" interactive @click="showCommitDetail(commit)">
                    <div class="commit-item">
                      <div class="commit-hash">{{ commit.hash }}</div>
                      <div class="commit-message">{{ commit.message }}</div>
                      <div class="commit-meta">
                        <span>{{ commit.author }}</span>
                        <span>{{ commit.date }}</span>
                      </div>
                    </div>
                  </NativeListItem>
                </NativeList>
                <NativeEmpty v-else-if="!commitsError" description="暂无提交历史" />
              </div>
            </NativeTabPanel>
          </NativeTabs>
        </NativeContent>
      </NativeLayout>
    </div>

    <!-- 添加仓库对话框 -->
    <NativeDialog v-model="addDialogVisible" title="添加代码仓库" @confirm="confirmAdd" :width="700" :confirm-loading="savingRepository" :confirm-disabled="savingRepository" :close-on-overlay-click="!savingRepository" :close-on-esc="!savingRepository" :close-btn="!savingRepository">
      <NativeForm :data="addForm">
        <NativeFormItem label="仓库URL">
          <NativeSpace style="width: 100%">
            <NativeInput v-model="addForm.url" placeholder="https://github.com/xxx/xxx.git" style="width: 480px" />
            <NativeButton theme="default" size="small" @click="fetchGithubInfo" :loading="fetchingInfo" :disabled="!isGithubUrl(addForm.url)">
              获取信息
            </NativeButton>
          </NativeSpace>
        </NativeFormItem>
        <NativeFormItem label="仓库名称">
          <NativeInput v-model="addForm.name" placeholder="给仓库起个名字" />
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea v-model="addForm.description" placeholder="仓库简介（可选）" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 编辑仓库对话框 -->
    <NativeDialog v-model="editDialogVisible" title="编辑代码仓库" @confirm="confirmEdit" :width="600" :confirm-loading="savingRepository" :confirm-disabled="savingRepository" :close-on-overlay-click="!savingRepository" :close-on-esc="!savingRepository" :close-btn="!savingRepository">
      <NativeForm :data="editForm">
        <NativeFormItem label="仓库名称">
          <NativeInput v-model="editForm.name" placeholder="仓库名称" />
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea v-model="editForm.description" placeholder="仓库简介" />
        </NativeFormItem>
        <NativeFormItem label="仓库URL">
          <NativeSpace style="width: 100%">
            <NativeInput v-model="editForm.url" disabled style="width: 380px" />
            <NativeButton theme="default" size="small" @click="fetchEditGithubInfo" :loading="fetchingEditInfo" :disabled="!isGithubUrl(editForm.url)">
              自动获取
            </NativeButton>
          </NativeSpace>
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 提交详情对话框 -->
    <NativeDialog v-model="commitDialogVisible" :title="commitDetail ? '提交详情: ' + commitDetail.hash : '提交详情'" :width="900" :show-footer="false">
      <div v-if="commitLoading" class="commit-loading">
        <NativeLoading text="加载中..." />
      </div>
      <div v-else-if="commitError" class="code-feedback" role="alert"><span>{{ commitError }}</span><NativeButton variant="outline" @click="showCommitDetail(requestedCommit)">重试提交详情</NativeButton></div>
      <div v-else-if="commitDetail" class="commit-detail">
        <div class="commit-detail-header">
          <div class="commit-info-row">
            <span class="label">提交哈希:</span>
            <span class="value">{{ commitDetail.hash }}</span>
          </div>
          <div v-if="commitDetail.files && commitDetail.files.length > 0" class="changed-files">
            <span class="label">变更文件 ({{ commitDetail.files.length }}):</span>
            <div class="file-list">
              <span v-for="f in commitDetail.files" :key="f.file" class="file-item">
                {{ f.file }}<span v-if="f.changes"> ({{ f.changes }} 行)</span>
              </span>
            </div>
          </div>
        </div>
        <div class="diff-container">
          <div class="diff-lines">
            <div v-for="(line, index) in parsedDiff" :key="index" :class="['diff-line', line.type]">
              <span class="line-number">{{ line.num || '' }}</span>
              <span class="line-prefix">{{ line.prefix }}</span>
              <span class="line-content">{{ line.content }}</span>
            </div>
          </div>
        </div>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { usePermission } from '@/composables/usePermission'
import { isReadOnlyRepository, repositorySourceLabel } from '@/utils/codeRepositoryCapabilities'
import CodeSourcePreview from '@/components/CodeSourcePreview.vue'
import { resolveRepositoryLink, scrollRepositoryAnchor } from '@/utils/repositoryNavigation'

import RepositorySearch from '@/components/RepositorySearch.vue'
import RepositoryTaskStatus from '@/components/RepositoryTaskStatus.vue'
import { useRepositoryTasks } from '@/composables/useRepositoryTasks'
const route = useRoute(), router = useRouter()
import { 
  NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, 
  NativeCheckbox, NativeLoading, NativeEmpty, NativeIcon, NativeSpace, 
  NativeList, NativeListItem, NativeTag, NativePopconfirm, NativeLayout, 
  NativeAside, NativeContent, NativeTree, NativeTabs, NativeTabPanel, 
  NativeForm, NativeFormItem, NativeRadio, NativeRadioGroup, NativeTextarea 
} from '@/components/native'
import { useToast } from '@/composables/useToast'
import { useAppTheme } from '@/composables/useAppTheme'
import {
  escapeHtml,
  sanitizeHighlightHtml,
  sanitizeRichHtml
} from '@/utils/sanitizeHtml'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import 'highlight.js/styles/github.css'

const toast = useToast()
const { isGuest } = usePermission()

// Markdown预览主题配置
const { resolved: editorTheme } = useAppTheme()
const previewTheme = ref('default')
const codeTheme = ref('atom')

const repoList = ref([])
const searchKeyword = ref('')
const loading = ref(false)
const listError = ref('')
let listRequest = 0
let fileRequest = 0
let repoEpoch = 0
let treeRequest = 0
let readmeRequest = 0
let commitsRequest = 0
let refreshRequest = 0
let disposed = false
const fileContentPanel = ref(null)
const fileError = ref('')
const treeError = ref('')
const readmeError = ref('')
const commitsError = ref('')
const requestedFile = ref(null)
const addDialogVisible = ref(false)
const savingRepository = ref(false)

const tasks = useRepositoryTasks(() => loadRepos())
const { cloneStatuses, syncStatuses } = tasks
function isSyncing(repoId) { return syncStatuses.value.get(String(repoId))?.status === 'syncing' }
function startSyncPolling(repoId) { return tasks.track(repoId) }
async function recloneRepo(repo) {
  if (isGuest.value || isReadOnlyRepository(repo)) return
  try { await api.code.reclone(repo.id); tasks.track(repo.id) }
  catch { toast.error('安全重克隆未启动，请重试') }
}

// 当前浏览的仓库
const currentRepo = ref(null)
const fileTree = ref([])
const fileTreeLoading = ref(false)
const commits = ref([])
const readmeContent = ref('')
const readmeLoading = ref(false)
const activeTab = ref('files')
const currentFile = ref(null)
const fileLoading = ref(false)

const addForm = ref({
  name: '',
  url: '',
  type: 'git',
  description: ''
})

const fetchingInfo = ref(false)

// 编辑仓库
const editDialogVisible = ref(false)
const editForm = ref({
  id: null,
  name: '',
  url: '',
  description: ''
})
const fetchingEditInfo = ref(false)

// 提交详情
const commitDialogVisible = ref(false)
const commitDetail = ref(null)
const commitLoading = ref(false)
const commitError = ref(''), requestedCommit = ref(null)
let commitDetailRequest = 0
watch(commitDialogVisible, visible => { if (!visible) commitDetailRequest++ })

// 检查是否为GitHub URL
function isGithubUrl(url) {
  return url && url.includes('github.com')
}

// 从GitHub获取仓库信息
async function fetchGithubInfo() {
  if (!addForm.value.url) {
    toast.warning('请先输入仓库URL')
    return
  }
  
  fetchingInfo.value = true
  try {
    const response = await api.code.getGithubInfo(addForm.value.url)
    const data = response.data?.data
    
    if (data) {
      // 自动填充信息
      if (!addForm.value.name) {
        addForm.value.name = data.name
      }
      if (!addForm.value.description) {
        addForm.value.description = data.description
      }
      toast.success('获取GitHub信息成功')
    }
  } catch (error) {
    toast.error(error.response?.data?.message || '获取GitHub信息失败')
  } finally {
    fetchingInfo.value = false
  }
}

// 编辑仓库
function editRepo(repo) {
  editForm.value = {
    id: repo.id,
    name: repo.name,
    url: repo.url,
    description: repo.description || ''
  }
  editDialogVisible.value = true
}

// 从GitHub获取编辑仓库的信息
async function fetchEditGithubInfo() {
  if (!editForm.value.url) {
    toast.warning('仓库URL无效')
    return
  }
  
  fetchingEditInfo.value = true
  try {
    const response = await api.code.getGithubInfo(editForm.value.url)
    const data = response.data?.data
    
    if (data) {
      editForm.value.name = data.name
      editForm.value.description = data.description || ''
      toast.success('获取GitHub信息成功')
    }
  } catch (error) {
    toast.error(error.response?.data?.message || '获取GitHub信息失败')
  } finally {
    fetchingEditInfo.value = false
  }
}

// 确认编辑
async function confirmEdit() {
  if (savingRepository.value) return
  if (!editForm.value.name) {
    toast.warning('请输入仓库名称')
    return
  }
  
  try {
    savingRepository.value = true
    await api.code.update(editForm.value.id, {
      name: editForm.value.name,
      description: editForm.value.description
    })
    toast.success('更新成功')
    editDialogVisible.value = false
    loadRepos()
  } catch (error) {
    toast.error(error.response?.data?.message || '更新失败')
  } finally { savingRepository.value = false }
}

// 显示提交详情
async function showCommitDetail(commit) {
  if (!currentRepo.value || !commit) return
  const request = ++commitDetailRequest, epoch = repoEpoch
  requestedCommit.value = commit; commitError.value = ''
  
  commitDialogVisible.value = true
  commitLoading.value = true
  commitDetail.value = null
  
  try {
    const response = await api.code.getCommitDetail(currentRepo.value.id, commit.fullHash || commit.hash)
    if (disposed || request !== commitDetailRequest || epoch !== repoEpoch) return
    commitDetail.value = response.data?.data
  } catch (error) {
    if (!disposed && request === commitDetailRequest && epoch === repoEpoch) commitError.value = '提交详情加载失败'
  } finally {
    if (!disposed && request === commitDetailRequest && epoch === repoEpoch) commitLoading.value = false
  }
}

// 解析diff内容为带类型的行
const parsedDiff = computed(() => {
  if (!commitDetail.value?.diff) return []
  
  const lines = commitDetail.value.diff.split('\n')
  const result = []
  let oldLine = 0
  let newLine = 0
  
  for (const line of lines) {
    if (line.startsWith('@@')) {
      // 解析 @@ -start,count +start,count @@ 格式
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1])
        newLine = parseInt(match[2])
      }
      result.push({ type: 'header', num: '', prefix: '', content: line })
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git') || line.startsWith('index ')) {
      result.push({ type: 'info', num: '', prefix: '', content: line })
    } else if (line.startsWith('-')) {
      result.push({ type: 'removed', num: oldLine++, prefix: '-', content: line.substring(1) })
    } else if (line.startsWith('+')) {
      result.push({ type: 'added', num: newLine++, prefix: '+', content: line.substring(1) })
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', num: oldLine++, prefix: ' ', content: line.substring(1) })
      newLine++
    } else if (line === '') {
      result.push({ type: 'empty', num: '', prefix: '', content: '' })
    } else {
      result.push({ type: 'context', num: oldLine++, prefix: '', content: line })
      newLine++
    }
  }
  
  return result
})

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 检查是否正在克隆
function isCloning(repoId) {
  const status = cloneStatuses.value.get(String(repoId))
  return status && status.status === 'cloning'
}

// 获取克隆进度
function cloneProgress(repoId) {
  const status = cloneStatuses.value.get(String(repoId))
  return status ? status.progress : 0
}

function startClonePolling(repoId) { return tasks.track(repoId, 'clone') }

// 配置 marked 使用 highlight.js 和标题 ID
const renderer = new marked.Renderer()
renderer.heading = function(text, level) {
  // 生成锚点 ID：将标题文本转换为小写，空格替换为连字符
  const anchorId = text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
  return `<h${level} id="${anchorId}">${text}</h${level}>`
}

marked.setOptions({
  renderer: renderer,
  highlight: function(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext'
    return hljs.highlight(code, { language }).value
  },
  langPrefix: 'hljs language-'
})

// 高亮后的代码内容
const highlightedCode = computed(() => {
  if (!currentFile.value?.content) return ''
  const lang = getLanguageFromFilename(currentFile.value.name)
  if (lang === 'plaintext') {
    return escapeHtml(currentFile.value.content)
  }
  try {
    return sanitizeHighlightHtml(
      hljs.highlight(currentFile.value.content, { language: lang }).value
    )
  } catch (e) {
    return escapeHtml(currentFile.value.content)
  }
})

// 判断是否为 Markdown 文件
function isMarkdownFile(filename) {
  return filename?.toLowerCase().endsWith('.md')
}

// 根据文件名获取语言
function getLanguageFromFilename(filename) {
  const ext = filename?.split('.').pop()?.toLowerCase()
  const langMap = {
    'js': 'javascript',
    'ts': 'typescript',
    'jsx': 'javascript',
    'tsx': 'typescript',
    'vue': 'html',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'r': 'r',
    'm': 'objectivec',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'ps1': 'powershell',
    'sql': 'sql',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'cmake': 'cmake',
    'gradle': 'gradle',
    'md': 'markdown',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    'vue': 'html'
  }
  return langMap[ext] || 'plaintext'
}

// 加载仓库列表
async function loadRepos() {
  if (disposed) return
  const request = ++listRequest
  loading.value = true
  listError.value = ''
  try {
    const response = await api.code.list({ keyword: searchKeyword.value })
    if (request !== listRequest) return
    repoList.value = response.data?.data || []
    for (const repo of repoList.value) if (!isReadOnlyRepository(repo)) tasks.refresh(repo.id)
  } catch {
    if (request === listRequest) listError.value = '加载仓库列表失败，请检查连接后重试'
  } finally {
    if (request === listRequest) loading.value = false
  }
}

// 显示添加对话框
function showAddDialog() {
  addForm.value = { name: '', url: '', type: 'git', description: '' }
  addDialogVisible.value = true
}

// 确认添加
async function confirmAdd() {
  if (savingRepository.value) return
  if (!addForm.value.name || !addForm.value.url) {
    toast.warning('请填写完整信息')
    return
  }
  try {
    savingRepository.value = true
    const response = await api.code.create(addForm.value)
    toast.success('仓库添加成功，正在后台克隆...')
    addDialogVisible.value = false
    
    // 开始轮询克隆进度
    if (response.data?.id) {
      startClonePolling(response.data.id)
    }
    
    loadRepos()
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
  } finally { savingRepository.value = false }
}

// 删除仓库
async function deleteRepo(id) {
  try {
    await api.code.delete(id)
    if (String(currentRepo.value?.id) === String(id)) closeRepo()
    toast.success('删除成功')
    loadRepos()
  } catch (error) {
    toast.error('删除失败')
  }
}

// 同步仓库
async function syncRepo(repo) {
  try {
    const response = await api.code.sync(repo.id)
    toast.success('开始同步仓库...')
    
    // 立即更新列表显示同步状态
    loadRepos()
    
    // 开始轮询同步进度
    if (response.data?.taskId) {
      startSyncPolling(repo.id, response.data.taskId)
    }
  } catch (error) {
    toast.error('同步失败')
  }
}

// 打开仓库浏览
function invalidateRepoRequests() {
  repoEpoch += 1
  refreshRequest += 1
  fileRequest += 1
  treeRequest += 1
  readmeRequest += 1
  commitsRequest += 1
  fileLoading.value = false
  fileTreeLoading.value = false
  readmeLoading.value = false
  fileError.value = treeError.value = readmeError.value = commitsError.value = ''
  requestedFile.value = null
}
async function openRepoState(repo) {
  invalidateRepoRequests()
  currentRepo.value = repo
  activeTab.value = 'files'
  currentFile.value = null
  fileTree.value = []
  commits.value = []
  readmeContent.value = ''
  await Promise.all([loadFileTree(), loadReadme(), loadCommits()])
}

function closeRepoState() {
  invalidateRepoRequests()
  currentRepo.value = null
  fileTree.value = []
  commits.value = []
  readmeContent.value = ''
  currentFile.value = null
}

// 加载树节点（用于异步加载）- NativeTree lazy load 回调
async function loadTreeNode(node) {
  if (!currentRepo.value) return []
  const repositoryId = currentRepo.value.id, epoch = repoEpoch
  
  // node 是 TreeNode 实例，实际数据在 node.data 中
  const nodeData = node.data || node
  const targetPath = nodeData.path || ''
  
  
  try {
    const response = await api.code.getTree(repositoryId, targetPath)
    if (epoch !== repoEpoch) return []
    const items = response.data.data || []
    
    // 转换为树形结构
    return items.map(item => ({
      path: item.path,
      name: item.name,
      type: item.type,
      // 懒加载节点需要设置 children: true 表示可以展开
      children: item.type === 'directory' ? true : undefined,
      isLeaf: item.type === 'file'
    }))
  } catch (error) {
    if (epoch !== repoEpoch) return []
    console.error('加载树节点失败:', error)
    toast.error('目录加载失败，可再次点击该目录重试')
    throw error
  }
}

// 加载文件树（初始加载根目录）
async function loadFileTree() {
  if (!currentRepo.value) return
  const repositoryId = currentRepo.value.id, epoch = repoEpoch, request = ++treeRequest
  fileTreeLoading.value = true
  treeError.value = ''
  try {
    const response = await api.code.getTree(repositoryId, '')
    if (epoch !== repoEpoch || request !== treeRequest) return
    fileTree.value = (response.data.data || []).map(item => ({
      path: item.path, name: item.name, type: item.type,
      children: item.type === 'directory' ? true : undefined,
      isLeaf: item.type === 'file'
    }))
    return true
  } catch {
    if (epoch === repoEpoch && request === treeRequest) treeError.value = '文件目录加载失败'
    return false
  } finally {
    if (epoch === repoEpoch && request === treeRequest) fileTreeLoading.value = false
  }
}

// 树节点选择
async function onTreeSelect(keys, node) {
  if (!node) return
  
  
  if (node.type === 'file') {
    // 如果当前在提交历史标签页，自动切换回文件标签页
    if (activeTab.value === 'commits') {
      activeTab.value = 'files'
    }
    await loadFile(node.path)
  }
  // 目录点击由 Tree 组件自动处理展开和异步加载
}

// 加载文件内容
async function loadFileState(path, searchLine = null, commit = null) {
  if (!currentRepo.value) return
  const repositoryId = currentRepo.value.id, epoch = repoEpoch, request = ++fileRequest
  requestedFile.value = { path, searchLine, commit }
  fileLoading.value = true
  fileError.value = ''
  try {
    const response = await api.code.getFile(repositoryId, path, commit)
    if (epoch !== repoEpoch || request !== fileRequest) return
    currentFile.value = {
      ...response.data.data, path,
      ...(Number.isSafeInteger(searchLine) && searchLine > 0 ? { searchLine } : {})
    }
    fileLoading.value = false
    await nextTick()
    if (epoch !== repoEpoch || request !== fileRequest) return
    if (fileContentPanel.value) {
      fileContentPanel.value.scrollTop = 0
      fileContentPanel.value.scrollLeft = 0
    }
    if (isMarkdownFile(path)) bindMarkdownLinks()
  } catch (error) {
    if (epoch !== repoEpoch || request !== fileRequest) return
    fileError.value = error.response?.data?.code === 'CODE_SNAPSHOT_STALE'
      ? '该引用对应的提交已过期，请刷新搜索结果后重新打开'
      : '文件加载失败，请重试'
  } finally {
    if (epoch === repoEpoch && request === fileRequest) fileLoading.value = false
  }
}

function retryFile() {
  if (requestedFile.value) {
    const { path, searchLine, commit } = requestedFile.value
    void loadFile(path, searchLine, commit)
  }
}

// Delegate links to the current preview container; never attach handlers to stale content.
function bindMarkdownLinks() {
  const panel = fileContentPanel.value
  if (!panel) return
  panel.onclick = (event) => {
    const link = event.target.closest?.('.markdown-preview a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href')
    if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return }
    const target = resolveRepositoryLink(href, currentFile.value?.path || 'README.md')
    if (!target) { toast.info('此链接不能在仓库内打开'); return }
    if (target.sameFile) scrollRepositoryAnchor(panel, target.anchor)
    else updateLocation({ path: target.path, line: null, commit: currentFile.value?.commit || null, anchor: target.anchor, tab: 'files' })
  }
  scrollRepositoryAnchor(panel, route.query.anchor)
}

// 关闭文件预览
function closeFileState() {
  fileRequest += 1
  currentFile.value = null
  requestedFile.value = null
  fileError.value = ''
  fileLoading.value = false
  void nextTick().then(bindMarkdownLinks)
}

async function loadReadme() {
  if (!currentRepo.value) return
  const repositoryId = currentRepo.value.id, epoch = repoEpoch, request = ++readmeRequest
  readmeLoading.value = true
  readmeError.value = ''
  try {
    const response = await api.code.getReadme(repositoryId)
    if (epoch !== repoEpoch || request !== readmeRequest) return
    readmeContent.value = response.data.data?.content || ''
    readmeLoading.value = false
    await nextTick()
    if (epoch === repoEpoch && request === readmeRequest) bindMarkdownLinks()
    return true
  } catch {
    if (epoch === repoEpoch && request === readmeRequest) readmeError.value = 'README 加载失败'
    return false
  } finally {
    if (epoch === repoEpoch && request === readmeRequest) readmeLoading.value = false
  }
}

async function loadCommits() {
  if (!currentRepo.value) return
  const repositoryId = currentRepo.value.id, epoch = repoEpoch, request = ++commitsRequest
  commitsError.value = ''
  try {
    const response = await api.code.getCommits(repositoryId, 20)
    if (epoch !== repoEpoch || request !== commitsRequest) return
    commits.value = response.data.data || []
    return true
  } catch {
    if (epoch === repoEpoch && request === commitsRequest) commitsError.value = '提交历史加载失败'
    return false
  }
}

async function refreshRepo() {
  const epoch = repoEpoch, request = ++refreshRequest
  const results = await Promise.all([loadFileTree(), loadReadme(), loadCommits()])
  if (epoch !== repoEpoch || request !== refreshRequest) return
  if (results.every(Boolean)) toast.success('刷新成功')
  else toast.warning('部分内容更新失败，可在对应区域重试')
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}

let navigationRequest = 0
const locationKeys = ['repositoryId', 'path', 'line', 'commit', 'anchor']
function updateLocation(patch) {
  const query = { ...route.query, ...patch }
  for (const key of Object.keys(query)) if (query[key] === null || query[key] === '') delete query[key]
  return router.push({ query })
}
function openRepo(repo) { return updateLocation({ repositoryId: String(repo.id), path: null, line: null, commit: null, tab: 'files', codeQ: null, codeMode: null, codePage: null }) }
function closeRepo() { return updateLocation({ repositoryId: null, path: null, line: null, commit: null, tab: null, codeQ: null, codeMode: null, codePage: null }) }
function loadFile(path, line = null, commit = null) {
  if (route.query.path === path && String(route.query.line || '') === String(line || '') && (route.query.commit || null) === commit) return loadFileState(path, line, commit)
  return updateLocation({ path, line: line ? String(line) : null, commit, anchor: null, tab: 'files' })
}
function closeFile() { return updateLocation({ path: null, line: null, commit: null, anchor: null }) }
function openSearchResult(locator) { loadFile(locator.path, locator.line, locator.commit || null) }
async function restoreLocation() {
  const request = ++navigationRequest
  const repositoryId = Number(route.query.repositoryId)
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) { closeRepoState(); return }
  if (Number(currentRepo.value?.id) !== repositoryId) {
    closeRepoState()
    let repository = repoList.value.find(item => Number(item.id) === repositoryId)
    try {
      if (!repository) repository = (await api.code.get(repositoryId)).data?.data
      if (disposed || request !== navigationRequest) return
      if (!repository) throw new Error('missing')
      await openRepoState(repository)
    } catch {
      if (!disposed && request === navigationRequest) listError.value = '仓库暂不可用，请刷新列表后重试'
      return
    }
  }
  if (disposed || request !== navigationRequest) return
  activeTab.value = ['files', 'commits', 'search'].includes(route.query.tab) ? route.query.tab : 'files'
  if (typeof route.query.path === 'string' && route.query.path) {
    const line = Number(route.query.line)
    await loadFileState(route.query.path, Number.isSafeInteger(line) && line > 0 ? line : null, typeof route.query.commit === 'string' ? route.query.commit : null)
  } else closeFileState()
}
watch(() => JSON.stringify(locationKeys.map(key => route.query[key])), restoreLocation)
watch(() => route.query.tab, (tab) => { if (['files', 'commits', 'search'].includes(tab)) activeTab.value = tab })
function changeTab(tab) { activeTab.value = tab; updateLocation({ tab }) }
onMounted(async () => { await loadRepos(); if (!disposed) restoreLocation() })
onBeforeUnmount(() => {
  disposed = true
  listRequest += 1
  invalidateRepoRequests()
  navigationRequest += 1
})
</script>

<style scoped>
.code-feedback{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;font-size:13px;line-height:1.6;color:var(--color-text-secondary);background:var(--color-surface-subtle);border-bottom:1px solid var(--color-border-subtle)}
.code-feedback--file{height:100%;box-sizing:border-box;justify-content:center;flex-direction:column}
.code-feedback--file strong{color:var(--color-text-primary);font-size:15px}
.code-feedback--file span{overflow-wrap:anywhere}
.repo-info:focus-visible{outline:2px solid var(--color-primary);outline-offset:4px;border-radius:4px}
.repo-item{grid-template-columns:minmax(0,1fr) auto}
.repo-item>.repo-info{grid-column:1;grid-row:1}.repo-item>.repo-actions{grid-column:2;grid-row:1}.repo-item>:deep(.repository-task){grid-column:1/-1;margin-top:0}
.content-area{background:var(--color-surface-raised)}
.code {
  padding: 0;
}

/* 内容区域加载状态 */
.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

/* 空状态包装器 */
.empty-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header p {
  font-size: 16px;
  color: var(--color-text-primary);
  margin: 0;
  font-weight: 500;
}

.repo-item {
  display: grid;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px;
  gap: 8px 20px;
  width: 100%;
}

.repo-info {
  flex: 1;
  cursor: pointer;
  min-width: 0;
}

.repo-info:hover .repo-name {
  color: var(--color-primary);
}

.repo-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding-left: 0;
}

.repo-desc {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
  padding-left: 24px;
  line-height: 1.5;
}

.repo-meta {
  font-size: 12px;
  color: var(--color-text-muted);
  display: flex;
  gap: 16px;
  padding-left: 24px;
}

.repo-stats {
  font-size: 12px;
  color: var(--color-text-secondary);
  display: flex;
  gap: 16px;
  padding-left: 24px;
  margin-top: 6px;
  align-items: center;
}

.repo-langs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.lang-tag {
  padding: 2px 8px;
  background: var(--color-primary-surface);
  border-radius: 4px;
  color: var(--color-primary);
  font-size: 11px;
}

.clone-progress-bar {
  width: 200px;
  height: 4px;
  background: var(--color-surface-subtle);
  border-radius: 2px;
  margin: 6px 0;
  overflow: hidden;
}

.clone-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-primary), #00a8ff);
  border-radius: 2px;
  transition: width 0.3s;
}

.repo-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  padding-top: 2px;
  align-items: flex-start;
  min-width: 120px;
  justify-content: flex-end;
}

/* 仓库浏览器样式 */
.repo-browser {
  height: calc(100vh - 120px);
}

.browser-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--color-surface-raised);
  border-radius: 8px;
}

.browser-header-left {
  flex-shrink: 0;
}

.browser-title {
  flex: 1;
  font-size: 18px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  justify-content: flex-start;
}

.browser-header-right {
  flex-shrink: 0;
  margin-left: auto;
  display: flex;
  gap: 12px;
}

.browser-layout {
  background: var(--color-surface-raised);
  border-radius: 8px;
  height: calc(100% - 60px);
  overflow: hidden;
  display: flex;
}

.file-sidebar {
  width: 280px;
  min-width: 280px;  /* 防止被挤压 */
  border-right: 1px solid var(--color-border-subtle);
  overflow-y: auto;
  flex-shrink: 0;  /* 不允许收缩 */
}

.sidebar-header {
  padding: 12px 16px;
  font-weight: 600;
  border-bottom: 1px solid var(--color-border-subtle);
}

.sidebar-empty {
  padding: 40px 16px;
}

.sidebar-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
}

.content-area {
  padding: 16px;
  overflow-y: auto;
  position: relative;
  flex: 1;
  min-width: 400px;  /* 最小宽度 */
}

.readme-panel {
  padding: 16px;
}

.markdown-content {
  line-height: 1.6;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
}

.markdown-content :deep(h1) {
  font-size: 2em;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0.3em;
}

.markdown-content :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0.3em;
}

.markdown-content :deep(h3) {
  font-size: 1.25em;
}

.markdown-content :deep(p) {
  margin-bottom: 16px;
}

.markdown-content :deep(code) {
  background: var(--color-surface-subtle);
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: monospace;
}

.markdown-content :deep(pre) {
  background: var(--color-surface-subtle);
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin-bottom: 16px;
}

.markdown-content :deep(pre code) {
  background: transparent;
  padding: 0;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 2em;
  margin-bottom: 16px;
}

.markdown-content :deep(li) {
  margin-bottom: 0.25em;
}

.markdown-content :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 16px;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--color-border-default);
  padding: 8px 12px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--color-surface-subtle);
  font-weight: 600;
}

.markdown-content :deep(tr:nth-child(even)) {
  background: var(--color-surface-subtle);
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid var(--color-border-default);
  padding-left: 16px;
  margin-left: 0;
  color: var(--color-text-secondary);
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border-subtle);
  margin: 24px 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  height: auto;
}

.tree-node-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tree-node-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

/* 文件预览区域样式 */
.file-preview-area {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--color-surface-subtle);
  border-radius: 6px 6px 0 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.file-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  font-size: 14px;
  color: var(--color-text-primary);
}

.search-line-badge {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-primary-surface);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
}

.file-content {
  flex: 1;
  overflow: auto;
  padding: 0;
  background: var(--color-surface-raised);
  border-radius: 0 0 6px 6px;
}

.file-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--color-text-secondary);
  gap: 12px;
}

.file-loading .loading-text {
  font-size: 14px;
  color: var(--color-text-muted);
}

/* Markdown预览样式 */
:deep(.markdown-preview) {
  padding: 24px;
}

:deep(.markdown-preview) :deep(h1),
:deep(.markdown-preview) :deep(h2),
:deep(.markdown-preview) :deep(h3),
:deep(.markdown-preview) :deep(h4),
:deep(.markdown-preview) :deep(h5),
:deep(.markdown-preview) :deep(h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--color-text-primary);
}

:deep(.markdown-preview) :deep(h1) {
  font-size: 2em;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0.3em;
}

:deep(.markdown-preview) :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0.3em;
}

:deep(.markdown-preview) :deep(h3) {
  font-size: 1.25em;
}

:deep(.markdown-preview) :deep(p) {
  margin-bottom: 16px;
  line-height: 1.6;
}

:deep(.markdown-preview) :deep(code) {
  background: var(--color-surface-subtle);
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 85%;
}

:deep(.markdown-preview) :deep(pre) {
  background: var(--color-surface-subtle);
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin-bottom: 16px;
}

:deep(.markdown-preview) :deep(pre code) {
  background: transparent;
  padding: 0;
}

:deep(.markdown-preview) :deep(ul),
:deep(.markdown-preview) :deep(ol) {
  padding-left: 2em;
  margin-bottom: 16px;
}

:deep(.markdown-preview) :deep(li) {
  margin-bottom: 0.25em;
}

:deep(.markdown-preview) :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}

:deep(.markdown-preview) :deep(a:hover) {
  text-decoration: underline;
}

:deep(.markdown-preview) :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 16px;
}

:deep(.markdown-preview) :deep(th),
:deep(.markdown-preview) :deep(td) {
  border: 1px solid var(--color-border-default);
  padding: 8px 12px;
  text-align: left;
}

:deep(.markdown-preview) :deep(th) {
  background: var(--color-surface-subtle);
  font-weight: 600;
}

:deep(.markdown-preview) :deep(tr:nth-child(even)) {
  background: var(--color-surface-subtle);
}

:deep(.markdown-preview) :deep(blockquote) {
  border-left: 4px solid var(--color-border-default);
  padding-left: 16px;
  margin-left: 0;
  color: var(--color-text-secondary);
  margin-bottom: 16px;
}

:deep(.markdown-preview) :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border-subtle);
  margin: 24px 0;
}

:deep(.markdown-preview) :deep(img) {
  max-width: 100%;
  height: auto;
}

/* 代码内容样式 */
.code-content {
  margin: 0;
  padding: 16px;
  background: #f6f8fa;
  border-radius: 0 0 6px 6px;
  overflow: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 14px;
  line-height: 1.6;
}

.code-content code {
  background: transparent;
  padding: 0;
}

/* 二进制文件显示 */
.binary-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--color-text-secondary);
}

.binary-file p {
  margin: 8px 0;
}

.binary-file .file-size {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* 提交列表面板 */
.commits-panel {
  padding: 16px;
}

.commit-list-item {
  cursor: pointer;
  transition: background 0.2s;
}

.commit-list-item:hover {
  background: var(--color-surface-subtle);
}

.commit-item {
  padding: 12px 8px 12px 16px;
}

.commit-hash {
  font-family: monospace;
  font-size: 12px;
  color: var(--color-primary);
  background: var(--color-primary-surface);
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.commit-message {
  font-size: 14px;
  color: var(--color-text-primary);
  margin-bottom: 8px;
  font-weight: 500;
}

.commit-meta {
  font-size: 12px;
  color: var(--color-text-muted);
  display: flex;
  gap: 16px;
}

/* 提交详情样式 */
.commit-loading {
  display: flex;
  justify-content: center;
  padding: 48px;
}

.commit-detail {
  max-height: 600px;
  overflow: auto;
}

.commit-detail-header {
  padding: 16px;
  background: var(--color-surface-subtle);
  border-radius: 6px;
  margin-bottom: 16px;
}

.commit-info-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.commit-info-row .label {
  font-weight: 500;
  color: var(--color-text-secondary);
}

.commit-info-row .value {
  color: var(--color-text-primary);
  font-family: monospace;
}

.changed-files {
  margin-top: 12px;
}

.changed-files .label {
  font-weight: 500;
  color: var(--color-text-secondary);
  display: block;
  margin-bottom: 8px;
}

.file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.file-item {
  background: var(--color-primary-surface);
  color: var(--color-primary);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}

/* Diff 显示样式 */
.diff-container {
  background: var(--color-surface-subtle);
  border-radius: 6px;
  overflow: auto;
  max-height: 400px;
}

.diff-lines {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
}

.diff-line {
  display: flex;
  padding: 2px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-line .line-number {
  width: 50px;
  color: var(--color-text-muted);
  text-align: right;
  padding-right: 8px;
  flex-shrink: 0;
}

.diff-line .line-prefix {
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.diff-line .line-content {
  flex: 1;
}

.diff-line.header {
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.diff-line.info {
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
}

.diff-line.removed {
  background: var(--color-danger-surface);
}

.diff-line.removed .line-prefix {
  color: var(--color-danger-text);
}

.diff-line.added {
  background: var(--color-success-surface);
}

.diff-line.added .line-prefix {
  color: var(--color-success-text);
}

.diff-line.context {
  background: transparent;
}

.diff-line.empty {
  background: transparent;
}

/* 工具栏样式 */
.toolbar :deep(.native-space) {
  align-items: center;
}

/* 列表项样式 */
:deep(.native-list-item) {
  padding: 0;
}

/* 删除按钮样式 - 白底红边红图标 */
.btn-delete {
  background-color: var(--color-surface-raised) !important;
  border-color: var(--color-danger) !important;
  color: var(--color-danger) !important;
}

.btn-delete :deep(.native-icon) {
  color: var(--color-danger) !important;
}
/* PC knowledge browsing: one constrained reader surface, not nested page scrolls. */
.toolbar{box-shadow:none}
.toolbar :deep(.native-card__body){padding:12px 16px}
.repo-item{padding:18px 16px;gap:16px;box-sizing:border-box}
.repo-name{font-size:15px}.repo-desc{font-size:13px}.repo-actions{gap:5px}
.repo-actions :deep(.native-button){min-width:30px;height:30px;padding:5px}
.repo-actions :deep(svg){width:15px;height:15px}
.repo-browser{display:flex;flex-direction:column;gap:12px;height:calc(100dvh - 120px);min-height:460px}
.browser-header{margin:0;padding:10px 14px;background:var(--color-surface-raised);border:1px solid var(--color-border-subtle)}
.browser-title{font-size:16px;min-width:0}
.browser-layout{height:auto;flex:1;min-height:0;background:var(--color-surface-raised);border:1px solid var(--color-border-subtle)}
.file-sidebar{width:clamp(200px,20vw,280px);min-width:200px;border-color:var(--color-border-subtle);background:var(--color-surface-subtle)}
.content-area{padding:0;min-width:0;overflow:hidden}
.content-area :deep(.native-tabs){display:flex;flex-direction:column;height:100%;min-height:0}
.content-area :deep(.native-tabs__header){flex-shrink:0;margin:0;padding-inline:16px}
.content-area :deep(.native-tabs__content){flex:1;min-height:0;overflow:hidden;padding:0}
.content-area :deep(.native-tab-panel){height:100%;overflow:auto}
.file-preview-area,.file-content{min-height:0}
.file-content{background:var(--color-surface-raised)}
.file-header{flex-shrink:0;min-height:42px;padding:8px 14px;border-radius:0;box-sizing:border-box;border-color:var(--color-border-subtle)}
.file-title{font-size:13px;min-width:0;overflow-wrap:anywhere;flex-wrap:wrap}
.search-line-badge{font-size:11px;background:var(--color-primary-surface);color:var(--color-primary)}
.file-sidebar .code-feedback{flex-direction:column;align-items:start}
</style>
