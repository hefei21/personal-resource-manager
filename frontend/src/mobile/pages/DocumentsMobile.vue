<template>
  <div id="mobile-documents-host" class="mobile-documents">
    <!-- 顶部导航栏（标题由Layout统一提供，此处不再重复） -->

    <!-- 浏览模式切换 -->
    <div class="view-mode-tabs">
      <div 
        class="tab-item" 
        :class="{ active: viewMode === 'category' }"
        @click="switchViewMode('category')"
      >
        <NativeIcon name="folder" />
        <span>分类</span>
      </div>
      <div 
        class="tab-item" 
        :class="{ active: viewMode === 'list' }"
        @click="switchViewMode('list')"
      >
        <NativeIcon name="view-list" />
        <span>列表</span>
      </div>
      <div 
        class="tab-item" 
        :class="{ active: viewMode === 'private' }"
        @click="switchViewMode('private')"
      >
        <NativeIcon name="lock-on" />
        <span>私密</span>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div class="search-bar">
      <NativeInput
        v-model="searchKeyword"
        :placeholder="viewMode === 'private' ? '搜索私密文件...' : '搜索文档...'"
        clearable
        @clear="handleSearch"
        @enter="handleSearch"
      >
        <template #prefix-icon>
          <NativeIcon name="search" />
        </template>
      </NativeInput>
    </div>

    <!-- 批量操作栏（放在文档列表上方） -->
    
    <!-- 删除确认对话框 -->
    <NativeDialog
      v-model="confirmBatchDeleteDialogVisible"
      title="确认删除"
      body="确定要删除选中的文档吗？此操作不可撤销。"
      :close-on-overlay-click="true"
      @confirm="handleBatchDelete"
      class="centered-dialog"
    />

    <!-- 分类浏览模式（主分类：小图标风格，与子分类统一） -->
    <div v-if="viewMode === 'category' && !currentCategoryId" class="categories-section">
      <div class="section-title-row">
        <span class="section-title">分类</span>
      </div>
      <div v-if="categories.length === 0" class="empty-categories">
        <span class="empty-text">无</span>
      </div>
      <div class="category-list" v-else>
        <div
          v-for="cat in categories"
          :key="cat.id"
          class="category-item"
          @click="enterCategory(cat)"
        >
          <NativeIcon name="folder" size="20" />
          <span>{{ cat.name }}</span>
        </div>
      </div>
    </div>

    <!-- 子分类 -->
    <div v-if="viewMode === 'category' && currentCategoryId" class="subcategories-section">
      <div class="section-title-row">
        <span class="section-title">分类</span>
        <NativeButton shape="circle" variant="text" size="small" @click="handleBack">
          <NativeIcon name="chevron-left" size="20" />
        </NativeButton>
      </div>
      <div v-if="currentSubcategories.length > 0" class="subcategory-list">
        <div
          v-for="sub in currentSubcategories"
          :key="sub.id"
          class="subcategory-item"
          @click="enterCategory(sub)"
        >
          <NativeIcon name="folder" size="20" />
          <span>{{ sub.name }}</span>
        </div>
      </div>
      <div v-else class="empty-categories">
        <span class="empty-text">无</span>
      </div>
    </div>

    <!-- 文档列表 -->
    <div class="documents-section" v-if="!loading || documents.length > 0">
      <!-- 批量操作栏（放在文档列表上方，多选模式下显示） -->
      <div v-if="batchMode" class="batch-bar">
        <span class="batch-info">已选 {{ selectedDocuments.length }} 项</span>
        <div class="batch-actions-space">
          <NativeButton theme="primary" size="small" @click="batchEditDialogVisible = true" :disabled="selectedDocuments.length === 0">更改</NativeButton>
          <NativeButton theme="danger" size="small" @click="confirmBatchDeleteDialogVisible = true" :disabled="selectedDocuments.length === 0">删除</NativeButton>
          <NativeButton variant="text" size="small" @click="exitBatchMode">取消</NativeButton>
        </div>
      </div>

      <div class="section-title" v-if="documents.length > 0 && !batchMode">
        {{ viewMode === 'category' && currentCategoryName ? currentCategoryName : '所有文件' }}
        <span class="count">({{ documents.length }})</span>
      </div>
      
      <div class="document-list">
        <div
          v-for="doc in documents"
          :key="doc.id"
          class="document-item"
          :class="{ selected: isSelected(doc.id), 'guest-mode': isGuest, 'previewing': isPreviewing(doc.id) }"
          @click="(e) => onDocItemClick(doc, e)"
          @touchstart.passive="!isGuest && onDocTouchStart($event, doc)"
          @touchend.passive="!isGuest && onDocTouchEnd"
          @touchcancel="onDocTouchEnd"
        >
          <!-- 文件图标 -->
          <div class="file-icon" :class="getFileIconClass(doc.filePath)">
            <NativeIcon :name="getFileIcon(doc.filePath)" size="24" />
          </div>
          
          <!-- 文件信息 -->
          <div class="file-info">
            <div class="file-name">{{ getFileNameWithExt(doc) }}</div>
            <div class="file-meta">
              <span class="file-size">{{ formatFileSize(doc.size || 0) }}</span>
              <span class="divider">|</span>
              <span class="file-date">{{ formatDate(doc.updatedAt) }}</span>
            </div>
            <div class="file-tags-row" v-if="doc.tags">
              <NativeTag v-for="(tag, idx) in parseTags(doc.tags)" :key="idx" size="small" variant="light" theme="primary">
                {{ tag }}
              </NativeTag>
            </div>
          </div>
          
          <!-- 预览loading转圈 -->
          <div v-if="isPreviewing(doc.id)" class="item-loading-spinner">
            <NativeLoading size="small" />
          </div>
          
          <!-- 操作菜单（非多选模式、非游客） -->
          <div v-if="!batchMode && !isGuest && !isPreviewing(doc.id)" class="action-menu"
            @click.stop.prevent="showActionMenu(doc)"
          >
            <NativeIcon name="ellipsis" size="22" />
          </div>
          <!-- 多选框（多选模式，放在右侧） -->
          <div v-else-if="batchMode" class="checkbox checkbox-right" @click.stop="toggleSelect(doc.id)">
            <NativeCheckbox :checked="isSelected(doc.id)" @change="toggleSelect(doc.id)" />
          </div>
        </div>
      </div>
      
      <!-- 加载更多 -->
      <div v-if="hasMore" class="load-more">
        <NativeButton variant="text" size="small" @click="loadMore" :loading="loading">
          加载更多
        </NativeButton>
      </div>
      
      <!-- 空状态 -->
      <div v-if="documents.length === 0 && !loading" class="empty-state">
        <NativeIcon name="file" size="48" />
        <p>暂无文档</p>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && documents.length === 0" class="loading-state">
      <NativeLoading size="medium" />
    </div>

    <!-- 操作菜单弹窗（底部弹出菜单） -->
    <div v-if="actionMenuVisible" class="native-action-overlay" @click.self="actionMenuVisible = false">
      <div class="native-action-sheet">
        <div class="action-sheet-title">{{ currentDoc?.title || '操作' }}</div>
        <div class="action-sheet-list">
          <div class="action-sheet-item" @click="handleActionSelect({ value: 'edit' })">
            <NativeIcon name="edit-1" size="20" />
            <span>更改</span>
          </div>
          <div class="action-sheet-item" @click="handleActionSelect({ value: 'versions' })">
            <NativeIcon name="history" size="20" />
            <span>历史版本</span>
          </div>
          <div class="action-sheet-item delete" @click="handleDeleteClick">
            <NativeIcon name="delete" size="20" />
            <span>删除</span>
          </div>
        </div>
        <div class="action-sheet-cancel" @click="actionMenuVisible = false">
          <span>取消</span>
        </div>
      </div>
    </div>

    <!-- 批量编辑弹窗 -->
    <NativeDialog
      v-model="batchEditDialogVisible"
      title="更改"
      :show-close="true"
      :close-on-overlay-click="true"
      class="centered-dialog"
    >
      <div class="edit-form">
        <NativeSelect
          v-model="batchEditForm.categoryPath"
          placeholder="更改分类"
          :options="categoryOptions"
          clearable
        />
        <NativeInput v-model="batchEditForm.tags" placeholder="更改标签，用逗号分隔" class="mt-4" />
      </div>
      <template #footer>
        <div class="dialog-footer-btns">
          <NativeButton variant="outline" @click="batchEditDialogVisible = false">取消</NativeButton>
          <NativeButton theme="primary" @click="handleBatchEditConfirm">确认</NativeButton>
        </div>
      </template>
    </NativeDialog>

    <!-- 版本历史弹窗 -->
    <div v-if="versionsDialogVisible" class="native-dialog-overlay" @click.self="versionsDialogVisible = false">
      <div class="native-dialog-container">
        <div class="native-dialog-header">
          <span>版本历史</span>
          <span class="dialog-close" @click="versionsDialogVisible = false">×</span>
        </div>
        <div class="versions-list">
          <div v-for="ver in versions" :key="ver.id" class="version-item" @click="previewVersion(ver)">
            <div class="version-info">
              <div class="version-header">
                <span class="version-num">v{{ ver.version }}</span>
                <span class="version-date">{{ formatDate(ver.createdAt) }}</span>
              </div>
              <div class="version-note" v-if="ver.note">{{ ver.note }}</div>
            </div>
            <div class="version-actions">
              <button class="version-preview-btn" @click.stop="previewVersion(ver)">预览</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="deleteConfirmVisible" class="native-dialog-overlay" @click.self="deleteConfirmVisible = false">
      <div class="native-dialog-container small">
        <div class="native-dialog-header">确认删除</div>
        <div class="delete-confirm-content">
          <p>确定要删除文件「{{ currentDoc?.title }}」吗？</p>
          <p class="delete-warning">删除后无法恢复</p>
        </div>
        <div class="native-dialog-footer">
          <button class="btn-cancel" @click="deleteConfirmVisible = false">取消</button>
          <button class="btn-confirm delete" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 私密空间密码验证 -->
    <NativeDialog
      v-model="privatePasswordDialogVisible"
      title="私密空间"
      :close-on-overlay-click="false"
      :show-close="false"
    >
      <NativeInput
        v-model="privatePasswordInput"
        type="password"
        placeholder="请输入私密空间密码"
        :status="privatePasswordError ? 'error' : ''"
        :tips="privatePasswordError"
        @enter="verifyPrivatePassword"
      />
      <template #footer>
        <NativeButton theme="primary" block @click="verifyPrivatePassword">确认</NativeButton>
      </template>
    </NativeDialog>

    <!-- 文件预览弹窗（原生全屏方案，最大化显示面积） -->
    <div v-if="previewDialogVisible" class="native-preview-overlay" @click.self="closePreview">
      <div class="native-preview-container">
        <!-- 头部标题栏 -->
        <div class="native-preview-header">
          <span class="preview-title">{{ previewFileName }}</span>
          <span class="preview-close" @click="closePreview">×</span>
        </div>
        <!-- 内容区 -->
        <div class="native-preview-body" v-if="!previewLoading">
        <!-- PDF预览 -->
        <div v-if="previewType === 'pdf'" class="pdf-preview">
          <canvas ref="pdfCanvas"></canvas>
          <div class="pdf-controls" v-if="totalPages > 1">
            <NativeButton size="small" @click="prevPage" :disabled="currentPage <= 1">
              <NativeIcon name="chevron-left" />
            </NativeButton>
            <span>{{ currentPage }} / {{ totalPages }}</span>
            <NativeButton size="small" @click="nextPage" :disabled="currentPage >= totalPages">
              <NativeIcon name="chevron-right" />
            </NativeButton>
          </div>
        </div>

        <!-- Markdown预览 -->
        <MdPreview
          v-else-if="previewType === 'markdown'"
          :modelValue="previewContent"
          :previewTheme="'default'"
          class="mobile-md-preview"
        />

        <!-- 代码预览 -->
        <div v-else-if="previewType === 'code'" class="code-preview">
          <pre><code v-html="highlightedCode" :class="`language-${previewLanguage}`"></code></pre>
        </div>

        <!-- 文本预览 -->
        <div v-else-if="previewType === 'text'" class="text-preview"><pre>{{ previewContent }}</pre></div>

        <!-- 图片预览 -->
        <img
          v-else-if="previewType === 'image' && previewIsBase64"
          :src="'data:image/' + getImageMimeType(previewFileName) + ';base64,' + previewContent"
          style="max-width:100%;display:block;margin:0 auto;"
          :alt="previewFileName"
        />

        <!-- Word HTML预览 -->
        <div v-else-if="previewType === 'word-html'" class="word-html-preview">
          <div class="office-content" v-html="previewContent"></div>
        </div>

        <!-- Excel HTML预览 -->
        <div v-else-if="previewType === 'excel-html'" class="excel-html-preview">
          <div class="office-content" v-html="previewContent"></div>
        </div>

        <!-- Office文档不支持预览提示 -->
        <div v-else-if="previewType === 'office'" class="office-preview">
          <NativeIcon :name="getOfficeIconName(previewLanguage)" size="48" />
          <h3>{{ getOfficeTypeLabel(previewLanguage) }}文档</h3>
          <p>此文件格式不支持在线预览</p>
          <NativeButton v-if="!isGuest" theme="primary" size="small" @click="handleDownloadFile">下载文件</NativeButton>
        </div>

        <!-- 不支持预览 -->
        <div v-else class="unsupported-preview">
          <p>此文件格式不支持在线预览</p>
        </div>
      </div>
      <!-- 加载中状态 -->
      <div v-if="previewLoading" class="loading-state"><NativeLoading text="加载中..." /></div>
    </div>
    </div>

    <!-- 图片预览弹窗 -->
    <div v-if="imagePreviewVisible" class="native-image-preview-overlay" @click.self="imagePreviewVisible = false">
      <div class="native-image-preview-container">
        <img :src="previewImageUrl" alt="预览" @click.stop />
        <button class="close-preview-btn" @click="imagePreviewVisible = false">
          <NativeIcon name="close" size="24" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { marked } from 'marked'
import hljs from 'highlight.js'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeIcon, NativeTag, NativeSelect } from '@/components/native'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest, canWrite } = usePermission()

// 配置 marked 选项
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return hljs.highlightAuto(code).value
  },
  breaks: true,
  gfm: true
})

// 动态加载 PDF.js
let pdfjsLib = null

async function loadPdfJS() {
  if (pdfjsLib) return pdfjsLib
  try {
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.10.377/pdf.min.js'
    script.async = true
    await new Promise((resolve, reject) => {
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })
    pdfjsLib = window.pdfjsLib
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.10.377/build/pdf.worker.min.js'
    return pdfjsLib
  } catch (e) {
    console.error('PDF.js 加载失败:', e)
    throw e
  }
}

// 状态定义
const loading = ref(false)
const documents = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const hasMore = computed(() => documents.value.length < total.value)

// 视图模式
const viewMode = ref('category') // category, list, private
const categories = ref([])
const currentCategoryId = ref(null)
const categoryPath = ref([])
const currentCategoryName = computed(() => {
  if (categoryPath.value.length === 0) return ''
  return categoryPath.value[categoryPath.value.length - 1].name
})

// 子分类
const currentSubcategories = computed(() => {
  if (!currentCategoryId.value) return []
  const currentCat = findCategoryById(categories.value, currentCategoryId.value)
  return currentCat?.subcategories || []
})

// 搜索
const searchKeyword = ref('')

// 批量模式
const batchMode = ref(false)
const selectedDocuments = ref([])

// 当前操作文档
const currentDoc = ref(null)

// 操作菜单
const actionMenuVisible = ref(false)
const actionItems = computed(() => {
  const items = [
    { label: '更改', value: 'edit' },
    { label: '版本历史', value: 'versions' },
    { label: '删除', value: 'delete' }
  ]
  return items
})

// 上传
const uploadDialogVisible = ref(false)
const uploadFiles = ref([])
const uploading = ref(false)
const uploadForm = ref({
  title: '',
  tags: '',
  categoryPath: ''
})
const uploadAction = computed(() => '/api/documents/upload')
const uploadHeaders = computed(() => {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token')
  return { Authorization: `Bearer ${token}` }
})

// 批量编辑
const batchEditDialogVisible = ref(false)
const confirmBatchDeleteDialogVisible = ref(false)
const batchEditForm = ref({
  categoryPath: '',
  tags: ''
})

// 版本
const versions = ref([])
const versionsDialogVisible = ref(false)

// 预览
const previewDialogVisible = ref(false)
const imagePreviewVisible = ref(false)
const previewLoading = ref(false)
const previewContent = ref('')
const previewIsBase64 = ref(false)
const previewType = ref('text')
const previewLanguage = ref('plaintext')
const previewFileName = ref('')
const previewImageUrl = ref('')
const previewDocumentId = ref(null)

// 预览中的文档ID（用于条目loading效果）
const previewingDocIds = ref(new Set())

function isPreviewing(docId) {
  return previewingDocIds.value.has(docId)
}

// PDF预览状态
const pdfCanvas = ref(null)
const pdfDoc = ref(null)
const currentPage = ref(1)
const totalPages = ref(0)

// 代码高亮结果
const highlightedCode = computed(() => {
  if (!previewContent.value || previewType.value !== 'code') return ''
  try {
    if (previewLanguage.value && hljs.getLanguage(previewLanguage.value)) {
      return hljs.highlight(previewContent.value, { language: previewLanguage.value }).value
    }
    return hljs.highlightAuto(previewContent.value).value
  } catch (e) {
    return previewContent.value
  }
})

// 创建分类
const createCategoryDialogVisible = ref(false)
const newCategoryName = ref('')

// 私密空间
const privatePasswordDialogVisible = ref(false)
const privatePasswordInput = ref('')
const privatePasswordError = ref('')
const privateAccessGranted = ref(false)

// 检查 sessionStorage 中是否有私密空间访问权限
function checkPrivateAccess() {
  return sessionStorage.getItem('privateAccessGranted') === 'true'
}

// 设置私密空间访问权限
function setPrivateAccess(granted) {
  if (granted) {
    sessionStorage.setItem('privateAccessGranted', 'true')
  } else {
    sessionStorage.removeItem('privateAccessGranted')
  }
  privateAccessGranted.value = granted
}

// 方法定义

// 切换视图模式
function switchViewMode(mode) {
  viewMode.value = mode
  currentCategoryId.value = null
  categoryPath.value = []
  documents.value = []
  page.value = 1
  selectedDocuments.value = []
  batchMode.value = false
  
  if (mode === 'private') {
    if (isGuest.value) {
      toast.warning('游客无权访问私密空间')
      viewMode.value = 'category'
      loadDocuments()
      return
    }
    // 从 sessionStorage 检查访问权限
    const hasAccess = checkPrivateAccess()
    if (!hasAccess) {
      privatePasswordDialogVisible.value = true
      return
    }
    privateAccessGranted.value = true
  }
  
  loadDocuments()
}

// 验证私密空间密码
async function verifyPrivatePassword() {
  try {
    const response = await api.documents.verifyPrivatePassword({
      password: privatePasswordInput.value
    })
    if (response.data.success) {
      // 持久化访问权限到 sessionStorage
      setPrivateAccess(true)
      privatePasswordDialogVisible.value = false
      privatePasswordError.value = ''
      privatePasswordInput.value = ''
      // 清空搜索关键词，避免带着之前的搜索词搜索私密文件
      searchKeyword.value = ''
      loadPrivateDocuments()
    } else {
      privatePasswordError.value = response.data.message || '密码错误'
    }
  } catch (error) {
    // 处理密码错误（400状态码）
    if (error.response?.status === 400) {
      privatePasswordError.value = error.response.data?.message || '密码错误'
    } else {
      privatePasswordError.value = error.response?.data?.message || '验证失败'
    }
  }
}

// 加载文档
async function loadDocuments() {
  if (viewMode.value === 'private') {
    if (privateAccessGranted.value) {
      loadPrivateDocuments()
    }
    return
  }
  
  loading.value = true
  try {
    const params = {
      keyword: searchKeyword.value,
      page: page.value,
      pageSize: pageSize.value
    }
    
    if (currentCategoryId.value) {
      const currentCat = findCategoryById(categories.value, currentCategoryId.value)
      if (currentCat) {
        const pathParts = currentCat.path.split('/')
        params.category = pathParts[0]
        if (pathParts.length > 1) {
          params.subcategory = pathParts.slice(1).join('/')
          params.includeSubcategories = 'true'
        }
      }
    }
    
    const response = await api.documents.list(params)
    const data = response.data?.data || []
    total.value = response.data?.total || 0
    
    if (page.value === 1) {
      documents.value = data
    } else {
      documents.value.push(...data)
    }
  } catch (error) {
    console.error('加载文档失败:', error)
    toast.error('加载失败')
  } finally {
    loading.value = false
  }
}

// 加载私密文档
async function loadPrivateDocuments() {
  loading.value = true
  try {
    const response = await api.documents.listPrivate({
      keyword: searchKeyword.value,
      page: page.value,
      pageSize: pageSize.value
    })
    const data = response.data?.data || []
    total.value = response.data?.total || 0
    
    // 给私密文档添加 isPrivate 标记，用于预览时调用正确的 API
    const privateData = data.map(doc => ({ ...doc, isPrivate: true }))
    
    if (page.value === 1) {
      documents.value = privateData
    } else {
      documents.value.push(...privateData)
    }
  } catch (error) {
    console.error('加载私密文档失败:', error)
  } finally {
    loading.value = false
  }
}

// 加载分类
async function loadCategories() {
  try {
    const response = await api.documents.categories()
    categories.value = response.data?.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
  }
}

// 创建分类
async function handleCreateCategory() {
  if (!newCategoryName.value.trim()) {
    toast.warning('请输入分类名称')
    return
  }
  
  try {
    await api.documents.createCategory({ name: newCategoryName.value.trim() })
    toast.success('创建成功')
    newCategoryName.value = ''
    createCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    toast.error(error.response?.data?.message || '创建失败')
  }
}

// 进入分类
function enterCategory(cat) {
  currentCategoryId.value = cat.id
  categoryPath.value.push(cat)
  page.value = 1
  documents.value = []
  loadDocuments()
}

// 返回上级
function handleBack() {
  if (categoryPath.value.length > 0) {
    categoryPath.value.pop()
    if (categoryPath.value.length === 0) {
      currentCategoryId.value = null
    } else {
      currentCategoryId.value = categoryPath.value[categoryPath.value.length - 1].id
    }
    page.value = 1
    documents.value = []
    loadDocuments()
  }
}

// 搜索
function handleSearch() {
  page.value = 1
  documents.value = []
  loadDocuments()
}

// 加载更多
function loadMore() {
  page.value++
  loadDocuments()
}

// 查找分类
function findCategoryById(categories, id) {
  for (const cat of categories) {
    if (cat.id === id) return cat
    if (cat.subcategories?.length) {
      const found = findCategoryById(cat.subcategories, id)
      if (found) return found
    }
  }
  return null
}

// 预览类型判断函数
function getPreviewType(ext) {
  const markdownFiles = ['md', 'markdown', 'mdown', 'mkd']
  const codeFiles = {
    'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
    'py': 'python', 'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp',
    'cs': 'csharp', 'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
    'swift': 'swift', 'kt': 'kotlin', 'scala': 'scala', 'sql': 'sql',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
    'xml': 'xml', 'html': 'html', 'htm': 'html', 'css': 'css',
    'scss': 'scss', 'sass': 'sass', 'less': 'less',
    'json': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml',
    'ini': 'ini', 'conf': 'ini', 'cfg': 'ini'
  }

  if (ext === 'pdf') return { type: 'pdf', language: 'pdf' }
  else if (markdownFiles.includes(ext)) return { type: 'markdown', language: 'markdown' }
  else if (codeFiles[ext]) return { type: 'code', language: codeFiles[ext] }
  else if (['txt', 'log', 'csv', 'tsv'].includes(ext)) return { type: 'text', language: 'plaintext' }
  else if (['doc', 'docx'].includes(ext)) return { type: 'office', language: 'word' }
  else if (['ppt', 'pptx'].includes(ext)) return { type: 'office', language: 'ppt' }
  else if (['xls', 'xlsx'].includes(ext)) return { type: 'office', language: 'excel' }
  else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return { type: 'image', language: 'image' }
  else return { type: 'unsupported', language: 'plaintext' }
}

// Office图标/标签工具函数
function getOfficeIconName(type) {
  const icons = { 'word': 'file-word', 'ppt': 'file-ppt', 'excel': 'file-excel' }
  return icons[type] || 'file'
}
function getOfficeTypeLabel(type) {
  const labels = { 'word': 'Word', 'ppt': 'PowerPoint', 'excel': 'Excel' }
  return labels[type] || 'Office'
}

// base64转Uint8Array
function base64ToUint8Array(base64) {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i)
  return bytes
}

// 加载Office文档内容
async function loadOfficeContent(base64Content, ext) {
  try {
    const binaryString = atob(base64Content)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)
    const arrayBuffer = bytes.buffer

    if (ext === 'docx') {
      const result = await mammoth.convertToHtml({ arrayBuffer })
      previewContent.value = result.value
      previewType.value = 'word-html'
      previewLoading.value = false
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      const html = XLSX.utils.sheet_to_html(worksheet, { editable: false })
      previewContent.value = html
      previewType.value = 'excel-html'
      previewLoading.value = false
    } else {
      previewType.value = 'office'
      previewLoading.value = false
    }
  } catch (error) {
    console.error('加载Office文档失败:', error)
    previewType.value = 'office'
    previewLoading.value = false
  }
}

// PDF渲染相关函数
async function loadPDFDocument(pdfData) {
  try {
    const pdfjs = await loadPdfJS()
    let uint8Array = pdfData
    if (typeof pdfData === 'string') uint8Array = base64ToUint8Array(pdfData)

    pdfDoc.value = await pdfjs.getDocument(uint8Array).promise
    totalPages.value = pdfDoc.value.numPages
    currentPage.value = 1
    // 注意: 不在此处渲染和关闭loading，由previewDocument统一控制
    // （先停止loading让canvas挂载到DOM，再nextTick，再renderPage）
  } catch (error) {
    console.error('PDF加载失败:', error)
    toast.error('PDF加载失败')
    previewLoading.value = false
  }
}

async function renderPage(pageNum) {
  if (!pdfDoc.value || !pdfCanvas.value) return
  try {
    const page = await pdfDoc.value.getPage(pageNum)
    const canvas = pdfCanvas.value
    const ctx = canvas.getContext('2d')
    const viewport = page.getViewport({ scale: 2.2 })
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: ctx, viewport }).promise
  } catch (e) {
    console.error('渲染页面失败:', e)
  }
}

function prevPage() {
  if (currentPage.value > 1) { currentPage.value--; renderPage(currentPage.value) }
}
function nextPage() {
  if (currentPage.value < totalPages.value) { currentPage.value++; renderPage(currentPage.value) }
}

// 下载文件
function handleDownloadFile() {
  const doc = documents.value.find(d => d.id === previewDocumentId.value)
  if (!doc) return
  const token = localStorage.getItem('token') || sessionStorage.getItem('token')
  // 根据是否是私密文档使用不同的下载链接
  const downloadUrl = doc.isPrivate
    ? `/api/documents/secure/download/${doc.id}?token=${token}&download=1`
    : `/api/documents/${doc.id}/content?token=${token}&download=1`
  window.open(downloadUrl, '_blank')
}

// 预览文档（与PC端逻辑完全对齐）
async function previewDocument(doc) {
  try {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    // 游客也可以预览（不需要token检查，游客登录时也有token）

    // 标记该条目为loading状态
    previewingDocIds.value.add(doc.id)

    const ext = getFileExtension(doc.filePath).toLowerCase()

    // 图片文件走 t-image-viewer 弹窗
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
      try {
        const response = doc.isPrivate ? await api.documents.getPrivateContent(doc.id) : await api.documents.getContent(doc.id)
        const data = response.data || {}
        if (data.isBase64 && data.content) {
          currentDoc.value = doc; previewContent.value = data.content
          previewIsBase64.value = true; previewType.value = 'image'
          previewFileName.value = doc.title || getFileNameWithExt(doc)
          previewLoading.value = false; previewDialogVisible.value = true
          previewingDocIds.value.delete(doc.id)
          return
        }
      } catch (e) { console.warn('图片base64获取失败，回退URL模式') }
      currentDoc.value = doc
      // 私密文档使用不同的图片预览链接
      previewImageUrl.value = doc.isPrivate
        ? `/api/documents/docs/special/view/${doc.id}?token=${token}`
        : `/api/documents/${doc.id}/content?token=${token}`
      imagePreviewVisible.value = true
      previewingDocIds.value.delete(doc.id)
      return
    }

    // 获取内容
    const response = doc.isPrivate ? await api.documents.getPrivateContent(doc.id) : await api.documents.getContent(doc.id)
    const data = response.data || {}
    const content = data.content || ''
    const isBase64 = data.isBase64 || false

    // 数据到达，打开弹窗并显示内部loading
    previewingDocIds.value.delete(doc.id)
    previewDialogVisible.value = true; previewLoading.value = true
    previewContent.value = ''; previewFileName.value = doc.title || getFileNameWithExt(doc)
    previewDocumentId.value = doc.id; pdfDoc.value = null; currentPage.value = 1; totalPages.value = 0

    // 根据扩展名确定预览类型
    const previewInfo = getPreviewType(ext)
    previewType.value = previewInfo.type
    previewLanguage.value = previewInfo.language

    if (previewType.value === 'pdf') {
      // 先加载PDF文档
      const pdfData = isBase64 ? base64ToUint8Array(content) : content
      await loadPDFDocument(pdfData)
      previewLoading.value = false
      await nextTick()
      await renderPage(currentPage.value)
    } else if (isBase64) {
      if (previewType.value === 'image') {
        previewContent.value = content; previewIsBase64.value = true; previewLoading.value = false
      } else if (previewType.value === 'office') {
        await loadOfficeContent(content, ext)
      } else {
        previewType.value = 'unsupported'; previewLoading.value = false
      }
    } else {
      previewContent.value = content; previewLoading.value = false
    }
  } catch (error) {
    previewingDocIds.value.clear()
    console.error('预览失败:', error); previewLoading.value = false
    if (error.response?.status === 400) previewType.value = 'unsupported'
    else toast.error('预览失败: ' + (error.message || '未知错误'))
  }
}

// 显示操作菜单
function showActionMenu(doc) {
  currentDoc.value = doc
  actionMenuVisible.value = true
}

// 关闭预览
function closePreview() {
  previewDialogVisible.value = false
  previewContent.value = ''
  previewType.value = ''
  highlightedCode.value = ''
  if (pdfDoc.value) {
    pdfDoc.value.destroy()
    pdfDoc.value = null
  }
}

// 点击/长按手势检测
// @click → 直接打开预览
// touchstart/touchend → 检测长按, 长按触发后设标志位阻止click合成

let _longPressState = { timer: null, triggered: false }

function onDocTouchStart(event, doc) {
  const t = event.touches[0]
  let moved = false

  function onMove(e) {
    const touch = e.touches[0]
    if (Math.abs(touch.clientX - t.clientX) > 10 || Math.abs(touch.clientY - t.clientY) > 10) {
      moved = true
      cleanup()
    }
  }
  function onEnd() { cleanup() }
  function cleanup() {
    clearTimeout(_longPressState.timer)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
  }

  document.addEventListener('touchmove', onMove, { passive: true })
  document.addEventListener('touchend', onEnd, { passive: true })

  _longPressState.triggered = false
  _longPressState.timer = setTimeout(() => {
    if (!moved) {
      _longPressState.triggered = true
      if (isGuest.value) return
      if (navigator.vibrate) navigator.vibrate(30)
      if (!batchMode.value) enterBatchMode(doc.id)
      cleanup()
    }
  }, 500)
}

function onDocTouchEnd() {
  clearTimeout(_longPressState.timer)
}

// 文档条目点击（由@click触发）
function onDocItemClick(doc, event) {
  // 如果点击了三点菜单（或菜单内的图标），忽略这次点击
  if (event && event.target && event.target.closest('.action-menu')) {
    return
  }
  if (_longPressState.triggered) {
    _longPressState.triggered = false
    return
  }
  if (batchMode.value) {
    toggleSelect(doc.id)
    return
  }
  previewDocument(doc)
}

// 处理操作选择
function handleActionSelect(item) {
  const doc = currentDoc.value
  if (!doc) return
  
  // 关闭菜单
  actionMenuVisible.value = false
  
  switch (item.value) {
    case 'versions':
      handleViewVersions(doc)
      break
    case 'edit':
      handleChangeSingle(doc)
      break
  }
}

// 删除确认弹窗状态
const deleteConfirmVisible = ref(false)

// 点击删除按钮
function handleDeleteClick() {
  actionMenuVisible.value = false
  deleteConfirmVisible.value = true
}

// 确认删除
async function confirmDelete() {
  const doc = currentDoc.value
  if (!doc) return
  
  deleteConfirmVisible.value = false
  await handleDelete(doc.id)
}

// 进入批量模式
function enterBatchMode(firstId) {
  batchMode.value = true
  selectedDocuments.value = [firstId]
}

// 退出批量模式
function exitBatchMode() {
  batchMode.value = false
  selectedDocuments.value = []
}

// 选择切换
function toggleSelect(id) {
  const index = selectedDocuments.value.indexOf(id)
  if (index > -1) {
    selectedDocuments.value.splice(index, 1)
  } else {
    selectedDocuments.value.push(id)
  }
}

// 是否选中
function isSelected(id) {
  return selectedDocuments.value.includes(id)
}

// 查看版本
async function handleViewVersions(doc) {
  try {
    const response = await api.documents.versions(doc.id)
    versions.value = response.data?.data || []
    versionsDialogVisible.value = true
  } catch (error) {
    toast.error('加载版本失败')
  }
}

// 单条编辑
function handleChangeSingle(doc) {
  currentDoc.value = doc
  batchEditForm.value = {
    categoryPath: doc.subcategory ? `${doc.category}/${doc.subcategory}` : (doc.category || ''),
    tags: doc.tags || ''
  }
  batchEditDialogVisible.value = true
}

// 批量编辑确认
async function handleBatchEditConfirm() {
  const ids = batchMode.value ? selectedDocuments.value : [currentDoc.value?.id]
  
  if (!ids || ids.length === 0) {
    toast.warning('请选择文档')
    return
  }
  
  try {
    const updateData = { ids }
    
    if (batchEditForm.value.categoryPath) {
      const pathParts = batchEditForm.value.categoryPath.split('/')
      updateData.category = pathParts[0]
      updateData.subcategory = pathParts.length > 1 ? pathParts.slice(1).join('/') : ''
    }
    
    if (batchEditForm.value.tags) {
      updateData.tags = batchEditForm.value.tags
    }
    
    await api.documents.batchUpdate(updateData)
    toast.success('更改成功')
    batchEditDialogVisible.value = false
    selectedDocuments.value = []
    batchMode.value = false
    loadDocuments()
    loadCategories()
  } catch (error) {
    toast.error('更改失败')
  }
}

// 批量删除
async function handleBatchDelete() {
  if (selectedDocuments.value.length === 0) {
    toast.warning('请选择要删除的文档')
    return
  }
  
  try {
    await Promise.all(selectedDocuments.value.map(id => api.documents.delete(id)))
    toast.success('删除成功')
    selectedDocuments.value = []
    batchMode.value = false
    loadDocuments()
    loadCategories()
  } catch (error) {
    toast.error('删除失败')
  }
}

// 单条删除
async function handleDelete(id) {
  try {
    await api.documents.delete(id)
    toast.success('删除成功')
    loadDocuments()
    loadCategories()
  } catch (error) {
    toast.error('删除失败')
  }
}

// 重命名
async function handleRename(doc) {
  // 简化版：直接弹出输入框
  const newName = prompt('请输入新文件名:', doc.title)
  if (!newName || newName === doc.title) return
  
  try {
    await api.documents.update(doc.id, { title: newName })
    toast.success('重命名成功')
    loadDocuments()
  } catch (error) {
    toast.error('重命名失败')
  }
}

// 上传
async function handleUpload() {
  if (uploadFiles.value.length === 0) {
    toast.warning('请选择文件')
    return
  }
  
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', uploadFiles.value[0].raw)
    formData.append('title', uploadForm.value.title || uploadFiles.value[0].name)
    
    if (uploadForm.value.categoryPath) {
      const pathParts = uploadForm.value.categoryPath.split('/')
      formData.append('category', pathParts[0])
      if (pathParts.length > 1) {
        formData.append('subcategory', pathParts.slice(1).join('/'))
      }
    }
    
    if (uploadForm.value.tags) {
      formData.append('tags', uploadForm.value.tags)
    }
    
    await api.documents.upload(formData)
    toast.success('上传成功')
    uploadDialogVisible.value = false
    uploadFiles.value = []
    uploadForm.value = { title: '', tags: '', categoryPath: '' }
    loadDocuments()
    loadCategories()
  } catch (error) {
    toast.error('上传失败')
  } finally {
    uploading.value = false
  }
}

function handleUploadSuccess() {
  // 上传成功回调
}

function handleUploadFail() {
  toast.error('上传失败')
}

// 恢复版本
async function restoreVersion(ver) {
  try {
    await api.documents.update(currentDoc.value.id, { version: ver.version })
    toast.success('恢复成功')
    versionsDialogVisible.value = false
    loadDocuments()
  } catch (error) {
    toast.error('恢复失败')
  }
}

// 预览版本
function previewVersion(ver) {
  // 简化处理：打开对应版本的文件
  const token = localStorage.getItem('token') || sessionStorage.getItem('token')
  const url = `/api/documents/${currentDoc.value.id}/content?token=${token}&version=${ver.version}`
  window.open(url, '_blank')
}

// 工具函数

function getFileExtension(fileName) {
  if (!fileName) return ''
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function getFileNameWithExt(doc) {
  if (!doc.filePath) return doc.title
  const ext = getFileExtension(doc.filePath)
  if (ext && !doc.title.toLowerCase().endsWith(`.${ext}`)) {
    return `${doc.title}.${ext}`
  }
  return doc.title
}

function getFileIcon(filePath) {
  const ext = getFileExtension(filePath)
  const iconMap = {
    'pdf': 'file-pdf',
    'doc': 'file-text',
    'docx': 'file-text',
    'xls': 'file-text',
    'xlsx': 'file-text',
    'ppt': 'file-text',
    'pptx': 'file-text',
    'txt': 'file-text',
    'md': 'file-text',
    'log': 'file-text',
    'csv': 'file-text',
    'jpg': 'image',
    'jpeg': 'image',
    'png': 'image',
    'gif': 'image'
  }
  return iconMap[ext] || 'file'
}

function getFileIconClass(filePath) {
  const ext = getFileExtension(filePath)
  return `file-icon-${ext}`
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseTags(tagsStr) {
  if (!tagsStr) return []
  return tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean)
}

function getImageMimeType(fileName) {
  if (!fileName) return 'png'
  const ext = fileName.split('.').pop().toLowerCase()
  const mimeMap = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
  return mimeMap[ext] || 'png'
}

// 计算属性

const categoryOptions = computed(() => {
  const options = []
  const buildOptions = (categories, prefix = '') => {
    for (const cat of categories) {
      const path = prefix ? `${prefix}/${cat.name}` : cat.name
      options.push({ label: path, value: path })
      if (cat.subcategories?.length) {
        buildOptions(cat.subcategories, path)
      }
    }
  }
  buildOptions(categories.value)
  return options
})

// 生命周期

onMounted(() => {
  loadCategories()
  loadDocuments()
})

// 监听视图模式变化
watch(viewMode, (newMode) => {
  if (newMode !== 'private' || privateAccessGranted.value) {
    page.value = 1
    documents.value = []
    loadDocuments()
  }
})
</script>

<style scoped>
.mobile-documents {
  padding: 12px;
  min-height: 100vh;
  background: #f5f5f5;
}

.mobile-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.mobile-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.view-mode-tabs {
  display: flex;
  background: #fff;
  border-radius: 8px;
  padding: 4px;
  margin-bottom: 12px;
}

.tab-item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 0;
  border-radius: 6px;
  font-size: 13px;
  color: #666;
  transition: all 0.2s;
}

.tab-item.active {
  background: #0052d9;
  color: #fff;
}

.search-bar {
  margin-bottom: 12px;
}

.batch-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #e6f2ff;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 8px;
}

.batch-actions-space {
  display: flex;
  gap: 8px;
}

.batch-info {
  font-size: 13px;
  color: #333;
  font-weight: 500;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.section-title .count {
  font-size: 12px;
  color: #999;
  font-weight: normal;
}

.categories-section {
  margin-bottom: 16px;
}

/* 主分类列表（小图标风格，与子分类统一） */
.category-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.category-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #fff;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 13px;
  color: #333;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.category-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #1976d2;
}

.empty-categories {
  padding: 8px 0 16px 4px;
}

.empty-text {
  color: #999;
  font-size: 12px;
}

.category-name {
  font-size: 13px;
  font-weight: 500;
  color: #333;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.file-count {
  font-size: 11px;
  color: #999;
}

.subcategories-section {
  margin-bottom: 16px;
}

.subcategory-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.subcategory-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #fff;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 13px;
  color: #333;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.documents-section {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
}

.document-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.document-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.2s;
}

.document-item:last-child {
  border-bottom: none;
}

.document-item.selected {
  background: #e6f2ff;
}

/* 预览中状态：条目显示loading效果 */
.document-item.previewing {
  opacity: 0.6;
  pointer-events: none;
  position: relative;
}
/* 预览时条目右侧的转圈loading */
.item-loading-spinner {
  flex-shrink: 0;
  padding: 4px 8px;
}

/* 游客模式：不显示操作区域 */
.document-item.guest-mode {
  cursor: default;
}

.checkbox {
  flex-shrink: 0;
}

/* 去掉多选框点击阴影 */
.checkbox :deep(.t-checkbox),
.checkbox-right :deep(.t-checkbox) {
  box-shadow: none !important;
  -webkit-tap-highlight-color: transparent;
}

/* 图片预览弹窗 */
.native-image-preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-image-preview-container {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-image-preview-container img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.close-preview-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.file-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #f5f5f5;
  color: #666;
}

.file-icon-pdf { color: #e53935; }
.file-icon-doc, .file-icon-docx { color: #1e88e5; }
.file-icon-xls, .file-icon-xlsx { color: #43a047; }
.file-icon-ppt, .file-icon-pptx { color: #fb8c00; }
.file-icon-jpg, .file-icon-jpeg, .file-icon-png, .file-icon-gif { color: #8e24aa; }
.file-icon-txt, .file-icon-md { color: #546e7a; }

.file-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.file-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #999;
  overflow: hidden;
}

.file-meta .divider {
  color: #ddd;
}

.file-tags {
  color: #0052d9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 80px;
}

.file-tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.action-menu {
  flex-shrink: 0;
  padding: 12px 10px;
  color: #999;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.load-more {
  text-align: center;
  padding: 16px 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 0;
  color: #999;
}

.empty-state p {
  margin-top: 12px;
  font-size: 14px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

/* 弹窗样式 */
.edit-popup,
.versions-popup,
.preview-popup {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.popup-header h3 {
  margin: 0;
  font-size: 16px;
}

/* 对话框底部按钮 */
.dialog-footer-btns {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.upload-form,
.edit-form {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.mt-4 {
  margin-top: 16px;
}

.popup-footer-btns {
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.versions-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.version-item {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  min-height: 44px;
  gap: 12px;
}

.version-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.version-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.version-num {
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.version-date {
  font-size: 12px;
  color: #999;
}

.version-note {
  font-size: 13px;
  color: #666;
  line-height: 1.4;
}

.version-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* 版本预览按钮 - 网站统一风格 */
.version-preview-btn {
  padding: 6px 16px;
  font-size: 13px;
  color: #fff;
  background: #0052d9;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.version-preview-btn:hover {
  background: #003bb3;
}

.version-preview-btn:active {
  background: #002d8a;
}

.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 1px;
}

.text-preview {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 14px;
  line-height: 1.6;
  color: #333;
}
.text-preview pre {
  margin: 0;
  padding: 0;
}

/* Markdown 预览样式（MdPreview组件移动端适配） */
.mobile-md-preview {
  border: none;
  box-shadow: none;
}
.mobile-md-preview :deep(.md-editor-preview) {
  padding: 0 2px;
}

/* PDF预览 */
.pdf-preview {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pdf-preview canvas {
  max-width: 100%;
  border: 1px solid #ddd;
  border-radius: 4px;
}
.pdf-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 8px;
  font-size: 13px;
  color: #666;
}

/* 代码预览 */
.code-preview {
  background: #282c34;
  border-radius: 4px;
  overflow-x: auto;
}
.code-preview pre {
  margin: 0;
  padding: 8px 6px;
}
.code-preview code {
  color: #abb2bf;
  font-size: 13px;
  line-height: 1.5;
}

/* Office文档预览 */
.office-toolbar {
  margin-bottom: 12px;
}
.office-content {
  overflow-x: auto;
}
.office-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.office-content table td,
.office-content table th {
  border: 1px solid #ddd;
  padding: 4px 6px;
}
.office-preview, .unsupported-preview {
  text-align: center;
  padding: 32px 0;
  color: #999;
}
.office-preview h3 {
  margin: 12px 0 8px;
  font-size: 16px;
  color: #333;
}
.office-preview p {
  margin-bottom: 16px;
  font-size: 14px;
}

/* 右侧多选框 */
.checkbox-right {
  padding: 8px;
}

/* 预览弹窗 - 全屏显示 */
.mobile-documents :deep(.preview-fullscreen-dialog) {
  margin: 0 !important;
  width: 100vw !important;
  max-width: 100vw !important;
  min-width: 100vw !important;
  max-height: calc(100vh - env(safe-area-inset-top)) !important;
  padding: 0 !important;
}
/* Dialog 每一层容器的 padding 全部清零 */
.mobile-documents :deep(.t-dialog__ctx) {
  padding: 0 !important;
}
.mobile-documents :deep(.t-dialog__position) {
  padding: 0 !important;
}
.mobile-documents :deep(.t-dialog__wrap) {
  align-items: flex-start !important;
  padding: 0 !important;
}
/* 标题区：只保留上下padding，左右归零 */
.mobile-documents :deep(.preview-fullscreen-dialog .t-dialog__header) {
  padding: 12px 8px 8px !important;
  margin: 0 !important;
}
/* 内容区：只保留上边距，左右下全部归零 */
.mobile-documents :deep(.preview-fullscreen-dialog .t-dialog__body) {
  max-height: calc(calc(100vh - env(safe-area-inset-top)) - 52px) !important;
  overflow-y: auto;
  padding: 4px 0 0 0 !important;
  margin: 0 !important;
  scrollbar-width: thin;
}
/* 压缩滚动条 */
.mobile-documents :deep(.preview-fullscreen-dialog .t-dialog__body::-webkit-scrollbar) {
  width: 3px;
}
.mobile-documents :deep(.preview-fullscreen-dialog .t-dialog__body::-webkit-scrollbar-track) {
  background: transparent;
}
.mobile-documents :deep(.preview-fullscreen-dialog .t-dialog__body::-webkit-scrollbar-thumb) {
  background: rgba(0,0,0,0.2);
  border-radius: 2px;
}
</style>

/* ==================== 全局样式：TDesign Dialog 兜底覆盖 ==================== */
<style>
/* TDesign Dialog 最外层遮罩层 - 铺满屏幕 */
.t-dialog__ctx,
.t-overlay {
  padding: 0 !important;
  margin: 0 !important;
}
.t-dialog__position {
  padding: 0 !important;
  margin: 0 !important;
  width: 100vw !important;
  max-width: 100vw !important;
}
.t-dialog__wrap {
  padding: 0 !important;
  margin: 0 !important;
}
/* 预览弹窗本身 - 使用 !important 层层覆盖 */
.t-dialog.preview-fullscreen-dialog {
  width: 100vw !important;
  max-width: 100vw !important;
  min-width: 100vw !important;
  margin: 0 !important;
  padding: 0 !important;
  border-radius: 0 !important;
}
/* 标题区 */
.t-dialog.preview-fullscreen-dialog .t-dialog__header {
  padding: 12px 4px 8px !important;
  margin: 0 !important;
}
/* 内容区 - 关键：左右padding设为0 */
.t-dialog.preview-fullscreen-dialog .t-dialog__body {
  padding: 4px 0 0 0 !important;
  margin: 0 !important;
}
/* 内容区内部 */
.preview-fullscreen-dialog .preview-body {
  padding: 0 !important;
  margin: 0 !important;
}
.preview-fullscreen-dialog .text-preview pre {
  margin: 0 !important;
  padding: 0 !important;
}
.preview-fullscreen-dialog .code-preview pre {
  padding: 4px 0 !important;
}
/* ==================== 原生全屏预览弹窗样式（最大化显示面积）==================== */
.native-preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.native-preview-container {
  display: flex;
  flex-direction: column;
  background: #fff;
  overflow: hidden;
  border-radius: 8px;
  width: 100%;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  /* 小文件时根据内容自适应高度，不超过屏幕 */
  height: auto;
}
.native-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #fff;
  color: #333;
  font-size: 16px;
  flex-shrink: 0;
  border-bottom: 1px solid #eee;
}
.preview-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 16px;
}
.preview-close {
  font-size: 28px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
  color: #999;
}
.preview-close:active {
  color: #fff;
}
.native-preview-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
  background: #fff;
}
/* 内容区各种预览类型适配 */
.native-preview-body .pdf-preview {
  width: 100%;
  padding: 0;
}
.native-preview-body .pdf-preview canvas {
  width: 100% !important;
  height: auto !important;
  display: block;
}
.native-preview-body .mobile-md-preview,
.native-preview-body .code-preview,
.native-preview-body .text-preview {
  width: 100%;
  padding: 8px 4px;
}
.native-preview-body .code-preview pre {
  margin: 0;
  padding: 8px 4px;
}
.native-preview-body .text-preview pre {
  margin: 0;
  padding: 8px 4px;
  color: #333;
}
.native-preview-body .image-preview img {
  max-width: 100%;
  display: block;
  margin: 0 auto;
}
.native-preview-body .office-content {
  padding: 8px 4px;
  color: #333;
}
.native-preview-body .office-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.native-preview-body .office-content table td,
.native-preview-body .office-content table th {
  border: 1px solid #ddd;
  padding: 6px 8px;
  color: #333;
}

/* 原生底部操作菜单 */
.native-action-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 10000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

/* 原生对话框（垂直居中） */
.native-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.native-dialog-container {
  background: #fff;
  border-radius: 12px;
  width: 90%;
  max-width: 400px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.native-dialog-container.small {
  width: 80%;
  max-width: 320px;
}
.native-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid #eee;
}
.dialog-close {
  font-size: 24px;
  color: #999;
  cursor: pointer;
}
.native-dialog-footer {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-top: 1px solid #eee;
}
.native-dialog-footer button {
  flex: 1;
  padding: 12px;
  border-radius: 6px;
  border: none;
  font-size: 15px;
  cursor: pointer;
}
.btn-cancel {
  background: #f5f5f5;
  color: #666;
}
.btn-confirm {
  background: #0052d9;
  color: #fff;
}
.btn-confirm.delete {
  background: #e34d59;
}
.delete-confirm-content {
  padding: 24px 16px;
  text-align: center;
}
.delete-confirm-content p {
  margin: 0 0 8px;
  font-size: 15px;
}
.delete-warning {
  color: #e34d59;
  font-size: 13px;
}
.native-action-sheet {
  background: #fff;
  border-radius: 12px 12px 0 0;
  padding: 16px 0 0;
  animation: slideUp 0.2s ease-out;
}
@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
.action-sheet-title {
  text-align: center;
  font-size: 14px;
  color: #999;
  padding: 8px 16px 16px;
  border-bottom: 1px solid #f0f0f0;
}
.action-sheet-list {
  padding: 8px 0;
}
.action-sheet-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  font-size: 16px;
  color: #333;
  cursor: pointer;
  transition: background 0.2s;
}
.action-sheet-item:active {
  background: #f5f5f5;
}
.action-sheet-item.delete {
  color: #e34d59;
}
.action-sheet-item.delete:active {
  background: #fff0f0;
}
.action-sheet-cancel {
  text-align: center;
  padding: 16px 20px;
  font-size: 16px;
  color: #666;
  border-top: 8px solid #f5f5f5;
  cursor: pointer;
}
.action-sheet-cancel:active {
  background: #f5f5f5;
}
</style>

/* ==================== 全局样式：对话框垂直居中 ==================== */
<style>
/* TDesign Dialog 垂直居中 */
.centered-dialog .t-dialog__wrap {
  align-items: center !important;
  justify-content: center !important;
  display: flex !important;
}
.centered-dialog .t-dialog__position {
  align-items: center !important;
  justify-content: center !important;
  display: flex !important;
  padding-top: 0 !important;
}
</style>
