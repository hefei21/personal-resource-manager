<template>
  <div class="mobile-bookmarks">
    <!-- 搜索栏 -->
    <div class="search-section">
      <div class="search-bar">
        <input
          v-model="searchKeyword"
          placeholder="搜索标题、URL..."
          @keyup.enter="handleSearch"
        />
        <NativeIcon name="search" class="search-icon" @click="handleSearch" />
      </div>
      <button v-if="!isGuest" class="add-btn" @click="handleAdd">
        <NativeIcon name="plus" size="20" />
      </button>
    </div>

    <!-- 标签筛选 -->
    <div v-if="allTags.length > 0" class="tag-filter">
      <div class="tag-scroll">
        <div
          class="tag-chip"
          :class="{ active: selectedTags.length === 0 }"
          @click="clearTags"
        >
          全部
        </div>
        <div
          v-for="tag in allTags"
          :key="tag"
          class="tag-chip"
          :class="{ active: selectedTags.includes(tag) }"
          @click="toggleTag(tag)"
        >
          {{ tag }}
        </div>
      </div>
    </div>

    <!-- 书签列表 -->
    <div class="bookmark-list">
      <ResourceListState
        v-if="loading || loadError || bookmarks.length === 0"
        :state="loading ? 'loading' : loadError ? 'error' : 'empty'"
        loading-text="加载书签中..."
        empty-text="暂无书签"
        :error-text="loadError"
        @retry="loadBookmarks(false)"
      />

      <div
        v-for="bookmark in bookmarks"
        :key="bookmark.id"
        class="bookmark-card"
        @click="handleCardClick(bookmark)"
      >
        <!-- 图标 -->
        <img
          :src="getIconUrl(bookmark)"
          class="card-icon"
          loading="lazy"
          @error="handleIconError"
          alt=""
        />

        <!-- 内容 -->
        <div class="card-content">
          <div class="card-title">{{ bookmark.title }}</div>
          <div class="card-url">{{ bookmark.url }}</div>
          <div v-if="bookmark.tags" class="card-tags">
            <span v-for="tag in parseTags(bookmark.tags)" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>

        <!-- 右侧操作 -->
        <div v-if="!isGuest" class="card-action" @click.stop="showActionMenu(bookmark)">
          <NativeIcon name="more" size="20" />
        </div>
      </div>
    </div>

    <!-- 加载更多 -->
    <div v-if="bookmarks.length > 0" class="load-more">
      <div v-if="isLoadingMore" class="load-more-spinner">
        <div class="spinner-small"></div>
        <span>加载中...</span>
      </div>
      <div v-else-if="!hasMore" class="no-more">没有更多了</div>
    </div>

    <!-- 无限滚动触发器 -->
    <div ref="loadMoreTriggerRef" class="load-more-trigger"></div>

    <!-- 底部操作菜单 -->
    <div v-if="actionMenuVisible" class="drawer-overlay" @click.self="closeActionMenu">
      <div class="action-sheet">
        <div class="sheet-title">{{ currentBookmark?.title }}</div>
        <div class="sheet-list">
          <div class="sheet-item" @click="openBookmark(currentBookmark)">
            <NativeIcon name="link" /> 打开链接
          </div>
          <div class="sheet-item" @click="handleEdit(currentBookmark); closeActionMenu()">
            <NativeIcon name="edit" /> 编辑
          </div>
        </div>
        <div class="sheet-cancel" @click="closeActionMenu">取消</div>
      </div>
    </div>

    <!-- 添加/编辑弹窗 -->
    <div v-if="editDialogVisible" class="modal-overlay" @click.self="editDialogVisible = false">
      <div class="modal-container">
        <div class="modal-header">{{ isEdit ? '编辑书签' : '添加书签' }}</div>
        <div class="modal-body">
          <div class="form-item">
            <label>URL</label>
            <input v-model="formData.url" class="native-input" placeholder="https://..." @blur="fetchTitle" />
            <NativeLoading v-if="fetchingTitle" size="small" />
          </div>
          <div class="form-item">
            <label>标题</label>
            <input v-model="formData.title" class="native-input" placeholder="书签标题" />
          </div>
          <div class="form-item">
            <label>标签</label>
            <input v-model="formData.tags" class="native-input" placeholder="用逗号分隔" />
          </div>
          <div class="form-item">
            <label>描述</label>
            <textarea v-model="formData.description" class="native-textarea" placeholder="描述" rows="3"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="editDialogVisible = false">取消</button>
          <button class="btn-primary" @click="handleConfirm">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { NativeIcon, NativeLoading } from '@/components/native'
import ResourceListState from '@/components/common/ResourceListState.vue'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

const loading = ref(false)
const loadError = ref('')
const bookmarks = ref([])
const searchKeyword = ref('')
const selectedTags = ref([])
const allTags = ref([])
const sortBy = ref('updated_at')

const pagination = ref({
  current: 1,
  pageSize: 20,
  total: 0
})
const hasMore = ref(true)
const isLoadingMore = ref(false)

// 操作菜单
const actionMenuVisible = ref(false)
const currentBookmark = ref(null)

// 编辑弹窗
const editDialogVisible = ref(false)
const isEdit = ref(false)
const formData = ref({
  id: null,
  title: '',
  url: '',
  icon: '',
  iconData: '',
  tags: '',
  description: ''
})
const fetchingTitle = ref(false)

// 无限滚动
const loadMoreTriggerRef = ref(null)
let loadMoreObserver = null

// 获取图标URL
function getIconUrl(row) {
  if (row.icon_data) {
    return row.icon_data
  }
  if (row.icon) {
    return row.icon
  }
  try {
    const urlObj = new URL(row.url)
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=64`
  } catch {
    return ''
  }
}

function handleIconError(e) {
  const img = e.target
  const src = img.src
  if (!src.includes('google.com')) {
    try {
      const row = bookmarks.value.find(b => b.icon === src || getIconUrl(b) === src)
      if (row) {
        const urlObj = new URL(row.url)
        img.src = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=64`
        return
      }
    } catch {}
  }
  img.style.display = 'none'
}

function parseTags(tagsStr) {
  if (!tagsStr) return []
  return tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean)
}

async function loadBookmarks(append = false) {
  if (!append) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const params = {
      keyword: searchKeyword.value,
      sortBy: sortBy.value,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    }
    if (selectedTags.value.length > 0) {
      params.tags = selectedTags.value.join(',')
    }
    const response = await api.bookmarks.list(params)
    const data = response.data.data || []
    const total = response.data.total || 0
    if (append) {
      bookmarks.value.push(...data)
    } else {
      bookmarks.value = data
    }
    pagination.value.total = total
    hasMore.value = bookmarks.value.length < total
  } catch (error) {
    if (!append) loadError.value = error.response?.data?.message || '加载书签失败，请稍后重试'
    toast.error('加载书签失败')
  } finally {
    loading.value = false
    isLoadingMore.value = false
    // 数据加载完成后，重新初始化滚动加载观察器
    nextTick(() => {
      setTimeout(() => {
        initLoadMoreObserver()
      }, 200)
    })
  }
}

async function loadAllTags() {
  try {
    const response = await api.bookmarks.getTags()
    allTags.value = response.data?.data || []
  } catch (error) {
    console.error('加载标签失败:', error)
  }
}

function handleSearch() {
  pagination.value.current = 1
  hasMore.value = true
  loadBookmarks(false)
}

function toggleTag(tag) {
  const index = selectedTags.value.indexOf(tag)
  if (index > -1) {
    selectedTags.value.splice(index, 1)
  } else {
    selectedTags.value.push(tag)
  }
  pagination.value.current = 1
  hasMore.value = true
  loadBookmarks(false)
}

function clearTags() {
  selectedTags.value = []
  pagination.value.current = 1
  hasMore.value = true
  loadBookmarks(false)
}

// 加载更多
function loadMore() {
  pagination.value.current += 1
  isLoadingMore.value = true
  loadBookmarks(true)
}

// 无限滚动：使用 IntersectionObserver
function initLoadMoreObserver() {
  // 先断开旧的观察器
  if (loadMoreObserver) {
    loadMoreObserver.disconnect()
    loadMoreObserver = null
  }
  
  // 如果没有更多数据，不创建观察器
  if (!hasMore.value) return
  
  const triggerEl = loadMoreTriggerRef.value
  if (!triggerEl) return
  
  loadMoreObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !isLoadingMore.value && hasMore.value && !loading.value) {
        loadMore()
      }
    })
  }, {
    rootMargin: '0px 0px 100px 0px',
    threshold: 0
  })
  
  loadMoreObserver.observe(triggerEl)
}

// 卡片点击
function handleCardClick(bookmark) {
  openBookmark(bookmark)
}

function openBookmark(bookmark) {
  const opened = window.open(bookmark.url, '_blank', 'noopener,noreferrer')
  if (opened) opened.opener = null
}

// 操作菜单
function showActionMenu(bookmark) {
  currentBookmark.value = bookmark
  actionMenuVisible.value = true
}

function closeActionMenu() {
  actionMenuVisible.value = false
  currentBookmark.value = null
}

// 添加/编辑
function handleAdd() {
  isEdit.value = false
  formData.value = { id: null, title: '', url: '', icon: '', iconData: '', tags: '', description: '' }
  editDialogVisible.value = true
}

function handleEdit(bookmark) {
  isEdit.value = true
  formData.value = { ...bookmark }
  editDialogVisible.value = true
}

async function fetchTitle() {
  if (!formData.value.url || formData.value.title) return
  
  fetchingTitle.value = true
  try {
    const response = await api.bookmarks.fetchTitle(formData.value.url)
    if (response.data.title && !formData.value.title) {
      formData.value.title = response.data.title
    }
    if (response.data.icon) {
      formData.value.icon = response.data.icon
    }
    if (response.data.iconData) {
      formData.value.iconData = response.data.iconData
    }
  } catch (error) {
    console.log('自动获取标题失败:', error)
  } finally {
    fetchingTitle.value = false
  }
}

async function handleConfirm() {
  try {
    if (isEdit.value) {
      await api.bookmarks.update(formData.value.id, formData.value)
      toast.success('更新成功')
    } else {
      await api.bookmarks.create(formData.value)
      toast.success('添加成功')
    }
    editDialogVisible.value = false
    loadBookmarks()
    loadAllTags()
  } catch (error) {
    toast.error('操作失败')
  }
}

onMounted(() => {
  loadBookmarks()
  loadAllTags()
  // 延迟初始化滚动加载观察器，确保DOM已渲染
  setTimeout(() => {
    initLoadMoreObserver()
  }, 500)
})

onUnmounted(() => {
  if (loadMoreObserver) loadMoreObserver.disconnect()
})
</script>

<style scoped>
.mobile-bookmarks {
  padding: 12px;
  min-height: 100vh;
  background: var(--color-surface-subtle);
}

/* 搜索栏 */
.search-section {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.search-bar {
  flex: 1;
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 8px;
  padding: 0 12px;
}

.search-bar input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 10px 0;
  font-size: 14px;
  outline: none;
}

.search-icon {
  color: var(--color-text-muted);
  cursor: pointer;
}

.add-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: none;
  background: var(--color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* 标签筛选 */
.tag-filter {
  margin-bottom: 12px;
}

.tag-scroll {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: #ccc transparent;
}

.tag-scroll::-webkit-scrollbar {
  height: 3px;
}

.tag-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.tag-scroll::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 2px;
}

.tag-chip {
  flex-shrink: 0;
  padding: 6px 12px;
  background: #fff;
  border-radius: 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.tag-chip.active {
  background: var(--color-primary);
  color: #fff;
}

/* 批量操作栏 */
.batch-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #e6f2ff;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 12px;
}

.batch-info {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--color-text-primary);
}

.text-btn {
  background: none;
  border: none;
  color: var(--color-primary);
  font-size: 13px;
  cursor: pointer;
}

.batch-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  border: none;
  cursor: pointer;
}

.action-btn.danger {
  background: var(--color-danger);
  color: #fff;
}

.action-btn.secondary {
  background: #fff;
  color: var(--color-text-secondary);
}

/* 书签列表 */
.bookmark-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bookmark-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  padding: 12px;
  border-radius: 10px;
  transition: all 0.2s;
  cursor: pointer;
}

.bookmark-card:active {
  background: #f5f7fa;
}

.bookmark-card.selected {
  background: #e6f2ff;
}

.batch-checkbox {
  flex-shrink: 0;
}

.checkbox {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.checkbox.checked {
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  flex-shrink: 0;
  object-fit: contain;
}

.card-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.card-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-url {
  font-size: 12px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.card-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.card-tags .tag {
  font-size: 11px;
  color: var(--color-primary);
  background: #e6f2ff;
  padding: 2px 8px;
  border-radius: 10px;
}

.card-action {
  flex-shrink: 0;
  padding: 8px;
  color: var(--color-text-muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* 加载/空状态 */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60px 0;
  color: var(--color-text-muted);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f0f0f0;
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state p {
  margin-top: 12px;
  font-size: 14px;
}

/* 加载更多 */
.load-more {
  padding: 16px 0;
  text-align: center;
}

.load-more-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid #f0f0f0;
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.no-more {
  color: var(--color-text-muted);
  font-size: 13px;
}

.load-more-trigger {
  height: 1px;
}

/* 分页 */
.pagination-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
}

.page-btn {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: #fff;
  color: var(--color-text-primary);
  font-size: 14px;
  cursor: pointer;
}

.page-btn:disabled {
  color: #ccc;
  cursor: not-allowed;
}

.page-info {
  font-size: 14px;
  color: var(--color-text-secondary);
}

/* 长按提示 */
.longpress-tip {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 14px;
  z-index: 500;
  animation: fadeInOut 1.5s ease forwards;
  pointer-events: none;
}

@keyframes fadeInOut {
  0% { opacity: 0; }
  20% { opacity: 1; }
  80% { opacity: 1; }
  100% { opacity: 0; }
}

/* 底部操作菜单遮罩 */
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding-bottom: var(--player-height, 0px);
}

.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  animation: slideUp 0.3s ease;
}

.sheet-title {
  text-align: center;
  padding: 16px;
  font-size: 13px;
  color: var(--color-text-muted);
  border-bottom: 1px solid #f0f0f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-list {
  max-height: 300px;
  overflow-y: auto;
}

.sheet-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  font-size: 15px;
  color: var(--color-text-primary);
  cursor: pointer;
  border-bottom: 1px solid #f8f8f8;
}

.sheet-item:active {
  background: #f5f7fa;
}

.sheet-item.delete {
  color: var(--color-danger);
}

.sheet-cancel {
  text-align: center;
  padding: 16px;
  font-size: 15px;
  color: var(--color-text-secondary);
  border-top: 8px solid #f5f7fa;
  cursor: pointer;
}

.sheet-cancel:active {
  background: #f5f7fa;
}

@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  padding-bottom: calc(20px + var(--player-height, 0px));
}

.modal-container {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 400px;
  max-height: 90vh;
  overflow: hidden;
  animation: scaleIn 0.2s ease;
}

.modal-header {
  padding: 16px 20px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid #f0f0f0;
}

.modal-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
}

.modal-footer button {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  font-size: 15px;
  border: none;
  cursor: pointer;
}

.btn-secondary {
  background: #f5f7fa;
  color: var(--color-text-secondary);
}

.btn-primary {
  background: var(--color-primary);
  color: #fff;
}

/* 表单 */
.form-item {
  margin-bottom: 16px;
}

.form-item label {
  display: block;
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}

.native-input,
.native-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}

.native-textarea {
  resize: vertical;
}

@keyframes scaleIn {
  from { transform: scale(0.9); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
</style>
