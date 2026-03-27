<template>
  <div class="code">
    <!-- 列表视图 -->
    <div v-if="!currentRepo">
      <div class="page-header">
        <p>管理 Git 和 SVN 代码仓库</p>
      </div>

      <t-card class="toolbar">
        <t-space>
          <t-input
            v-model="searchKeyword"
            placeholder="搜索代码仓库..."
            style="width: 300px"
            @enter="loadRepos"
          >
            <template #suffix-icon>
              <t-icon name="search" />
            </template>
          </t-input>
          <t-button theme="primary" @click="showAddDialog">
            <template #icon><t-icon name="add" /></template>
            添加仓库
          </t-button>
        </t-space>
      </t-card>

      <t-card style="margin-top: 16px">
        <t-list v-if="repoList.length > 0" :split="true">
          <t-list-item v-for="repo in repoList" :key="repo.id">
            <div class="repo-item">
              <div class="repo-info" @click="openRepo(repo)">
                <div class="repo-name">
                  <t-icon :name="repo.type === 'svn' ? 'folder' : 'git'" />
                  {{ repo.name }}
                  <t-tag v-if="isCloning(repo.id)" theme="warning" variant="light">克隆中 {{ cloneProgress(repo.id) }}%</t-tag>
                  <t-tag v-else-if="!repo.last_sync" theme="warning" variant="light">等待克隆</t-tag>
                </div>
                <div class="repo-desc">{{ repo.description || '暂无描述' }}</div>
                <div v-if="isCloning(repo.id)" class="clone-progress-bar">
                  <div class="clone-progress-fill" :style="{ width: cloneProgress(repo.id) + '%' }"></div>
                </div>
                <div class="repo-meta">
                  <span>{{ repo.type.toUpperCase() }}</span>
                  <span v-if="repo.last_sync">同步: {{ formatDate(repo.last_sync) }}</span>
                  <span v-if="repo.size !== undefined" class="repo-size">{{ formatSize(repo.size) }}</span>
                </div>
              </div>
              <div class="repo-actions">
                <t-button theme="default" size="small" @click.stop="editRepo(repo)" :disabled="isCloning(repo.id)">
                  <template #icon><t-icon name="edit" /></template>
                </t-button>
                <t-button theme="default" size="small" @click.stop="syncRepo(repo)" :disabled="isCloning(repo.id)">
                  <template #icon><t-icon name="refresh" /></template>
                </t-button>
                <t-popconfirm content="确定删除吗？这将同时删除本地代码文件。" @confirm="deleteRepo(repo.id)">
                  <t-button theme="danger" size="small">
                    <template #icon><t-icon name="delete" /></template>
                  </t-button>
                </t-popconfirm>
              </div>
            </div>
          </t-list-item>
        </t-list>
        <t-empty v-else description="暂无代码仓库，请添加一个仓库" />
      </t-card>
    </div>

    <!-- 仓库详情浏览视图 -->
    <div v-else class="repo-browser">
      <div class="browser-header">
        <t-button theme="default" @click="closeRepo">
          <template #icon><t-icon name="arrow-left" /></template>
          返回列表
        </t-button>
        <div class="browser-title">
          <t-icon :name="currentRepo.type === 'svn' ? 'folder' : 'git'" />
          {{ currentRepo.name }}
        </div>
        <t-space>
          <t-button theme="default" size="small" @click="refreshRepo">
            <template #icon><t-icon name="refresh" /></template>
            刷新
          </t-button>
        </t-space>
      </div>

      <t-layout class="browser-layout">
        <!-- 左侧文件树 -->
        <t-aside class="file-sidebar">
          <div class="sidebar-header">文件目录</div>
          <t-tree
            :data="fileTree"
            :expand-all="false"
            :keys="{ value: 'path', label: 'name', children: 'children' }"
            :activable="true"
            :expand-on-click-node="true"
            lazy
            :load="loadTreeNode"
            @click="onTreeClick"
            hover
            transition
          >
            <template #label="{ node }">
              <span class="tree-node-label">
                <t-icon :name="node.data.type === 'directory' ? 'folder' : 'file'" class="tree-node-icon" />
                {{ node.label }}
              </span>
            </template>
          </t-tree>
        </t-aside>

        <!-- 右侧内容区 -->
        <t-content class="content-area">
          <t-tabs v-model="activeTab">
            <t-tab-panel value="files" label="文件">
              <!-- 文件预览区域 -->
              <div class="file-preview-area">
                <!-- 文件头部：显示文件名和关闭按钮 -->
                <div v-if="currentFile" class="file-header">
                  <span class="file-title">
                    <t-icon :name="isMarkdownFile(currentFile.name) ? 'file-markdown' : 'file'" />
                    {{ currentFile.name }}
                  </span>
                  <t-button size="small" theme="default" variant="text" @click="closeFile">
                    <template #icon><t-icon name="close" /></template>
                  </t-button>
                </div>
                <div v-else class="file-header">
                  <span class="file-title">
                    <t-icon name="file-markdown" />
                    README
                  </span>
                </div>
                
                <!-- 文件内容 -->
                <div class="file-content">
                  <!-- 当前选择的文件 -->
                  <template v-if="currentFile">
                    <!-- Markdown 文件预览 -->
                    <div v-if="isMarkdownFile(currentFile.name)" class="markdown-preview markdown-body" v-html="renderedFileContent"></div>
                    <!-- 文本/代码文件预览（带语法高亮） -->
                    <pre v-else-if="currentFile.type === 'text'" class="code-content"><code :class="'language-' + getLanguageFromFilename(currentFile.name)" v-html="highlightedCode"></code></pre>
                    <!-- 二进制文件 -->
                    <div v-else class="binary-file">
                      <t-icon name="file-icon" size="48px" />
                      <p>二进制文件，无法预览</p>
                      <p class="file-size">大小: {{ formatSize(currentFile.size || 0) }}</p>
                    </div>
                  </template>
                  <!-- 默认显示 README -->
                  <template v-else>
                    <div v-if="readmeContent" class="markdown-preview markdown-body" v-html="renderedReadme"></div>
                    <t-empty v-else description="该仓库暂无 README 文件" />
                  </template>
                </div>
              </div>
            </t-tab-panel>
            <t-tab-panel value="commits" label="提交历史">
              <div class="commits-panel">
                <t-list v-if="commits.length > 0" :split="true">
                  <t-list-item v-for="commit in commits" :key="commit.hash" class="commit-list-item" @click="showCommitDetail(commit)">
                    <div class="commit-item">
                      <div class="commit-hash">{{ commit.hash }}</div>
                      <div class="commit-message">{{ commit.message }}</div>
                      <div class="commit-meta">
                        <span>{{ commit.author }}</span>
                        <span>{{ commit.date }}</span>
                      </div>
                    </div>
                  </t-list-item>
                </t-list>
                <t-empty v-else description="暂无提交历史" />
              </div>
            </t-tab-panel>
          </t-tabs>
        </t-content>
      </t-layout>
    </div>

    <!-- 添加仓库对话框 -->
    <t-dialog v-model:visible="addDialogVisible" header="添加代码仓库" @confirm="confirmAdd" :width="700">
      <t-form :data="addForm">
        <t-form-item label="仓库URL">
          <t-space style="width: 100%">
            <t-input v-model="addForm.url" placeholder="https://github.com/xxx/xxx.git" style="width: 480px" />
            <t-button theme="default" size="small" @click="fetchGithubInfo" :loading="fetchingInfo" :disabled="!isGithubUrl(addForm.url)">
              获取信息
            </t-button>
          </t-space>
        </t-form-item>
        <t-form-item label="仓库名称">
          <t-input v-model="addForm.name" placeholder="给仓库起个名字" />
        </t-form-item>
        <t-form-item label="仓库类型">
          <t-radio-group v-model="addForm.type">
            <t-radio value="git">Git</t-radio>
            <t-radio value="svn">SVN</t-radio>
          </t-radio-group>
        </t-form-item>
        <t-form-item label="简介">
          <t-textarea v-model="addForm.description" placeholder="仓库简介（可选）" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 编辑仓库对话框 -->
    <t-dialog v-model:visible="editDialogVisible" header="编辑代码仓库" @confirm="confirmEdit" :width="600">
      <t-form :data="editForm">
        <t-form-item label="仓库名称">
          <t-input v-model="editForm.name" placeholder="仓库名称" />
        </t-form-item>
        <t-form-item label="简介">
          <t-textarea v-model="editForm.description" placeholder="仓库简介" />
        </t-form-item>
        <t-form-item label="仓库URL">
          <t-space style="width: 100%">
            <t-input v-model="editForm.url" disabled style="width: 380px" />
            <t-button theme="default" size="small" @click="fetchEditGithubInfo" :loading="fetchingEditInfo" :disabled="!isGithubUrl(editForm.url)">
              自动获取
            </t-button>
          </t-space>
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 提交详情对话框 -->
    <t-dialog v-model:visible="commitDialogVisible" :header="commitDetail ? '提交详情: ' + commitDetail.hash : '提交详情'" :width="900" :footer="false">
      <div v-if="commitLoading" class="commit-loading">
        <t-loading text="加载中..." />
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
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'
import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'

const repoList = ref([])
const searchKeyword = ref('')
const loading = ref(false)
const addDialogVisible = ref(false)

// 克隆状态管理
const cloneStatuses = ref(new Map())

// 当前浏览的仓库
const currentRepo = ref(null)
const fileTree = ref([])
const commits = ref([])
const readmeContent = ref('')
const activeTab = ref('files')
const currentFile = ref(null)

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
    MessagePlugin.warning('请先输入仓库URL')
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
      MessagePlugin.success('获取GitHub信息成功')
    }
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '获取GitHub信息失败')
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
    MessagePlugin.warning('仓库URL无效')
    return
  }
  
  fetchingEditInfo.value = true
  try {
    const response = await api.code.getGithubInfo(editForm.value.url)
    const data = response.data?.data
    
    if (data) {
      editForm.value.name = data.name
      editForm.value.description = data.description || ''
      MessagePlugin.success('获取GitHub信息成功')
    }
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '获取GitHub信息失败')
  } finally {
    fetchingEditInfo.value = false
  }
}

// 确认编辑
async function confirmEdit() {
  if (!editForm.value.name) {
    MessagePlugin.warning('请输入仓库名称')
    return
  }
  
  try {
    await api.code.update(editForm.value.id, {
      name: editForm.value.name,
      description: editForm.value.description
    })
    MessagePlugin.success('更新成功')
    editDialogVisible.value = false
    loadRepos()
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '更新失败')
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
    MessagePlugin.error('获取提交详情失败')
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

// 渲染 Markdown
const renderedReadme = computed(() => {
  if (!readmeContent.value) return ''
  return marked(readmeContent.value)
})

// 渲染当前文件的 Markdown 内容
const renderedFileContent = computed(() => {
  if (!currentFile.value?.content) return ''
  return marked(currentFile.value.content)
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
  try {
    const response = await api.code.list({ keyword: searchKeyword.value })
    repoList.value = response.data.data || []
  } catch (error) {
    MessagePlugin.error('加载仓库列表失败')
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
    MessagePlugin.warning('请填写完整信息')
    return
  }
  try {
    const response = await api.code.create(addForm.value)
    MessagePlugin.success('仓库添加成功，正在后台克隆...')
    addDialogVisible.value = false
    
    // 开始轮询克隆进度
    if (response.data?.id) {
      startClonePolling(response.data.id)
    }
    
    loadRepos()
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '添加失败')
  }
}

// 删除仓库
async function deleteRepo(id) {
  try {
    await api.code.delete(id)
    MessagePlugin.success('删除成功')
    loadRepos()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 同步仓库
async function syncRepo(repo) {
  try {
    await api.code.sync(repo.id)
    MessagePlugin.success('开始同步仓库...')
  } catch (error) {
    MessagePlugin.error('同步失败')
  }
}

// 打开仓库浏览
async function openRepo(repo) {
  currentRepo.value = repo
  activeTab.value = 'files'
  currentFile.value = null
  
  // 并行加载数据
  Promise.all([
    loadFileTree(),
    loadReadme(),
    loadCommits()
  ])
}

// 关闭仓库浏览
function closeRepo() {
  currentRepo.value = null
  fileTree.value = []
  commits.value = []
  readmeContent.value = ''
  currentFile.value = null
}

// 加载树节点（用于异步加载）- TDesign Tree lazy load 回调
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
    MessagePlugin.error('加载失败')
    return []
  }
}

// 加载文件树（初始加载根目录）
async function loadFileTree() {
  if (!currentRepo.value) return
  try {
    console.log('加载根目录')
    const response = await api.code.getTree(currentRepo.value.id, '')
    const items = response.data.data || []
    console.log('根目录文件:', items)
    
    // 转换为树形结构
    fileTree.value = items.map(item => ({
      path: item.path,
      name: item.name,
      type: item.type,
      // 懒加载节点需要设置 children: true 表示可以展开
      children: item.type === 'directory' ? true : undefined,
      isLeaf: item.type === 'file'
    }))
  } catch (error) {
    console.error('加载文件树失败:', error)
    MessagePlugin.error('加载文件树失败')
  }
}

// 树节点点击
async function onTreeClick(context) {
  // TDesign Tree 点击事件返回的是 { node, e }
  const node = context?.node
  if (!node) return
  
  // 从 node.data 获取实际数据
  const nodeData = node.data || node
  console.log('树节点点击:', nodeData)
  
  if (nodeData.type === 'file') {
    await loadFile(nodeData.path)
  }
  // 目录点击由 Tree 组件自动处理展开和异步加载
}

// 加载文件内容
async function loadFile(path) {
  if (!currentRepo.value) return
  try {
    const response = await api.code.getFile(currentRepo.value.id, path)
    currentFile.value = response.data.data
    
    // 延迟重置滚动条到顶部和处理Markdown链接（等待DOM渲染）
    if (isMarkdownFile(path)) {
      setTimeout(() => {
        const markdownPanel = document.querySelector('.markdown-preview')
        if (markdownPanel) {
          markdownPanel.scrollTop = 0
        }
        bindMarkdownLinks()
      }, 100)
    } else {
      setTimeout(() => {
        const codePanel = document.querySelector('.code-content')
        if (codePanel) {
          codePanel.scrollTop = 0
        }
      }, 100)
    }
  } catch (error) {
    MessagePlugin.error('加载文件失败')
  }
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
        MessagePlugin.info('内部文档链接暂不支持跳转')
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
  try {
    const response = await api.code.getReadme(currentRepo.value.id)
    readmeContent.value = response.data.data?.content || ''
  } catch (error) {
    readmeContent.value = ''
  }
}

// 加载提交历史
async function loadCommits() {
  if (!currentRepo.value) return
  try {
    const response = await api.code.getCommits(currentRepo.value.id, 20)
    commits.value = response.data.data || []
  } catch (error) {
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
  MessagePlugin.success('刷新成功')
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

.browser-title {
  flex: 1;
  font-size: 18px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.browser-layout {
  background: #fff;
  border-radius: 8px;
  height: calc(100% - 60px);
  overflow: hidden;
}

.file-sidebar {
  width: 280px;
  border-right: 1px solid #e7e7e7;
  overflow-y: auto;
}

.sidebar-header {
  padding: 12px 16px;
  font-weight: 600;
  border-bottom: 1px solid #e7e7e7;
}

.content-area {
  padding: 16px;
  overflow-y: auto;
  position: relative;
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

.markdown-content :deep(p) {
  margin-bottom: 16px;
}

.markdown-content :deep(code) {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
}

.markdown-content :deep(pre) {
  background: #f5f5f5;
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-content :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 8px 0;
}

.markdown-content :deep(a) {
  color: #0052d9;
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.commits-panel {
  padding: 16px;
}

.commit-item {
  padding: 12px 0;
}

.commit-hash {
  font-family: monospace;
  color: #0052d9;
  font-size: 12px;
  margin-bottom: 4px;
}

.commit-message {
  font-size: 14px;
  color: #333;
  margin-bottom: 4px;
}

.commit-meta {
  font-size: 12px;
  color: #999;
  display: flex;
  gap: 16px;
}

.repo-size {
  margin-left: auto;
  color: #666;
  font-weight: 500;
}

.commit-list-item {
  cursor: pointer;
  transition: background-color 0.2s;
}

.commit-list-item:hover {
  background-color: #f5f5f5;
}

.commit-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
}

.commit-detail {
  max-height: 70vh;
  overflow-y: auto;
}

.commit-detail-header {
  margin-bottom: 16px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
}

.commit-info-row {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.commit-info-row .label {
  font-weight: 600;
  color: #666;
  min-width: 80px;
}

.commit-info-row .value {
  font-family: monospace;
  color: #0052d9;
}

.changed-files {
  margin-top: 8px;
}

.changed-files .label {
  font-weight: 600;
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
  display: inline-block;
  padding: 4px 8px;
  background: #e8f4ff;
  border-radius: 4px;
  font-size: 12px;
  color: #0052d9;
}

.diff-container {
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  overflow: auto;
  max-height: 500px;
}

.diff-lines {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
}

.diff-line {
  display: flex;
  min-height: 22px;
}

.diff-line.header {
  background: #e8e8e8;
  color: #666;
  padding: 4px 8px;
  font-weight: 500;
}

.diff-line.info {
  background: #f0f0f0;
  color: #888;
  padding: 2px 8px;
}

.diff-line.removed {
  background: #ffebe9;
  border-left: 3px solid #ffa8a8;
}

.diff-line.added {
  background: #e6ffec;
  border-left: 3px solid #a8d6a8;
}

.diff-line.context {
  background: #fff;
  border-left: 3px solid transparent;
}

.diff-line.empty {
  background: #f9f9f9;
  min-height: 10px;
}

.line-number {
  display: inline-block;
  width: 40px;
  padding: 0 8px;
  text-align: right;
  color: #999;
  background: #f7f7f7;
  border-right: 1px solid #e8e8e8;
  user-select: none;
  flex-shrink: 0;
}

.line-prefix {
  display: inline-block;
  width: 20px;
  text-align: center;
  color: #666;
  flex-shrink: 0;
}

.diff-line.removed .line-prefix {
  color: #c93c3c;
}

.diff-line.added .line-prefix {
  color: #3c9c3c;
}

.line-content {
  padding: 0 8px;
  white-space: pre;
  overflow-x: auto;
  flex: 1;
  color: #333;
}

.file-preview-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #fafafa;
  border-bottom: 1px solid #e7e7e7;
  flex-shrink: 0;
}

.file-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #333;
}

.file-content {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.code-content {
  flex: 1;
  padding: 16px;
  margin: 0;
  overflow: auto;
  background: #f8f9fa;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
}

.binary-file {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #999;
  gap: 12px;
}

.binary-file .file-size {
  font-size: 12px;
  color: #999;
}

/* 代码高亮样式 */
.code-content code {
  display: block;
  white-space: pre;
}

/* 确保 highlight.js 样式正确应用 */
.code-content .hljs {
  background: transparent;
  padding: 0;
}

.tree-node-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tree-node-icon {
  font-size: 16px;
  color: #666;
}

.markdown-preview {
  flex: 1;
  padding: 20px;
  overflow: auto;
  background: #fff;
  line-height: 1.6;
}

.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3),
.markdown-preview :deep(h4),
.markdown-preview :deep(h5),
.markdown-preview :deep(h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: #333;
}

.markdown-preview :deep(p) {
  margin-bottom: 16px;
  color: #333;
}

.markdown-preview :deep(code) {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
}

.markdown-preview :deep(pre) {
  background: #f5f5f5;
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin-bottom: 16px;
}

.markdown-preview :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-preview :deep(ul),
.markdown-preview :deep(ol) {
  margin-bottom: 16px;
  padding-left: 24px;
}

.markdown-preview :deep(li) {
  margin-bottom: 4px;
}

.markdown-preview :deep(blockquote) {
  border-left: 4px solid #ddd;
  padding-left: 16px;
  margin-left: 0;
  color: #666;
}

.markdown-preview :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}

.markdown-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 16px;
}

.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  border: 1px solid #ddd;
  padding: 8px 12px;
  text-align: left;
}

.markdown-preview :deep(th) {
  background: #f5f5f5;
  font-weight: 600;
}

.markdown-preview :deep(a) {
  color: #0052d9;
  text-decoration: none;
}

.markdown-preview :deep(a:hover) {
  text-decoration: underline;
}
</style>
