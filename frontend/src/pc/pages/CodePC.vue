<template>
  <div class="code">
    <!-- 列表视图 -->
    <div v-if="!currentRepo">
      <div class="page-header">
        <p>管理 Git 和 SVN 代码仓库</p>
      </div>

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
          <NativeButton theme="primary" @click="showAddDialog" :disabled="isGuest">
            <template #icon><NativeIcon name="plus" /></template>
            添加仓库
          </NativeButton>
        </NativeSpace>
      </NativeCard>

      <NativeCard style="margin-top: 16px; min-height: 200px;">
        <!-- 加载状态 -->
        <div v-if="loading" class="content-loading">
          <NativeLoading size="small" />
        </div>
        <template v-else>
          <NativeList v-if="repoList && repoList.length > 0" :split="true">
            <NativeListItem v-for="repo in repoList" :key="repo.id">
              <div class="repo-item">
                <div class="repo-info" @click="openRepo(repo)">
                  <div class="repo-name">
                    <NativeIcon :name="repo.type === 'svn' ? 'folder' : 'git'" />
                    {{ repo.name }}
                    <NativeTag v-if="isCloning(repo.id)" theme="warning" variant="light">克隆中 {{ cloneProgress(repo.id) }}%</NativeTag>
                    <NativeTag v-else-if="!repo.last_sync" theme="warning" variant="light">等待克隆</NativeTag>
                  </div>
                  <div class="repo-desc">{{ repo.description || '暂无描述' }}</div>
                  <div v-if="isCloning(repo.id)" class="clone-progress-bar">
                    <div class="clone-progress-fill" :style="{ width: cloneProgress(repo.id) + '%' }"></div>
                  </div>
                  <div class="repo-meta">
                    <span>{{ repo.type.toUpperCase() }}</span>
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
                <div class="repo-actions">
                  <NativeButton theme="default" size="small" @click.stop="editRepo(repo)" :disabled="isCloning(repo.id) || isSyncing(repo.id) || isGuest">
                    <template #icon><NativeIcon name="pencil" /></template>
                  </NativeButton>
                  <NativeButton theme="default" size="small" @click.stop="syncRepo(repo)" :disabled="isCloning(repo.id) || isSyncing(repo.id) || isGuest">
                    <template #icon><NativeIcon name="arrow-clockwise" /></template>
                  </NativeButton>
                  <NativePopconfirm content="确定删除吗？这将同时删除本地代码文件。" @confirm="deleteRepo(repo.id)">
                    <template #trigger>
                      <NativeButton theme="default" size="small" class="btn-delete" :disabled="isGuest">
                        <template #icon><NativeIcon name="trash" color="#e34d59" /></template>
                      </NativeButton>
                    </template>
                  </NativePopconfirm>
                </div>
              </div>
            </NativeListItem>
          </NativeList>
          <div v-else class="empty-wrapper">
            <NativeEmpty description="暂无代码仓库，请添加一个仓库" />
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
          <NativeIcon :name="currentRepo.type === 'svn' ? 'folder' : 'git'" />
          {{ currentRepo.name }}
        </div>
        <div class="browser-header-right">
          <NativeButton theme="default" size="small" @click="refreshRepo" v-if="!isGuest">
            <template #icon><NativeIcon name="arrow-clockwise" /></template>
            刷新
          </NativeButton>
          <NativePopconfirm content="确定删除吗？这将同时删除本地代码文件。" @confirm="deleteRepo(currentRepo.id)">
            <template #trigger>
              <NativeButton theme="default" size="small" class="btn-delete" :disabled="isGuest">
                <template #icon><NativeIcon name="trash" color="#e34d59" /></template>
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
          <div v-if="fileTreeLoading" class="sidebar-loading">
            <NativeLoading size="small" />
          </div>
          <div v-else-if="fileTree.length === 0" class="sidebar-empty">
            <NativeEmpty description="暂无文件" />
          </div>
          <NativeTree
            v-else
            :data="fileTree"
            :expand-all="false"
            key-field="path"
            label-field="name"
            children-field="children"
            :activable="true"
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
        <NativeContent class="content-area">
          <NativeTabs v-model="activeTab">
            <NativeTabPanel name="files" label="文件">
              <!-- 文件预览区域 -->
              <div class="file-preview-area">
                <!-- 文件头部：显示文件名和关闭按钮 -->
                <div v-if="currentFile" class="file-header">
                  <span class="file-title">
                    <NativeIcon :name="isMarkdownFile(currentFile.name) ? 'file-text' : 'file'" />
                    {{ currentFile.name }}
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
                <div class="file-content">
                  <!-- 加载中 -->
                  <div v-if="fileLoading || readmeLoading" class="file-loading">
                    <NativeLoading size="medium" />
                    <span class="loading-text">加载中...</span>
                  </div>
                  <!-- 当前选择的文件 -->
                  <template v-else-if="currentFile">
                    <!-- Markdown 文件预览 -->
                    <MdPreview
                      v-if="isMarkdownFile(currentFile.name)"
                      :modelValue="currentFile.content"
                      :theme="editorTheme"
                      :previewTheme="previewTheme"
                      :codeTheme="codeTheme"
                      class="markdown-preview"
                    />
                    <!-- 文本/代码文件预览（带语法高亮） -->
                    <pre v-else-if="currentFile.type === 'text'" class="code-content"><code :class="'language-' + getLanguageFromFilename(currentFile.name)" v-html="highlightedCode"></code></pre>
                    <!-- 二进制文件 -->
                    <div v-else class="binary-file">
                      <NativeIcon name="file" size="48" />
                      <p>二进制文件，无法预览</p>
                      <p class="file-size">大小: {{ formatSize(currentFile.size || 0) }}</p>
                    </div>
                  </template>
                  <!-- 默认显示 README -->
                  <template v-else>
                    <MdPreview
                      v-if="readmeContent"
                      :modelValue="readmeContent"
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
            <NativeTabPanel name="commits" label="提交历史">
              <div class="commits-panel">
                <NativeList v-if="commits.length > 0" :split="true">
                  <NativeListItem v-for="commit in commits" :key="commit.hash" class="commit-list-item" @click="showCommitDetail(commit)">
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
                <NativeEmpty v-else description="暂无提交历史" />
              </div>
            </NativeTabPanel>
          </NativeTabs>
        </NativeContent>
      </NativeLayout>
    </div>

    <!-- 添加仓库对话框 -->
    <NativeDialog v-model="addDialogVisible" title="添加代码仓库" @confirm="confirmAdd" :width="700">
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
        <NativeFormItem label="仓库类型">
          <NativeRadioGroup v-model="addForm.type">
            <NativeRadio value="git">Git</NativeRadio>
            <NativeRadio value="svn">SVN</NativeRadio>
          </NativeRadioGroup>
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea v-model="addForm.description" placeholder="仓库简介（可选）" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 编辑仓库对话框 -->
    <NativeDialog v-model="editDialogVisible" title="编辑代码仓库" @confirm="confirmEdit" :width="600">
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
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { usePermission } from '@/composables/usePermission'
import { 
  NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, 
  NativeCheckbox, NativeLoading, NativeEmpty, NativeIcon, NativeSpace, 
  NativeList, NativeListItem, NativeTag, NativePopconfirm, NativeLayout, 
  NativeAside, NativeContent, NativeTree, NativeTabs, NativeTabPanel, 
  NativeForm, NativeFormItem, NativeRadio, NativeRadioGroup, NativeTextarea 
} from '@/components/native'
import { useToast } from '@/composables/useToast'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import 'highlight.js/styles/github.css'

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

// 克隆状态管理
const cloneStatuses = ref(new Map())
const syncStatuses = ref(new Map())
let syncPollInterval = null

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

// 显示提交详情
async function showCommitDetail(commit) {
  if (!currentRepo.value) return
  
  commitDialogVisible.value = true
  commitLoading.value = true
  commitDetail.value = null
  
  try {
    const response = await api.code.getCommitDetail(currentRepo.value.id, commit.fullHash || commit.hash)
    commitDetail.value = response.data?.data
  } catch (error) {
    toast.error('获取提交详情失败')
    commitDialogVisible.value = false
  } finally {
    commitLoading.value = false
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
          loadRepos() // 刷新列表
        }
      }
    } catch (e) {
      console.error('获取克隆状态失败:', e)
    }
  }, 1000) // 每秒轮询一次
}

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
    return currentFile.value.content
  }
  try {
    return hljs.highlight(currentFile.value.content, { language: lang }).value
  } catch (e) {
    return currentFile.value.content
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
  loading.value = true
  console.log('[CodePC] 开始加载仓库列表')
  try {
    const response = await api.code.list({ keyword: searchKeyword.value })
    console.log('[CodePC] API 响应:', response)
    repoList.value = response.data?.data || []
    console.log('[CodePC] 仓库列表:', repoList.value)
  } catch (error) {
    console.error('[CodePC] 加载失败:', error)
    toast.error('加载仓库列表失败')
    repoList.value = []
  } finally {
    loading.value = false
    console.log('[CodePC] loading 状态:', loading.value)
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
    toast.success('仓库添加成功，正在后台克隆...')
    addDialogVisible.value = false
    
    // 开始轮询克隆进度
    if (response.data?.id) {
      startClonePolling(response.data.id)
    }
    
    loadRepos()
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
  }
}

// 删除仓库
async function deleteRepo(id) {
  try {
    await api.code.delete(id)
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
async function openRepo(repo) {
  console.log('[CodePC] 打开仓库:', repo.name, 'repoId:', repo.id)
  currentRepo.value = repo
  activeTab.value = 'files'
  currentFile.value = null
  
  // 重置数据
  fileTree.value = []
  commits.value = []
  readmeContent.value = ''
  
  // 并行加载数据
  try {
    await Promise.all([
      loadFileTree(),
      loadReadme(),
      loadCommits()
    ])
    console.log('[CodePC] 仓库数据加载完成')
  } catch (error) {
    console.error('[CodePC] 加载仓库数据失败:', error)
  }
}

// 关闭仓库浏览
function closeRepo() {
  currentRepo.value = null
  fileTree.value = []
  commits.value = []
  readmeContent.value = ''
  currentFile.value = null
}

// 加载树节点（用于异步加载）- NativeTree lazy load 回调
async function loadTreeNode(node) {
  if (!currentRepo.value) return []
  
  // node 是 TreeNode 实例，实际数据在 node.data 中
  const nodeData = node.data || node
  const targetPath = nodeData.path || ''
  
  console.log('异步加载树节点:', targetPath, 'nodeData:', nodeData)
  
  try {
    const response = await api.code.getTree(currentRepo.value.id, targetPath)
    const items = response.data.data || []
    console.log('加载到的子项:', items)
    
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
    console.error('加载树节点失败:', error)
    toast.error('加载失败')
    return []
  }
}

// 加载文件树（初始加载根目录）
async function loadFileTree() {
  if (!currentRepo.value) return
  fileTreeLoading.value = true
  try {
    console.log('[CodePC] 加载根目录')
    const response = await api.code.getTree(currentRepo.value.id, '')
    const items = response.data.data || []
    console.log('[CodePC] 根目录文件:', items)
    
    // 转换为树形结构
    fileTree.value = items.map(item => ({
      path: item.path,
      name: item.name,
      type: item.type,
      // 懒加载节点需要设置 children: true 表示可以展开
      children: item.type === 'directory' ? true : undefined,
      isLeaf: item.type === 'file'
    }))
    
    console.log('[CodePC] fileTree 已设置, 长度:', fileTree.value.length)
  } catch (error) {
    console.error('[CodePC] 加载文件树失败:', error)
    toast.error('加载文件树失败')
    fileTree.value = []
  } finally {
    fileTreeLoading.value = false
  }
}

// 树节点选择
async function onTreeSelect(keys, node) {
  if (!node) return
  
  console.log('树节点选择:', node)
  
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
async function loadFile(path) {
  if (!currentRepo.value) return
  fileLoading.value = true
  console.log('========== 开始加载文件 ==========', path)
  try {
    const response = await api.code.getFile(currentRepo.value.id, path)
    currentFile.value = response.data.data
    console.log('文件加载完成:', {
      name: currentFile.value?.name,
      type: currentFile.value?.type,
      contentLength: currentFile.value?.content?.length
    })
    
    // 等待 Vue DOM 更新完成后再重置滚动条
    await nextTick()
    console.log('nextTick 完成，准备重置滚动条')
    
    // 多次重置以确保生效（立即 + 延迟）
    console.log('--- 第一次重置滚动条 ---')
    resetScrollPosition('第一次')
    setTimeout(() => {
      console.log('--- 第二次重置滚动条（延迟100ms） ---')
      resetScrollPosition('第二次')
      
      // 如果是Markdown文件，绑定链接点击事件
      if (isMarkdownFile(path)) {
        setTimeout(() => {
          bindMarkdownLinks()
        }, 200)
      }
    }, 100)
  } catch (error) {
    console.error('加载文件失败:', error)
    toast.error('加载文件失败')
  } finally {
    fileLoading.value = false
  }
}

// 重置滚动位置
function resetScrollPosition(label = '') {
  console.log(`[${label}] 开始重置滚动位置`)
  
  // 重置外层 .file-content 容器
  const fileContentPanel = document.querySelector('.file-content')
  console.log(`[${label}] .file-content 容器:`, fileContentPanel ? '找到' : '未找到')
  if (fileContentPanel) {
    console.log(`[${label}] .file-content 当前滚动位置:`, {
      scrollTop: fileContentPanel.scrollTop,
      scrollLeft: fileContentPanel.scrollLeft,
      scrollHeight: fileContentPanel.scrollHeight,
      clientHeight: fileContentPanel.clientHeight
    })
    fileContentPanel.scrollTop = 0
    fileContentPanel.scrollLeft = 0
    console.log(`[${label}] .file-content 重置后滚动位置:`, {
      scrollTop: fileContentPanel.scrollTop,
      scrollLeft: fileContentPanel.scrollLeft
    })
  }
  
  // 重置 Markdown 预览容器
  const markdownPanel = document.querySelector('.markdown-preview')
  console.log(`[${label}] .markdown-preview 容器:`, markdownPanel ? '找到' : '未找到')
  if (markdownPanel) {
    console.log(`[${label}] .markdown-preview 当前滚动位置:`, {
      scrollTop: markdownPanel.scrollTop,
      scrollLeft: markdownPanel.scrollLeft,
      scrollHeight: markdownPanel.scrollHeight,
      clientHeight: markdownPanel.clientHeight
    })
    markdownPanel.scrollTop = 0
    markdownPanel.scrollLeft = 0
    console.log(`[${label}] .markdown-preview 重置后滚动位置:`, {
      scrollTop: markdownPanel.scrollTop,
      scrollLeft: markdownPanel.scrollLeft
    })
    
    // 尝试找到 MdPreview 内部的滚动容器
    const innerScroll = markdownPanel.querySelector('.md-preview-wrapper')
    console.log(`[${label}] .md-preview-wrapper 容器:`, innerScroll ? '找到' : '未找到')
    if (innerScroll) {
      console.log(`[${label}] .md-preview-wrapper 当前滚动位置:`, {
        scrollTop: innerScroll.scrollTop,
        scrollLeft: innerScroll.scrollLeft
      })
      innerScroll.scrollTop = 0
      innerScroll.scrollLeft = 0
    }
  }
  
  // 重置代码预览容器
  const codePanel = document.querySelector('.code-content')
  console.log(`[${label}] .code-content 容器:`, codePanel ? '找到' : '未找到')
  if (codePanel) {
    console.log(`[${label}] .code-content 当前滚动位置:`, {
      scrollTop: codePanel.scrollTop,
      scrollLeft: codePanel.scrollLeft,
      scrollHeight: codePanel.scrollHeight,
      clientHeight: codePanel.clientHeight
    })
    codePanel.scrollTop = 0
    codePanel.scrollLeft = 0
    console.log(`[${label}] .code-content 重置后滚动位置:`, {
      scrollTop: codePanel.scrollTop,
      scrollLeft: codePanel.scrollLeft
    })
  }
  
  // 重置 content-area 容器（可能是真正的滚动容器）
  const contentArea = document.querySelector('.content-area')
  console.log(`[${label}] .content-area 容器:`, contentArea ? '找到' : '未找到')
  if (contentArea) {
    console.log(`[${label}] .content-area 当前滚动位置:`, {
      scrollTop: contentArea.scrollTop,
      scrollLeft: contentArea.scrollLeft,
      scrollHeight: contentArea.scrollHeight,
      clientHeight: contentArea.clientHeight
    })
    contentArea.scrollTop = 0
    contentArea.scrollLeft = 0
    console.log(`[${label}] .content-area 重置后滚动位置:`, {
      scrollTop: contentArea.scrollTop,
      scrollLeft: contentArea.scrollLeft
    })
  }
  
  console.log(`[${label}] 滚动位置重置完成`)
}

// 绑定Markdown链接点击事件，阻止默认跳转，改为新标签页打开
function bindMarkdownLinks() {
  const previewPanel = document.querySelector('.markdown-preview')
  if (!previewPanel) return
  
  const links = previewPanel.querySelectorAll('a')
  links.forEach(link => {
    // 跳过已处理的链接
    if (link.dataset.linkBound) return
    link.dataset.linkBound = 'true'
    
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href')
      if (!href) return
      
      // 如果是外部链接（http/https），在新标签页打开
      if (href.startsWith('http://') || href.startsWith('https://')) {
        e.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
      }
      // 如果是内部锚点链接（#开头），滚动到对应锚点
      else if (href.startsWith('#')) {
        e.preventDefault()
        // URL解码锚点ID（处理中文锚点）
        const anchorId = decodeURIComponent(href.substring(1))
        console.log('点击锚点:', anchorId)
        
        // 首先尝试通过 id 查找
        let anchorElement = previewPanel.querySelector(`[id="${anchorId}"]`)
        
        // 如果没找到，尝试通过 name 查找
        if (!anchorElement) {
          anchorElement = previewPanel.querySelector(`[name="${anchorId}"]`)
        }
        
        // 还是没找到，尝试查找标题元素并匹配生成的 ID
        if (!anchorElement) {
          const headings = previewPanel.querySelectorAll('h1, h2, h3, h4, h5, h6')
          for (const heading of headings) {
            const headingText = heading.textContent.trim()
            // 计算标题应该生成的 ID（与 marked 渲染器一致）
            const expectedId = headingText.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
            if (heading.id === anchorId || 
                expectedId === anchorId ||
                headingText.toLowerCase().replace(/\s+/g, '-') === anchorId.toLowerCase()) {
              anchorElement = heading
              break
            }
          }
        }
        
        if (anchorElement) {
          console.log('找到锚点元素:', anchorElement)
          anchorElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
        } else {
          console.log('未找到锚点元素:', anchorId)
        }
      }
      // 如果是其他相对链接（如 ./xxx.md），阻止默认行为并提示
      else {
        e.preventDefault()
        toast.info('内部文档链接暂不支持跳转')
      }
    })
  })
}

// 关闭文件预览
function closeFile() {
  currentFile.value = null
}

// 加载 README
async function loadReadme() {
  if (!currentRepo.value) return
  readmeLoading.value = true
  console.log('[CodePC] 开始加载 README, repoId:', currentRepo.value.id)
  try {
    const response = await api.code.getReadme(currentRepo.value.id)
    console.log('[CodePC] README 响应:', response.data)
    readmeContent.value = response.data.data?.content || ''
    console.log('[CodePC] readmeContent 已设置:', readmeContent.value ? '有内容' : '空')
  } catch (error) {
    console.error('[CodePC] 加载 README 失败:', error)
    readmeContent.value = ''
  } finally {
    readmeLoading.value = false
  }
}

// 加载提交历史
async function loadCommits() {
  if (!currentRepo.value) return
  console.log('[CodePC] 开始加载提交历史, repoId:', currentRepo.value.id)
  try {
    const response = await api.code.getCommits(currentRepo.value.id, 20)
    console.log('[CodePC] 提交历史响应:', response.data)
    commits.value = response.data.data || []
    console.log('[CodePC] commits 已设置, 数量:', commits.value.length)
  } catch (error) {
    console.error('[CodePC] 加载提交历史失败:', error)
    commits.value = []
  }
}

// 刷新仓库
async function refreshRepo() {
  await Promise.all([
    loadFileTree(),
    loadReadme(),
    loadCommits()
  ])
  toast.success('刷新成功')
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}

onMounted(() => loadRepos())
</script>

<style scoped>
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
  color: #333;
  margin: 0;
  font-weight: 500;
}

.repo-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px;
  gap: 24px;
  width: 100%;
}

.repo-info {
  flex: 1;
  cursor: pointer;
  min-width: 0;
}

.repo-info:hover .repo-name {
  color: #0052d9;
}

.repo-name {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding-left: 0;
}

.repo-desc {
  font-size: 14px;
  color: #666;
  margin-bottom: 6px;
  padding-left: 24px;
  line-height: 1.5;
}

.repo-meta {
  font-size: 12px;
  color: #999;
  display: flex;
  gap: 16px;
  padding-left: 24px;
}

.repo-stats {
  font-size: 12px;
  color: #666;
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
  background: #e8f4ff;
  border-radius: 4px;
  color: #0052d9;
  font-size: 11px;
}

.clone-progress-bar {
  width: 200px;
  height: 4px;
  background: #f0f0f0;
  border-radius: 2px;
  margin: 6px 0;
  overflow: hidden;
}

.clone-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #0052d9, #00a8ff);
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
  background: #fff;
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
  background: #fff;
  border-radius: 8px;
  height: calc(100% - 60px);
  overflow: hidden;
  display: flex;
}

.file-sidebar {
  width: 280px;
  min-width: 280px;  /* 防止被挤压 */
  border-right: 1px solid #e7e7e7;
  overflow-y: auto;
  flex-shrink: 0;  /* 不允许收缩 */
}

.sidebar-header {
  padding: 12px 16px;
  font-weight: 600;
  border-bottom: 1px solid #e7e7e7;
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
  border-bottom: 1px solid #e7e7e7;
  padding-bottom: 0.3em;
}

.markdown-content :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid #e7e7e7;
  padding-bottom: 0.3em;
}

.markdown-content :deep(h3) {
  font-size: 1.25em;
}

.markdown-content :deep(p) {
  margin-bottom: 16px;
}

.markdown-content :deep(code) {
  background: #f5f5f5;
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: monospace;
}

.markdown-content :deep(pre) {
  background: #f5f5f5;
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
  color: #0052d9;
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
  border: 1px solid #ddd;
  padding: 8px 12px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: #f5f5f5;
  font-weight: 600;
}

.markdown-content :deep(tr:nth-child(even)) {
  background: #fafafa;
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid #ddd;
  padding-left: 16px;
  margin-left: 0;
  color: #666;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid #e7e7e7;
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
  color: #0052d9;
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
  background: #f5f5f5;
  border-radius: 6px 6px 0 0;
  border-bottom: 1px solid #e7e7e7;
}

.file-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  font-size: 14px;
  color: #333;
}

.file-content {
  flex: 1;
  overflow: auto;
  padding: 0;
  background: #fff;
  border-radius: 0 0 6px 6px;
}

.file-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #666;
  gap: 12px;
}

.file-loading .loading-text {
  font-size: 14px;
  color: #999;
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
  color: #333;
}

:deep(.markdown-preview) :deep(h1) {
  font-size: 2em;
  border-bottom: 1px solid #e7e7e7;
  padding-bottom: 0.3em;
}

:deep(.markdown-preview) :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid #e7e7e7;
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
  background: #f5f5f5;
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 85%;
}

:deep(.markdown-preview) :deep(pre) {
  background: #f6f8fa;
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
  color: #0052d9;
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
  border: 1px solid #ddd;
  padding: 8px 12px;
  text-align: left;
}

:deep(.markdown-preview) :deep(th) {
  background: #f5f5f5;
  font-weight: 600;
}

:deep(.markdown-preview) :deep(tr:nth-child(even)) {
  background: #fafafa;
}

:deep(.markdown-preview) :deep(blockquote) {
  border-left: 4px solid #ddd;
  padding-left: 16px;
  margin-left: 0;
  color: #666;
  margin-bottom: 16px;
}

:deep(.markdown-preview) :deep(hr) {
  border: none;
  border-top: 1px solid #e7e7e7;
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
  color: #666;
}

.binary-file p {
  margin: 8px 0;
}

.binary-file .file-size {
  font-size: 12px;
  color: #999;
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
  background: #f5f5f5;
}

.commit-item {
  padding: 12px 8px 12px 16px;
}

.commit-hash {
  font-family: monospace;
  font-size: 12px;
  color: #0052d9;
  background: #e8f4ff;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.commit-message {
  font-size: 14px;
  color: #333;
  margin-bottom: 8px;
  font-weight: 500;
}

.commit-meta {
  font-size: 12px;
  color: #999;
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
  background: #f5f5f5;
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
  color: #666;
}

.commit-info-row .value {
  color: #333;
  font-family: monospace;
}

.changed-files {
  margin-top: 12px;
}

.changed-files .label {
  font-weight: 500;
  color: #666;
  display: block;
  margin-bottom: 8px;
}

.file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.file-item {
  background: #e8f4ff;
  color: #0052d9;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}

/* Diff 显示样式 */
.diff-container {
  background: #f6f8fa;
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
  color: #999;
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
  background: #e8f4ff;
  color: #0052d9;
}

.diff-line.info {
  background: #f0f0f0;
  color: #666;
}

.diff-line.removed {
  background: #ffe6e6;
}

.diff-line.removed .line-prefix {
  color: #d32f2f;
}

.diff-line.added {
  background: #e6f7e6;
}

.diff-line.added .line-prefix {
  color: #388e3c;
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
  background-color: #fff !important;
  border-color: #e34d59 !important;
  color: #e34d59 !important;
}

.btn-delete :deep(.native-icon) {
  color: #e34d59 !important;
}
</style>
