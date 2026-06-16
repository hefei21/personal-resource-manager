<template>
  <div class="blog">
    <div class="page-header">
      <p>记录技术心得与生活感悟</p>
    </div>

    <NativeCard>
      <NativeSpace direction="vertical" fill>
        <!-- 顶部操作栏 -->
        <div class="toolbar">
          <NativeSpace direction="vertical" fill>
            <!-- 视图切换独占一行 -->
            <NativeSpace fill>
              <NativeRadioGroup v-model="statusFilter" variant="default-filled" @change="handleStatusFilterChange">
                <NativeRadio value="">全部</NativeRadio>
                <NativeRadio value="published">已发布</NativeRadio>
                <NativeRadio v-if="!isGuest" value="draft">草稿</NativeRadio>
              </NativeRadioGroup>
            </NativeSpace>
            
            <!-- 其他元素另起一行左对齐 -->
            <NativeSpace fill>
              <NativeInput
                v-model="searchKeyword"
                placeholder="搜索文章..."
                clearable
                @clear="loadPosts"
                @enter="loadPosts"
                style="width: 240px"
              >
                <template #suffix-icon>
                  <NativeIcon name="magnifying-glass" />
                </template>
              </NativeInput>

              <NativeSelect
                v-model="categoryFilter"
                placeholder="选择分类"
                clearable
                @change="loadPosts"
                style="width: 160px"
                :options="flatCategories.map(cat => ({ value: cat.id, label: cat.name }))"
              />

              <NativeSelect
                v-model="tagFilter"
                placeholder="选择标签"
                clearable
                @change="loadPosts"
                style="width: 160px"
                :options="tags.map(tag => ({ value: tag.id, label: tag.name }))"
              />

              <NativeButton theme="primary" @click="handleCreate" :disabled="isGuest">
                <template #icon><NativeIcon name="plus" /></template>
                新建文章
              </NativeButton>
              <NativeButton theme="default" @click="showCategoryManager = true" :disabled="isGuest">
                <template #icon><NativeIcon name="folder" /></template>
                分类管理
              </NativeButton>
            </NativeSpace>
          </NativeSpace>
        </div>

        <!-- 加载状态 -->
        <div v-if="loading" class="content-loading">
          <NativeLoading size="small" />
        </div>

        <!-- 文章列表 -->
        <div v-else-if="posts.length > 0" class="posts-list">
          <div
            v-for="post in posts"
            :key="post.id"
            class="post-item"
            @click="handlePreview(post)"
          >
            <div class="post-main">
              <div class="post-title">
                <NativeTag v-if="post.is_top" theme="warning" size="small" style="margin-right: 8px">置顶</NativeTag>
                <NativeTag v-if="post.status === 'draft'" theme="default" size="small" style="margin-right: 8px">草稿</NativeTag>
                <span class="title-text">{{ post.title }}</span>
              </div>
              <div class="post-meta">
                <span v-if="post.category_name" class="meta-item">
                  <NativeIcon name="folder" />
                  {{ post.category_name }}
                </span>
                <span v-if="post.tags && post.tags.length > 0" class="meta-item tags">
                  <NativeIcon name="tag" />
                  {{ post.tags.join(', ') }}
                </span>
                <span class="meta-item">
                  <NativeIcon name="clock" />
                  {{ post.updated_at }}
                </span>
              </div>
            </div>
            <div class="post-actions" @click.stop>
              <NativeButton size="small" variant="text" class="action-btn view-btn" @click="handlePreview(post)">
                <NativeIcon name="eye" />
              </NativeButton>
              <NativeButton size="small" variant="text" class="action-btn edit-btn" @click="handleEdit(post)" :disabled="isGuest">
                <NativeIcon name="pencil" />
              </NativeButton>
              <NativePopconfirm content="确定删除这篇文章吗？" @confirm="handleDelete(post.id)">
                <template #trigger>
                  <NativeButton size="small" variant="text" theme="danger" class="action-btn delete-btn" :disabled="isGuest">
                    <NativeIcon name="trash" />
                  </NativeButton>
                </template>
              </NativePopconfirm>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="empty-state">
          <NativeIcon name="file" size="64" />
          <p>暂无文章</p>
          <NativeButton theme="primary" @click="handleCreate" :disabled="isGuest">
            <template #icon><NativeIcon name="plus" /></template>
            写第一篇文章
          </NativeButton>
        </div>

        <!-- 分页 -->
        <div v-if="!loading && total > 0" class="pagination-wrapper">
          <NativePagination
            v-model:current="pagination.current"
            v-model:pageSize="pagination.pageSize"
            :total="total"
            :pageSizeOptions="[30, 50, 100]"
            @change="handlePageChange"
          />
        </div>
      </NativeSpace>
    </NativeCard>

    <!-- 文章编辑对话框 -->
    <NativeDialog
      v-model="editDialogVisible"
      :header="editingPost ? '编辑文章' : '新建文章'"
      width="85%"
      :show-footer="false"
      :close-on-overlay-click="false"
      class="blog-edit-dialog"
    >
      <div class="editor-container">
        <div class="editor-header">
          <NativeInput
            v-model="editForm.title"
            placeholder="文章标题"
            size="large"
            style="font-size: 20px; font-weight: 600"
          />
        </div>

        <div class="editor-meta">
          <NativeSpace>
            <NativeSelect
              v-model="editForm.category_id"
              placeholder="选择分类"
              clearable
              style="width: 200px"
              :options="flatCategories.map(cat => ({ value: cat.id, label: cat.name }))"
            />

            <NativeTagInput
              v-model="editForm.tags"
              placeholder="添加标签（回车确认）"
              clearable
              style="width: 400px"
            />
          </NativeSpace>

          <NativeCheckbox v-model="editForm.is_top">置顶文章</NativeCheckbox>
        </div>

        <div class="editor-body">
          <MdEditor
            v-model="editForm.content"
            :theme="editorTheme"
            :previewTheme="previewTheme"
            :codeTheme="codeTheme"
            :toolbars="editorToolbars"
            @onSave="handleAutoSave"
            style="height: calc(100vh - 380px); min-height: 300px;"
          />
        </div>

        <div class="editor-footer">
          <NativeSpace>
            <NativeButton variant="outline" @click="handleSaveDraft" :loading="saving">
              保存草稿
            </NativeButton>
            <NativeButton theme="primary" @click="handlePublish" :loading="saving">
              {{ editForm.status === 'published' ? '更新文章' : '发布文章' }}
            </NativeButton>
          </NativeSpace>
          <NativeButton variant="text" @click="editDialogVisible = false">
            取消
          </NativeButton>
        </div>
      </div>
    </NativeDialog>

    <!-- 预览文章对话框 -->
    <NativeDialog
      v-model="previewDialogVisible"
      :title="previewPost?.title || '文章预览'"
      width="85%"
      :show-footer="false"
    >
      <div class="preview-container">
        <div class="preview-meta">
          <NativeSpace>
            <span v-if="previewPost?.category_name" class="meta-item">
              <NativeIcon name="folder" size="14" />
              {{ previewPost.category_name }}
            </span>
            <span v-if="previewPost?.tags && previewPost.tags.length > 0" class="meta-item">
              <NativeIcon name="tag" size="14" />
              {{ previewPost.tags.join(', ') }}
            </span>
            <span class="meta-item">
              <NativeIcon name="clock" size="14" />
              {{ previewPost?.updated_at }}
            </span>
          </NativeSpace>
        </div>
        <div class="preview-divider"></div>
        <MdPreview
          :modelValue="previewContent"
          :theme="editorTheme"
          :previewTheme="previewTheme"
          :codeTheme="codeTheme"
          class="preview-markdown"
        />
      </div>
    </NativeDialog>

    <!-- 分类管理对话框 -->
    <NativeDialog
      v-model="showCategoryManager"
      title="分类管理"
      width="480px"
      :footer="false"
    >
      <div class="category-manager">
        <div class="manager-toolbar">
          <NativeInput
            v-model="newCategoryName"
            placeholder="新分类名称"
            style="flex: 1"
            @enter="handleCreateCategory"
          />
          <NativeButton theme="primary" @click="handleCreateCategory" :disabled="isGuest">
            <template #icon><NativeIcon name="add" /></template>
            添加
          </NativeButton>
        </div>

        <div class="category-list">
          <div v-for="cat in categories" :key="cat.id" class="category-item">
            <div class="category-info">
              <NativeIcon name="folder" />
              <span class="category-name">{{ cat.name }}</span>
              <NativeTag size="small" variant="light">{{ cat.post_count || 0 }} 篇</NativeTag>
            </div>
            <NativeSpace align="center">
              <NativeButton size="small" variant="text" @click="handleEditCategory(cat)" :disabled="isGuest">
                <NativeIcon name="pencil" size="14" />
              </NativeButton>
              <NativePopconfirm content="确定删除此分类吗？" @confirm="handleDeleteCategory(cat.id)">
                <template #trigger>
                  <NativeButton size="small" variant="text" theme="danger" :disabled="isGuest">
                    <NativeIcon name="trash" size="14" />
                  </NativeButton>
                </template>
              </NativePopconfirm>
            </NativeSpace>
          </div>
        </div>
      </div>
    </NativeDialog>

    <!-- 编辑分类对话框 -->
    <NativeDialog
      v-model="editCategoryDialogVisible"
      title="编辑分类"
      @confirm="handleUpdateCategory"
      width="400px"
    >
      <NativeForm>
        <NativeFormItem label="分类名称">
          <NativeInput v-model="editingCategory.name" placeholder="请输入分类名称" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { MdEditor, MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import 'md-editor-v3/lib/preview.css'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeIcon, NativeSpace, NativeRadioGroup, NativeRadio, NativeSelect, NativeTag, NativePopconfirm, NativePagination, NativeTagInput, NativeForm, NativeFormItem } from '@/components/native'



const toast = useToast()
const { isGuest } = usePermission()

// 编辑器配置
const editorTheme = ref('light')
const previewTheme = ref('default')
const codeTheme = ref('atom')
const editorToolbars = [
  'bold', 'underline', 'italic', '-',
  'strikeThrough', 'title', 'sub', 'sup', 'quote', '-',
  'unorderedList', 'orderedList', 'task', '-',
  'codeRow', 'code', 'link', 'image', 'table', '-',
  'revoke', 'next', 'save', '=', 'preview', 'fullscreen'
]

// 文章列表
const posts = ref([])
const total = ref(0)
const loading = ref(false)
const pagination = ref({ current: 1, pageSize: 30 })
const searchKeyword = ref('')
const statusFilter = ref('')
const categoryFilter = ref(null)
const tagFilter = ref(null)

// 分类和标签
const categories = ref([])
const tags = ref([])

// 编辑相关
const editDialogVisible = ref(false)
const editingPost = ref(null)
const editForm = ref({
  title: '',
  content: '',
  category_id: null,
  tags: [],
  status: 'draft',
  is_top: false
})
const saving = ref(false)

// 文章预览
const previewDialogVisible = ref(false)
const previewPost = ref(null)
const previewContent = ref('')

// 分类管理
const showCategoryManager = ref(false)
const newCategoryName = ref('')
const editCategoryDialogVisible = ref(false)
const editingCategory = ref({ id: null, name: '' })

// 计算属性：扁平化分类列表
const flatCategories = computed(() => {
  const flatten = (items, result = []) => {
    items.forEach(item => {
      result.push(item)
      if (item.children && item.children.length > 0) {
        flatten(item.children, result)
      }
    })
    return result
  }
  return flatten(categories.value)
})

// 加载文章列表
async function loadPosts() {
  loading.value = true
  try {
    const params = {
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    }
    if (searchKeyword.value) params.keyword = searchKeyword.value
    if (statusFilter.value) params.status = statusFilter.value
    if (categoryFilter.value) params.category_id = categoryFilter.value
    if (tagFilter.value) params.tag_id = tagFilter.value

    const response = await api.blog.getPosts(params)
    posts.value = response.data.data || []
    total.value = response.data.total || 0
  } catch (error) {
    console.error('加载文章失败:', error)
    toast.error('加载文章失败')
  } finally {
    loading.value = false
  }
}

// 加载分类
async function loadCategories() {
  try {
    const response = await api.blog.getAllCategories()
    categories.value = response.data.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
  }
}

// 加载标签
async function loadTags() {
  try {
    const response = await api.blog.getTags()
    tags.value = response.data.data || []
  } catch (error) {
    console.error('加载标签失败:', error)
  }
}

// 状态筛选变化
function handleStatusFilterChange() {
  pagination.value.current = 1
  loadPosts()
}

// 分页
function handlePageChange() {
  loadPosts()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange() {
  pagination.value.current = 1
  loadPosts()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 新建文章
function handleCreate() {
  editingPost.value = null
  editForm.value = {
    title: '',
    content: '',
    category_id: null,
    tags: [],
    status: 'draft',
    is_top: false
  }
  editDialogVisible.value = true
}

// 编辑文章
async function handleEdit(post) {
  try {
    const response = await api.blog.getPost(post.id)
    const data = response.data.data
    editingPost.value = data
    editForm.value = {
      title: data.title,
      content: data.content || '',
      category_id: data.category_id,
      tags: data.tags || [],
      status: data.status,
      is_top: data.is_top === 1
    }
    editDialogVisible.value = true
  } catch (error) {
    console.error('加载文章失败:', error)
    toast.error('加载文章失败')
  }
}

// 预览文章
async function handlePreview(post) {
  try {
    const response = await api.blog.getPost(post.id)
    const data = response.data.data
    previewPost.value = data
    previewContent.value = data.content || ''
    previewDialogVisible.value = true
  } catch (error) {
    console.error('加载文章失败:', error)
    toast.error('加载文章失败')
  }
}

// 编辑器工具栏保存按钮回调
function handleAutoSave(content) {
  // 调用保存草稿功能
  handleSaveDraft()
}

// 保存草稿
async function handleSaveDraft() {
  await savePost('draft')
}

// 发布文章
async function handlePublish() {
  await savePost('published')
}

// 保存文章
async function savePost(status) {
  if (!editForm.value.title || !editForm.value.title.trim()) {
    toast.warning('请输入文章标题')
    return
  }

  saving.value = true
  try {
    const data = {
      title: editForm.value.title.trim(),
      content: editForm.value.content,
      category_id: editForm.value.category_id || null,
      tags: editForm.value.tags,
      status: status,
      is_top: editForm.value.is_top
    }

    if (editingPost.value) {
      await api.blog.updatePost(editingPost.value.id, data)
      toast.success('更新成功')
    } else {
      await api.blog.createPost(data)
      toast.success('创建成功')
    }

    editDialogVisible.value = false
    loadPosts()
    loadCategories()
  } catch (error) {
    console.error('保存失败:', error)
    toast.error(error.response?.data?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

// 删除文章
async function handleDelete(id) {
  try {
    await api.blog.deletePost(id)
    toast.success('删除成功')
    loadPosts()
    loadCategories()
  } catch (error) {
    console.error('删除失败:', error)
    toast.error('删除失败')
  }
}

// 创建分类
async function handleCreateCategory() {
  if (!newCategoryName.value || !newCategoryName.value.trim()) {
    toast.warning('请输入分类名称')
    return
  }

  try {
    await api.blog.createCategory({ name: newCategoryName.value.trim() })
    toast.success('创建成功')
    newCategoryName.value = ''
    loadCategories()
  } catch (error) {
    console.error('创建分类失败:', error)
    toast.error(error.response?.data?.message || '创建失败')
  }
}

// 编辑分类
function handleEditCategory(category) {
  editingCategory.value = { id: category.id, name: category.name }
  editCategoryDialogVisible.value = true
}

// 更新分类
async function handleUpdateCategory() {
  if (!editingCategory.value.name || !editingCategory.value.name.trim()) {
    toast.warning('请输入分类名称')
    return
  }

  try {
    await api.blog.updateCategory(editingCategory.value.id, { name: editingCategory.value.name.trim() })
    toast.success('更新成功')
    editCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    console.error('更新分类失败:', error)
    toast.error(error.response?.data?.message || '更新失败')
  }
}

// 删除分类
async function handleDeleteCategory(id) {
  try {
    await api.blog.deleteCategory(id)
    toast.success('删除成功')
    loadCategories()
  } catch (error) {
    console.error('删除分类失败:', error)
    toast.error(error.response?.data?.message || '删除失败')
  }
}

onMounted(() => {
  loadPosts()
  loadCategories()
  loadTags()
})
</script>

<style scoped>
.blog {
  padding: 0;
}

/* 内容区域加载状态 */
.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header h2 {
  font-size: 28px;
  font-weight: 600;
  color: #333;
  margin: 0 0 8px 0;
}

.page-header p {
  font-size: 16px;
  color: #333;
  margin: 0;
  font-weight: 500;
}

.toolbar {
  width: 100%;
}

.toolbar :deep(.native-space) {
  justify-content: flex-start !important;
  align-items: center !important;
}

.posts-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.post-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: linear-gradient(135deg, #f6f8fa 0%, #ffffff 100%);
  border-radius: 10px;
  border: 1px solid #e8e8e8;
  cursor: pointer;
  transition: all 0.3s ease;
}

.post-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
  border-color: #667eea;
}

.post-main {
  flex: 1;
  overflow: hidden;
}

.post-title {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.title-text {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #888;
}

.meta-item :deep(svg),
.meta-item :deep(.native-icon) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.meta-item.tags {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.3s;
}

.post-item:hover .post-actions {
  opacity: 1;
}

/* 操作按钮样式 */
.action-btn {
  color: #666 !important;
}

.action-btn:hover {
  color: #0052d9 !important;
}

.view-btn:hover {
  color: #0052d9 !important;
}

.edit-btn:hover {
  color: #0052d9 !important;
}

.delete-btn {
  color: #666 !important;
}

.delete-btn:hover {
  color: #e34d59 !important;
}

/* 预览对话框样式 */
.preview-container {
  max-height: calc(90vh - 120px);
  overflow-y: auto;
}

.preview-markdown {
  background: transparent !important;
}

.preview-markdown :deep(.md-preview) {
  background: transparent !important;
  padding: 0 !important;
}

.preview-meta {
  padding: 12px 0;
}

.preview-meta .meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: #666;
}

.preview-divider {
  height: 1px;
  background: #e7e7e7;
  margin: 8px 0 20px;
}

.preview-content {
  padding: 16px 0;
  line-height: 1.8;
  color: #333;
}

.preview-content :deep(h1),
.preview-content :deep(h2),
.preview-content :deep(h3),
.preview-content :deep(h4),
.preview-content :deep(h5),
.preview-content :deep(h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: #333;
}

.preview-content :deep(h1) { font-size: 28px; }
.preview-content :deep(h2) { font-size: 24px; }
.preview-content :deep(h3) { font-size: 20px; }
.preview-content :deep(h4) { font-size: 18px; }

.preview-content :deep(p) {
  margin-bottom: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 16px;
}

.empty-state .native-icon {
  color: #d0d0d0;
}

.empty-state p {
  font-size: 16px;
  color: #666;
  margin: 0;
}

.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
  width: 100%;
}

/* 编辑器对话框 */
.blog-edit-dialog :deep(.native-dialog__content) {
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 编辑器样式 */
.editor-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(85vh - 60px);
  overflow: hidden;
}

.editor-header {
  padding-bottom: 12px;
  border-bottom: 1px solid #e8e8e8;
}

.editor-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.editor-body {
  flex: 1;
  min-height: 0;
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid #e8e8e8;
}

/* 分类管理 */
.category-manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.manager-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}

.category-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
  overflow-x: hidden;
  width: 100%;
}

.category-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #f6f8fa;
  border-radius: 8px;
  transition: background 0.3s;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
}

.category-item:hover {
  background: #f0f3ff;
}

.category-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.category-info .category-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.category-info .native-tag,
.category-info .native-icon {
  flex-shrink: 0;
}

.category-item > .native-space {
  margin-left: auto !important;
  flex-shrink: 0;
  flex-grow: 0;
  width: auto !important;
}

.category-item .native-button {
  padding: 2px !important;
  min-width: 24px !important;
  height: 24px !important;
  width: 24px !important;
}

.category-item .native-button .native-icon {
  font-size: 12px !important;
}

/* 响应式 */
@media (max-width: 768px) {
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  
  .post-meta {
    flex-direction: column;
    gap: 4px;
  }
  
  .editor-meta {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
