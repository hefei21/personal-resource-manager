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

    <!-- 批量操作栏 -->
    <div v-if="batchMode" class="batch-bar">
      <div class="batch-info">
        <span>已选择 {{ selectedIds.length }} 项</span>
        <button class="text-btn" @click="toggleSelectAll">{{ isAllSelected ? '取消全选' : '全选' }}</button>
      </div>
      <div class="batch-actions">
        <button class="action-btn danger" @click="confirmBatchDelete">删除</button>
        <button class="action-btn secondary" @click="exitBatchMode">完成</button>
      </div>
    </div>

    <!-- 书签列表 -->
    <div class="bookmark-list">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="bookmarks.length === 0" class="empty-state">
        <NativeIcon name="bookmark" size="48" />
        <p>暂无书签</p>
      </div>

      <div
        v-for="bookmark in bookmarks"
        :key="bookmark.id"
        class="bookmark-card"
        :class="{ selected: batchMode && selectedIds.includes(bookmark.id) }"
        @click="handleCardClick(bookmark)"
        @touchstart="!isGuest && handleTouchStart($event, bookmark)"
        @touchend="handleTouchEnd"
        @touchmove="handleTouchMove"
      >
        <!-- 批量模式复选框 -->
        <div v-if="batchMode" class="batch-checkbox">
          <div class="checkbox" :class="{ checked: selectedIds.includes(bookmark.id) }">
            <NativeIcon v-if="selectedIds.includes(bookmark.id)" name="check" size="12" />
          </div>
        </div>

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
        <div v-if="!batchMode && !isGuest" class="card-action" @click.stop="showActionMenu(bookmark)">
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

    <!-- 长按提示 -->
    <div v-if="showLongPressTip" class="longpress-tip">长按进入多选模式</div>

    <!-- 底部操作菜单 -->
    <div v-if="actionMenuVisible" class="drawer-overlay" @click.self="closeActionMenu">
      <div class="action-sheet">
        <div class="sheet-title">{{ currentBookmark?.title }}</div>
        <div class="sheet-list">
          <div class="sheet-item" @click="openBookmark(currentBookmark)">
            <NativeIcon name="link" /> 打开链接
          </div>
          <div class="sheet-item" @click="startBatchFromBookmark(currentBookmark)">
            <NativeIcon name="check-rectangle" /> 多选
          </div>
          <div class="sheet-item" @click="handleEdit(currentBookmark); closeActionMenu()">
            <NativeIcon name="edit" /> 编辑
          </div>
          <div class="sheet-item delete" @click="confirmDelete(currentBookmark)">
            <NativeIcon name="delete" /> 删除
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
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

const loading = ref(false)
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

// 批量操作
const batchMode = ref(false)
const selectedIds = ref([])

// 长按相关
let longPressTimer = null
const LONG_PRESS_DURATION = 600
const showLongPressTip = ref(false)

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

const isAllSelected = computed(() => {
  return bookmarks.value.length > 0 && selectedIds.value.length === bookmarks.value.length
})

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
  if (batchMode.value) {
    toggleSelection(bookmark.id)
  } else {
    openBookmark(bookmark)
  }
}

function openBookmark(bookmark) {
  window.open(bookmark.url, '_blank')
}

// 长按处理（仅管理员）
function handleTouchStart(e, bookmark) {
  if (batchMode.value || isGuest.value) return
  
  longPressTimer = setTimeout(() => {
    batchMode.value = true
    selectedIds.value = [bookmark.id]
    showLongPressTip.value = true
    setTimeout(() => showLongPressTip.value = false, 1500)
  }, LONG_PRESS_DURATION)
}

function handleTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function handleTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

// 从操作菜单进入批量模式
function startBatchFromBookmark(bookmark) {
  batchMode.value = true
  selectedIds.value = [bookmark.id]
  closeActionMenu()
}

// 退出批量模式
function exitBatchMode() {
  batchMode.value = false
  selectedIds.value = []
}

// 切换选择
function toggleSelection(id) {
  const index = selectedIds.value.indexOf(id)
  if (index > -1) {
    selectedIds.value.splice(index, 1)
  } else {
    selectedIds.value.push(id)
  }
}

// 全选/取消全选
function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value = []
  } else {
    selectedIds.value = bookmarks.value.map(b => b.id)
  }
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

// 删除确认
function confirmDelete(bookmark) {
  closeActionMenu()
  if (!confirm('确定删除该书签吗？')) return
  handleDelete(bookmark.id)
}

// 批量删除确认
function confirmBatchDelete() {
  if (selectedIds.value.length === 0) return
  if (!confirm(`确定删除选中的 ${selectedIds.value.length} 项书签吗？`)) return
  handleBatchDelete()
}

async function handleDelete(id) {
  try {
    await api.bookmarks.delete(id)
    toast.success('删除成功')
    loadBookmarks()
  } catch (error) {
    toast.error('删除失败')
  }
}

async function handleBatchDelete() {
  try {
    await api.bookmarks.batchDelete({ ids: selectedIds.value })
    toast.success('批量删除成功')
    exitBatchMode()
    loadBookmarks()
  } catch (error) {
    toast.error('批量删除失败')
  }
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
  background: #f5f5f5;
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
  color: #999;
  cursor: pointer;
}

.add-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: none;
  background: #0052d9;
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
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
}

.tag-chip.active {
  background: #0052d9;
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
  color: #333;
}

.text-btn {
  background: none;
  border: none;
  color: #0052d9;
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
  background: #e34d59;
  color: #fff;
}

.action-btn.secondary {
  background: #fff;
  color: #666;
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
  background: #0052d9;
  border-color: #0052d9;
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
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-url {
  font-size: 12px;
  color: #999;
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
  color: #0052d9;
  background: #e6f2ff;
  padding: 2px 8px;
  border-radius: 10px;
}

.card-action {
  flex-shrink: 0;
  padding: 8px;
  color: #999;
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
  color: #999;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f0f0f0;
  border-top-color: #0052d9;
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
  color: #999;
  font-size: 13px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.no-more {
  color: #999;
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
  color: #333;
  font-size: 14px;
  cursor: pointer;
}

.page-btn:disabled {
  color: #ccc;
  cursor: not-allowed;
}

.page-info {
  font-size: 14px;
  color: #666;
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
  color: #999;
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
  color: #333;
  cursor: pointer;
  border-bottom: 1px solid #f8f8f8;
}

.sheet-item:active {
  background: #f5f7fa;
}

.sheet-item.delete {
  color: #e34d59;
}

.sheet-cancel {
  text-align: center;
  padding: 16px;
  font-size: 15px;
  color: #666;
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
  color: #666;
}

.btn-primary {
  background: #0052d9;
  color: #fff;
}

/* 表单 */
.form-item {
  margin-bottom: 16px;
}

.form-item label {
  display: block;
  font-size: 14px;
  color: #666;
  margin-bottom: 8px;
}

.native-input,
.native-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #e8e8e8;
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
