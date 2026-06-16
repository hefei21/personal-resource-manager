<template>
  <div class="code-mobile">
    <!-- 列表视图 -->
    <div v-if="!currentRepo" class="list-view">
      <div class="page-header">
        <h2>代码仓库</h2>
      </div>

      <div class="search-bar">
        <NativeInput
          v-model="searchKeyword"
          placeholder="搜索代码仓库..."
          clearable
          @enter="loadRepos"
        >
          <template #prefix-icon>
            <NativeIcon name="magnifying-glass" />
          </template>
        </NativeInput>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="content-loading">
        <NativeLoading size="small" />
      </div>

      <!-- 仓库列表 -->
      <div v-else-if="repoList.length > 0" class="repo-list">
        <div
          v-for="repo in repoList"
          :key="repo.id"
          class="repo-card"
          @click="openRepo(repo)"
        >
          <div class="repo-header">
            <div class="repo-name">
              <NativeIcon :name="repo.type === 'svn' ? 'folder' : 'git'" size="18" />
              <span class="name-text">{{ repo.name }}</span>
              <NativeTag v-if="isCloning(repo.id)" theme="warning" size="small">
                克隆中 {{ cloneProgress(repo.id) }}%
              </NativeTag>
              <NativeTag v-else-if="isSyncing(repo.id)" theme="primary" size="small">
                同步中
              </NativeTag>
              <NativeTag v-else-if="!repo.last_sync" theme="warning" size="small">
                等待克隆
              </NativeTag>
            </div>
            <div class="repo-actions" @click.stop>
              <NativeButton theme="default" size="small" variant="text" @click.stop="editRepo(repo)">
                <NativeIcon name="pencil" size="16" />
              </NativeButton>
              <NativeButton theme="default" size="small" variant="text" @click.stop="syncRepo(repo)" :disabled="isCloning(repo.id) || isSyncing(repo.id)">
                <NativeIcon name="arrow-clockwise" size="16" />
              </NativeButton>
              <NativeButton theme="default" size="small" variant="text" class="btn-delete" @click.stop="confirmDelete(repo)">
                <NativeIcon name="trash" size="16" color="#e34d59" />
              </NativeButton>
            </div>
          </div>
          
          <div class="repo-desc">{{ repo.description || '暂无描述' }}</div>
          
          <div v-if="isCloning(repo.id)" class="clone-progress-bar">
            <div class="clone-progress-fill" :style="{ width: cloneProgress(repo.id) + '%' }"></div>
          </div>
          
          <div class="repo-meta">
            <span class="repo-type">{{ repo.type.toUpperCase() }}</span>
            <span v-if="repo.last_sync">同步: {{ formatDate(repo.last_sync) }}</span>
          </div>
          
          <div v-if="repo.languages && repo.languages.length > 0" class="repo-langs">
            <span v-for="(lang, idx) in repo.languages.slice(0, 3)" :key="idx" class="lang-tag">
              {{ lang.name }}
            </span>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <NativeIcon name="git" size="48" color="#ccc" />
        <p>暂无代码仓库</p>
        <span class="empty-tip">点击右上角添加仓库</span>
      </div>

      <!-- 添加按钮 -->
      <button v-if="!isGuest" class="fab-add" @click="showAddDialog">
        <NativeIcon name="plus" size="24" color="#fff" />
      </button>
    </div>

    <!-- 仓库详情视图 -->
    <div v-else class="repo-detail">
      <div class="detail-header">
        <button class="back-btn" @click="closeRepo">
          <NativeIcon name="arrow-left" size="20" />
        </button>
        <div class="detail-title">{{ currentRepo.name }}</div>
        <button class="action-btn" @click="refreshRepo">
          <NativeIcon name="arrow-clockwise" size="18" />
        </button>
      </div>

      <div class="detail-tabs">
        <div
          v-for="tab in tabs"
          :key="tab.value"
          class="tab-item"
          :class="{ active: activeTab === tab.value }"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </div>
      </div>

      <!-- README 内容 -->
      <div v-if="activeTab === 'readme'" class="detail-content">
        <div v-if="readmeLoading" class="content-loading">
          <NativeLoading size="small" />
        </div>
        <MdPreview
          v-else-if="readmeContent"
          :modelValue="readmeContent"
          :theme="editorTheme"
          :previewTheme="previewTheme"
          :codeTheme="codeTheme"
          class="markdown-preview"
        />
        <div v-else class="empty-content">
          <NativeIcon name="file-text" size="48" color="#ccc" />
          <p>暂无 README 文件</p>
        </div>
      </div>

      <!-- 文件列表 -->
      <div v-else-if="activeTab === 'files'" class="detail-content">
        <!-- 路径导航 -->
        <div class="path-nav">
          <button v-if="pathStack.length > 0" class="path-back" @click="goBack">
            <NativeIcon name="arrow-left" size="16" />
            返回上级
          </button>
          <span v-else class="path-current">{{ currentPath || '根目录' }}</span>
        </div>
        <!-- 加载中 -->
        <div v-if="fileLoading" class="content-loading">
          <NativeLoading size="small" />
        </div>
        <!-- 文件列表 -->
        <div v-else-if="fileList.length > 0" class="file-list">
          <div
            v-for="file in fileList"
            :key="file.path"
            class="file-item"
            :class="{ 'is-directory': file.type === 'directory' }"
            @click="onFileClick(file)"
          >
            <NativeIcon :name="file.type === 'directory' ? 'folder' : 'file'" size="18" />
            <span class="file-name">{{ file.name }}</span>
            <NativeIcon v-if="file.type === 'directory'" name="chevron-right" size="16" color="#999" />
          </div>
        </div>
        <div v-else class="empty-content">
          <NativeIcon name="folder" size="48" color="#ccc" />
          <p>暂无文件</p>
        </div>
      </div>

      <!-- 提交历史 -->
      <div v-else-if="activeTab === 'commits'" class="detail-content">
        <div v-if="commitsLoading" class="content-loading">
          <NativeLoading size="small" />
        </div>
        <div v-else-if="commits.length > 0" class="commit-list">
          <div
            v-for="commit in commits"
            :key="commit.hash"
            class="commit-item"
          >
            <div class="commit-hash">{{ commit.hash }}</div>
            <div class="commit-message">{{ commit.message }}</div>
            <div class="commit-meta">
              <span>{{ commit.author }}</span>
              <span>{{ commit.date }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty-content">
          <NativeIcon name="git-commit" size="48" color="#ccc" />
          <p>暂无提交历史</p>
        </div>
      </div>
    </div>

    <!-- 添加仓库对话框 -->
    <NativeDialog v-model="addDialogVisible" title="添加代码仓库" @confirm="confirmAdd">
      <NativeForm>
        <NativeFormItem label="仓库URL">
          <div class="url-input-row">
            <NativeInput v-model="addForm.url" placeholder="https://github.com/xxx/xxx.git" />
            <NativeButton
              theme="default"
              size="small"
              @click="fetchGithubInfo"
              :loading="fetchingInfo"
              :disabled="!isGithubUrl(addForm.url)"
            >
              获取信息
            </NativeButton>
          </div>
        </NativeFormItem>
        <NativeFormItem label="仓库名称">
          <NativeInput v-model="addForm.name" placeholder="给仓库起个名字" />
        </NativeFormItem>
        <NativeFormItem label="仓库类型">
          <NativeRadioGroup v-model="addForm.type">
            <NativeRadio value="git">Git</NativeRadio>
            <NativeRadio value="svn">SVN</NativeRadio>
          </NativeRadioGroup>
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea v-model="addForm.description" placeholder="仓库简介（可选）" :rows="3" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 编辑仓库对话框 -->
    <NativeDialog v-model="editDialogVisible" title="编辑代码仓库" @confirm="confirmEdit">
      <NativeForm>
        <NativeFormItem label="仓库名称">
          <NativeInput v-model="editForm.name" placeholder="仓库名称" />
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea v-model="editForm.description" placeholder="仓库简介" :rows="3" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 删除确认对话框 -->
    <NativeDialog v-model="deleteDialogVisible" title="确认删除" :show-footer="false">
      <div class="delete-confirm">
        <p>确定删除仓库 "{{ deleteTarget?.name }}" 吗？</p>
        <p class="delete-warning">这将同时删除本地代码文件，此操作不可恢复。</p>
        <div class="delete-actions">
          <NativeButton theme="default" @click="deleteDialogVisible = false">取消</NativeButton>
          <NativeButton theme="danger" @click="doDelete">删除</NativeButton>
        </div>
      </div>
    </NativeDialog>

    <!-- 文件预览弹窗 -->
    <NativeDialog v-model="filePreviewVisible" :title="currentFile?.name || '文件预览'" :show-footer="false" width="95%">
      <div class="file-preview-dialog">
        <!-- 加载中 -->
        <div v-if="fileLoading" class="preview-loading">
          <NativeLoading size="medium" />
          <span>加载中...</span>
        </div>
        <!-- Markdown 文件 -->
        <MdPreview
          v-else-if="isMarkdownFile(currentFile?.name)"
          :modelValue="currentFileContent"
          :theme="editorTheme"
          :previewTheme="previewTheme"
          :codeTheme="codeTheme"
          class="markdown-preview"
        />
        <!-- 文本文件 -->
        <pre v-else-if="currentFile?.type === 'text'" class="text-preview"><code>{{ currentFileContent }}</code></pre>
        <!-- 二进制文件 -->
        <div v-else class="binary-preview">
          <NativeIcon name="file" size="64" color="#ccc" />
          <p>二进制文件，无法预览</p>
          <p class="file-size" v-if="currentFile?.size">大小: {{ formatSize(currentFile.size) }}</p>
        </div>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { 
  NativeButton, NativeInput, NativeDialog, NativeLoading, 
  NativeIcon, NativeTag, NativeForm, NativeFormItem,
  NativeRadio, NativeRadioGroup, NativeTextarea 
} from '@/components/native'
import { useToast } from '@/composables/useToast'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

const toast = useToast()
const { isGuest } = usePermission()

// Markdown预览主题配置
const editorTheme = ref('light')
const previewTheme = ref('default')
const codeTheme = ref('atom')

const repoList = ref([])
const searchKeyword = ref('')
const loading = ref(false)
const addDialogVisible = ref(false)
const editDialogVisible = ref(false)
const deleteDialogVisible = ref(false)
const deleteTarget = ref(null)

// 克隆状态管理
const cloneStatuses = ref(new Map())
const syncStatuses = ref(new Map())

// 当前浏览的仓库
const currentRepo = ref(null)
const fileList = ref([])
const commits = ref([])
const readmeContent = ref('')
const readmeLoading = ref(false)
const commitsLoading = ref(false)
const activeTab = ref('readme')

// 目录浏览状态
const currentPath = ref('')
const pathStack = ref([])  // 路径历史栈，用于返回上级
const fileLoading = ref(false)

// 文件预览状态
const filePreviewVisible = ref(false)
const currentFile = ref(null)
const currentFileContent = ref('')

const tabs = [
  { value: 'readme', label: 'README' },
  { value: 'files', label: '文件' },
  { value: 'commits', label: '提交' }
]

const addForm = ref({
  name: '',
  url: '',
  type: 'git',
  description: ''
})

const fetchingInfo = ref(false)

const editForm = ref({
  id: null,
  name: '',
  url: '',
  description: ''
})

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

// 轮询克隆状态
let clonePollInterval = null
function startClonePolling(repoId) {
  cloneStatuses.value.set(String(repoId), { status: 'cloning', progress: 0, message: '准备中...' })
  
  if (clonePollInterval) {
    clearInterval(clonePollInterval)
  }
  
  clonePollInterval = setInterval(async () => {
    try {
      const response = await api.code.getCloneStatus(repoId)
      const data = response.data?.data
      
      if (data) {
        cloneStatuses.value.set(String(repoId), data)
        
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(clonePollInterval)
          clonePollInterval = null
          loadRepos()
        }
      }
    } catch (e) {
      console.error('获取克隆状态失败:', e)
    }
  }, 1000)
}

// 加载仓库列表
async function loadRepos() {
  loading.value = true
  try {
    const response = await api.code.list({ keyword: searchKeyword.value })
    repoList.value = response.data.data || []
  } catch (error) {
    toast.error('加载仓库列表失败')
  } finally {
    loading.value = false
  }
}

// 显示添加对话框
function showAddDialog() {
  addForm.value = { name: '', url: '', type: 'git', description: '' }
  addDialogVisible.value = true
}

// 确认添加
async function confirmAdd() {
  if (!addForm.value.name || !addForm.value.url) {
    toast.warning('请填写完整信息')
    return
  }
  try {
    const response = await api.code.create(addForm.value)
    toast.success('仓库添加成功')
    addDialogVisible.value = false
    
    if (response.data?.id) {
      startClonePolling(response.data.id)
    }
    
    loadRepos()
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
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

// 确认编辑
async function confirmEdit() {
  if (!editForm.value.name) {
    toast.warning('请输入仓库名称')
    return
  }
  
  try {
    await api.code.update(editForm.value.id, {
      name: editForm.value.name,
      description: editForm.value.description
    })
    toast.success('更新成功')
    editDialogVisible.value = false
    loadRepos()
  } catch (error) {
    toast.error(error.response?.data?.message || '更新失败')
  }
}

// 确认删除
function confirmDelete(repo) {
  deleteTarget.value = repo
  deleteDialogVisible.value = true
}

// 执行删除
async function doDelete() {
  if (!deleteTarget.value) return
  
  try {
    await api.code.delete(deleteTarget.value.id)
    toast.success('删除成功')
    deleteDialogVisible.value = false
    deleteTarget.value = null
    loadRepos()
  } catch (error) {
    toast.error('删除失败')
  }
}

// 检查是否正在同步
function isSyncing(repoId) {
  const status = syncStatuses.value.get(String(repoId))
  return status && status.status === 'syncing'
}

// 获取同步进度
function syncProgress(repoId) {
  const status = syncStatuses.value.get(String(repoId))
  return status ? status.progress : 0
}

// 轮询同步状态
let syncPollInterval = null
function startSyncPolling(repoId, taskId) {
  syncStatuses.value.set(String(repoId), { status: 'syncing', progress: 0, message: '准备中...' })

  if (syncPollInterval) {
    clearInterval(syncPollInterval)
  }

  syncPollInterval = setInterval(async () => {
    try {
      const response = await api.code.getSyncStatus(repoId)
      const data = response.data?.data

      if (data) {
        syncStatuses.value.set(String(repoId), data)

        if (data.status === 'completed') {
          clearInterval(syncPollInterval)
          syncPollInterval = null
          toast.success('同步成功')
          loadRepos() // 刷新列表
        } else if (data.status === 'failed') {
          clearInterval(syncPollInterval)
          syncPollInterval = null
          toast.error(data.message || '同步失败')
        }
      }
    } catch (e) {
      console.error('获取同步状态失败:', e)
    }
  }, 1000) // 每秒轮询一次
}

// 同步仓库
async function syncRepo(repo) {
  try {
    const response = await api.code.sync(repo.id)
    toast.success('开始同步仓库...')
    
    // 立即刷新列表显示同步状态
    loadRepos()
    
    // 开始轮询同步进度
    if (response.data?.taskId) {
      startSyncPolling(repo.id, response.data.taskId)
    }
  } catch (error) {
    toast.error('同步失败')
  }
}

// 打开仓库
async function openRepo(repo) {
  currentRepo.value = repo
  activeTab.value = 'readme'
  fileList.value = []
  commits.value = []
  readmeContent.value = ''
  currentPath.value = ''
  pathStack.value = []
  
  // 并行加载数据
  Promise.all([
    loadFileList(),
    loadReadme(),
    loadCommits()
  ])
}

// 关闭仓库
function closeRepo() {
  currentRepo.value = null
}

// 加载文件列表
async function loadFileList(path = '') {
  if (!currentRepo.value) return
  fileLoading.value = true
  try {
    const response = await api.code.getTree(currentRepo.value.id, path)
    fileList.value = response.data.data || []
  } catch (error) {
    console.error('加载文件列表失败:', error)
    fileList.value = []
  } finally {
    fileLoading.value = false
  }
}

// 判断是否为 Markdown 文件
function isMarkdownFile(filename) {
  if (!filename) return false
  return filename.toLowerCase().endsWith('.md') || filename.toLowerCase().endsWith('.markdown')
}

// 格式化文件大小
function formatSize(size) {
  if (size === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(size) / Math.log(1024))
  return (size / Math.pow(1024, index)).toFixed(2) + ' ' + units[index]
}

// 检查是否为 GitHub URL
function isGithubUrl(url) {
  return url && url.includes('github.com')
}

// 从 GitHub 获取仓库信息
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
        addForm.value.description = data.description || ''
      }
      toast.success('获取GitHub信息成功')
    }
  } catch (error) {
    toast.error(error.response?.data?.message || '获取GitHub信息失败')
  } finally {
    fetchingInfo.value = false
  }
}

// 加载 README
async function loadReadme() {
  if (!currentRepo.value) return
  readmeLoading.value = true
  try {
    const response = await api.code.getReadme(currentRepo.value.id)
    readmeContent.value = response.data.data?.content || ''
  } catch (error) {
    readmeContent.value = ''
  } finally {
    readmeLoading.value = false
  }
}

// 加载提交历史
async function loadCommits() {
  if (!currentRepo.value) return
  commitsLoading.value = true
  try {
    const response = await api.code.getCommits(currentRepo.value.id, 20)
    commits.value = response.data.data || []
  } catch (error) {
    commits.value = []
  } finally {
    commitsLoading.value = false
  }
}

// 刷新仓库
async function refreshRepo() {
  if (activeTab.value === 'files') {
    await loadFileList(currentPath.value)
  } else if (activeTab.value === 'readme') {
    await loadReadme()
  } else if (activeTab.value === 'commits') {
    await loadCommits()
  }
  toast.success('刷新成功')
}

// 文件点击
async function onFileClick(file) {
  if (file.type === 'directory') {
    // 进入子目录
    pathStack.value.push(currentPath.value)
    currentPath.value = file.path
    await loadFileList(file.path)
  } else {
    // 预览文件
    await previewFile(file)
  }
}

// 返回上级目录
async function goBack() {
  if (pathStack.value.length > 0) {
    currentPath.value = pathStack.value.pop()
    await loadFileList(currentPath.value)
  }
}

// 预览文件
async function previewFile(file) {
  if (!currentRepo.value) return
  currentFile.value = file
  filePreviewVisible.value = true
  fileLoading.value = true
  currentFileContent.value = ''
  
  try {
    const response = await api.code.getFile(currentRepo.value.id, file.path)
    const fileData = response.data.data
    currentFile.value = { ...file, ...fileData }
    currentFileContent.value = fileData.content || ''
  } catch (error) {
    console.error('加载文件失败:', error)
    toast.error('加载文件失败')
  } finally {
    fileLoading.value = false
  }
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}

onMounted(() => loadRepos())

// 组件卸载时清理定时器
onUnmounted(() => {
  if (clonePollInterval) {
    clearInterval(clonePollInterval)
  }
  if (syncPollInterval) {
    clearInterval(syncPollInterval)
  }
})
</script>

<style scoped>
.code-mobile {
  min-height: 100vh;
  background: #f5f5f5;
}

.list-view {
  padding: 16px;
}

.page-header {
  margin-bottom: 16px;
}

.page-header h2 {
  margin: 0 0 4px 0;
  font-size: 20px;
  color: #333;
}

.page-header .subtitle {
  margin: 0;
  font-size: 13px;
  color: #999;
}

.search-bar {
  margin-bottom: 16px;
}

.content-loading {
  display: flex;
  justify-content: center;
  padding: 48px;
}

.repo-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.repo-card {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.repo-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.repo-name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.name-text {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.repo-desc {
  font-size: 13px;
  color: #666;
  margin-bottom: 8px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.clone-progress-bar {
  width: 100%;
  height: 4px;
  background: #f0f0f0;
  border-radius: 2px;
  margin: 8px 0;
  overflow: hidden;
}

.clone-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #0052d9, #00a8ff);
  border-radius: 2px;
  transition: width 0.3s;
}

.repo-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #999;
  margin-bottom: 8px;
}

.repo-type {
  background: #e8f4ff;
  color: #0052d9;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.repo-langs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.lang-tag {
  background: #f0f0f0;
  color: #666;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 16px;
  color: #999;
}

.empty-state p {
  margin: 16px 0 4px 0;
  font-size: 16px;
}

.empty-tip {
  font-size: 13px;
  color: #bbb;
}

.fab-add {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #0052d9;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 82, 217, 0.4);
  z-index: 100;
}

/* 仓库详情视图 */
.repo-detail {
  min-height: 100vh;
  background: #fff;
}

.detail-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: #fff;
  border-bottom: 1px solid #eee;
  position: sticky;
  top: 0;
  z-index: 10;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 8px;
}

.detail-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.detail-tabs {
  display: flex;
  background: #fff;
  border-bottom: 1px solid #eee;
}

.tab-item {
  flex: 1;
  text-align: center;
  padding: 12px;
  font-size: 14px;
  color: #666;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.tab-item.active {
  color: #0052d9;
  border-bottom-color: #0052d9;
  font-weight: 500;
}

.detail-content {
  padding: 16px;
  min-height: calc(100vh - 110px);
}

.file-list {
  display: flex;
  flex-direction: column;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.file-name {
  flex: 1;
  font-size: 14px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-list {
  display: flex;
  flex-direction: column;
}

.commit-item {
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.commit-hash {
  font-family: monospace;
  font-size: 12px;
  color: #0052d9;
  background: #e8f4ff;
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  margin-bottom: 6px;
}

.commit-message {
  font-size: 14px;
  color: #333;
  margin-bottom: 6px;
  line-height: 1.4;
}

.commit-meta {
  font-size: 12px;
  color: #999;
  display: flex;
  gap: 12px;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 16px;
  color: #999;
}

.empty-content p {
  margin: 16px 0 0 0;
}

.delete-confirm {
  text-align: center;
  padding: 16px;
}

.delete-confirm p {
  margin: 0 0 8px 0;
  font-size: 15px;
}

.delete-warning {
  color: #d32f2f;
  font-size: 13px;
}

.delete-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 24px;
}

/* URL 输入行 */
.url-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.url-input-row .native-input {
  flex: 1;
}

/* 路径导航 */
.path-nav {
  display: flex;
  align-items: center;
  padding: 8px 0 16px 0;
  border-bottom: 1px solid #f0f0f0;
  margin-bottom: 8px;
}

.path-back {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: #0052d9;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}

.path-back:active {
  background: #f0f0f0;
}

.path-current {
  font-size: 14px;
  color: #666;
}

/* 文件列表项 */
.file-item.is-directory {
  background: #fafafa;
}

.file-item:active {
  background: #f0f0f0;
}

/* 文件预览弹窗 */
.file-preview-dialog {
  max-height: 70vh;
  overflow: auto;
}

.preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #666;
  gap: 12px;
}

.text-preview {
  background: #f8f9fa;
  padding: 16px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  color: #333;
  white-space: pre-wrap;
  word-break: break-word;
}

.binary-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #666;
  gap: 12px;
}

.binary-preview .file-size {
  font-size: 13px;
  color: #999;
}
</style>
