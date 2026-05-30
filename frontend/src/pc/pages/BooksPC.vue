<template>
  <div class="books">
    <div class="page-header">
      <p>管理电子书，支持在线阅读</p>
    </div>

    <!-- 搜索栏和排序 -->
    <NativeCard>
      <!-- 第一行：搜索和视图切换 -->
      <div class="search-sort-row">
        <div class="search-controls">
          <NativeInput
            v-model="searchKeyword"
            placeholder="搜索书名或作者..."
            clearable
            @clear="loadBooks"
            @enter="loadBooks"
            style="width: 280px"
          >
            <template #suffix-icon>
              <NativeIcon name="magnifying-glass" />
            </template>
          </NativeInput>

          <NativeSelect
            v-model="sortBy"
            placeholder="排序方式"
            style="width: 140px"
            @change="loadBooks"
            :options="[
              { value: 'last_read_at', label: '最近阅读' },
              { value: 'title', label: '书名' },
              { value: 'author', label: '作者' },
              { value: 'year', label: '年份' },
              { value: 'updated_at', label: '上传时间' }
            ]"
          />

          <NativeButton
            variant="outline"
            @click="toggleSortOrder"
            shape="circle"
            :title="sortOrder === 'desc' ? '降序' : '升序'"
          >
            <template #icon>
              <NativeIcon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" />
            </template>
          </NativeButton>
        </div>

        <!-- 视图切换 -->
        <div class="view-mode-group">
          <NativeButton
            :variant="viewMode === 'cover' ? 'base' : 'outline'"
            @click="viewMode = 'cover'"
            title="封面视图"
          >
            <template #icon><NativeIcon name="view-module" size="22" /></template>
          </NativeButton>
          <NativeButton
            :variant="viewMode === 'list' ? 'base' : 'outline'"
            @click="viewMode = 'list'"
            title="列表视图"
          >
            <template #icon><NativeIcon name="list-dashes" size="22" /></template>
          </NativeButton>
        </div>
      </div>

      <!-- 第二行：查找资源或返回按钮 -->
      <div class="action-row">
        <NativeButton
          v-if="!currentCategoryId"
          theme="warning"
          variant="outline"
          @click="showBookSearch = true"
          :disabled="isGuest"
        >
          <template #icon><NativeIcon name="magnifying-glass" /></template>
          查找资源
        </NativeButton>

        <!-- 返回按钮 -->
        <NativeButton v-if="currentCategoryId" @click="backToRoot">
          <template #icon><NativeIcon name="arrow-left" /></template>
          返回
        </NativeButton>
      </div>
    </NativeCard>

    <!-- 分类浏览 -->
    <NativeCard v-if="!currentCategoryId" class="category-view">
      <!-- 加载状态 - 骨架屏 -->
      <div v-if="categoriesLoading" class="categories-skeleton">
        <div v-for="i in 4" :key="i" class="skeleton-card">
          <div class="skeleton-icon"></div>
          <div class="skeleton-text"></div>
          <div class="skeleton-count"></div>
        </div>
      </div>
      <div v-else-if="categories.length === 0" class="empty-categories">
        <NativeIcon name="folder-open" size="64" />
        <h3>还没有分类</h3>
        <p>创建第一个分类来开始管理书籍</p>
        <NativeButton theme="primary" size="large" iconSize="1.15em" @click="handleCreateCategory" :disabled="isGuest">
          <template #icon><NativeIcon name="folder-plus" /></template>
          创建第一个分类
        </NativeButton>
      </div>
      <div v-else>
        <div class="categories-grid">
          <div
            v-for="cat in categories"
            :key="cat.id"
            class="category-card"
            @click="enterCategory(cat)"
          >
            <NativeIcon name="folder-open" size="24" color="white" class="category-icon" />
            <h3>{{ cat.name }}</h3>
            <div class="book-count">{{ cat.bookCount }} 本书</div>
            <div class="category-actions" v-if="!isGuest">
              <div class="action-btn rename-btn" @click.stop="handleRenameCategory(cat)" title="重命名">
                <NativeIcon name="pencil" size="14" />
              </div>
              <div class="action-btn delete-btn" @click.stop="handleDeleteCategory(cat)" title="删除">
                <NativeIcon name="x" size="14" />
              </div>
            </div>
          </div>
        </div>
        <!-- 分类操作按钮 -->
        <div class="category-actions-row">
          <NativeButton
            theme="default"
            @click="handleCreateCategory"
            :disabled="isGuest"
          >
            <template #icon><NativeIcon name="folder-plus" /></template>
            创建分类
          </NativeButton>
          <NativeButton
            theme="primary"
            @click="handleUpload"
            :disabled="isGuest"
          >
            <template #icon><NativeIcon name="plus" /></template>
            上传书籍
          </NativeButton>
        </div>
      </div>
    </NativeCard>

    <!-- 书籍列表（列表视图） -->
    <NativeCard v-if="books.length > 0 && viewMode === 'list'" class="books-list">
      <h3 v-if="currentCategoryId" class="section-title">
        {{ currentCategoryName }} - 书籍列表
      </h3>
      <h3 v-else class="section-title">
        所有书籍
      </h3>

      <!-- 批量操作栏 -->
      <div v-if="selectedRowKeys.length > 0" class="batch-actions-bar">
        <NativePopconfirm content="确定删除选中的书籍吗？" @confirm="handleBatchDelete">
          <template #trigger>
            <NativeButton theme="danger" variant="outline" size="small" :disabled="isGuest">
              <template #icon><NativeIcon name="trash" /></template>
              批量删除 ({{ selectedRowKeys.length }})
            </NativeButton>
          </template>
        </NativePopconfirm>
        <span class="batch-actions-hint">已选择 {{ selectedRowKeys.length }} 项</span>
      </div>

      <NativeTable
        :data-source="books"
        :columns="columns"
        :loading="loading"
        row-key="id"
        hover
        selectable
        :selectedKeys="selectedRowKeys"
        @selectionChange="handleSelectChange"
      >
        <template #cell-title="{ row }">
          <span class="book-title-text" :title="row.title">{{ row.title }}</span>
        </template>
        <template #cell-author="{ row }">
          {{ row.author || '-' }}
        </template>
        <template #cell-year="{ row }">
          {{ row.year || '-' }}
        </template>
        <template #cell-progress="{ row }">
          <NativeProgress
            :percentage="Math.round(row.progress * 100) / 100"
            :label="true"
            size="small"
            style="width: 120px"
          />
        </template>
        <template #cell-lastReadAt="{ row }">
          {{ row.lastReadAt ? formatDate(row.lastReadAt) : '未阅读' }}
        </template>
        <template #cell-operation="{ row }">
          <NativeSpace :size="8">
            <NativeButton theme="primary" size="small" iconSize="1em" @click="handleRead(row)">
              <NativeIcon name="book" size="14" /> 阅读
            </NativeButton>
            <NativeButton theme="default" size="small" iconSize="1em" @click="handleEditBook(row)" :disabled="isGuest">
              <NativeIcon name="pencil" size="14" /> 编辑
            </NativeButton>
            <NativeButton theme="default" size="small" iconSize="1em" @click="handleDownload(row)" :disabled="isGuest">
              <NativeIcon name="download" size="14" /> 下载
            </NativeButton>
            <NativePopconfirm
              content="确定删除吗？"
              @confirm="handleDelete(row.id)"
            >
              <template #trigger>
                <NativeButton theme="danger" variant="outline" size="small" iconSize="1em" :disabled="isGuest">
                  <NativeIcon name="trash" size="14" /> 删除
                </NativeButton>
              </template>
            </NativePopconfirm>
          </NativeSpace>
        </template>
      </NativeTable>
    </NativeCard>

    <!-- 书籍封面视图 loading 骨架屏 -->
    <NativeCard v-if="loading && viewMode === 'cover'" class="books-cover-view">
      <h3 class="section-title">加载中...</h3>
      <div class="books-skeleton-grid">
        <div v-for="i in 8" :key="i" class="book-skeleton-card">
          <div class="book-skeleton-cover"></div>
          <div class="book-skeleton-title"></div>
          <div class="book-skeleton-author"></div>
        </div>
      </div>
    </NativeCard>

    <!-- 书籍封面视图 -->
    <NativeCard v-else-if="books.length > 0 && viewMode === 'cover'" class="books-cover-view">
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
              <NativeIcon name="book" size="48" />
              <span class="book-type">{{ getFileTypeLabel(book.fileType) }}</span>
            </div>
          </div>
          <div class="book-info">
            <h4 class="book-title" :title="book.title">{{ book.title }}</h4>
            <p class="book-author" v-if="book.author">{{ book.author }}</p>
            <div class="book-progress" v-if="book.progress > 0">
              <NativeProgress
                :percentage="Math.round(book.progress * 100) / 100"
                :label="true"
                size="small"
              />
            </div>
          </div>
          <div class="book-actions">
            <NativeButton class="book-edit-btn" size="small" theme="default" @click.stop="handleEditBook(book)" :disabled="isGuest">
              <template #icon><NativeIcon name="pencil" /></template>
            </NativeButton>
            <div class="book-delete-wrapper" @click.stop>
              <NativePopconfirm
                content="确定删除吗？"
                @confirm="handleDelete(book.id)"
              >
                <template #trigger>
                  <NativeButton class="book-delete-btn" size="small" theme="danger" variant="outline" :disabled="isGuest">
                    <template #icon><NativeIcon name="trash" /></template>
                  </NativeButton>
                </template>
              </NativePopconfirm>
            </div>
          </div>
        </div>
      </div>
    </NativeCard>

    <!-- 空状态 -->
    <NativeCard v-if="books.length === 0 && !loading && currentCategoryId" class="empty-state">
      <NativeIcon name="book" size="64" />
      <p>当前分类下暂无书籍</p>
      <NativeButton theme="primary" @click="handleUpload" :disabled="isGuest">上传第一本书</NativeButton>
    </NativeCard>
    <NativeCard v-else-if="books.length === 0 && !loading && !currentCategoryId && categories.length > 0" class="empty-state">
      <NativeIcon name="book" size="64" />
      <p>暂无书籍</p>
      <NativeButton theme="primary" @click="handleUpload" :disabled="isGuest">上传第一本书</NativeButton>
    </NativeCard>

    <!-- 创建分类对话框 -->
    <NativeDialog
      v-model="createCategoryDialogVisible"
      title="创建分类"
      @confirm="handleCreateCategoryConfirm"
      width="400px"
    >
      <NativeForm :model="categoryForm" :rules="categoryRules">
        <NativeFormItem label="分类名称" prop="name" required>
          <NativeInput v-model="categoryForm.name" placeholder="请输入分类名称" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 重命名分类对话框 -->
    <NativeDialog
      v-model="renameCategoryDialogVisible"
      title="重命名分类"
      width="400px"
      @confirm="handleRenameCategoryConfirm"
    >
      <NativeForm>
        <NativeFormItem label="分类名称">
          <NativeInput v-model="renameCategoryName" placeholder="请输入新的分类名称" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 上传书籍对话框 -->
    <NativeDialog
      v-model="uploadDialogVisible"
      title="上传书籍"
      @confirm="handleUploadConfirm"
      width="600px"
      :confirm-btn="{ content: uploading ? '上传中...' : '确定', loading: uploading }"
      :close-on-overlay-click="!uploading"
      :close-btn="!uploading"
      class="upload-book-dialog"
    >
      <NativeForm :model="uploadForm" :rules="uploadRules">
        <NativeFormItem label="文件" required>
          <NativeUpload
            v-model="uploadForm.file"
            theme="file-input"
            accept=".txt,.epub,.pdf,.mobi,.azw,.azw3,.fb2"
            :multiple="false"
            :auto-upload="false"
            :disabled="parsingMetadata"
            @change="onFileChange"
          />
          <div v-if="parsingMetadata" class="parsing-loading">
            <NativeLoading size="small" />
            <span>正在解析书籍信息，请稍候...</span>
          </div>
        </NativeFormItem>
        <NativeFormItem label="书名" prop="title" required>
          <NativeInput v-model="uploadForm.title" placeholder="书籍名称" />
        </NativeFormItem>
        <NativeFormItem label="作者">
          <NativeInput v-model="uploadForm.author" placeholder="作者" />
        </NativeFormItem>
        <NativeFormItem label="年份">
          <NativeInput v-model="uploadForm.year" placeholder="出版年份" />
        </NativeFormItem>
        <NativeFormItem label="出版社">
          <NativeInput v-model="uploadForm.publisher" placeholder="出版社" />
        </NativeFormItem>
        <NativeFormItem label="ISBN">
          <NativeInput v-model="uploadForm.isbn" placeholder="ISBN" />
        </NativeFormItem>
        <NativeFormItem label="分类">
          <NativeSelect
            v-model="uploadForm.categoryId"
            placeholder="选择分类（可选）"
            clearable
            :options="categories.map(cat => ({ value: cat.id, label: cat.name }))"
          />
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea
            v-model="uploadForm.description"
            placeholder="书籍简介"
            :maxlength="1000"
            :rows="3"
          />
        </NativeFormItem>
      </NativeForm>
      <!-- 上传进度条 -->
      <div v-if="uploading" class="upload-progress-container">
        <NativeProgress
          :percentage="uploadProgress"
          :label="true"
          theme="line"
          :stroke-width="12"
        />
        <p class="upload-status-text">正在上传，请稍候...</p>
      </div>
    </NativeDialog>

    <!-- 编辑书籍对话框 -->
    <NativeDialog
      v-model="editBookDialogVisible"
      title="编辑书籍信息"
      @confirm="handleEditBookConfirm"
      width="600px"
    >
      <NativeForm :model="editBookForm">
        <NativeFormItem label="书名">
          <NativeInput v-model="editBookForm.title" placeholder="书籍名称" />
        </NativeFormItem>
        <NativeFormItem label="作者">
          <NativeInput v-model="editBookForm.author" placeholder="作者" />
        </NativeFormItem>
        <NativeFormItem label="年份">
          <NativeInput v-model="editBookForm.year" placeholder="出版年份" />
        </NativeFormItem>
        <NativeFormItem label="出版社">
          <NativeInput v-model="editBookForm.publisher" placeholder="出版社" />
        </NativeFormItem>
        <NativeFormItem label="ISBN">
          <NativeInput v-model="editBookForm.isbn" placeholder="ISBN" />
        </NativeFormItem>
        <NativeFormItem label="分类">
          <NativeSelect
            v-model="editBookForm.categoryId"
            placeholder="选择分类"
            clearable
            :options="categories.map(cat => ({ value: cat.id, label: cat.name }))"
          />
        </NativeFormItem>
        <NativeFormItem label="简介">
          <NativeTextarea
            v-model="editBookForm.description"
            placeholder="书籍简介"
            :maxlength="1000"
            :rows="3"
          />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 阅读器对话框 -->
    <NativeDialog
      v-model="readerDialogVisible"
      :title="currentBook?.title || '阅读器'"
      width="1300px"
      :show-footer="false"
      :close-on-overlay-click="false"
      @close="handleReaderClose"
    >
      <div class="reader-wrapper">
        <!-- 目录侧边栏 -->
        <div class="reader-sidebar" :class="{ 'sidebar-collapsed': !sidebarVisible }">
          <div class="sidebar-header">
            <span v-if="sidebarVisible">目录</span>
            <NativeButton size="small" variant="text" @click="sidebarVisible = !sidebarVisible">
              <NativeIcon :name="sidebarVisible ? 'chevron-left' : 'chevron-right'" />
            </NativeButton>
          </div>
          <div v-if="sidebarVisible" class="sidebar-content">
            <div v-if="readerLoading" class="sidebar-loading">
              <NativeLoading size="small" text="加载目录..." />
            </div>
            <div v-else-if="bookToc.length === 0" class="empty-toc">
              <NativeIcon name="folder-open" size="32" />
              <p>暂无目录</p>
            </div>
            <div v-else class="toc-list">
              <div
                v-for="(chapter, index) in bookToc"
                :key="index"
                class="toc-item"
                :class="{ 'toc-active': currentChapterIndex === chapter.chapterIndex }"
                @click="jumpToChapter(chapter)"
              >
                <span :title="chapter.title">{{ chapter.title }}</span>
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
                  <NativeButton class="toolbar-btn" size="small" @click="fontSize -= 2" :disabled="fontSize <= 12">
                    <template #icon><NativeIcon name="remove" /></template>
                    <span>字体-</span>
                  </NativeButton>
                  <span class="font-size-display">{{ fontSize }}px</span>
                  <NativeButton class="toolbar-btn" size="small" @click="fontSize += 2" :disabled="fontSize >= 32">
                    <template #icon><NativeIcon name="plus" /></template>
                    <span>字体+</span>
                  </NativeButton>
                  <NativeSelect
                    v-model="fontFamily"
                    style="width: 90px"
                    size="small"
                    :options="[
                      { value: 'serif', label: '宋体' },
                      { value: 'sans-serif', label: '黑体' },
                      { value: 'kai', label: '楷体' }
                    ]"
                  />
                </div>
                <NativeDivider layout="vertical" style="height: 28px; margin: 0 8px;" />
                <div class="toolbar-group">
                  <NativeButton class="toolbar-btn" size="small" @click="prevChapter" :disabled="currentChapterIndex <= 0">
                    <template #icon><NativeIcon name="chevron-left" /></template>
                    <span>上一章</span>
                  </NativeButton>
                  <NativeButton class="toolbar-btn" size="small" @click="nextChapter" :disabled="currentChapterIndex >= bookChapters.length - 1">
                    <span>下一章</span>
                    <template #icon><NativeIcon name="chevron-right" /></template>
                  </NativeButton>
                </div>
              </div>
              <div class="toolbar-progress">
                <span class="progress-info">
                  {{ currentChapterIndex + 1 }} / {{ bookChapters.length }} 章
                </span>
                <NativeButton class="toolbar-btn-icon" size="small" variant="outline" @click="refreshContent" title="重新解析（清除缓存）">
                  <template #icon><NativeIcon name="arrow-clockwise" /></template>
                  <span>刷新</span>
                </NativeButton>
              </div>
            </div>

            <!-- 阅读内容 -->
            <div class="reader-content" :style="{ fontSize: fontSize + 'px', fontFamily: getFontFamily(fontFamily) }">
              <!-- 内容始终渲染，用遮罩层控制loading显示 -->
              <div class="book-paper">
                <!-- 单章节渲染 -->
                <div
                  class="book-text"
                  :class="{ 'content-hidden': readerLoading }"
                  :data-chapter-id="bookChapters[currentChapterIndex]?.id"
                  v-html="currentChapterContent"
                ></div>
                <!-- loading遮罩层（只在内容区显示） -->
                <div v-if="readerLoading" class="loading-overlay">
                  <div class="loading-container">
                    <div class="loading-spinner"></div>
                    <span class="loading-text">加载中...</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 阅读器底部 -->
            <div class="reader-footer">
              <NativeProgress
                :percentage="chapterProgress"
                :label="false"
                size="small"
              />
            </div>
          </div>
        </div>
      </div>
    </NativeDialog>

    <!-- 电子书搜索弹窗 -->
    <BookSearchDialog v-model="showBookSearch" />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import api from '@/api'
import BookSearchDialog from '@/components/BookSearchDialog.vue'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import {
  NativeButton, NativeInput, NativeCard, NativeDialog, NativeIcon,
  NativeSpace, NativeSelect, NativeTable, NativeForm, NativeFormItem,
  NativeTextarea, NativeProgress, NativePopconfirm, NativeDivider,
  NativeUpload
} from '@/components/native'
import { generateCFI, parseCFI, scrollToCFI, getCurrentCFI, ChapterBoundaryCache, CharacterOffsetProgress } from '@/utils/epub-cfi'

const toast = useToast()

const { isGuest } = usePermission()

// 调试：输出用户身份信息
console.log('🔍 用户身份检查:', {
  isGuest: isGuest.value,
  localStorage_user: localStorage.getItem('user'),
  sessionStorage_user: sessionStorage.getItem('user')
})

const loading = ref(false)
const books = ref([])
const categories = ref([])
const categoriesLoading = ref(false) // 分类独立的 loading 状态
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
const fontSize = ref(16)
const fontFamily = ref('sans-serif')
const sidebarVisible = ref(true) // 侧边栏显示状态
let scrollSaveTimer = null // 滚动保存定时器
let scrollListener = null // 滚动监听器引用
let isProgressLoaded = false // 进度是否已加载完成
let resizeObserver = null // ResizeObserver 实例（监听内容区域宽度变化）
let resizeDebounceTimer = null // ResizeObserver 防抖定时器

// 当前 CFI 锚点（用于进度保存和恢复）
let currentCFI = null

// 阅读器滚动位置（响应式，用于触发进度计算更新）
const readerScrollTop = ref(0)

// 表格列
const columns = [
  { key: 'title', title: '书名', width: 200 },
  { key: 'author', title: '作者', width: 120 },
  { key: 'year', title: '年份', width: 80 },
  { key: 'progress', title: '阅读进度', width: 150 },
  { key: 'lastReadAt', title: '最近阅读', width: 180 },
  { key: 'operation', title: '操作', width: 280 }
]

// 计算当前章节内容
const currentChapterContent = computed(() => {
  if (bookChapters.value.length === 0) return ''
  const chapter = bookChapters.value[currentChapterIndex.value]
  return chapter?.content || ''
})

// 字符偏移进度计算器
const charOffsetProgress = ref(new CharacterOffsetProgress())

// 计算阅读进度（基于字符偏移：当前偏移字符数 / 本书总字符数）
const readingProgress = computed(() => {
  if (bookChapters.value.length === 0) return 0
  if (!charOffsetProgress.value.initialized) {
    // 回退到基于章节的粗略计算
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }
  
  // 依赖 readerScrollTop 确保滚动时重新计算
  readerScrollTop.value
  
  // 使用字符偏移进度计算
  const readerContent = document.querySelector('.reader-content')
  // PC端使用 .book-text 作为章节内容元素
  const currentChapterEl = readerContent?.querySelector('.book-text')
  
  const progress = charOffsetProgress.value.calculateProgress(
    currentChapterIndex.value,
    readerContent,
    currentChapterEl
  )
  
  return progress
})

// 章节内进度（用于底部进度条显示）
const chapterProgress = computed(() => {
  if (bookChapters.value.length === 0) return 0
  // 使用readingProgress获取更精确的进度
  const preciseProgress = readingProgress.value
  return parseFloat(preciseProgress.toFixed(2))
})

// 加载分类
async function loadCategories() {
  categoriesLoading.value = true
  try {
    const response = await api.books.getCategories()
    categories.value = response.data?.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
    toast.error('加载分类失败')
  } finally {
    categoriesLoading.value = false
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
    toast.error('加载书籍失败')
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

// 格式化日期时间
function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
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
      toast.error('请输入分类名称')
      return
    }

    const response = await api.books.createCategory({ name: categoryForm.value.name.trim() })
    toast.success('创建成功')
    createCategoryDialogVisible.value = false
    // 本地添加新分类到列表
    if (response.data?.data) {
      categories.value.push({
        ...response.data.data,
        bookCount: 0
      })
    } else {
      await loadCategories()
    }
  } catch (error) {
    console.error('创建分类失败:', error)
    toast.error(error.response?.data?.message || '创建失败')
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
      toast.error('请输入分类名称')
      return
    }

    await api.books.updateCategory(renameCategoryData.value.id, { name: renameCategoryName.value.trim() })
    toast.success('重命名成功')
    renameCategoryDialogVisible.value = false
    // 强制刷新分类列表 - 先本地更新，再重新加载
    const idx = categories.value.findIndex(c => c.id === renameCategoryData.value.id)
    if (idx > -1) {
      categories.value[idx] = { ...categories.value[idx], name: renameCategoryName.value.trim() }
    }
    await loadBooks()
  } catch (error) {
    console.error('重命名失败:', error)
    toast.error(error.response?.data?.message || '重命名失败')
  }
}

// 删除分类
async function handleDeleteCategory(cat) {
  try {
    await api.books.deleteCategory(cat.id)
    toast.success('删除成功')
    // 强制刷新分类列表 - 先本地过滤，再重新加载
    categories.value = categories.value.filter(c => c.id !== cat.id)
    await loadBooks()
  } catch (error) {
    console.error('删除失败:', error)
    toast.error(error.response?.data?.message || '删除失败')
  }
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
          toast.success('书籍信息已自动填充')
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
        toast.success('书籍信息已自动填充')
      } else {
        console.log('⚠️ 元数据解析返回为空')
      }
    }
  } catch (error) {
    console.error('❌ 解析元数据失败:', error)
    toast.warning('自动解析失败，请手动填写信息')
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
      toast.error('请选择文件')
      return
    }

    if (!uploadForm.value.title.trim()) {
      toast.error('请输入书名')
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

    toast.success('上传成功')
    uploadDialogVisible.value = false
    uploadedFilePath.value = null // 重置已上传文件路径
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) {
    console.error('上传失败:', error)
    toast.error(error.response?.data?.message || '上传失败')
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
    toast.success('更新成功')
    editBookDialogVisible.value = false
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) {
    console.error('更新失败:', error)
    toast.error('更新失败')
  }
}

// 删除书籍
async function handleDelete(id) {
  try {
    await api.books.delete(id)
    toast.success('删除成功')
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) {
    toast.error('删除失败')
  }
}

// 批量删除
async function handleBatchDelete() {
  if (selectedRowKeys.value.length === 0) {
    toast.warning('请选择要删除的书籍')
    return
  }

  try {
    await api.books.batchDelete({ ids: selectedRowKeys.value })
    toast.success('批量删除成功')
    selectedRowKeys.value = []
    loadCategories()
    loadBooks()
  } catch (error) {
    console.error('批量删除失败:', error)
    toast.error('批量删除失败')
  }
}

// 下载书籍
function handleDownload(row) {
  const token = localStorage.getItem('token')
  if (token) {
    window.open(`${window.location.origin}/api/ebooks/download/${row.id}?token=${token}`, '_blank')
  } else {
    toast.error('无法下载，未登录')
  }
}

// 阅读器
async function handleRead(row) {
  try {
    console.log('📖 打开阅读器:', {
      书名: row.title,
      ID: row.id,
      文件类型: row.fileType,
      文件路径: row.filePath,
      用户身份: isGuest.value ? '游客' : '管理员'
    })

    // 先显示对话框
    readerDialogVisible.value = true
    // 等待对话框渲染完成后再显示loading
    await nextTick()
    readerLoading.value = true
    console.log('⏳ Loading已显示')
    isProgressLoaded = false // 进度尚未加载
    // 立即设置 currentBook 显示正确的标题，但添加加载标志
    currentBook.value = { ...row, _loading: true }
    currentChapterIndex.value = 0
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

    // 初始化字符偏移进度计算器
    charOffsetProgress.value.clear()
    charOffsetProgress.value.init(bookChapters.value)
    console.log('📊 字符偏移进度计算器已初始化，总字符数:', charOffsetProgress.value.totalChars)

    // 获取阅读进度（游客不加载进度，每次从开头阅读）
    if (!isGuest.value) {
      const progressResponse = await api.books.getProgress(row.id)
      if (progressResponse.data?.currentPage !== undefined) {
        currentChapterIndex.value = Math.min(progressResponse.data.currentPage, bookChapters.value.length - 1)
        // 使用 CFI 锚点
        const cfi = progressResponse.data.cfi
        console.log('📖 阅读进度已加载:', {
          章节: currentChapterIndex.value + 1,
          总章节: bookChapters.value.length,
          CFI: cfi || '无'
        })
        // 将 CFI 附加到 currentBook 用于恢复位置
        row.cfi = cfi
      }
    } else {
      console.log('📖 游客模式：不加载阅读进度，从开头开始阅读')
    }

    // 进度加载完成后更新 currentBook 状态
    currentBook.value = { ...row, _loading: false }
    isProgressLoaded = true // 进度已加载完成

    // 检查阅读器是否已关闭
    if (!readerDialogVisible.value) {
      console.log('⏹️ 阅读器已关闭，中断后续加载')
      return
    }

    // 等待 Vue 渲染内容到 DOM（loading 遮罩层保持显示，用户看不到内容）
    console.log('⏳ 等待内容渲染到 DOM...')
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // 再次检查阅读器是否已关闭
    if (!readerDialogVisible.value) {
      console.log('⏹️ 阅读器已关闭，中断图片加载')
      return
    }
    
    // 预加载图片并定位（loading 始终显示）
    await preloadAndPosition()
    
    // 检查阅读器是否已关闭
    if (!readerDialogVisible.value) {
      console.log('⏹️ 阅读器已关闭，跳过后续初始化')
      return
    }
    
    // 定位完成后关闭 loading，用户看到已定位好的内容
    readerLoading.value = false
    
    // 设置滚动监听
    setupScrollListener()
    
    console.log('✅ 阅读器准备完成')
  } catch (error) {
    console.error('❌ 打开阅读器失败:', error)
    toast.error(error.response?.data?.message || '打开阅读器失败')
    readerDialogVisible.value = false
    readerLoading.value = false
  }
}

// 图片加载控制器（用于取消未完成的请求）
let imageLoadController = null
let isImageLoading = false

// 预加载当前章节图片（带并发控制，可取消）
async function preloadChapterImagesWithCache(container, timeout = 15000) {
  const images = Array.from(container.querySelectorAll('img'))
  const totalImages = images.length
  
  if (totalImages === 0) {
    console.log('🖼️ 章节内无图片')
    return
  }
  
  // 如果阅读器已关闭，直接返回
  if (!readerDialogVisible.value) {
    console.log('🖼️ 阅读器已关闭，取消图片加载')
    return
  }
  
  console.log(`🖼️ 开始加载 ${totalImages} 张图片（并发限制: 3）...`)
  const startTime = performance.now()
  isImageLoading = true
  
  // 并发控制：同时最多加载3张图片
  const CONCURRENT_LIMIT = 3
  let loadedCount = 0
  
  async function loadImage(img, index) {
    // 如果阅读器已关闭或请求被取消，直接返回
    if (!readerDialogVisible.value || (imageLoadController && imageLoadController.signal.aborted)) {
      console.log(`🖼️ 图片${index + 1}加载被取消`)
      return
    }
    
    // 移除懒加载
    if (img.loading === 'lazy') {
      img.loading = 'eager'
    }
    
    // 处理 data-src
    const dataSrc = img.getAttribute('data-src')
    if (dataSrc && !img.src) {
      img.src = dataSrc
    }
    
    // 等待加载完成
    return new Promise((resolve) => {
      // 再次检查是否已取消
      if (!readerDialogVisible.value) {
        console.log(`🖼️ 图片${index + 1}加载被中断（阅读器关闭）`)
        resolve()
        return
      }
      
      if (img.complete && img.naturalHeight > 0) {
        loadedCount++
        resolve()
        return
      }
      
      const onLoad = () => {
        img.removeEventListener('load', onLoad)
        img.removeEventListener('error', onError)
        loadedCount++
        resolve()
      }
      const onError = () => {
        img.removeEventListener('load', onLoad)
        img.removeEventListener('error', onError)
        resolve()
      }
      
      img.addEventListener('load', onLoad)
      img.addEventListener('error', onError)
    })
  }
  
  // 分批加载图片
  for (let i = 0; i < images.length; i += CONCURRENT_LIMIT) {
    // 检查是否已取消
    if (!readerDialogVisible.value || (imageLoadController && imageLoadController.signal.aborted)) {
      console.log('🖼️ 图片加载批次被取消')
      isImageLoading = false
      return
    }
    
    const batch = images.slice(i, i + CONCURRENT_LIMIT)
    await Promise.all(batch.map((img, idx) => loadImage(img, i + idx)))
  }
  
  isImageLoading = false
  const elapsed = Math.round(performance.now() - startTime)
  
  console.log(`🖼️ 图片加载完成: ${loadedCount}/${totalImages} 张, 耗时: ${elapsed}ms`)
}

// 预加载并定位（核心流程）
async function preloadAndPosition() {
  const perfStart = performance.now()
  
  // 检查阅读器是否已关闭
  if (!readerDialogVisible.value) {
    console.log('⏹️ 阅读器已关闭，跳过预加载')
    return
  }
  
  const readerContent = document.querySelector('.reader-content')
  if (!readerContent) {
    console.warn('⚠️ 未找到阅读器容器')
    return
  }
  
  const bookText = readerContent.querySelector('.book-text')
  if (!bookText) {
    console.warn('⚠️ 未找到内容元素')
    return
  }
  
  // 步骤1: 简单延迟确保DOM渲染
  await new Promise(r => setTimeout(r, 100))
  
  // 检查阅读器是否已关闭
  if (!readerDialogVisible.value) {
    console.log('⏹️ 阅读器已关闭，跳过图片加载')
    return
  }
  
  // 步骤2: 加载图片
  const imgStart = performance.now()
  await preloadChapterImagesWithCache(bookText)
  const imgTime = Math.round(performance.now() - imgStart)
  
  // 检查阅读器是否已关闭
  if (!readerDialogVisible.value) {
    console.log('⏹️ 阅读器已关闭，跳过定位')
    return
  }
  
  // 步骤3: 定位
  isRestoringPosition = true
  
  if (currentBook.value?.cfi) {
    const success = scrollToCFI(readerContent, currentBook.value.cfi, null, false)
    if (success) {
      currentCFI = currentBook.value.cfi
      console.log('✅ CFI定位成功')
    } else {
      console.warn('⚠️ CFI定位失败')
      readerContent.scrollTop = 0
    }
  } else {
    readerContent.scrollTop = 0
  }
  
  setTimeout(() => { isRestoringPosition = false }, 100)
  
  const total = Math.round(performance.now() - perfStart)
  console.log('📊 加载性能报告:', { 总耗时: `${total}ms`, 图片加载: `${imgTime}ms`, 章节: currentChapterIndex.value + 1 })
}

// 是否正在恢复位置（用于禁用滚动监听器的CFI更新）
let isRestoringPosition = false

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
    // 恢复位置期间不更新CFI（避免中间位置覆盖目标位置）
    if (isRestoringPosition) return
    
    // 更新响应式滚动位置，触发进度计算
    readerScrollTop.value = readerContent.scrollTop
    
    // 防抖处理：只在滚动停止后更新CFI和保存
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(async () => {
      // 先等待图片加载完成，确保DOM结构稳定后再生成CFI
      const bookText = readerContent.querySelector('.book-text')
      if (bookText) {
        const images = bookText.querySelectorAll('img')
        const pendingImages = Array.from(images).filter(img => !img.complete)
        if (pendingImages.length > 0) {
          console.log(`🖼️ 等待${pendingImages.length}张图片加载完成后再生成CFI...`)
          await Promise.race([
            Promise.all(pendingImages.map(img => new Promise(resolve => {
              img.onload = resolve
              img.onerror = resolve
            }))),
            new Promise(resolve => setTimeout(resolve, 2000)) // 最多等待2秒
          ])
        }
      }
      
      // 图片加载完成后再生成CFI，确保DOM结构稳定
      if (isProgressLoaded) {
        const cfi = getCurrentCFI(readerContent)
        if (cfi) {
          currentCFI = cfi
        }
      }
      
      // 滚动停止后才输出一次日志
      const maxScroll = readerContent.scrollHeight - readerContent.clientHeight
      const currentScroll = readerContent.scrollTop
      console.log('📜 滚动停止，保存进度:', {
        当前滚动: currentScroll,
        最大滚动: maxScroll,
        进度: readingProgress.value.toFixed(2) + '%',
        cfi: currentCFI?.substring(0, 40) + '...'
      })
      
      saveProgress()
    }, 500)
  }
  
  readerContent.addEventListener('scroll', scrollListener)
  console.log('✅ 滚动监听器已设置')
  
  // 设置链接点击拦截（处理EPUB内部链接如脚注）
  setupLinkClickHandler(readerContent)
  
  // 设置 ResizeObserver 监听内容区域宽度变化（sidebar 展开/收起时）
  setupResizeObserver(readerContent)
}

// 设置链接点击拦截器（处理EPUB内部链接如脚注、目录锚点）
let linkClickHandler = null

function setupLinkClickHandler(readerContent) {
  // 移除旧的事件监听器
  if (linkClickHandler) {
    readerContent.removeEventListener('click', linkClickHandler)
  }
  
  // 创建新的事件处理函数
  linkClickHandler = (e) => {
    // 查找最近的a标签
    const link = e.target.closest('a[href]')
    if (!link) return
    
    const href = link.getAttribute('href')
    if (!href) return
    
    // 处理内部锚点链接（#开头）
    if (href.startsWith('#')) {
      e.preventDefault()
      const targetId = href.substring(1)
      console.log('📖 内部锚点跳转:', targetId)
      
      // 在当前章节内查找目标元素
      const targetElement = readerContent.querySelector(`#${CSS.escape(targetId)}`)
      if (targetElement) {
        // 滚动到目标位置
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
        console.log('✅ 已跳转到内部锚点:', targetId)
      } else {
        console.warn('⚠️ 未找到内部锚点目标:', targetId)
      }
      return
    }
    
    // 处理相对路径链接（跳转到其他章节）
    if (!href.startsWith('http') && !href.startsWith('data:') && !href.startsWith('javascript:')) {
      e.preventDefault()
      
      // 分离文件名和锚点
      const [filePath, anchor] = href.split('#')
      console.log('📖 章节链接跳转:', { filePath, anchor })
      
      // 在当前书籍章节中查找匹配的章节
      const chapterIndex = bookChapters.value.findIndex(ch => {
        if (!ch.href) return false
        // 匹配文件名或完整路径
        const chFileName = ch.href.split('/').pop()
        const targetFileName = filePath.split('/').pop()
        return chFileName === targetFileName || ch.href === filePath
      })
      
      if (chapterIndex !== -1) {
        // 跳转到目标章节
        currentChapterIndex.value = chapterIndex
        nextTick(() => {
          // 如果有锚点，在章节加载后跳转到锚点
          if (anchor) {
            setTimeout(() => {
              const targetElement = readerContent.querySelector(`#${CSS.escape(anchor)}`)
              if (targetElement) {
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
                console.log('✅ 已跳转到章节锚点:', anchor)
              }
            }, 100)
          }
        })
      } else {
        console.warn('⚠️ 未找到目标章节:', filePath)
      }
      return
    }
    
    // 外部链接（http/https）默认行为，但提示用户
    if (href.startsWith('http')) {
      e.preventDefault()
      if (confirm('这是一个外部链接，是否在新窗口打开？\n' + href)) {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    }
  }
  
  // 使用事件委托监听点击
  readerContent.addEventListener('click', linkClickHandler)
  console.log('✅ 链接点击拦截器已设置')
}

// 设置 ResizeObserver 监听内容区域宽度变化
let lastContentWidth = 0

function setupResizeObserver(readerContent) {
  // 断开旧的 observer
  if (resizeObserver) {
    resizeObserver.disconnect()
    console.log('📐 已断开旧的 ResizeObserver')
  }
  
  // 记录初始宽度
  lastContentWidth = readerContent.clientWidth
  console.log('📐 初始内容区域宽度:', lastContentWidth)
  
  // 创建新的 ResizeObserver
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const newWidth = entry.contentRect.width
      
      // 只有宽度变化才处理
      if (newWidth !== lastContentWidth) {
        console.log('📐 内容区域宽度变化:', { 之前: lastContentWidth, 现在: newWidth })
        
        // 如果阅读器打开且已加载进度，使用 CFI 恢复位置
        if (readerDialogVisible.value && isProgressLoaded && currentCFI) {
          console.log('📐 使用 CFI 恢复位置:', currentCFI)
          
          // 清除之前的防抖定时器
          if (resizeDebounceTimer) {
            clearTimeout(resizeDebounceTimer)
          }
          
          // 防抖处理，等待布局稳定后恢复位置
          resizeDebounceTimer = setTimeout(() => {
            if (currentCFI) {
              console.log('📐 布局稳定，使用 CFI 恢复位置:', currentCFI)
              // 临时禁用CFI更新，使用即时滚动
              isRestoringPosition = true
              scrollToCFI(readerContent, currentCFI, null, false)
              setTimeout(() => {
                isRestoringPosition = false
                console.log('🔓 ResizeObserver恢复完成')
              }, 100)
            }
          }, 150)
        }
        
        lastContentWidth = newWidth
      }
    }
  })
  
  resizeObserver.observe(readerContent)
  console.log('✅ ResizeObserver 已设置，监听内容区域宽度变化')
}

// 滚动到顶部
function scrollToTop() {
  const readerContent = document.querySelector('.reader-content')
  if (readerContent) {
    readerContent.scrollTop = 0
  }
}

// 章节切换（简单 loading，图片懒加载）
async function switchChapter(newIndex) {
  if (newIndex < 0 || newIndex >= bookChapters.value.length) return
  
  // 显示 loading
  readerLoading.value = true
  await nextTick()
  
  // 切换章节
  currentChapterIndex.value = newIndex
  
  // 等待内容渲染
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 50))
  
  // 滚动到顶部（图片使用懒加载，不需要等待）
  scrollToTop()
  saveProgress()
  
  // 关闭 loading
  readerLoading.value = false
}

// 章节导航
function prevChapter() {
  switchChapter(currentChapterIndex.value - 1)
}

function nextChapter() {
  switchChapter(currentChapterIndex.value + 1)
}

function jumpToChapter(tocItem) {
  // 使用 TOC 中的 chapterIndex 直接跳转
  if (tocItem.chapterIndex !== undefined) {
    switchChapter(tocItem.chapterIndex)
  }
}

function handleReaderClose() {
  console.log('📖 阅读器关闭中...')
  
  // 标记阅读器已关闭（这会触发图片加载中的检查）
  readerDialogVisible.value = false
  
  // 取消未完成的图片加载请求
  if (imageLoadController) {
    imageLoadController.abort()
    imageLoadController = null
    console.log('🖼️ 已取消图片加载请求')
  }
  
  // 阅读器关闭时保存进度（只在非恢复状态下保存，避免保存错误位置）
  if (!isRestoringPosition && isProgressLoaded) {
    saveProgress()
  } else {
    console.log('⏸️ 阅读器关闭时跳过保存（正在恢复位置或未加载完成）')
  }
  // 移除滚动监听
  const readerContent = document.querySelector('.reader-content')
  if (readerContent && scrollListener) {
    readerContent.removeEventListener('scroll', scrollListener)
    scrollListener = null
  }
  // 断开 ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
    console.log('📐 ResizeObserver 已断开')
  }
  // 清除防抖定时器
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer)
    resizeDebounceTimer = null
  }
  // 清除 CFI 锚点
  currentCFI = null
  // 重置进度加载标志
  isProgressLoaded = false
}

// 刷新内容
async function refreshContent() {
  if (!currentBook.value) return
  
  readerLoading.value = true
  try {
    // 清除缓存
    await api.books.clearCache(currentBook.value.id)
    
    // 重新加载内容
    const contentResponse = await api.books.getContent(currentBook.value.id)
    if (contentResponse.data?.chapters) {
      bookChapters.value = contentResponse.data.chapters
      bookToc.value = contentResponse.data.toc || []
    }

    toast.success('内容已刷新')
    readerLoading.value = false
  } catch (error) {
    console.error('刷新失败:', error)
    toast.error('刷新失败')
    readerLoading.value = false
  }
}

// 保存阅读进度（使用 EPUB CFI）
async function saveProgress() {
  // 游客不保存进度
  if (isGuest.value) {
    console.log('📖 游客模式：不保存阅读进度')
    return
  }

  // 只在进度加载完成后才保存
  if (!currentBook.value || !isProgressLoaded) return

  try {
    const readerContent = document.querySelector('.reader-content')
    
    // 使用 CFI 获取当前位置
    const cfi = getCurrentCFI(readerContent)
    if (cfi) {
      currentCFI = cfi
    }
    
    // 计算进度百分比（使用字符偏移进度）
    const progressPercent = readingProgress.value

    console.log('💾 保存阅读进度 (CFI):', {
      书名: currentBook.value.title,
      章节: currentChapterIndex.value + 1,
      CFI: currentCFI,
      进度: progressPercent.toFixed(1) + '%'
    })

    await api.books.saveProgress(currentBook.value.id, {
      currentPage: currentChapterIndex.value,
      progress: progressPercent,
      fontSize: fontSize.value,
      cfi: currentCFI // EPUB CFI 锚点
    })
  } catch (error) {
    console.error('保存进度失败:', error)
  }
}

// 监听字体大小变化
watch(fontSize, async () => {
  // 保存当前 CFI
  const readerContent = document.querySelector('.reader-content')
  const cfi = getCurrentCFI(readerContent)
  if (cfi) {
    currentCFI = cfi
  }
  
  // 等待字体渲染完成后恢复位置
  await nextTick()
  setTimeout(() => {
    if (currentCFI && readerContent) {
      console.log('📐 字体变化，使用 CFI 恢复位置:', currentCFI.substring(0, 40) + '...')
      // 临时禁用CFI更新，使用即时滚动
      isRestoringPosition = true
      scrollToCFI(readerContent, currentCFI, null, false)
      setTimeout(() => {
        isRestoringPosition = false
        console.log('🔓 字体变化恢复完成')
      }, 100)
    }
    saveProgress()
  }, 100)
})

// 监听阅读器关闭，刷新列表
watch(readerDialogVisible, (newVal) => {
  if (!newVal) {
    loadBooks()
  }
})

// 监听目录侧边栏展开/收起，重新定位阅读位置
watch(sidebarVisible, async () => {
  console.log('📐 侧边栏状态变化:', sidebarVisible.value ? '展开' : '收起')
  
  // 等待侧边栏动画完成
  await nextTick()
  setTimeout(() => {
    // 使用 CFI 重新定位
    const readerContent = document.querySelector('.reader-content')
    if (isProgressLoaded && readerDialogVisible.value && currentCFI && readerContent) {
      console.log('📐 侧边栏变化后，使用 CFI 恢复位置:', currentCFI.substring(0, 40) + '...')
      // 临时禁用CFI更新，使用即时滚动
      isRestoringPosition = true
      scrollToCFI(readerContent, currentCFI, null, false)
      setTimeout(() => {
        isRestoringPosition = false
        console.log('🔓 侧边栏变化恢复完成')
      }, 100)
    }
  }, 350) // 等待CSS过渡动画完成
})

// 监听窗口大小变化，重新定位阅读位置




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
  // 只在进度加载完成且不在恢复过程中才保存（避免保存错误位置）
  if (currentBook.value && readerDialogVisible.value && isProgressLoaded && !isRestoringPosition) {
    const token = localStorage.getItem('token')
    if (token) {
      // 使用 CFI 获取当前位置
      const readerContent = document.querySelector('.reader-content')
      const cfi = getCurrentCFI(readerContent)
      
      const data = {
        currentPage: currentChapterIndex.value,
        progress: readingProgress.value,
        fontSize: fontSize.value,
        cfi: cfi || currentCFI // EPUB CFI 锚点
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
  // 只在进度加载完成且不在恢复过程中才保存（避免保存错误位置）
  if (document.visibilityState === 'hidden' && currentBook.value && readerDialogVisible.value && isProgressLoaded && !isRestoringPosition) {
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

/* 内容区域加载状态 */
.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}

/* 分类骨架屏 */
.categories-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
  padding: 16px 0;
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: #f5f5f5;
  border-radius: 10px;
  min-height: 120px;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.skeleton-icon {
  width: 32px;
  height: 32px;
  background: #e0e0e0;
  border-radius: 6px;
  margin-bottom: 12px;
}

.skeleton-text {
  width: 80px;
  height: 16px;
  background: #e0e0e0;
  border-radius: 4px;
  margin: 6px 0;
}

.skeleton-count {
  width: 60px;
  height: 12px;
  background: #e0e0e0;
  border-radius: 4px;
  margin-top: 4px;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
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
  justify-content: space-between;
  margin-bottom: 12px;
}

.search-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: flex-start;
}

/* 搜索栏中的选择框高度与输入框统一(32px) */
.search-controls :deep(.native-select) {
  height: 32px !important;
  min-height: 32px !important;
  max-height: 32px !important;
}

.search-controls :deep(.native-select__trigger) {
  height: 32px !important;
  min-height: 32px !important;
  max-height: 32px !important;
  padding: 0 12px !important;
  box-sizing: border-box !important;
}

.search-controls :deep(.native-select__label),
.search-controls :deep(.native-select__placeholder) {
  line-height: 20px !important;
  font-size: 14px;
}

.action-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: flex-start;
}

/* 视图切换按钮组 */
.view-mode-group {
  display: inline-flex;
  gap: 0;
  margin-left: auto;
}

.view-mode-group .native-button {
  border-radius: 0;
  height: 36px;
  width: 44px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.view-mode-group .native-button:first-child {
  border-radius: 4px 0 0 4px;
}

.view-mode-group .native-button:last-child {
  border-radius: 0 4px 4px 0;
}

/* 视图切换按钮图标大小 - 使用 :deep 穿透 scoped CSS */
.view-mode-group :deep(.native-btn__icon) {
  --icon-size: 18px !important;
}

.view-mode-group :deep(.native-btn__icon .native-icon),
.view-mode-group :deep(.native-btn__icon svg) {
  width: 18px !important;
  height: 18px !important;
  min-width: 18px !important;
  min-height: 18px !important;
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

.empty-categories .native-icon {
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

.category-card .native-icon {
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

/* 分类操作按钮容器 - 右上角 */
.category-card .category-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.category-card:hover .category-actions {
  opacity: 1;
}

.category-card .action-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.2s;
  color: white;
  padding-bottom: 2px;
  box-sizing: border-box;
}

.category-card .action-btn .native-icon {
  color: white;
  margin-bottom: -1px;
}

.category-card .action-btn:hover {
  background: rgba(255, 255, 255, 0.5);
}

.category-card .action-btn.rename-btn:hover {
  background: rgba(0, 82, 217, 0.6);
}

.category-card .action-btn.delete-btn:hover {
  background: rgba(227, 77, 89, 0.8);
}

/* 分类操作按钮行 */
.category-actions-row {
  display: flex;
  gap: 12px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #e8e8e8;
}

/* 分类图标大小强制设置 */
.category-card .category-icon,
.category-card .category-icon svg,
.category-card .category-icon .native-icon {
  width: 32px !important;
  height: 32px !important;
  min-width: 32px !important;
  min-height: 32px !important;
}

.books-list {
  margin-top: 16px;
}

/* 批量操作栏 */
.batch-actions-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f6f8fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.batch-actions-hint {
  color: #666;
  font-size: 14px;
  margin-left: auto;
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

.empty-state .native-icon {
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
  height: 78vh;
  max-height: 800px;
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
  width: 44px;
  min-width: 44px;
}

.reader-sidebar.sidebar-collapsed .sidebar-header {
  justify-content: center;
  padding: 10px 8px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-weight: 600;
  color: #333;
}

.sidebar-header .native-button {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  border-top: none;
}

.sidebar-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #666;
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
  padding: 0;
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

/* 工具栏中的选择框高度统一 - 与按钮一致(24px) */
.toolbar-group :deep(.native-select),
.toolbar-group :deep(.native-select--small),
.reader-toolbar .toolbar-group :deep(.native-select),
.reader-toolbar .toolbar-group :deep(.native-select--small) {
  height: 24px !important;
  min-height: 24px !important;
  max-height: 24px !important;
}

.toolbar-group :deep(.native-select__trigger),
.toolbar-group :deep(.native-select--small .native-select__trigger),
.reader-toolbar .toolbar-group :deep(.native-select__trigger),
.reader-toolbar .toolbar-group :deep(.native-select--small .native-select__trigger) {
  height: 24px !important;
  min-height: 24px !important;
  max-height: 24px !important;
  padding: 0 6px !important;
  box-sizing: border-box !important;
}

.toolbar-group :deep(.native-select__label),
.toolbar-group :deep(.native-select--small .native-select__label),
.toolbar-group :deep(.native-select__placeholder),
.toolbar-group :deep(.native-select--small .native-select__placeholder),
.reader-toolbar .toolbar-group :deep(.native-select__label),
.reader-toolbar .toolbar-group :deep(.native-select--small .native-select__label),
.reader-toolbar .toolbar-group :deep(.native-select__placeholder),
.reader-toolbar .toolbar-group :deep(.native-select--small .native-select__placeholder) {
  line-height: 16px !important;
  font-size: 13px;
}

.toolbar-progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.font-size-display {
  min-width: 50px;
  text-align: center;
  font-weight: 500;
  font-size: 14px;
  color: #333;
}

/* 工具栏按钮样式 - 图标文字对齐 */
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.toolbar-btn :deep(.native-button__icon) {
  display: inline-flex;
  align-items: center;
  margin-right: 2px;
}

.toolbar-btn span {
  font-size: 13px;
  font-weight: 500;
}

.toolbar-btn-icon {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.toolbar-btn-icon :deep(.native-button__icon) {
  display: inline-flex;
  align-items: center;
  margin-right: 2px;
}

.toolbar-btn-icon span {
  font-size: 13px;
  font-weight: 500;
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

/* 章节块样式 */
.chapter-block {
  margin-bottom: 3em;
  padding-bottom: 2em;
  border-bottom: 1px dashed #e0e0e0;
}

.chapter-block:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.reader-footer {
  margin-top: 16px;
  padding: 0 16px;
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #f5f1e8;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.loading-container {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 16px;
}

.content-hidden {
  visibility: hidden;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #e0e0e0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-text {
  font-size: 14px;
  color: #666;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
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

/* 书籍骨架屏 */
.books-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 24px;
  padding: 8px 0;
}

.book-skeleton-card {
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
  border-radius: 8px;
  overflow: hidden;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.book-skeleton-cover {
  width: 100%;
  height: 220px;
  background: #e0e0e0;
}

.book-skeleton-title {
  height: 16px;
  background: #e0e0e0;
  margin: 12px 12px 8px;
  border-radius: 4px;
}

.book-skeleton-author {
  height: 12px;
  background: #e0e0e0;
  margin: 0 12px 12px;
  border-radius: 4px;
  width: 60%;
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

/* 条目不换行 */
:deep(.native-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.native-table .book-title-text) {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
}

.book-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.2s;
}

.book-card:hover .book-actions {
  opacity: 1;
}

.book-actions .native-button {
  backdrop-filter: blur(4px);
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* 书籍卡片按钮图标大小 - 使用 :deep 穿透 scoped CSS */
.book-actions :deep(.native-btn__icon) {
  --icon-size: 16px !important;
}

.book-actions :deep(.native-btn__icon .native-icon),
.book-actions :deep(.native-btn__icon svg) {
  width: 16px !important;
  height: 16px !important;
  min-width: 16px !important;
  min-height: 16px !important;
}

/* 编辑按钮 - 黑色样式 */
.book-edit-btn {
  background: rgba(0, 0, 0, 0.75) !important;
  color: #fff !important;
  border-color: rgba(0, 0, 0, 0.75) !important;
}

.book-edit-btn:hover {
  background: rgba(0, 0, 0, 0.9) !important;
  border-color: rgba(0, 0, 0, 0.9) !important;
}

.book-edit-btn :deep(.native-icon) {
  color: #fff !important;
}

/* 删除按钮 - 红色半透明 */
.book-delete-btn {
  background: rgba(227, 77, 89, 0.9) !important;
  color: #fff !important;
  border-color: rgba(227, 77, 89, 0.9) !important;
}

.book-delete-btn:hover {
  background: rgba(227, 77, 89, 1) !important;
  border-color: rgba(227, 77, 89, 1) !important;
}

.book-delete-btn :deep(.native-icon) {
  color: #fff !important;
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

/* 解析元数据loading */
.parsing-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: #999;
  font-size: 12px;
}

/* 上传书籍对话框高度限制 */
.upload-book-dialog :deep(.native-dialog__body) {
  max-height: 60vh;
  overflow-y: auto;
}

/* 操作列左侧留白，与按钮对齐 */
:deep(.native-table th:last-child),
:deep(.native-table td:last-child) {
  text-align: left;
  padding-left: 8px;
}

:deep(.native-table td:last-child) {
  padding-right: 24px;
}
</style>
