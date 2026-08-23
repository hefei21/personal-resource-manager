<template>
  <div class="books-mobile">
    <!-- 搜索栏 -->
    <div v-if="!showTrash" class="search-section">
      <div class="search-bar">
        <input
          v-model="searchKeyword"
          placeholder="搜索书名或作者..."
          @keyup.enter="handleSearch"
        />
        <svg class="search-icon" viewBox="0 0 24 24" @click="handleSearch">
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
      </div>
    </div>

    <!-- 分类标签栏 -->
    <div class="category-tabs">
      <div class="tab-scroll">
        <div
          class="tab-item"
          :class="{ active: !showTrash && !currentCategoryId }"
          @click="selectCategory(null)"
        >
          <span>全部</span>
        </div>
        <div
          v-for="category in validCategories"
          :key="category.id"
          class="tab-item"
          :class="{ active: !showTrash && currentCategoryId === category.id }"
          @click="selectCategory(category)"
        >
          <span>{{ category.name }}</span>
        </div>
        <div v-if="!isGuest && !showTrash" class="tab-item add-btn" @click="showCreateCategory = true">
          <span>+</span>
        </div>
        <div
          class="tab-item trash-tab"
          :class="{ active: showTrash }"
          @click="toggleTrash"
        >
          <span>{{ showTrash ? '返回书库' : '回收站' }}</span>
        </div>
      </div>
    </div>

    <!-- 书籍网格 -->
    <div v-if="!showTrash" class="books-container">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="books.length === 0" class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24">
          <path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/>
        </svg>
        <p>暂无书籍</p>
        <p v-if="!isGuest" class="hint">点击右下角按钮上传</p>
      </div>

      <div v-else class="books-grid">
        <div
          v-for="book in books"
          :key="book.id"
          class="book-card"
          @click="handleRead(book)"
        >
          <div class="book-cover">
            <img v-if="book.coverImage" :src="getCoverUrl(book)" :alt="book.title" @error="handleCoverError($event, book)" />
            <div v-else class="cover-placeholder">
              <svg viewBox="0 0 24 24" width="32" height="32">
                <path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/>
              </svg>
            </div>
            <!-- 阅读进度 -->
            <div v-if="book.progress > 0" class="progress-badge">
              {{ Math.round(book.progress) }}%
            </div>
          </div>
          <div class="book-info">
            <div class="book-title" :title="book.title">{{ book.title }}</div>
            <div class="book-author">{{ book.author || '未知作者' }}</div>
            <div v-if="metadataStatusLabel(book.metadataStatus)" class="metadata-status" :class="`is-${book.metadataStatus}`">
              {{ metadataStatusLabel(book.metadataStatus) }}
            </div>
          </div>
          <div v-if="!isGuest" class="book-card-actions" @click.stop>
            <NativeButton v-if="canReparseBook(book)" theme="default" variant="outline" size="small"
              :loading="metadataReparseLoading[book.id]" @click="handleMetadataReparse(book)">
              <template #icon><NativeIcon name="arrow-clockwise" /></template>
              重解析
            </NativeButton>
            <NativePopconfirm content="确定将这本书移入回收站吗？" @confirm="handleDelete(book.id)">
              <template #trigger>
                <NativeButton theme="danger" variant="outline" size="small">
                  <template #icon><NativeIcon name="trash" /></template>
                  移入回收站
                </NativeButton>
              </template>
            </NativePopconfirm>
          </div>
        </div>
      </div>
    </div>

    <!-- 电子书回收站 -->
    <div v-else class="trash-container">
      <div class="trash-heading">
        <span>电子书回收站</span>
        <span class="trash-hint">普通删除默认保留 30 天</span>
      </div>
      <div v-if="trashLoading" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>
      <div v-else-if="trashBooks.length === 0" class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24">
          <path fill="currentColor" d="M3 6h18v2H3V6zm2 3h14v11H5V9zm3-6h6l1 2H7l1-2z"/>
        </svg>
        <p>回收站为空</p>
      </div>
      <div v-else class="trash-list">
        <div v-for="item in trashBooks" :key="item.id" class="trash-item">
          <div class="trash-item-info">
            <div class="trash-item-title">{{ item.title }}</div>
            <div class="trash-item-meta">
              {{ item.author || '未知作者' }} · {{ item.originalCategoryName || '未分类' }} · {{ formatTrashDate(item.deletedAt) }}
            </div>
          </div>
          <NativeButton
            theme="primary"
            size="small"
            @click.stop="handleRestoreTrash(item.id)"
            :disabled="isGuest"
          >
            恢复
          </NativeButton>
        </div>
      </div>
    </div>

    <!-- 浮动上传按钮 -->
    <button v-if="!isGuest && !showTrash" class="fab-upload" @click="handleUpload">
      <svg viewBox="0 0 24 24" width="24" height="24">
        <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
      </svg>
    </button>

    <!-- 创建分类弹窗（原生实现） -->
    <div v-if="showCreateCategory" class="modal-overlay" @click.self="showCreateCategory = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>新建分类</h3>
          <button class="close-btn" @click="showCreateCategory = false">×</button>
        </div>
        <div class="modal-body">
          <input
            v-model="newCategoryName"
            placeholder="请输入分类名称"
            @keyup.enter="confirmCreateCategory"
            ref="categoryInput"
          />
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showCreateCategory = false">取消</button>
          <button
            class="btn-confirm"
            :disabled="creatingCategory || !newCategoryName.trim()"
            @click="confirmCreateCategory"
          >
            {{ creatingCategory ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 提示消息（原生实现） -->
    <div v-if="toastMessage" class="toast" :class="toastType">
      {{ toastMessage }}
    </div>

    <!-- 阅读器 -->
    <BookReader
      v-model:visible="readerVisible"
      :book="currentBook"
      @close="handleReaderClose"
    />

    <!-- 上传书籍对话框（原生实现） -->
    <div v-if="showUploadDialog" class="modal-overlay upload-modal" @click.self="closeUploadDialog">
      <div class="modal-content upload-content">
        <div class="modal-header">
          <h3>上传书籍</h3>
          <button class="close-btn" @click="closeUploadDialog">×</button>
        </div>
        <div class="modal-body upload-body">
          <!-- 文件选择 -->
          <div class="form-item">
            <label class="form-label">文件 <span class="required">*</span></label>
            <div class="file-selector">
              <input
                type="file"
                ref="fileInput"
                accept=".txt,.epub,.pdf,.mobi,.azw,.azw3"
                @change="handleFileSelect"
                style="display: none"
              />
              <button class="btn-file-select" @click="$refs.fileInput.click()" :disabled="parsingMetadata">
                <svg v-if="!parsingMetadata" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
                </svg>
                <span v-else class="btn-spinner"></span>
                {{ parsingMetadata ? '解析中...' : (selectedFileName || '选择文件') }}
              </button>
            </div>
            <p v-if="!parsingMetadata" class="file-hint">支持 .txt, .epub, .pdf, .mobi, .azw, .azw3</p>
            <p v-else class="parsing-hint">正在解析书籍信息...</p>
          </div>

          <!-- 书名 -->
          <div class="form-item">
            <label class="form-label">书名 <span class="required">*</span></label>
            <input v-model="uploadForm.title" placeholder="书籍名称" class="form-input" />
          </div>

          <!-- 作者 -->
          <div class="form-item">
            <label class="form-label">作者</label>
            <input v-model="uploadForm.author" placeholder="作者" class="form-input" />
          </div>

          <!-- 年份 -->
          <div class="form-item">
            <label class="form-label">年份</label>
            <input v-model="uploadForm.year" placeholder="出版年份" class="form-input" type="number" />
          </div>

          <!-- 出版社 -->
          <div class="form-item">
            <label class="form-label">出版社</label>
            <input v-model="uploadForm.publisher" placeholder="出版社" class="form-input" />
          </div>

          <!-- 分类 -->
          <div class="form-item">
            <label class="form-label">分类</label>
            <select v-model="uploadForm.categoryId" class="form-select">
              <option :value="null">无分类</option>
              <option v-for="cat in categories" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="closeUploadDialog">取消</button>
          <button
            class="btn-confirm"
            :disabled="uploading || parsingMetadata || !uploadForm.title.trim() || !selectedFile"
            @click="confirmUpload"
          >
            {{ uploading ? '上传中...' : '确定' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { useAuthStore } from '@/stores/auth'
import BookReader from '@/mobile/components/BookReader.vue'
import { NativeButton, NativeIcon, NativePopconfirm } from '@/components/native'

const authStore = useAuthStore()
const route = useRoute()
const isGuest = computed(() => authStore.isGuest())

// 搜索
const searchKeyword = ref('')

// 分类
const categories = ref([])
const currentCategoryId = ref(null)
const showTrash = ref(false)
const trashBooks = ref([])
const trashLoading = ref(false)
const showCreateCategory = ref(false)
const newCategoryName = ref('')
const creatingCategory = ref(false)
const categoryInput = ref(null)

// 过滤后的有效分类
const validCategories = computed(() => {
  if (!Array.isArray(categories.value)) return []
  return categories.value.filter(c => c && c.id && c.name)
})

// 书籍列表
const books = ref([])
const loading = ref(false)

// 阅读器
const readerVisible = ref(false)
const currentBook = ref(null)

// 原生提示
const toastMessage = ref('')
const toastType = ref('success')
let toastTimer = null

// 上传对话框
const showUploadDialog = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const selectedFileName = ref('')
const parsingMetadata = ref(false)
const uploading = ref(false)
const metadataReparseLoading = ref({})
const uploadForm = ref({
  title: '',
  author: '',
  year: '',
  publisher: '',
  categoryId: null
})

function showToast(message, type = 'success') {
  toastMessage.value = message
  toastType.value = type
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
  }, 2500)
}

// 初始化
onMounted(async () => {
  await Promise.all([loadCategories(), loadBooks()])
  const bookId = Number(route.query.bookId)
  if (Number.isSafeInteger(bookId) && bookId > 0) {
    const book = books.value.find((item) => Number(item.id) === bookId)
    if (book) {
      const chapterIndex = Number(route.query.chapterIndex)
      handleRead({
        ...book,
        ...(Number.isSafeInteger(chapterIndex) && chapterIndex >= 0 ? { searchChapterIndex: chapterIndex } : {})
      })
    }
  }
})

// 监听弹窗显示，自动聚焦输入框
watch(showCreateCategory, (val) => {
  if (val) {
    nextTick(() => {
      categoryInput.value?.focus()
    })
  }
})

// 加载分类
async function loadCategories() {
  try {
    const response = await api.books.getCategories()
    // API返回 {data: [...]} 结构
    categories.value = response.data?.data || response.data || []
  } catch (error) {
    console.error('[BooksMobile] 加载分类失败:', error)
  }
}

// 选择分类
function selectCategory(category) {
  showTrash.value = false
  currentCategoryId.value = category?.id || null
  loadBooks()
}

async function toggleTrash() {
  if (showTrash.value) {
    showTrash.value = false
    await loadBooks()
    return
  }

  currentCategoryId.value = null
  showTrash.value = true
  await loadTrashBooks()
}

// 创建分类
async function confirmCreateCategory() {
  if (!newCategoryName.value.trim()) {
    showToast('请输入分类名称', 'warning')
    return
  }
  creatingCategory.value = true
  try {
    await api.books.createCategory({ name: newCategoryName.value.trim() })
    showToast('创建成功')
    newCategoryName.value = ''
    showCreateCategory.value = false
    await loadCategories()
  } catch (error) {
    showToast(error.response?.data?.message || '创建失败', 'error')
  } finally {
    creatingCategory.value = false
  }
}

// 搜索
function handleSearch() {
  loadBooks()
}

// 加载书籍
async function loadBooks() {
  loading.value = true
  try {
    const params = {
      keyword: searchKeyword.value,
      sortBy: 'last_read_at',
      sortOrder: 'desc'
    }
    // 后端API使用'category'作为参数名，不是'categoryId'
    if (currentCategoryId.value) {
      params.category = Number(currentCategoryId.value)
    }
    console.log('[BooksMobile] 加载书籍参数:', params, '当前分类ID:', currentCategoryId.value)
    const response = await api.books.list(params)
    // API返回 {data: [...]} 结构
    books.value = response.data?.data || response.data || []
  } catch (error) {
    console.error('[BooksMobile] 加载书籍失败:', error)
    showToast('加载失败', 'error')
  } finally {
    loading.value = false
  }
}

async function loadTrashBooks() {
  trashLoading.value = true
  try {
    const response = await api.books.trash()
    trashBooks.value = response.data?.data || []
  } catch (error) {
    console.error('[BooksMobile] 加载回收站失败:', error)
    showToast(error.response?.data?.message || '加载回收站失败', 'error')
    trashBooks.value = []
  } finally {
    trashLoading.value = false
  }
}

async function handleDelete(id) {
  try {
    await api.books.delete(id)
    showToast('已移入回收站')
    await loadBooks()
  } catch (error) {
    console.error('[BooksMobile] 移入回收站失败:', error)
    showToast(error.response?.data?.message || '移入回收站失败', 'error')
  }
}

async function handleRestoreTrash(id) {
  try {
    await api.books.restoreTrash(id)
    showToast('书籍已恢复')
    await Promise.all([loadTrashBooks(), loadCategories(), loadBooks()])
  } catch (error) {
    console.error('[BooksMobile] 恢复书籍失败:', error)
    showToast(error.response?.data?.message || '恢复书籍失败', 'error')
  }
}

function formatTrashDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

// 获取封面URL
function getCoverUrl(book) {
  if (book.coverImage) {
    return authenticatedAssetUrl(`/api/ebooks/${book.id}/cover`)
  }
  return null
}

// 封面加载失败处理
function handleCoverError(event, book) {
  event.target.style.display = 'none'
  book.coverImage = null
}

// 打开上传对话框
function handleUpload() {
  // 重置表单
  selectedFile.value = null
  selectedFileName.value = ''
  uploadForm.value = {
    title: '',
    author: '',
    year: '',
    publisher: '',
    categoryId: currentCategoryId.value || null
  }
  showUploadDialog.value = true
}

// 关闭上传对话框
function closeUploadDialog() {
  if (uploading.value || parsingMetadata.value) return
  showUploadDialog.value = false
}

// 处理文件选择
async function handleFileSelect(e) {
  const file = e.target.files[0]
  if (!file) return

  selectedFile.value = file
  selectedFileName.value = file.name

  // 设置默认标题（去除扩展名）
  uploadForm.value.title = file.name.replace(/\.[^/.]+$/, '')

  // 如果是EPUB文件，自动解析元数据
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'epub') {
    await parseBookMetadata(file)
  }
}

// 解析书籍元数据
async function parseBookMetadata(file) {
  parsingMetadata.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.books.parseMetadata(formData)
    const metadata = response.data?.data

    if (metadata) {
      if (metadata.title) uploadForm.value.title = metadata.title
      if (metadata.author) uploadForm.value.author = metadata.author
      if (metadata.year) uploadForm.value.year = metadata.year
      if (metadata.publisher) uploadForm.value.publisher = metadata.publisher
      showToast('书籍信息已自动填充', 'success')
    }
  } catch (error) {
    console.error('解析元数据失败:', error)
    showToast('自动解析失败，请手动填写', 'warning')
  } finally {
    parsingMetadata.value = false
  }
}

// 确认上传
async function confirmUpload() {
  if (uploading.value || parsingMetadata.value) return
  if (!selectedFile.value || !uploadForm.value.title.trim()) {
    showToast('请选择文件并填写书名', 'warning')
    return
  }

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', selectedFile.value)
    formData.append('title', uploadForm.value.title.trim())
    if (uploadForm.value.author) formData.append('author', uploadForm.value.author)
    if (uploadForm.value.year) formData.append('year', uploadForm.value.year)
    if (uploadForm.value.publisher) formData.append('publisher', uploadForm.value.publisher)
    if (uploadForm.value.categoryId) formData.append('categoryId', uploadForm.value.categoryId)

    const response = await api.books.upload(formData)
    const metadataStatus = response.data?.metadataStatus
    showToast(
      metadataStatus === 'pending'
        ? '上传成功，元数据将在后台重解析'
        : metadataStatus === 'failed'
          ? '上传成功，元数据解析失败，可稍后手动重试'
          : '上传成功',
      metadataStatus === 'pending' || metadataStatus === 'failed' ? 'warning' : 'success'
    )
    showUploadDialog.value = false
    loadBooks()
  } catch (error) {
    console.error('上传失败:', error)
    showToast(error.response?.data?.message || '上传失败', 'error')
  } finally {
    uploading.value = false
  }
}

// 阅读书籍
function handleRead(book) {
  currentBook.value = book
  readerVisible.value = true
}

// 阅读器关闭
function handleReaderClose() {
  readerVisible.value = false
  currentBook.value = null
  // 刷新列表以更新进度
  loadBooks()
}


function canReparseBook(book) {
  return String(book?.fileType || '').toLowerCase() === 'epub'
}

function metadataStatusLabel(status) {
  return ({ pending: '元数据排队中', partial: '元数据不完整', failed: '元数据解析失败' })[status] || ''
}

async function handleMetadataReparse(book) {
  if (!canReparseBook(book) || metadataReparseLoading.value[book.id]) return
  metadataReparseLoading.value[book.id] = true
  try {
    await api.books.reparseMetadata(book.id)
    showToast('元数据重解析任务已加入队列')
  } catch (error) {
    if (error.response?.status === 409 && error.response?.data?.activeConflict) {
      showToast('该书的元数据重解析任务已在运行', 'warning')
    } else {
      showToast(error.response?.data?.message || '元数据重解析任务创建失败', 'error')
    }
  } finally {
    metadataReparseLoading.value[book.id] = false
    await loadBooks()
  }
}

</script>

<style scoped>
.books-mobile {
  padding: 12px;
  min-height: 100vh;
  background: #f5f5f5;
}

/* 搜索栏 */
.search-section {
  margin-bottom: 12px;
}

.search-bar {
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 8px;
  padding: 8px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.search-bar input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 14px;
  background: transparent;
}

.search-icon {
  width: 20px;
  height: 20px;
  color: #999;
  cursor: pointer;
  margin-left: 8px;
}

/* 分类标签栏 */
.category-tabs {
  margin-bottom: 16px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.tab-scroll {
  display: flex;
  gap: 8px;
  padding-bottom: 4px;
  overflow-x: scroll;
  /* 隐藏滚动条但保留滚动功能 */
  scrollbar-width: none !important; /* Firefox */
  -ms-overflow-style: none !important; /* IE 10+ */
}

/* 隐藏Webkit滚动条 */
.tab-scroll::-webkit-scrollbar,
.tab-scroll::-webkit-scrollbar-track,
.tab-scroll::-webkit-scrollbar-thumb {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  background: transparent !important;
}

.tab-item {
  flex-shrink: 0;
  padding: 6px 14px;
  background: #fff;
  border-radius: 16px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.tab-item.active {
  background: #0052d9;
  color: #fff;
}

.trash-tab {
  color: #666;
}

.tab-item.add-btn {
  background: #e7e7e7;
  color: #666;
  font-weight: bold;
  padding: 6px 12px;
}

/* 书籍容器 */
.books-container {
  min-height: 300px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #999;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #e7e7e7;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty-icon {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.hint {
  font-size: 12px;
  margin-top: 8px;
}

/* 书籍网格 - 改为3列 */
.books-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.book-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: transform 0.2s;
}

.book-card:active {
  transform: scale(0.98);
}

.book-cover {
  position: relative;
  aspect-ratio: 3 / 4;
  background: #e7e7e7;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.book-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  color: #ccc;
}

.progress-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 4px;
}

.book-info {
  padding: 8px;
}

.book-card-actions {
  display: flex;
  padding: 0 8px 8px;
}

.book-card-actions :deep(.native-btn) {
  width: 100%;
  font-size: 11px;
}

.book-title {
  font-size: 12px;
  font-weight: 500;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.3;
  min-height: 31px;
}

.book-author {
  font-size: 11px;
  color: #999;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 回收站 */
.trash-container {
  min-height: 300px;
}

.trash-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
  color: #333;
  font-size: 16px;
  font-weight: 500;
}

.trash-hint {
  color: #999;
  font-size: 11px;
  font-weight: 400;
}

.trash-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.trash-item-info {
  flex: 1;
  min-width: 0;
}

.trash-item-title {
  overflow: hidden;
  color: #333;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-item-meta {
  margin-top: 4px;
  overflow: hidden;
  color: #999;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 浮动上传按钮 */
.fab-upload {
  position: fixed;
  right: 20px;
  bottom: calc(20px + var(--player-height, 0px));
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #0052d9;
  color: #fff;
  border: none;
  box-shadow: 0 4px 12px rgba(0, 82, 217, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
  z-index: 100;
}

.fab-upload:active {
  transform: scale(0.95);
}

/* 原生弹窗样式 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: #fff;
  border-radius: 12px;
  width: 80%;
  max-width: 300px;
  overflow: hidden;
  animation: modal-in 0.2s ease;
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #eee;
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  color: #999;
  cursor: pointer;
  line-height: 1;
}

.modal-body {
  padding: 16px;
}

.modal-body input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
}

.modal-body input:focus {
  outline: none;
  border-color: #0052d9;
}

.modal-footer {
  display: flex;
  padding: 12px 16px;
  gap: 12px;
  border-top: 1px solid #eee;
}

.btn-cancel,
.btn-confirm {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  border: none;
}

.btn-cancel {
  background: #f5f5f5;
  color: #666;
}

.btn-confirm {
  background: #0052d9;
  color: #fff;
}

.btn-confirm:disabled {
  background: #ccc;
  cursor: not-allowed;
}

/* 原生提示样式 */
.toast {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 14px;
  color: #fff;
  z-index: 2000;
  animation: fade-in-out 2.5s ease;
}

.toast.success {
  background: rgba(0, 0, 0, 0.8);
}

.toast.error {
  background: rgba(227, 77, 89, 0.9);
}

.toast.warning {
  background: rgba(255, 165, 0, 0.9);
}

.toast.info {
  background: rgba(0, 82, 217, 0.9);
}

@keyframes fade-in-out {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
  10% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  90% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
}

/* 上传对话框样式 */
.upload-modal .modal-content {
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.upload-body {
  overflow-y: auto;
  flex: 1;
  padding: 16px;
}

.form-item {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 14px;
  color: #333;
  margin-bottom: 6px;
  font-weight: 500;
}

.form-label .required {
  color: #e34d59;
}

.form-input,
.form-select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
  background: #fff;
}

.form-input:focus,
.form-select:focus {
  outline: none;
  border-color: #0052d9;
}

.file-selector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.btn-file-select {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  background: #f5f5f5;
  border: 1px dashed #ccc;
  border-radius: 6px;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-file-select:active:not(:disabled) {
  background: #e8e8e8;
}

.btn-file-select:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #999;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.file-hint {
  font-size: 12px;
  color: #999;
  margin: 4px 0 0 0;
}

.parsing-hint {
  font-size: 12px;
  color: #0052d9;
  margin: 4px 0 0 0;
}
.metadata-status {
  margin-top: 4px;
  font-size: 11px;
  color: var(--native-color-text-secondary, #666);
}

.metadata-status.is-pending { color: #b26a00; }
.metadata-status.is-failed { color: #c62828; }

</style>
