<template>
  <div class="books">
    <div class="page-header">
      <p>管理电子书，支持在线阅读</p>
    </div>

    <!-- 搜索栏和排序 -->
    <t-card>
      <t-space direction="vertical" style="width: 100%">
        <div class="search-sort-row">
          <t-input
            v-model="searchKeyword"
            placeholder="搜索书名或作者..."
            clearable
            @clear="loadBooks"
            @enter="loadBooks"
            style="flex: 1"
          >
            <template #suffix-icon>
              <t-icon name="search" />
            </template>
          </t-input>

          <t-select
            v-model="sortBy"
            placeholder="排序方式"
            style="width: 140px"
            @change="loadBooks"
          >
            <t-option value="last_read_at" label="最近阅读" />
            <t-option value="title" label="书名" />
            <t-option value="author" label="作者" />
            <t-option value="year" label="年份" />
            <t-option value="updated_at" label="上传时间" />
          </t-select>

          <t-button
            variant="outline"
            @click="toggleSortOrder"
            shape="circle"
            :title="sortOrder === 'desc' ? '降序' : '升序'"
          >
            <template #icon>
              <t-icon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" />
            </template>
          </t-button>

          <!-- 视图切换 -->
          <t-button-group>
            <t-button
              :variant="viewMode === 'cover' ? 'base' : 'outline'"
              @click="viewMode = 'cover'"
              title="封面视图"
            >
              <template #icon><t-icon name="view-module" /></template>
            </t-button>
            <t-button
              :variant="viewMode === 'list' ? 'base' : 'outline'"
              @click="viewMode = 'list'"
              title="列表视图"
            >
              <template #icon><t-icon name="view-list" /></template>
            </t-button>
          </t-button-group>
        </div>

        <t-space>
          <!-- 批量操作按钮 -->
          <t-popconfirm
            v-if="selectedRowKeys.length > 0"
            content="确定删除选中的书籍吗？"
            @confirm="handleBatchDelete"
          >
            <t-button theme="danger" variant="outline">
              <template #icon><t-icon name="delete" /></template>
              批量删除 ({{ selectedRowKeys.length }})
            </t-button>
          </t-popconfirm>

          <!-- 创建分类按钮 -->
          <t-button
            v-if="!currentCategoryId"
            theme="default"
            @click="handleCreateCategory"
          >
            <template #icon><t-icon name="folder-add" /></template>
            创建分类
          </t-button>

          <!-- 上传书籍按钮 -->
          <t-button
            v-if="!currentCategoryId"
            theme="primary"
            @click="handleUpload"
          >
            <template #icon><t-icon name="add" /></template>
            上传书籍
          </t-button>

          <!-- 查找资源按钮 -->
          <t-button
            v-if="!currentCategoryId"
            theme="warning"
            variant="outline"
            @click="showBookSearch = true"
          >
            <template #icon><t-icon name="search" /></template>
            查找资源
          </t-button>

          <!-- 返回按钮 -->
          <t-button v-if="currentCategoryId" @click="backToRoot">
            <t-icon name="arrow-left" /> 返回
          </t-button>
        </t-space>
      </t-space>
    </t-card>

    <!-- 分类浏览 -->
    <t-card v-if="!currentCategoryId" class="category-view">
      <div v-if="categories.length === 0" class="empty-categories">
        <t-icon name="folder-open" size="64px" />
        <h3>还没有分类</h3>
        <p>创建第一个分类来开始管理书籍</p>
        <t-button theme="primary" size="large" @click="handleCreateCategory">
          <template #icon><t-icon name="folder-add" /></template>
          创建第一个分类
        </t-button>
      </div>
      <div v-else class="categories-grid">
        <div
          v-for="(cat, index) in categories"
          :key="cat.id"
          class="category-card"
          draggable="true"
          @click="enterCategory(cat)"
          @dragstart="handleDragStart($event, cat, index)"
          @dragover.prevent="handleDragOver($event, cat)"
          @drop="handleDrop($event, cat, index)"
          @dragend="handleDragEnd"
        >
          <t-icon name="folder" size="48px" />
          <h3>{{ cat.name }}</h3>
          <div class="book-count">{{ cat.bookCount }} 本书</div>
          <div class="rename-handle" @click.stop="handleRenameCategory(cat)">
            <t-icon name="edit" size="14px" />
          </div>
          <div class="delete-handle" @click.stop="handleDeleteCategory(cat)">
            <t-icon name="close" size="16px" />
          </div>
        </div>
      </div>
    </t-card>

    <!-- 书籍列表（列表视图） -->
    <t-card v-if="books.length > 0 && viewMode === 'list'" class="books-list">
      <h3 v-if="currentCategoryId" class="section-title">
        {{ currentCategoryName }} - 书籍列表
      </h3>
      <h3 v-else class="section-title">
        所有书籍
      </h3>

      <t-table
        :data="books"
        :columns="columns"
        :loading="loading"
        row-key="id"
        hover
        :selected-row-keys="selectedRowKeys"
        @select-change="handleSelectChange"
      >
        <template #progress="{ row }">
          <t-progress
            :percentage="Math.round(row.progress * 100) / 100"
            :label="true"
            size="small"
            style="width: 120px"
          />
        </template>
        <template #operation="{ row }">
          <t-space>
            <t-button theme="primary" size="small" @click="handleRead(row)">
              <t-icon name="book" /> 阅读
            </t-button>
            <t-button theme="default" size="small" @click="handleEditBook(row)">
              <t-icon name="edit" /> 编辑
            </t-button>
            <t-button theme="default" size="small" @click="handleDownload(row)">
              <t-icon name="download" /> 下载
            </t-button>
            <t-popconfirm
              content="确定删除吗？"
              @confirm="handleDelete(row.id)"
            >
              <t-button theme="danger" variant="outline" size="small">
                <t-icon name="delete" /> 删除
              </t-button>
            </t-popconfirm>
          </t-space>
        </template>
      </t-table>
    </t-card>

    <!-- 书籍封面视图 -->
    <t-card v-if="books.length > 0 && viewMode === 'cover'" class="books-cover-view">
      <h3 v-if="currentCategoryId" class="section-title">
        {{ currentCategoryName }} - 书籍列表
      </h3>
      <h3 v-else class="section-title">
        所有书籍
      </h3>

      <div class="books-grid">
        <div
          v-for="book in books"
          :key="book.id"
          class="book-card"
          @click="handleRead(book)"
        >
          <div class="book-cover">
            <img
              v-if="book.coverImage"
              :src="getCoverUrl(book)"
              :alt="book.title"
              loading="lazy"
              @error="handleCoverError($event, book)"
            />
            <div v-else class="cover-placeholder">
              <t-icon name="book" size="48px" />
              <span class="book-type">{{ getFileTypeLabel(book.fileType) }}</span>
            </div>
          </div>
          <div class="book-info">
            <h4 class="book-title" :title="book.title">{{ book.title }}</h4>
            <p class="book-author" v-if="book.author">{{ book.author }}</p>
            <div class="book-progress" v-if="book.progress > 0">
              <t-progress
                :percentage="Math.round(book.progress * 100) / 100"
                :label="true"
                size="small"
              />
            </div>
          </div>
          <div class="book-actions">
            <t-button size="small" @click.stop="handleEditBook(book)">
              <t-icon name="edit" />
            </t-button>
            <t-popconfirm
              content="确定删除吗？"
              @confirm="handleDelete(book.id)"
            >
              <t-button size="small" theme="danger" variant="outline" @click.stop>
                <t-icon name="delete" />
              </t-button>
            </t-popconfirm>
          </div>
        </div>
      </div>
    </t-card>

    <!-- 空状态 -->
    <t-card v-if="books.length === 0 && !loading && currentCategoryId" class="empty-state">
      <t-icon name="book" size="64px" />
      <p>当前分类下暂无书籍</p>
      <t-button theme="primary" @click="handleUpload">上传第一本书</t-button>
    </t-card>
    <t-card v-else-if="books.length === 0 && !loading && !currentCategoryId && categories.length > 0" class="empty-state">
      <t-icon name="book" size="64px" />
      <p>暂无书籍</p>
      <t-button theme="primary" @click="handleUpload">上传第一本书</t-button>
    </t-card>

    <!-- 创建分类对话框 -->
    <t-dialog
      v-model:visible="createCategoryDialogVisible"
      header="创建分类"
      @confirm="handleCreateCategoryConfirm"
      width="400px"
    >
      <t-form :data="categoryForm" :rules="categoryRules">
        <t-form-item label="分类名称" name="name" required>
          <t-input v-model="categoryForm.name" placeholder="请输入分类名称" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 重命名分类对话框 -->
    <t-dialog
      v-model:visible="renameCategoryDialogVisible"
      header="重命名分类"
      width="400px"
      @confirm="handleRenameCategoryConfirm"
    >
      <t-form>
        <t-form-item label="分类名称">
          <t-input v-model="renameCategoryName" placeholder="请输入新的分类名称" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 上传书籍对话框 -->
    <t-dialog
      v-model:visible="uploadDialogVisible"
      header="上传书籍"
      @confirm="handleUploadConfirm"
      width="600px"
      :confirm-btn="{ content: uploading ? '上传中...' : '确定', loading: uploading }"
      :close-on-overlay-click="!uploading"
      :close-btn="!uploading"
    >
      <t-form :data="uploadForm" :rules="uploadRules">
        <t-form-item label="文件" required>
          <t-upload
            v-model="uploadForm.file"
            theme="file-input"
            accept=".txt,.epub,.pdf,.mobi,.azw,.azw3,.fb2"
            :multiple="false"
            :auto-upload="false"
            :loading="parsingMetadata"
            @change="onFileChange"
          />
          <p v-if="parsingMetadata" style="color: #999; font-size: 12px; margin-top: 4px;">
            正在解析书籍信息，请稍候...
          </p>
        </t-form-item>
        <t-form-item label="书名" name="title" required>
          <t-input v-model="uploadForm.title" placeholder="书籍名称" />
        </t-form-item>
        <t-form-item label="作者">
          <t-input v-model="uploadForm.author" placeholder="作者" />
        </t-form-item>
        <t-form-item label="年份">
          <t-input v-model="uploadForm.year" placeholder="出版年份" />
        </t-form-item>
        <t-form-item label="出版社">
          <t-input v-model="uploadForm.publisher" placeholder="出版社" />
        </t-form-item>
        <t-form-item label="ISBN">
          <t-input v-model="uploadForm.isbn" placeholder="ISBN" />
        </t-form-item>
        <t-form-item label="分类">
          <t-select
            v-model="uploadForm.categoryId"
            placeholder="选择分类（可选）"
            clearable
          >
            <t-option v-for="cat in categories" :key="cat.id" :value="cat.id" :label="cat.name" />
          </t-select>
        </t-form-item>
        <t-form-item label="简介">
          <t-textarea
            v-model="uploadForm.description"
            placeholder="书籍简介"
            :maxlength="1000"
            :autosize="{ minRows: 3, maxRows: 5 }"
          />
        </t-form-item>
      </t-form>
      <!-- 上传进度条 -->
      <div v-if="uploading" class="upload-progress-container">
        <t-progress
          :percentage="uploadProgress"
          :label="true"
          theme="line"
          :stroke-width="12"
        />
        <p class="upload-status-text">正在上传，请稍候...</p>
      </div>
    </t-dialog>

    <!-- 编辑书籍对话框 -->
    <t-dialog
      v-model:visible="editBookDialogVisible"
      header="编辑书籍信息"
      @confirm="handleEditBookConfirm"
      width="600px"
    >
      <t-form :data="editBookForm">
        <t-form-item label="书名">
          <t-input v-model="editBookForm.title" placeholder="书籍名称" />
        </t-form-item>
        <t-form-item label="作者">
          <t-input v-model="editBookForm.author" placeholder="作者" />
        </t-form-item>
        <t-form-item label="年份">
          <t-input v-model="editBookForm.year" placeholder="出版年份" />
        </t-form-item>
        <t-form-item label="出版社">
          <t-input v-model="editBookForm.publisher" placeholder="出版社" />
        </t-form-item>
        <t-form-item label="ISBN">
          <t-input v-model="editBookForm.isbn" placeholder="ISBN" />
        </t-form-item>
        <t-form-item label="分类">
          <t-select
            v-model="editBookForm.categoryId"
            placeholder="选择分类"
            clearable
          >
            <t-option v-for="cat in categories" :key="cat.id" :value="cat.id" :label="cat.name" />
          </t-select>
        </t-form-item>
        <t-form-item label="简介">
          <t-textarea
            v-model="editBookForm.description"
            placeholder="书籍简介"
            :maxlength="1000"
            :autosize="{ minRows: 3, maxRows: 5 }"
          />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 阅读器对话框 -->
    <t-dialog
      v-model:visible="readerDialogVisible"
      :header="currentBook?.title || '阅读器'"
      width="1300px"
      :footer="false"
      top="10px"
      :close-on-overlay-click="false"
      @close="handleReaderClose"
    >
      <div class="reader-wrapper">
        <!-- 目录侧边栏 -->
        <div class="reader-sidebar" :class="{ 'sidebar-collapsed': !sidebarVisible }">
          <div class="sidebar-header">
            <span v-if="sidebarVisible">目录</span>
            <t-button size="small" variant="text" @click="sidebarVisible = !sidebarVisible">
              <t-icon :name="sidebarVisible ? 'chevron-left' : 'chevron-right'" />
            </t-button>
          </div>
          <div v-if="sidebarVisible" class="sidebar-content">
            <div v-if="bookToc.length === 0" class="empty-toc">
              <t-icon name="folder-open" size="32px" />
              <p>暂无目录</p>
            </div>
            <div v-else class="toc-list">
              <div
                v-for="(chapter, index) in bookToc"
                :key="index"
                class="toc-item"
                :class="{ 'toc-active': currentChapterIndex === chapter.chapterIndex }"
                :title="chapter.title"
                @click="jumpToChapter(chapter)"
              >
                {{ chapter.title }}
              </div>
            </div>
          </div>
        </div>

        <!-- 阅读器主内容 -->
        <div class="reader-main">
          <div class="reader-container">
            <!-- 阅读器工具栏 -->
            <div class="reader-toolbar">
              <div class="toolbar-row">
                <div class="toolbar-group">
                  <t-button size="small" @click="fontSize -= 2" :disabled="fontSize <= 12">
                    <t-icon name="remove" /> 字体-
                  </t-button>
                  <span class="font-size-display">{{ fontSize }}px</span>
                  <t-button size="small" @click="fontSize += 2" :disabled="fontSize >= 32">
                    <t-icon name="add" /> 字体+
                  </t-button>
                  <t-select v-model="fontFamily" style="width: 90px" size="small">
                    <t-option value="serif" label="宋体" />
                    <t-option value="sans-serif" label="黑体" />
                    <t-option value="kai" label="楷体" />
                  </t-select>
                </div>
                <t-divider layout="vertical" style="height: 24px; margin: 0 8px;" />
                <div class="toolbar-group">
                  <t-button size="small" @click="prevChapter" :disabled="currentChapterIndex <= 0">
                    <t-icon name="chevron-left" /> 上一章
                  </t-button>
                  <t-button size="small" @click="nextChapter" :disabled="currentChapterIndex >= bookChapters.length - 1">
                    下一章 <t-icon name="chevron-right" />
                  </t-button>
                </div>
              </div>
              <div class="toolbar-progress">
                <span class="progress-info">
                  {{ currentChapterIndex + 1 }} / {{ bookChapters.length }} 章
                </span>
                <t-button size="small" variant="outline" @click="refreshContent" title="重新解析（清除缓存）">
                  <t-icon name="refresh" />
                </t-button>
              </div>
            </div>

            <!-- 阅读内容 -->
            <div class="reader-content" :style="{ fontSize: fontSize + 'px', fontFamily: getFontFamily(fontFamily) }">
              <div v-if="readerLoading" class="loading-container">
                <t-loading text="加载中..." />
              </div>
              <div v-else class="book-paper">
                <div class="book-text" v-html="currentChapterContent"></div>
              </div>
            </div>

            <!-- 阅读器底部 -->
            <div class="reader-footer">
              <t-progress
                :percentage="chapterProgress"
                :label="false"
                size="small"
              />
            </div>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 电子书搜索弹窗 -->
    <BookSearchDialog v-model:visible="showBookSearch" />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'
import BookSearchDialog from '@/components/BookSearchDialog.vue'

const loading = ref(false)
const books = ref([])
const categories = ref([])
const showBookSearch = ref(false)  // 电子书搜索弹窗显示状态
const currentCategoryId = ref(null)
const currentCategoryName = ref('')
const searchKeyword = ref('')
const sortBy = ref('last_read_at')
const sortOrder = ref('desc')
const selectedRowKeys = ref([])
const viewMode = ref('cover') // 'list' 或 'cover'

// 分类相关
const createCategoryDialogVisible = ref(false)
const renameCategoryDialogVisible = ref(false)
const renameCategoryData = ref(null)
const renameCategoryName = ref('')
const categoryForm = ref({ name: '' })
const categoryRules = {
  name: [{ required: true, message: '请输入分类名称', type: 'error' }]
}

// 拖拽相关
const draggedCategoryIndex = ref(null)
const draggedCategoryData = ref(null)

// 上传相关
const uploadDialogVisible = ref(false)
const parsingMetadata = ref(false)
const uploadProgress = ref(0) // 上传进度百分比
const uploading = ref(false) // 上传中状态
const uploadedFilePath = ref(null) // 分片上传后的文件路径
const uploadForm = ref({
  file: [],
  title: '',
  author: '',
  year: '',
  publisher: '',
  isbn: '',
  description: '',
  categoryId: null
})
const uploadRules = {
  title: [{ required: true, message: '请输入书名', type: 'error' }],
  file: [{ required: true, message: '请选择文件', type: 'error' }]
}

// 编辑相关
const editBookDialogVisible = ref(false)
const editBookForm = ref({})

// 阅读器相关
const readerDialogVisible = ref(false)
const readerLoading = ref(false)
const currentBook = ref(null)
const bookChapters = ref([]) // 章节内容数组
const bookToc = ref([]) // 目录数组
const currentChapterIndex = ref(0)
const scrollPosition = ref(0) // 滚动位置（0-1）
const fontSize = ref(16)
const fontFamily = ref('sans-serif')
const sidebarVisible = ref(true) // 侧边栏显示状态
let scrollSaveTimer = null // 滚动保存定时器
let scrollListener = null // 滚动监听器引用
let isProgressLoaded = false // 进度是否已加载完成

// 表格列
const columns = [
  { colKey: 'row-select', type: 'multiple', width: 50 },
  { colKey: 'title', title: '书名', width: 200, ellipsis: true },
  { colKey: 'author', title: '作者', width: 120 },
  { colKey: 'year', title: '年份', width: 80 },
  { colKey: 'progress', title: '阅读进度', width: 150 },
  { colKey: 'lastReadAt', title: '最近阅读', width: 180 },
  { colKey: 'operation', title: '操作', width: 280 }
]

// 计算当前章节内容
const currentChapterContent = computed(() => {
  if (bookChapters.value.length === 0) return ''
  const chapter = bookChapters.value[currentChapterIndex.value]
  return chapter?.content || ''
})

// 计算阅读进度（章节 + 滚动位置）
const readingProgress = computed(() => {
  if (bookChapters.value.length === 0) return 0
  const chapterProgress = currentChapterIndex.value / bookChapters.value.length
  const scrollProgress = scrollPosition.value / bookChapters.value.length
  return (chapterProgress + scrollProgress) * 100
})

// 加载分类
async function loadCategories() {
  try {
    const response = await api.books.getCategories()
    categories.value = response.data?.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
    MessagePlugin.error('加载分类失败')
  }
}

// 加载书籍
async function loadBooks() {
  loading.value = true
  try {
    const params = {
      keyword: searchKeyword.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value
    }

    if (currentCategoryId.value) {
      params.category = currentCategoryId.value
    }

    const response = await api.books.list(params)
    books.value = response.data?.data || []
  } catch (error) {
    console.error('加载书籍失败:', error)
    MessagePlugin.error('加载书籍失败')
  } finally {
    loading.value = false
  }
}

// 切换排序顺序
function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'
  loadBooks()
}

// 处理表格选择
function handleSelectChange(selectedKeys) {
  selectedRowKeys.value = selectedKeys
}

// 进入分类
function enterCategory(cat) {
  currentCategoryId.value = cat.id
  currentCategoryName.value = cat.name
  loadBooks()
}

// 返回根目录
function backToRoot() {
  currentCategoryId.value = null
  currentCategoryName.value = ''
  loadBooks()
}

// 创建分类
function handleCreateCategory() {
  categoryForm.value = { name: '' }
  createCategoryDialogVisible.value = true
}

async function handleCreateCategoryConfirm() {
  try {
    if (!categoryForm.value.name.trim()) {
      MessagePlugin.error('请输入分类名称')
      return
    }

    await api.books.createCategory({ name: categoryForm.value.name.trim() })
    MessagePlugin.success('创建成功')
    createCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    console.error('创建分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '创建失败')
  }
}

// 重命名分类
function handleRenameCategory(cat) {
  renameCategoryData.value = cat
  renameCategoryName.value = cat.name
  renameCategoryDialogVisible.value = true
}

async function handleRenameCategoryConfirm() {
  try {
    if (!renameCategoryName.value.trim()) {
      MessagePlugin.error('请输入分类名称')
      return
    }

    await api.books.updateCategory(renameCategoryData.value.id, { name: renameCategoryName.value.trim() })
    MessagePlugin.success('重命名成功')
    renameCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    console.error('重命名失败:', error)
    MessagePlugin.error(error.response?.data?.message || '重命名失败')
  }
}

// 删除分类
async function handleDeleteCategory(cat) {
  try {
    await api.books.deleteCategory(cat.id)
    MessagePlugin.success('删除成功')
    loadCategories()
    loadBooks()
  } catch (error) {
    console.error('删除失败:', error)
    MessagePlugin.error(error.response?.data?.message || '删除失败')
  }
}

// 拖拽排序
function handleDragStart(event, cat, index) {
  draggedCategoryIndex.value = index
  draggedCategoryData.value = cat
  event.dataTransfer.effectAllowed = 'move'
  event.target.style.opacity = '0.5'
}

function handleDragOver(event, cat) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

async function handleDrop(event, targetCat, targetIndex) {
  event.preventDefault()

  if (!draggedCategoryData.value || draggedCategoryData.value.id === targetCat.id) {
    return
  }

  try {
    const reorderedCategories = [...categories.value]
    const [removed] = reorderedCategories.splice(draggedCategoryIndex.value, 1)
    reorderedCategories.splice(targetIndex, 0, removed)

    const orders = reorderedCategories.map((cat, idx) => ({
      id: cat.id,
      sortOrder: idx
    }))

    await api.books.reorderCategories({ orders })
    categories.value = reorderedCategories
    MessagePlugin.success('排序已更新')
  } catch (error) {
    console.error('更新排序失败:', error)
    MessagePlugin.error('更新排序失败')
  } finally {
    draggedCategoryIndex.value = null
    draggedCategoryData.value = null
  }
}

function handleDragEnd(event) {
  event.target.style.opacity = '1'
  draggedCategoryIndex.value = null
  draggedCategoryData.value = null
}

// 上传书籍
function handleUpload() {
  uploadForm.value = {
    file: [],
    title: '',
    author: '',
    year: '',
    publisher: '',
    isbn: '',
    description: '',
    categoryId: currentCategoryId.value || null
  }
  uploadedFilePath.value = null // 重置已上传文件路径
  uploadDialogVisible.value = true
}

function onFileChange(files) {
  if (files.length > 0) {
    const fileName = files[0].name
    const file = files[0]
    const ext = fileName.split('.').pop().toLowerCase()

    console.log('📁 文件已选择:', {
      文件名: fileName,
      文件类型: ext,
      文件大小: (file.size / 1024 / 1024).toFixed(2) + 'MB'
    })

    // 设置默认标题
    uploadForm.value.title = fileName.replace(/\.[^/.]+$/, '')

    // 如果是EPUB文件，自动解析元数据
    if (ext === 'epub') {
      console.log('📖 检测到EPUB文件，开始解析元数据...')
      parseBookMetadata(file)
    } else {
      console.log('📄 非EPUB文件，跳过元数据解析')
    }
  }
}

// 解析书籍元数据（使用分片上传）
async function parseBookMetadata(file) {
  parsingMetadata.value = true
  console.log('⏳ 正在解析EPUB元数据...')
  try {
    const fileToParse = file.raw || file.originFileObj || file
    const fileSize = fileToParse.size / 1024 / 1024

    // 大于100MB使用分片上传
    if (fileSize > 100) {
      console.log(`📦 文件较大(${fileSize.toFixed(2)}MB)，使用分片上传解析元数据`)
      const result = await uploadFileInChunks(fileToParse, true)
      console.log('📥 分片上传返回结果:', result)
      if (result && result.filePath) {
        uploadedFilePath.value = result.filePath
        // 检查是否有元数据（title、author等字段直接在result中）
        if (result.title || result.author || result.publisher) {
          fillMetadata(result)
          MessagePlugin.success('书籍信息已自动填充')
        } else {
          console.log('⚠️ 分片上传返回的元数据为空')
        }
      }
    } else {
      // 小文件直接上传
      const formData = new FormData()
      formData.append('file', fileToParse)

      const response = await api.books.parseMetadata(formData)
      const metadata = response.data?.data

      if (metadata) {
        fillMetadata(metadata)
        MessagePlugin.success('书籍信息已自动填充')
      } else {
        console.log('⚠️ 元数据解析返回为空')
      }
    }
  } catch (error) {
    console.error('❌ 解析元数据失败:', error)
    MessagePlugin.warning('自动解析失败，请手动填写信息')
  } finally {
    parsingMetadata.value = false
  }
}

// 填充元数据
function fillMetadata(metadata) {
  console.log('✅ 元数据解析成功:', {
    书名: metadata.title || '未读取到',
    作者: metadata.author || '未读取到',
    年份: metadata.year || '未读取到',
    出版社: metadata.publisher || '未读取到',
    ISBN: metadata.isbn || '未读取到',
    简介: metadata.description ? (metadata.description.substring(0, 50) + '...') : '未读取到'
  })

  if (metadata.title) uploadForm.value.title = metadata.title
  if (metadata.author) uploadForm.value.author = metadata.author
  if (metadata.year) uploadForm.value.year = metadata.year
  if (metadata.publisher) uploadForm.value.publisher = metadata.publisher
  if (metadata.isbn) uploadForm.value.isbn = metadata.isbn
  if (metadata.description) uploadForm.value.description = metadata.description
}

// 分片上传文件
async function uploadFileInChunks(file, isMetadataOnly = false) {
  const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB per chunk
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  console.log(`📤 开始分片上传: ${file.name}`)
  console.log(`📊 总大小: ${(file.size / 1024 / 1024).toFixed(2)}MB, 分片数: ${totalChunks}`)

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const chunk = file.slice(start, end)

      const formData = new FormData()
      formData.append('chunk', chunk)
      formData.append('index', i)
      formData.append('totalChunks', totalChunks)
      formData.append('fileId', fileId)
      formData.append('fileName', file.name)

      await api.books.uploadChunk(formData)

      const progress = Math.round(((i + 1) / totalChunks) * 100)
      console.log(`📦 分片 ${i + 1}/${totalChunks} 上传完成 (${progress}%)`)
    }

    // 合并分片
    console.log('🔧 正在合并分片...')
    const mergeResponse = await api.books.mergeChunks({
      fileId,
      fileName: file.name,
      totalChunks
    })

    console.log('✅ 分片合并完成，返回结果:', mergeResponse.data)
    return mergeResponse.data?.data
  } catch (error) {
    console.error('❌ 分片上传失败:', error)
    // 清理临时文件
    try {
      await api.books.cancelUpload(fileId)
    } catch (e) {
      // 忽略清理错误
    }
    throw error
  }
}

async function handleUploadConfirm() {
  try {
    if (!uploadForm.value.file || uploadForm.value.file.length === 0) {
      MessagePlugin.error('请选择文件')
      return
    }

    if (!uploadForm.value.title.trim()) {
      MessagePlugin.error('请输入书名')
      return
    }

    const file = uploadForm.value.file[0]
    const fileToUpload = file.raw || file.originFileObj || file
    const fileSize = fileToUpload.size / 1024 / 1024

    console.log('📤 开始上传书籍:', {
      书名: uploadForm.value.title,
      作者: uploadForm.value.author || '未填写',
      文件大小: fileSize.toFixed(2) + 'MB',
      文件类型: file.name.split('.').pop()
    })

    // 设置上传状态
    uploading.value = true
    uploadProgress.value = 0

    const startTime = Date.now()
    let response

    // 如果已经有上传的文件路径（分片上传已解析过元数据）
    if (uploadedFilePath.value) {
      console.log('📁 使用已上传的文件路径')
      // 直接调用上传接口，传递文件路径
      response = await api.books.uploadWithPath({
        filePath: uploadedFilePath.value,
        title: uploadForm.value.title.trim(),
        author: uploadForm.value.author || '',
        year: uploadForm.value.year || '',
        publisher: uploadForm.value.publisher || '',
        isbn: uploadForm.value.isbn || '',
        description: uploadForm.value.description || '',
        categoryId: uploadForm.value.categoryId || null
      })
    } else if (fileSize > 100) {
      // 大于100MB使用分片上传
      console.log('📦 文件较大，使用分片上传')
      uploadProgress.value = 50 // 显示处理中状态

      const result = await uploadFileInChunks(fileToUpload)
      if (result && result.filePath) {
        response = await api.books.uploadWithPath({
          filePath: result.filePath,
          title: uploadForm.value.title.trim(),
          author: uploadForm.value.author || '',
          year: uploadForm.value.year || '',
          publisher: uploadForm.value.publisher || '',
          isbn: uploadForm.value.isbn || '',
          description: uploadForm.value.description || '',
          categoryId: uploadForm.value.categoryId || null
        })
      }
      uploadProgress.value = 100
    } else {
      // 小文件直接上传
      const formData = new FormData()
      formData.append('file', fileToUpload)
      formData.append('title', uploadForm.value.title.trim())
      formData.append('author', uploadForm.value.author || '')
      formData.append('year', uploadForm.value.year || '')
      formData.append('publisher', uploadForm.value.publisher || '')
      formData.append('isbn', uploadForm.value.isbn || '')
      formData.append('description', uploadForm.value.description || '')
      if (uploadForm.value.categoryId) {
        formData.append('categoryId', uploadForm.value.categoryId)
      }

      const onUploadProgress = (progressEvent) => {
        if (progressEvent.total) {
          uploadProgress.value = Math.round((progressEvent.loaded / progressEvent.total) * 100)
          const loadedMB = (progressEvent.loaded / 1024 / 1024).toFixed(2)
          const totalMB = (progressEvent.total / 1024 / 1024).toFixed(2)
          console.log(`📊 上传进度: ${uploadProgress.value}% (${loadedMB}/${totalMB}MB)`)
        }
      }

      response = await api.books.upload(formData, onUploadProgress)
    }

    const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log('✅ 上传成功!', {
      耗时: uploadTime + '秒',
      平均速度: (fileSize / uploadTime).toFixed(2) + 'MB/s',
      返回数据: response.data
    })

    MessagePlugin.success('上传成功')
    uploadDialogVisible.value = false
    uploadedFilePath.value = null // 重置已上传文件路径
    loadCategories()
    loadBooks()
  } catch (error) {
    console.error('上传失败:', error)
    MessagePlugin.error(error.response?.data?.message || '上传失败')
  } finally {
    uploading.value = false
    uploadProgress.value = 0
  }
}

// 编辑书籍
function handleEditBook(row) {
  editBookForm.value = {
    id: row.id,
    title: row.title,
    author: row.author || '',
    year: row.year || '',
    publisher: row.publisher || '',
    isbn: row.isbn || '',
    description: row.description || '',
    categoryId: row.categoryId
  }
  editBookDialogVisible.value = true
}

async function handleEditBookConfirm() {
  try {
    await api.books.update(editBookForm.value.id, editBookForm.value)
    MessagePlugin.success('更新成功')
    editBookDialogVisible.value = false
    loadCategories() // 重新加载分类以更新书籍数量
    loadBooks()
  } catch (error) {
    console.error('更新失败:', error)
    MessagePlugin.error('更新失败')
  }
}

// 删除书籍
async function handleDelete(id) {
  try {
    await api.books.delete(id)
    MessagePlugin.success('删除成功')
    loadCategories()
    loadBooks()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 批量删除
async function handleBatchDelete() {
  if (selectedRowKeys.value.length === 0) {
    MessagePlugin.warning('请选择要删除的书籍')
    return
  }

  try {
    await api.books.batchDelete({ ids: selectedRowKeys.value })
    MessagePlugin.success('批量删除成功')
    selectedRowKeys.value = []
    loadCategories()
    loadBooks()
  } catch (error) {
    console.error('批量删除失败:', error)
    MessagePlugin.error('批量删除失败')
  }
}

// 下载书籍
function handleDownload(row) {
  const token = localStorage.getItem('token')
  if (token) {
    window.open(`${window.location.origin}/api/ebooks/download/${row.id}?token=${token}`, '_blank')
  } else {
    MessagePlugin.error('无法下载，未登录')
  }
}

// 阅读器
async function handleRead(row) {
  try {
    console.log('📖 打开阅读器:', {
      书名: row.title,
      ID: row.id,
      文件类型: row.fileType,
      文件路径: row.filePath
    })

    readerDialogVisible.value = true
    readerLoading.value = true
    isProgressLoaded = false // 进度尚未加载
    // 暂时不设置 currentBook，避免在进度加载完成前触发保存
    currentChapterIndex.value = 0
    scrollPosition.value = 0
    bookChapters.value = []
    bookToc.value = []
    fontSize.value = row.fontSize || 16

    // 获取书籍内容
    console.log('📖 正在获取书籍内容...')
    const contentResponse = await api.books.getContent(row.id)
    console.log('📖 内容响应:', contentResponse.data)

    // 处理新格式（章节列表）
    if (contentResponse.data?.chapters) {
      bookChapters.value = contentResponse.data.chapters
      bookToc.value = contentResponse.data.toc || []
      console.log('📖 章节数:', bookChapters.value.length)
      console.log('📖 目录数:', bookToc.value.length)
    } else if (contentResponse.data?.content) {
      // 兼容旧格式（纯文本）
      bookChapters.value = [{
        id: 'content',
        href: '',
        content: contentResponse.data.content.replace(/\n/g, '<br>')
      }]
    }

    if (bookChapters.value.length === 0) {
      console.warn('⚠️ 书籍内容为空')
    }

    // 获取阅读进度
    const progressResponse = await api.books.getProgress(row.id)
    if (progressResponse.data?.currentPage !== undefined) {
      currentChapterIndex.value = Math.min(progressResponse.data.currentPage, bookChapters.value.length - 1)
      scrollPosition.value = progressResponse.data.scrollPosition || 0
      console.log('📖 阅读进度已加载:', {
        章节: currentChapterIndex.value + 1,
        总章节: bookChapters.value.length,
        滚动位置: (scrollPosition.value * 100).toFixed(1) + '%'
      })
    }

    // 进度加载完成后再设置 currentBook，避免保存初始值
    currentBook.value = row
    isProgressLoaded = true // 进度已加载完成
    readerLoading.value = false

    // 恢复滚动位置（使用 nextTick 和重试机制）
    await nextTick()
    restoreScrollPositionWithRetry(0)
    setupScrollListener()
  } catch (error) {
    console.error('❌ 打开阅读器失败:', error)
    MessagePlugin.error(error.response?.data?.message || '打开阅读器失败')
    readerDialogVisible.value = false
    readerLoading.value = false
  }
}

// 恢复滚动位置（带重试机制和图片加载等待）
function restoreScrollPositionWithRetry(retryCount) {
  const readerContent = document.querySelector('.reader-content')
  if (!readerContent || scrollPosition.value <= 0) return
  
  const maxScroll = readerContent.scrollHeight - readerContent.clientHeight
  
  // 如果内容尚未渲染完成（scrollHeight 为 0 或很小），延迟重试
  if (maxScroll < 10 && retryCount < 20) {
    console.log(`⏳ 内容尚未渲染完成，重试中... (${retryCount + 1}/20)`)
    setTimeout(() => {
      restoreScrollPositionWithRetry(retryCount + 1)
    }, 100)
    return
  }
  
  // 检查是否有图片正在加载
  const images = readerContent.querySelectorAll('img')
  const loadingImages = Array.from(images).filter(img => !img.complete)
  
  if (loadingImages.length > 0 && retryCount < 20) {
    console.log(`🖼️ 等待 ${loadingImages.length} 张图片加载... (${retryCount + 1}/20)`)
    // 监听图片加载完成
    let loadedCount = 0
    loadingImages.forEach(img => {
      if (!img.complete) {
        img.onload = () => {
          loadedCount++
          if (loadedCount === loadingImages.length) {
            // 所有图片加载完成，重新计算并恢复滚动位置
            setTimeout(() => {
              const newMaxScroll = readerContent.scrollHeight - readerContent.clientHeight
              readerContent.scrollTop = newMaxScroll * scrollPosition.value
              console.log('✅ 图片加载完成，滚动位置已调整:', {
                新高度: readerContent.scrollHeight,
                滚动到: readerContent.scrollTop,
                百分比: (scrollPosition.value * 100).toFixed(1) + '%'
              })
            }, 50)
          }
        }
        img.onerror = () => {
          // 图片加载失败也计数
          loadedCount++
        }
      }
    })
    // 延迟重试以防图片加载时间过长
    setTimeout(() => {
      restoreScrollPositionWithRetry(retryCount + 1)
    }, 200)
    return
  }
  
  // 恢复滚动位置
  const targetScroll = maxScroll * scrollPosition.value
  readerContent.scrollTop = targetScroll
  console.log('✅ 滚动位置已恢复:', {
    总高度: readerContent.scrollHeight,
    可视高度: readerContent.clientHeight,
    滚动到: targetScroll,
    百分比: (scrollPosition.value * 100).toFixed(1) + '%'
  })
}

// 设置滚动监听
function setupScrollListener() {
  const readerContent = document.querySelector('.reader-content')
  if (!readerContent) return
  
  // 移除旧的监听器（如果存在）
  if (scrollListener) {
    readerContent.removeEventListener('scroll', scrollListener)
  }

  // 创建新的监听器函数并保存引用
  scrollListener = () => {
    const maxScroll = readerContent.scrollHeight - readerContent.clientHeight
    const currentScroll = readerContent.scrollTop
    
    console.log('📜 滚动事件触发:', {
      当前滚动: currentScroll,
      最大滚动: maxScroll,
      可视高度: readerContent.clientHeight,
      内容高度: readerContent.scrollHeight
    })
    
    if (maxScroll > 0) {
      scrollPosition.value = currentScroll / maxScroll
      console.log('📊 滚动位置更新:', (scrollPosition.value * 100).toFixed(1) + '%')
    } else {
      console.warn('⚠️ maxScroll 为 0，无法计算滚动位置')
    }

    // 防抖保存（缩短到 500ms 以减少数据丢失风险）
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(() => {
      saveProgress()
    }, 500)
  }
  
  readerContent.addEventListener('scroll', scrollListener)
  console.log('✅ 滚动监听器已设置')
}

// 章节导航
function prevChapter() {
  if (currentChapterIndex.value > 0) {
    currentChapterIndex.value--
    scrollPosition.value = 0
    scrollToTop()
    saveProgress()
  }
}

function nextChapter() {
  if (currentChapterIndex.value < bookChapters.value.length - 1) {
    currentChapterIndex.value++
    scrollPosition.value = 0
    scrollToTop()
    saveProgress()
  }
}

function jumpToChapter(tocItem) {
  // 使用 TOC 中的 chapterIndex 直接跳转
  if (tocItem.chapterIndex !== undefined) {
    currentChapterIndex.value = tocItem.chapterIndex
    scrollPosition.value = 0
    scrollToTop()
    saveProgress()
  }
}

function handleReaderClose() {
  // 阅读器关闭时保存进度
  saveProgress()
  // 移除滚动监听
  const readerContent = document.querySelector('.reader-content')
  if (readerContent && scrollListener) {
    readerContent.removeEventListener('scroll', scrollListener)
    scrollListener = null
  }
  // 重置进度加载标志
  isProgressLoaded = false
}

// 刷新内容（清除缓存并重新加载）
async function refreshContent() {
  if (!currentBook.value) return
  
  try {
    readerLoading.value = true
    await api.books.clearCache(currentBook.value.id)
    
    // 重新加载内容
    const contentResponse = await api.books.getContent(currentBook.value.id)
    if (contentResponse.data?.chapters) {
      bookChapters.value = contentResponse.data.chapters
      bookToc.value = contentResponse.data.toc || []
    }
    
    MessagePlugin.success('内容已刷新')
    readerLoading.value = false
  } catch (error) {
    console.error('刷新失败:', error)
    MessagePlugin.error('刷新失败')
    readerLoading.value = false
  }
}

// 阅读器页面操作
function scrollToTop() {
  const readerContent = document.querySelector('.reader-content')
  if (readerContent) {
    readerContent.scrollTop = 0
  }
}

// 保存阅读进度
async function saveProgress() {
  // 只在进度加载完成后才保存
  if (!currentBook.value || !isProgressLoaded) return

  try {
    console.log('💾 保存阅读进度:', {
      书名: currentBook.value.title,
      章节: currentChapterIndex.value + 1,
      滚动位置: (scrollPosition.value * 100).toFixed(1) + '%',
      总进度: readingProgress.value.toFixed(1) + '%'
    })
    
    await api.books.saveProgress(currentBook.value.id, {
      currentPage: currentChapterIndex.value,
      scrollPosition: scrollPosition.value,
      progress: readingProgress.value,
      fontSize: fontSize.value
    })
  } catch (error) {
    console.error('保存进度失败:', error)
  }
}

// 监听字体大小变化
watch(fontSize, () => {
  saveProgress()
})

// 监听阅读器关闭，刷新列表
watch(readerDialogVisible, (newVal) => {
  if (!newVal) {
    loadBooks()
  }
})

// 封面视图辅助函数
function getCoverUrl(book) {
  if (book.coverImage) {
    // 如果是绝对路径，说明是服务器上的文件，使用封面API
    const token = localStorage.getItem('token')
    return `${window.location.origin}/api/ebooks/${book.id}/cover?token=${token}`
  }
  return null
}

function handleCoverError(event, book) {
  // 封面加载失败时显示占位图
  event.target.style.display = 'none'
  book.coverImage = null
}

// 获取字体CSS值
function getFontFamily(font) {
  const fonts = {
    'serif': '"Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, serif',
    'sans-serif': '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    'kai': '"Kaiti SC", "STKaiti", KaiTi, serif'
  }
  return fonts[font] || fonts['serif']
}

function getFileTypeLabel(fileType) {
  const labels = {
    'txt': 'TXT',
    'epub': 'EPUB',
    'pdf': 'PDF',
    'mobi': 'MOBI',
    'azw': 'AZW',
    'azw3': 'AZW3',
    'fb2': 'FB2'
  }
  return labels[fileType] || fileType?.toUpperCase() || 'BOOK'
}

// 处理页面卸载前的保存
function handleBeforeUnload() {
  // 只在进度加载完成后才保存
  if (currentBook.value && readerDialogVisible.value && isProgressLoaded) {
    const token = localStorage.getItem('token')
    if (token) {
      const data = {
        currentPage: currentChapterIndex.value,
        scrollPosition: scrollPosition.value,
        progress: readingProgress.value,
        fontSize: fontSize.value
      }
      
      console.log('💾 页面卸载，保存进度:', data)
      
      // 使用 fetch with keepalive 确保在页面卸载时也能保存
      fetch(`${window.location.origin}/api/ebooks/${currentBook.value.id}/progress?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data),
        keepalive: true // 确保请求在页面卸载后也能完成
      }).catch(err => {
        console.error('页面卸载时保存进度失败:', err)
      })
    }
  }
}

// 处理标签页切换
function handleVisibilityChange() {
  // 只在进度加载完成后才保存
  if (document.visibilityState === 'hidden' && currentBook.value && readerDialogVisible.value && isProgressLoaded) {
    // 标签页切换到后台时立即保存
    console.log('💾 标签页切换到后台，保存进度')
    saveProgress()
  }
}

onMounted(() => {
  loadCategories()
  loadBooks()
  // 监听页面卸载和标签页切换
  window.addEventListener('beforeunload', handleBeforeUnload)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<style scoped>
.books {
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

.search-sort-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.category-view {
  margin-top: 16px;
}

.empty-categories {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 20px;
}

.empty-categories .t-icon {
  color: #d0d0d0;
}

.empty-categories h3 {
  font-size: 24px;
  color: #333;
  margin: 0;
}

.empty-categories p {
  font-size: 16px;
  color: #666;
  margin: 0;
}

.categories-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
}

.category-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 3px 8px rgba(102, 126, 234, 0.2);
  position: relative;
  user-select: none;
}

.category-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
}

.category-card .t-icon {
  color: white;
  margin-bottom: 12px;
}

.category-card h3 {
  margin: 6px 0;
  font-size: 16px;
  color: white;
  font-weight: 600;
}

.category-card .book-count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
}

.category-card .rename-handle,
.category-card .delete-handle {
  position: absolute;
  top: 8px;
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
  padding: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.category-card:hover .rename-handle,
.category-card:hover .delete-handle {
  opacity: 1;
}

.rename-handle {
  right: 32px;
}

.delete-handle {
  right: 8px;
}

.category-card .delete-handle:hover {
  background: rgba(227, 77, 89, 0.8);
}

.category-card .rename-handle:hover {
  background: rgba(0, 82, 217, 0.6);
}

.books-list {
  margin-top: 16px;
}

.section-title {
  font-size: 18px;
  color: #333;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid #667eea;
}

.empty-state {
  margin-top: 32px;
  text-align: center;
  padding: 60px 20px;
}

.empty-state .t-icon {
  color: #d0d0d0;
  margin-bottom: 20px;
}

.empty-state p {
  font-size: 16px;
  color: #666;
  margin: 0 0 24px 0;
}

/* 阅读器样式 */
.reader-wrapper {
  display: flex;
  height: 75vh;
  overflow: hidden;
}

.reader-sidebar {
  width: 220px;
  min-width: 220px;
  background: #f8f9fa;
  border-right: 1px solid #e8e8e8;
  display: flex;
  flex-direction: column;
  transition: all 0.3s ease;
}

.reader-sidebar.sidebar-collapsed {
  width: 40px;
  min-width: 40px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid #e8e8e8;
  font-weight: 600;
  color: #333;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.empty-toc {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #999;
}

.empty-toc p {
  margin-top: 12px;
  font-size: 14px;
}

.toc-list {
  padding: 8px 0;
}

.toc-item {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 14px;
  color: #333;
  border-left: 3px solid transparent;
  transition: all 0.2s;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc-item:hover {
  background: #e8f4ff;
  color: #0052d9;
}

.toc-item.toc-active {
  background: #e8f4ff;
  color: #0052d9;
  border-left-color: #0052d9;
}

.reader-main {
  flex: 1;
  overflow: hidden;
}

.reader-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.reader-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #f6f8fa;
  border-radius: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-progress {
  display: flex;
  align-items: center;
}

.font-size-display {
  min-width: 50px;
  text-align: center;
  font-weight: 500;
  font-size: 14px;
  color: #333;
}

.progress-info {
  font-size: 14px;
  color: #666;
  white-space: nowrap;
}

.reader-content {
  flex: 1;
  overflow-y: auto;
  background: #f5f1e8;
  border-radius: 8px;
  padding: 24px;
}

.book-paper {
  max-width: 800px;
  margin: 0 auto;
  background: linear-gradient(to bottom, #fdfcf8 0%, #f8f5ed 100%);
  padding: 40px;
  min-height: 100%;
  box-shadow: 
    0 0 20px rgba(0, 0, 0, 0.05),
    inset 0 0 80px rgba(0, 0, 0, 0.02);
  border-radius: 4px;
  position: relative;
}

.book-paper::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: repeating-linear-gradient(
    transparent 0px,
    transparent 27px,
    rgba(200, 180, 150, 0.1) 28px,
    rgba(200, 180, 150, 0.1) 29px
  );
  pointer-events: none;
}

.book-text {
  line-height: 1.9;
  color: #333;
  text-align: justify;
  word-break: break-word;
  position: relative;
  z-index: 1;
}

.book-text img {
  max-width: 100%;
  width: auto;
  height: auto;
  display: block;
  margin: 16px auto;
  border-radius: 4px;
  object-fit: contain;
}

.book-text p {
  margin: 0.8em 0;
  text-indent: 2em;
}

.book-text h1,
.book-text h2,
.book-text h3,
.book-text h4,
.book-text h5,
.book-text h6 {
  margin: 1.5em 0 0.5em;
  text-indent: 0;
}

.book-text a {
  color: #0052d9;
  text-decoration: none;
}

.book-text a:hover {
  text-decoration: underline;
}

.reader-footer {
  margin-top: 16px;
  padding: 0 16px;
}

.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

/* 封面视图样式 */
.books-cover-view {
  margin-top: 16px;
}

.books-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 24px;
  padding: 8px 0;
}

.book-card {
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s ease;
  cursor: pointer;
  position: relative;
}

.book-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.book-cover {
  width: 100%;
  height: 220px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.9);
  gap: 12px;
}

.book-type {
  font-size: 12px;
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 12px;
}

.book-info {
  padding: 12px;
  flex: 1;
}

.book-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin: 0 0 4px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-author {
  font-size: 12px;
  color: #666;
  margin: 0 0 8px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-progress {
  margin-top: 4px;
}

.book-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.book-card:hover .book-actions {
  opacity: 1;
}

.book-actions .t-button {
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(4px);
}

/* 上传进度样式 */
.upload-progress-container {
  margin-top: 16px;
  padding: 16px;
  background: #f5f7fa;
  border-radius: 8px;
}

.upload-status-text {
  margin-top: 8px;
  font-size: 14px;
  color: #666;
  text-align: center;
}
</style>
