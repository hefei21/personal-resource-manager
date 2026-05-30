<template>
  <div class="mobile-blog">
    <!-- 状态筛选标签 -->
    <div class="status-tabs">
      <div class="tab-item" :class="{ active: statusFilter === '' }" @click="switchStatus('')">全部</div>
      <div class="tab-item" :class="{ active: statusFilter === 'published' }" @click="switchStatus('published')">已发布</div>
      <div v-if="!isGuest" class="tab-item" :class="{ active: statusFilter === 'draft' }" @click="switchStatus('draft')">草稿</div>
    </div>

    <!-- 搜索栏 -->
    <div class="search-section">
      <div class="search-bar">
        <input v-model="searchKeyword" type="text" placeholder="搜索文章..." @keyup.enter="loadPosts(true)" />
        <span class="search-icon" @click="loadPosts(true)"><NativeIcon name="search" /></span>
      </div>
      <button class="filter-btn" @click="showFilterDrawer = true"><NativeIcon name="filter" /></button>
    </div>

    <!-- 文章列表 -->
    <div class="posts-container">
      <div v-if="loading && posts.length === 0" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="posts.length === 0" class="empty-state">
        <NativeIcon name="file" size="48" />
        <p>暂无文章</p>
        <button v-if="!isGuest" class="primary-btn" @click="handleCreate">写第一篇文章</button>
      </div>

      <div v-else class="post-list">
        <div v-for="post in posts" :key="post.id" class="post-card" @click="handlePreview(post)">
          <div class="post-header">
            <div class="post-badges">
              <span v-if="post.is_top" class="badge badge-top">置顶</span>
              <span v-if="post.status === 'draft'" class="badge badge-draft">草稿</span>
            </div>
            <h3 class="post-title">{{ post.title }}</h3>
          </div>
          <div class="post-meta">
            <span v-if="post.category_name" class="meta-item"><NativeIcon name="folder" size="14" />{{ post.category_name }}</span>
            <span v-if="post.tags && post.tags.length > 0" class="meta-item tags"><NativeIcon name="discount" size="14" />{{ post.tags.slice(0, 2).join(', ') }}<span v-if="post.tags.length > 2">+{{ post.tags.length - 2 }}</span></span>
            <span class="meta-item time"><NativeIcon name="time" size="14" />{{ formatDate(post.updated_at) }}</span>
          </div>
          <div class="post-actions" @click.stop>
            <button class="action-btn-small" @click="handlePreview(post)"><NativeIcon name="browse" size="16" /></button>
            <button v-if="!isGuest" class="action-btn-small" @click="handleEdit(post)"><NativeIcon name="edit" size="16" /></button>
            <button v-if="!isGuest" class="action-btn-small danger" @click="confirmDelete(post)"><NativeIcon name="delete" size="16" /></button>
          </div>
        </div>

        <div v-if="hasMore" class="load-more">
          <button v-if="!loadingMore" class="load-btn" @click="loadMore">加载更多</button>
          <div v-else class="loading-more"><div class="spinner-small"></div><span>加载中...</span></div>
        </div>
      </div>
    </div>

    <!-- 新建按钮 -->
    <button v-if="!isGuest" class="fab" @click="handleCreate"><NativeIcon name="add" size="24" /></button>

    <!-- 筛选抽屉 -->
    <div v-if="showFilterDrawer" class="drawer-overlay" @click.self="showFilterDrawer = false">
      <div class="filter-drawer">
        <div class="drawer-header"><span>筛选</span><button class="close-btn" @click="showFilterDrawer = false"><NativeIcon name="close" size="20" /></button></div>
        <div class="drawer-body">
          <div class="filter-section">
            <label class="filter-label">分类</label>
            <div class="filter-options">
              <div class="filter-chip" :class="{ active: !categoryFilter }" @click="categoryFilter = null">全部</div>
              <div v-for="cat in flatCategories" :key="cat.id" class="filter-chip" :class="{ active: categoryFilter === cat.id }" @click="categoryFilter = cat.id">{{ cat.name }}</div>
            </div>
          </div>
          <div class="filter-section">
            <label class="filter-label">标签</label>
            <div class="filter-options">
              <div class="filter-chip" :class="{ active: !tagFilter }" @click="tagFilter = null">全部</div>
              <div v-for="tag in tags" :key="tag.id" class="filter-chip" :class="{ active: tagFilter === tag.id }" @click="tagFilter = tag.id">{{ tag.name }}</div>
            </div>
          </div>
        </div>
        <div class="drawer-footer">
          <button class="btn-secondary" @click="resetFilters">重置</button>
          <button class="btn-primary" @click="applyFilters">应用</button>
        </div>
      </div>
    </div>

    <!-- 分类管理抽屉 -->
    <div v-if="showCategoryManager" class="drawer-overlay" @click.self="showCategoryManager = false">
      <div class="category-drawer">
        <div class="drawer-header"><span>分类管理</span><button class="close-btn" @click="showCategoryManager = false"><NativeIcon name="close" size="20" /></button></div>
        <div class="drawer-body">
          <div class="add-category">
            <input v-model="newCategoryName" type="text" placeholder="输入新分类名称" @keyup.enter="handleCreateCategory" />
            <button class="btn-primary" @click="handleCreateCategory" :disabled="!newCategoryName.trim()">添加</button>
          </div>
          <div class="category-list">
            <div v-for="cat in categories" :key="cat.id" class="category-list-item">
              <div class="category-info"><NativeIcon name="folder" size="18" /><span>{{ cat.name }}</span><span class="count">({{ cat.post_count || 0 }})</span></div>
              <div class="category-actions" v-if="!isGuest">
                <button class="action-btn-icon" @click="handleEditCategory(cat)"><NativeIcon name="edit" size="16" /></button>
                <button class="action-btn-icon danger" @click="confirmDeleteCategory(cat)"><NativeIcon name="delete" size="16" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑分类弹窗 -->
    <div v-if="editCategoryDialogVisible" class="modal-overlay" @click.self="editCategoryDialogVisible = false">
      <div class="modal-container">
        <div class="modal-header">编辑分类</div>
        <div class="modal-body">
          <input v-model="editingCategory.name" type="text" placeholder="分类名称" class="modal-input" />
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="editCategoryDialogVisible = false">取消</button>
          <button class="btn-primary" @click="handleUpdateCategory">保存</button>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="deleteConfirmVisible" class="modal-overlay" @click.self="deleteConfirmVisible = false">
      <div class="modal-container small">
        <div class="modal-header">确认删除</div>
        <div class="modal-body">
          <p>确定要删除文章「{{ postToDelete?.title }}」吗？</p>
          <p class="warning-text">删除后无法恢复</p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="deleteConfirmVisible = false">取消</button>
          <button class="btn-danger" @click="doDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 文章预览全屏页 -->
    <div v-if="previewVisible" class="fullscreen-preview">
      <div class="preview-header">
        <button class="back-btn" @click="previewVisible = false"><NativeIcon name="chevron-left" size="24" /></button>
        <span class="preview-title">文章预览</span>
        <button v-if="!isGuest && previewPost" class="edit-btn" @click="handleEditFromPreview"><NativeIcon name="edit" size="20" /></button>
        <div v-else class="placeholder"></div>
      </div>
      <div class="preview-body">
        <div class="preview-article">
          <h1 class="article-title">{{ previewPost?.title }}</h1>
          <div class="article-meta">
            <span v-if="previewPost?.category_name" class="meta-tag"><NativeIcon name="folder" size="14" />{{ previewPost.category_name }}</span>
            <span v-if="previewPost?.tags && previewPost.tags.length > 0" class="meta-tag"><NativeIcon name="discount" size="14" />{{ previewPost.tags.join(', ') }}</span>
            <span class="meta-tag"><NativeIcon name="time" size="14" />{{ previewPost?.updated_at }}</span>
          </div>
          <div class="article-divider"></div>
          <MdPreview 
            v-if="previewVisible && previewContent" 
            :modelValue="previewContent" 
            :theme="editorTheme" 
            :previewTheme="previewTheme" 
            :codeTheme="codeTheme" 
            class="article-content" 
          />
        </div>
      </div>
    </div>

    <!-- 编辑器全屏页 -->
    <div v-if="editorVisible" class="fullscreen-editor">
      <div class="editor-header">
        <button class="back-btn" @click="closeEditor"><NativeIcon name="chevron-left" size="24" /></button>
        <input v-model="editForm.title" type="text" placeholder="文章标题" class="title-input" />
        <button class="more-btn" @click="showEditorOptions = true"><NativeIcon name="more" size="20" /></button>
      </div>
      <div class="editor-body">
        <MdEditor 
          v-if="editorVisible"
          v-model="editForm.content" 
          :theme="editorTheme" 
          :previewTheme="previewTheme" 
          :codeTheme="codeTheme" 
          :toolbars="mobileToolbars" 
          :preview="false" 
          editorClass="mobile-md-editor"
        />
      </div>
      <div class="editor-toolbar">
        <div class="toolbar-left"><span class="word-count">{{ contentLength }} 字</span></div>
        <div class="toolbar-right">
          <button class="btn-save-draft" @click="handleSaveDraft" :disabled="saving">存草稿</button>
          <button class="btn-publish" @click="handlePublish" :disabled="saving">{{ editForm.status === 'published' ? '更新' : '发布' }}</button>
        </div>
      </div>
      <!-- 编辑器选项抽屉 -->
      <div v-if="showEditorOptions" class="drawer-overlay" @click.self="showEditorOptions = false">
        <div class="options-drawer">
          <div class="drawer-header"><span>文章设置</span><button class="close-btn" @click="showEditorOptions = false"><NativeIcon name="close" size="20" /></button></div>
          <div class="drawer-body">
            <div class="form-item">
              <label>分类</label>
              <select v-model="editForm.category_id" class="native-select">
                <option :value="null">无分类</option>
                <option v-for="cat in flatCategories" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
              </select>
            </div>
            <div class="form-item">
              <label>标签（用逗号分隔）</label>
              <input v-model="tagInput" type="text" placeholder="例如：技术, 生活, 随笔" class="native-input" />
            </div>
            <div class="form-item checkbox-item">
              <label class="checkbox-label"><input type="checkbox" v-model="editForm.is_top" /><span>置顶文章</span></label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import api from '@/api'
import { MdPreview, MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import 'md-editor-v3/lib/preview.css'
import { usePermission } from '@/composables/usePermission'
import { NativeIcon } from '@/components/native'

const { isGuest } = usePermission()

const editorTheme = ref('light')
const previewTheme = ref('default')
const codeTheme = ref('atom')
const mobileToolbars = ['bold', 'underline', 'italic', 'strikeThrough', '|', 'title', 'quote', 'unorderedList', 'orderedList', '|', 'codeRow', 'code', 'link', 'image', '|', 'revoke', 'next', 'save']

const posts = ref([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const page = ref(1)
const pageSize = 20
const hasMore = ref(true)
const searchKeyword = ref('')
const statusFilter = ref('')
const categoryFilter = ref(null)
const tagFilter = ref(null)

const categories = ref([])
const tags = ref([])

const editorVisible = ref(false)
const showEditorOptions = ref(false)
const editingPost = ref(null)
const editForm = ref({ title: '', content: '', category_id: null, tags: [], status: 'draft', is_top: false })
const tagInput = ref('')
const saving = ref(false)

const previewVisible = ref(false)
const previewPost = ref(null)
const previewContent = ref('')

const showFilterDrawer = ref(false)
const showCategoryManager = ref(false)
const newCategoryName = ref('')
const editCategoryDialogVisible = ref(false)
const editingCategory = ref({ id: null, name: '' })
const deleteConfirmVisible = ref(false)
const postToDelete = ref(null)

const flatCategories = computed(() => {
  const flatten = (items, result = []) => {
    items.forEach(item => {
      result.push(item)
      if (item.children && item.children.length > 0) flatten(item.children, result)
    })
    return result
  }
  return flatten(categories.value)
})

const contentLength = computed(() => editForm.value.content?.length || 0)

async function loadPosts(reset = false) {
  if (reset) { page.value = 1; posts.value = []; hasMore.value = true }
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize }
    if (searchKeyword.value) params.keyword = searchKeyword.value
    if (statusFilter.value) params.status = statusFilter.value
    if (categoryFilter.value) params.category_id = categoryFilter.value
    if (tagFilter.value) params.tag_id = tagFilter.value
    const response = await api.blog.getPosts(params)
    const newPosts = response.data.data || []
    if (reset) posts.value = newPosts
    else posts.value.push(...newPosts)
    total.value = response.data.total || 0
    hasMore.value = posts.value.length < total.value
  } catch (error) {
    console.error('加载文章失败:', error)
    toast.error('加载文章失败')
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  page.value++
  try { await loadPosts() } finally { loadingMore.value = false }
}

function switchStatus(status) { statusFilter.value = status; loadPosts(true) }

async function loadCategories() {
  try { categories.value = (await api.blog.getAllCategories()).data.data || [] } catch (e) { console.error('加载分类失败:', e) }
}

async function loadTags() {
  try { tags.value = (await api.blog.getTags()).data.data || [] } catch (e) { console.error('加载标签失败:', e) }
}

function applyFilters() { showFilterDrawer.value = false; loadPosts(true) }
function resetFilters() { categoryFilter.value = null; tagFilter.value = null; showFilterDrawer.value = false; loadPosts(true) }

function handleCreate() {
  editingPost.value = null
  editForm.value = { title: '', content: '', category_id: null, tags: [], status: 'draft', is_top: false }
  tagInput.value = ''
  editorVisible.value = true
}

async function handleEdit(post) {
  try {
    const data = (await api.blog.getPost(post.id)).data.data
    editingPost.value = data
    editForm.value = { title: data.title, content: data.content || '', category_id: data.category_id, tags: data.tags || [], status: data.status, is_top: data.is_top === 1 }
    tagInput.value = (data.tags || []).join(', ')
    editorVisible.value = true
  } catch (error) {
    toast.error('加载文章失败')
  }
}

function closeEditor() {
  if (editForm.value.title || editForm.value.content) { if (confirm('确定要放弃编辑吗？')) editorVisible.value = false }
  else editorVisible.value = false
}

async function handleSaveDraft() { await savePost('draft') }
async function handlePublish() { await savePost('published') }

async function savePost(status) {
  if (!editForm.value.title?.trim()) { toast.warning('请输入文章标题'); return }
  const tags = tagInput.value.split(/[,，]/).map(t => t.trim()).filter(t => t)
  saving.value = true
  try {
    const data = { title: editForm.value.title.trim(), content: editForm.value.content, category_id: editForm.value.category_id || null, tags: tags, status: status, is_top: editForm.value.is_top }
    if (editingPost.value) { await api.blog.updatePost(editingPost.value.id, data); toast.success('更新成功') }
    else { await api.blog.createPost(data); toast.success('创建成功') }
    editorVisible.value = false
    loadPosts(true)
    loadCategories()
  } catch (error) {
    toast.error(error.response?.data?.message || '保存失败')
  } finally { saving.value = false }
}

async function handlePreview(post) {
  try {
    const data = (await api.blog.getPost(post.id)).data.data
    previewPost.value = data
    previewContent.value = data.content || ''
    previewVisible.value = true
  } catch (error) { toast.error('加载文章失败') }
}

function handleEditFromPreview() { previewVisible.value = false; handleEdit(previewPost.value) }

function confirmDelete(post) { postToDelete.value = post; deleteConfirmVisible.value = true }

async function doDelete() {
  if (!postToDelete.value) return
  try {
    await api.blog.deletePost(postToDelete.value.id)
    toast.success('删除成功')
    deleteConfirmVisible.value = false
    postToDelete.value = null
    loadPosts(true)
    loadCategories()
  } catch (error) { toast.error('删除失败') }
}

async function handleCreateCategory() {
  if (!newCategoryName.value?.trim()) { toast.warning('请输入分类名称'); return }
  try {
    await api.blog.createCategory({ name: newCategoryName.value.trim() })
    toast.success('创建成功')
    newCategoryName.value = ''
    loadCategories()
  } catch (error) { toast.error(error.response?.data?.message || '创建失败') }
}

function handleEditCategory(category) { editingCategory.value = { id: category.id, name: category.name }; editCategoryDialogVisible.value = true }

async function handleUpdateCategory() {
  if (!editingCategory.value.name?.trim()) { toast.warning('请输入分类名称'); return }
  try {
    await api.blog.updateCategory(editingCategory.value.id, { name: editingCategory.value.name.trim() })
    toast.success('更新成功')
    editCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) { toast.error(error.response?.data?.message || '更新失败') }
}

function confirmDeleteCategory(category) { if (confirm(`确定要删除分类「${category.name}」吗？`)) handleDeleteCategory(category.id) }

async function handleDeleteCategory(id) {
  try { await api.blog.deleteCategory(id); toast.success('删除成功'); loadCategories() }
  catch (error) { toast.error(error.response?.data?.message || '删除失败') }
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now - date
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000))
    if (hours < 1) { const mins = Math.floor(diff / (60 * 1000)); return mins < 1 ? '刚刚' : `${mins}分钟前` }
    return `${hours}小时前`
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))}天前`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

onMounted(() => { loadPosts(true); loadCategories(); loadTags() })
</script>

<style scoped>
.mobile-blog { padding: 12px; padding-bottom: 100px; min-height: 100vh; background: #f5f7fa; }
.status-tabs { display: flex; gap: 8px; margin-bottom: 12px; overflow-x: auto; padding-bottom: 4px; }
.status-tabs::-webkit-scrollbar { display: none; }
.tab-item { flex-shrink: 0; padding: 8px 16px; border-radius: 20px; font-size: 14px; color: #666; background: #fff; border: 1px solid #e8e8e8; transition: all 0.2s; cursor: pointer; }
.tab-item.active { background: #0052d9; color: #fff; border-color: #0052d9; }
.search-section { display: flex; gap: 8px; margin-bottom: 16px; }
.search-bar { flex: 1; display: flex; align-items: center; background: #fff; border-radius: 24px; padding: 0 16px; border: 1px solid #e8e8e8; }
.search-bar input { flex: 1; border: none; background: none; padding: 12px 8px; font-size: 14px; outline: none; }
.search-icon { color: #999; cursor: pointer; }
.filter-btn { width: 44px; height: 44px; border-radius: 50%; border: none; background: #fff; border: 1px solid #e8e8e8; display: flex; align-items: center; justify-content: center; color: #666; cursor: pointer; }
.filter-btn:active { background: #f0f0f0; }
.posts-container { min-height: 300px; }
.loading-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: #999; }
.spinner { width: 32px; height: 32px; border: 3px solid #f0f0f0; border-top-color: #0052d9; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
.spinner-small { width: 20px; height: 20px; border: 2px solid #f0f0f0; border-top-color: #0052d9; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; color: #999; }
.empty-state p { margin: 16px 0; font-size: 14px; }
.primary-btn { padding: 10px 24px; background: #0052d9; color: #fff; border: none; border-radius: 20px; font-size: 14px; cursor: pointer; }
.post-list { display: flex; flex-direction: column; gap: 12px; }
.post-card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
.post-card:active { transform: scale(0.98); }
.post-header { margin-bottom: 12px; }
.post-badges { display: flex; gap: 6px; margin-bottom: 8px; }
.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
.badge-top { background: #fff7e6; color: #fa8c16; }
.badge-draft { background: #f5f5f5; color: #999; }
.post-title { font-size: 16px; font-weight: 600; color: #333; line-height: 1.4; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.post-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.meta-item { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #888; }
.meta-item.tags { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-actions { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid #f0f0f0; pointer-events: auto; }
.action-btn-small { width: 32px; height: 32px; border-radius: 6px; border: none; background: #f5f7fa; display: flex; align-items: center; justify-content: center; color: #666; cursor: pointer; transition: transform 0.15s, background 0.2s; position: relative; z-index: 1; }
.action-btn-small:active { transform: scale(0.9); background: #e8e8e8; }
.action-btn-small.danger { color: #e34d59; }
.action-btn-small.danger:active { background: #ffe6e6; }
.load-more { text-align: center; padding: 20px; }
.load-btn { padding: 10px 32px; background: #fff; border: 1px solid #e8e8e8; border-radius: 20px; font-size: 14px; color: #666; cursor: pointer; }
.loading-more { display: flex; align-items: center; justify-content: center; gap: 8px; color: #999; font-size: 14px; }
.fab { position: fixed; right: 20px; bottom: 100px; width: 56px; height: 56px; border-radius: 50%; background: #0052d9; color: #fff; border: none; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0, 82, 217, 0.4); cursor: pointer; z-index: 100; }
.fab:active { transform: scale(0.95); }
.drawer-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 200; display: flex; flex-direction: column; justify-content: flex-end; }
.filter-drawer { background: #fff; border-radius: 16px 16px 0 0; max-height: 80vh; display: flex; flex-direction: column; animation: slideUp 0.3s ease; }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.drawer-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
.drawer-header span { font-size: 16px; font-weight: 600; }
.close-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background: #f5f7fa; display: flex; align-items: center; justify-content: center; color: #666; cursor: pointer; }
.drawer-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.drawer-footer { display: flex; gap: 12px; padding: 16px 20px; border-top: 1px solid #f0f0f0; }
.drawer-footer button { flex: 1; padding: 12px; border-radius: 8px; font-size: 15px; border: none; cursor: pointer; }
.btn-secondary { background: #f5f7fa; color: #666; }
.btn-primary { background: #0052d9; color: #fff; }
.btn-danger { background: #e34d59; color: #fff; }
.filter-section { margin-bottom: 20px; }
.filter-label { display: block; font-size: 14px; font-weight: 500; color: #333; margin-bottom: 12px; }
.filter-options { display: flex; flex-wrap: wrap; gap: 8px; }
.filter-chip { padding: 8px 14px; background: #f5f7fa; border-radius: 16px; font-size: 13px; color: #666; cursor: pointer; transition: all 0.2s; }
.filter-chip.active { background: #0052d9; color: #fff; }
.category-drawer { background: #fff; border-radius: 16px 16px 0 0; max-height: 80vh; display: flex; flex-direction: column; animation: slideUp 0.3s ease; }
.add-category { display: flex; gap: 8px; margin-bottom: 20px; }
.add-category input { flex: 1; padding: 10px 14px; border: 1px solid #e8e8e8; border-radius: 8px; font-size: 14px; outline: none; }
.add-category button { padding: 10px 16px; white-space: nowrap; }
.category-list { display: flex; flex-direction: column; gap: 8px; }
.category-list-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f9fafb; border-radius: 8px; }
.category-info { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #333; }
.category-info .count { color: #999; font-size: 12px; }
.category-actions { display: flex; gap: 8px; }
.action-btn-icon { width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent; display: flex; align-items: center; justify-content: center; color: #666; cursor: pointer; }
.action-btn-icon.danger { color: #e34d59; }
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.6); z-index: 300; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal-container { background: #fff; border-radius: 12px; width: 100%; max-width: 400px; max-height: 90vh; overflow: hidden; }
.modal-container.small { max-width: 320px; }
.modal-header { padding: 16px 20px; font-size: 16px; font-weight: 600; border-bottom: 1px solid #f0f0f0; }
.modal-body { padding: 20px; }
.modal-input { width: 100%; padding: 12px; border: 1px solid #e8e8e8; border-radius: 8px; font-size: 14px; outline: none; }
.warning-text { color: #e34d59; font-size: 13px; margin-top: 8px; }
.modal-footer { display: flex; gap: 12px; padding: 16px 20px; border-top: 1px solid #f0f0f0; }
.modal-footer button { flex: 1; padding: 12px; border-radius: 8px; font-size: 15px; border: none; cursor: pointer; }
.fullscreen-preview { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: #fff; z-index: 500; display: flex; flex-direction: column; }
.preview-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #f0f0f0; background: #fff; }
.back-btn { width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent; display: flex; align-items: center; justify-content: center; color: #333; cursor: pointer; }
.preview-title { font-size: 16px; font-weight: 500; }
.edit-btn { width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent; display: flex; align-items: center; justify-content: center; color: #0052d9; cursor: pointer; }
.placeholder { width: 40px; }
.preview-body { flex: 1; overflow-y: auto; background: #fff; }
.preview-article { padding: 20px; max-width: 720px; margin: 0 auto; }
.article-title { font-size: 22px; font-weight: 600; color: #333; line-height: 1.4; margin: 0 0 16px 0; }
.article-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.meta-tag { display: flex; align-items: center; gap: 4px; font-size: 13px; color: #888; }
.article-divider { height: 1px; background: #f0f0f0; margin: 16px 0 24px; }
.article-content { font-size: 15px; line-height: 1.8; color: #333; }
.fullscreen-editor { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: #fff; z-index: 500; display: flex; flex-direction: column; }
.editor-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #f0f0f0; background: #fff; }
.more-btn { width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent; display: flex; align-items: center; justify-content: center; color: #666; cursor: pointer; }
.title-input { flex: 1; border: none; background: none; padding: 10px 8px; font-size: 16px; font-weight: 500; outline: none; }
.editor-body { flex: 1; overflow: hidden; }
.editor-body :deep(.mobile-md-editor) { height: 100% !important; }
.editor-body :deep(.md-editor-preview) { display: none !important; }
.editor-body :deep(.md-editor-content) { width: 100% !important; }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid #f0f0f0; background: #fff; }
.word-count { font-size: 13px; color: #999; }
.toolbar-right { display: flex; gap: 8px; }
.btn-save-draft { padding: 8px 16px; background: #f5f7fa; color: #666; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
.btn-publish { padding: 8px 20px; background: #0052d9; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
.options-drawer { background: #fff; border-radius: 16px 16px 0 0; max-height: 70vh; display: flex; flex-direction: column; animation: slideUp 0.3s ease; }
.form-item { margin-bottom: 20px; }
.form-item label { display: block; font-size: 14px; font-weight: 500; color: #333; margin-bottom: 8px; }
.native-select, .native-input { width: 100%; padding: 12px; border: 1px solid #e8e8e8; border-radius: 8px; font-size: 14px; background: #fff; outline: none; }
.checkbox-item { margin-top: 16px; }
.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #333; cursor: pointer; }
.checkbox-label input { width: 18px; height: 18px; accent-color: #0052d9; }
</style>
