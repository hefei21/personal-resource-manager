<template>
  <div class="blog">
    <div class="page-header">
      <p>记录技术心得与生活感悟</p>
    </div>

    <t-card>
      <t-space direction="vertical" style="width: 100%">
        <!-- 顶部操作栏 -->
        <div class="toolbar">
          <t-space>
            <t-radio-group v-model="statusFilter" variant="default-filled" @change="handleStatusFilterChange">
              <t-radio-button value="">全部</t-radio-button>
              <t-radio-button value="published">已发布</t-radio-button>
              <t-radio-button v-if="!isGuest" value="draft">草稿</t-radio-button>
            </t-radio-group>

            <t-input
              v-model="searchKeyword"
              placeholder="搜索文章..."
              clearable
              @clear="loadPosts"
              @enter="loadPosts"
              style="width: 240px"
            >
              <template #suffix-icon>
                <t-icon name="search" />
              </template>
            </t-input>

            <t-select
              v-model="categoryFilter"
              placeholder="选择分类"
              clearable
              @change="loadPosts"
              style="width: 160px"
            >
              <t-option v-for="cat in flatCategories" :key="cat.id" :value="cat.id" :label="cat.name" />
            </t-select>

            <t-select
              v-model="tagFilter"
              placeholder="选择标签"
              clearable
              @change="loadPosts"
              style="width: 160px"
            >
              <t-option v-for="tag in tags" :key="tag.id" :value="tag.id" :label="tag.name" />
            </t-select>
          </t-space>

          <t-space>
            <t-button theme="primary" @click="handleCreate" :disabled="isGuest">
              <template #icon><t-icon name="add" /></template>
              新建文章
            </t-button>
            <t-button theme="default" @click="showCategoryManager = true" :disabled="isGuest">
              <template #icon><t-icon name="folder" /></template>
              分类管理
            </t-button>
          </t-space>
        </div>

        <!-- 加载状态 -->
        <div v-if="loading" class="content-loading">
          <t-loading size="small" />
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
                <t-tag v-if="post.is_top" theme="warning" size="small" style="margin-right: 8px">置顶</t-tag>
                <t-tag v-if="post.status === 'draft'" theme="default" size="small" style="margin-right: 8px">草稿</t-tag>
                <span class="title-text">{{ post.title }}</span>
              </div>
              <div class="post-meta">
                <span v-if="post.category_name" class="meta-item">
                  <t-icon name="folder" size="14px" />
                  {{ post.category_name }}
                </span>
                <span v-if="post.tags && post.tags.length > 0" class="meta-item tags">
                  <t-icon name="discount" size="14px" />
                  {{ post.tags.join(', ') }}
                </span>
                <span class="meta-item">
                  <t-icon name="time" size="14px" />
                  {{ post.updated_at }}
                </span>
              </div>
            </div>
            <div class="post-actions" @click.stop>
              <t-button size="small" variant="text" class="action-btn view-btn" @click="handlePreview(post)">
                <t-icon name="browse" />
              </t-button>
              <t-button size="small" variant="text" class="action-btn edit-btn" @click="handleEdit(post)" :disabled="isGuest">
                <t-icon name="edit" />
              </t-button>
              <t-popconfirm content="确定删除这篇文章吗？" @confirm="handleDelete(post.id)">
                <t-button size="small" variant="text" class="action-btn delete-btn" :disabled="isGuest">
                  <t-icon name="delete" />
                </t-button>
              </t-popconfirm>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="empty-state">
          <t-icon name="file" size="64px" />
          <p>暂无文章</p>
          <t-button theme="primary" @click="handleCreate" :disabled="isGuest">
            <template #icon><t-icon name="add" /></template>
            写第一篇文章
          </t-button>
        </div>

        <!-- 分页 -->
        <div v-if="!loading && total > 0" class="pagination-wrapper">
          <t-pagination
            v-model="pagination.current"
            v-model:page-size="pagination.pageSize"
            :total="total"
            show-page-number
            show-page-size
            :page-size-options="[30, 50, 100]"
            @change="handlePageChange"
            @page-size-change="handlePageSizeChange"
          />
        </div>
      </t-space>
    </t-card>

    <!-- 文章编辑对话框 -->
    <t-dialog
      v-model:visible="editDialogVisible"
      :header="editingPost ? '编辑文章' : '新建文章'"
      width="95%"
      :footer="false"
      :close-on-overlay-click="false"
      top="20px"
    >
      <div class="editor-container">
        <div class="editor-header">
          <t-input
            v-model="editForm.title"
            placeholder="文章标题"
            size="large"
            style="font-size: 20px; font-weight: 600"
          />
        </div>

        <div class="editor-meta">
          <t-space>
            <t-select
              v-model="editForm.category_id"
              placeholder="选择分类"
              clearable
              style="width: 200px"
            >
              <t-option v-for="cat in flatCategories" :key="cat.id" :value="cat.id" :label="cat.name" />
            </t-select>

            <t-tag-input
              v-model="editForm.tags"
              placeholder="添加标签（回车确认）"
              clearable
              style="width: 400px"
            />
          </t-space>

          <t-checkbox v-model="editForm.is_top">置顶文章</t-checkbox>
        </div>

        <div class="editor-body">
          <MdEditor
            v-model="editForm.content"
            :theme="editorTheme"
            :previewTheme="previewTheme"
            :codeTheme="codeTheme"
            :toolbars="editorToolbars"
            @onSave="handleAutoSave"
            style="height: calc(100vh - 350px)"
          />
        </div>

        <div class="editor-footer">
          <t-space>
            <t-button variant="outline" @click="handleSaveDraft" :loading="saving">
              保存草稿
            </t-button>
            <t-button theme="primary" @click="handlePublish" :loading="saving">
              {{ editForm.status === 'published' ? '更新文章' : '发布文章' }}
            </t-button>
          </t-space>
          <t-button variant="text" @click="editDialogVisible = false">
            取消
          </t-button>
        </div>
      </div>
    </t-dialog>

    <!-- 预览文章对话框 -->
    <t-dialog
      v-model:visible="previewDialogVisible"
      :header="previewPost?.title || '文章预览'"
      width="90%"
      :footer="false"
      top="20px"
    >
      <div class="preview-container">
        <div class="preview-meta">
          <t-space>
            <span v-if="previewPost?.category_name" class="meta-item">
              <t-icon name="folder" size="14px" />
              {{ previewPost.category_name }}
            </span>
            <span v-if="previewPost?.tags && previewPost.tags.length > 0" class="meta-item">
              <t-icon name="discount" size="14px" />
              {{ previewPost.tags.join(', ') }}
            </span>
            <span class="meta-item">
              <t-icon name="time" size="14px" />
              {{ previewPost?.updated_at }}
            </span>
          </t-space>
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
    </t-dialog>

    <!-- 分类管理对话框 -->
    <t-dialog
      v-model:visible="showCategoryManager"
      header="分类管理"
      width="600px"
      :footer="false"
    >
      <div class="category-manager">
        <div class="manager-toolbar">
          <t-input
            v-model="newCategoryName"
            placeholder="新分类名称"
            style="flex: 1"
            @enter="handleCreateCategory"
          />
          <t-button theme="primary" @click="handleCreateCategory" :disabled="isGuest">
            <template #icon><t-icon name="add" /></template>
            添加
          </t-button>
        </div>

        <div class="category-list">
          <div v-for="cat in categories" :key="cat.id" class="category-item">
            <div class="category-info">
              <t-icon name="folder" />
              <span class="category-name">{{ cat.name }}</span>
              <t-tag size="small" variant="light">{{ cat.post_count || 0 }} 篇</t-tag>
            </div>
            <t-space>
              <t-button size="small" variant="text" @click="handleEditCategory(cat)" :disabled="isGuest">
                <t-icon name="edit" />
              </t-button>
              <t-popconfirm content="确定删除此分类吗？" @confirm="handleDeleteCategory(cat.id)">
                <t-button size="small" variant="text" theme="danger" :disabled="isGuest">
                  <t-icon name="delete" />
                </t-button>
              </t-popconfirm>
            </t-space>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 标签管理对话框 -->
    <t-dialog
      v-model:visible="showTagManager"
      header="标签管理"
      width="700px"
      :footer="false"
    >
      <div class="tag-manager">
        <div class="manager-toolbar">
          <t-input
            v-model="newTagName"
            placeholder="新标签名称"
            style="width: 200px"
            @enter="handleCreateTag"
          />
          <t-color-picker
            v-model="newTagColor"
            format="HEX"
            :show-primary-color-preview="false"
            style="width: 100px"
          />
          <t-button theme="primary" @click="handleCreateTag" :disabled="isGuest">
            <template #icon><t-icon name="add" /></template>
            添加
          </t-button>
        </div>

        <div class="tag-list">
          <div v-for="tag in tags" :key="tag.id" class="tag-item">
            <div class="tag-info">
              <span
                class="tag-dot"
                :style="{ backgroundColor: tag.color || '#667eea' }"
              ></span>
              <span class="tag-name">{{ tag.name }}</span>
              <t-tag size="small" variant="light">{{ tag.post_count || 0 }} 篇</t-tag>
            </div>
            <t-space>
              <t-button size="small" variant="text" @click="handleEditTag(tag)" :disabled="isGuest">
                <t-icon name="edit" />
              </t-button>
              <t-popconfirm content="确定删除此标签吗？" @confirm="handleDeleteTag(tag.id)">
                <t-button size="small" variant="text" theme="danger" :disabled="isGuest">
                  <t-icon name="delete" />
                </t-button>
              </t-popconfirm>
            </t-space>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 编辑分类对话框 -->
    <t-dialog
      v-model:visible="editCategoryDialogVisible"
      header="编辑分类"
      @confirm="handleUpdateCategory"
      width="400px"
    >
      <t-form>
        <t-form-item label="分类名称">
          <t-input v-model="editingCategory.name" placeholder="请输入分类名称" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 编辑标签对话框 -->
    <t-dialog
      v-model:visible="editTagDialogVisible"
      header="编辑标签"
      @confirm="handleUpdateTag"
      width="400px"
    >
      <t-form>
        <t-form-item label="标签名称">
          <t-input v-model="editingTag.name" placeholder="请输入标签名称" />
        </t-form-item>
        <t-form-item label="标签颜色">
          <t-color-picker
            v-model="editingTag.color"
            format="HEX"
            :show-primary-color-preview="false"
          />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'
import { MdEditor, MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { usePermission } from '@/composables/usePermission'

const { isGuest } = usePermission()
import 'md-editor-v3/lib/style.css'
import 'md-editor-v3/lib/preview.css'

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

// 标签管理
const showTagManager = ref(false)
const newTagName = ref('')
const newTagColor = ref('#667eea')
const editTagDialogVisible = ref(false)
const editingTag = ref({ id: null, name: '', color: '' })

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
    MessagePlugin.error('加载文章失败')
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
    MessagePlugin.error('加载文章失败')
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
    MessagePlugin.error('加载文章失败')
  }
}

// 自动保存
function handleAutoSave(content) {
  // 可以实现自动保存草稿逻辑
  console.log('自动保存:', content.substring(0, 100))
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
    MessagePlugin.warning('请输入文章标题')
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
      MessagePlugin.success('更新成功')
    } else {
      await api.blog.createPost(data)
      MessagePlugin.success('创建成功')
    }

    editDialogVisible.value = false
    loadPosts()
    loadCategories() // 刷新分类文章数
    loadTags() // 刷新标签文章数
  } catch (error) {
    console.error('保存失败:', error)
    MessagePlugin.error(error.response?.data?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

// 删除文章
async function handleDelete(id) {
  try {
    await api.blog.deletePost(id)
    MessagePlugin.success('删除成功')
    loadPosts()
    loadCategories()
    loadTags()
  } catch (error) {
    console.error('删除失败:', error)
    MessagePlugin.error('删除失败')
  }
}

// 创建分类
async function handleCreateCategory() {
  if (!newCategoryName.value || !newCategoryName.value.trim()) {
    MessagePlugin.warning('请输入分类名称')
    return
  }

  try {
    await api.blog.createCategory({ name: newCategoryName.value.trim() })
    MessagePlugin.success('创建成功')
    newCategoryName.value = ''
    loadCategories()
  } catch (error) {
    console.error('创建分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '创建失败')
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
    MessagePlugin.warning('请输入分类名称')
    return
  }

  try {
    await api.blog.updateCategory(editingCategory.value.id, { name: editingCategory.value.name.trim() })
    MessagePlugin.success('更新成功')
    editCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    console.error('更新分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '更新失败')
  }
}

// 删除分类
async function handleDeleteCategory(id) {
  try {
    await api.blog.deleteCategory(id)
    MessagePlugin.success('删除成功')
    loadCategories()
  } catch (error) {
    console.error('删除分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '删除失败')
  }
}

// 创建标签
async function handleCreateTag() {
  if (!newTagName.value || !newTagName.value.trim()) {
    MessagePlugin.warning('请输入标签名称')
    return
  }

  try {
    await api.blog.createTag({
      name: newTagName.value.trim(),
      color: newTagColor.value
    })
    MessagePlugin.success('创建成功')
    newTagName.value = ''
    newTagColor.value = '#667eea'
    loadTags()
  } catch (error) {
    console.error('创建标签失败:', error)
    MessagePlugin.error(error.response?.data?.message || '创建失败')
  }
}

// 编辑标签
function handleEditTag(tag) {
  editingTag.value = { id: tag.id, name: tag.name, color: tag.color || '#667eea' }
  editTagDialogVisible.value = true
}

// 更新标签
async function handleUpdateTag() {
  if (!editingTag.value.name || !editingTag.value.name.trim()) {
    MessagePlugin.warning('请输入标签名称')
    return
  }

  try {
    await api.blog.updateTag(editingTag.value.id, {
      name: editingTag.value.name.trim(),
      color: editingTag.value.color
    })
    MessagePlugin.success('更新成功')
    editTagDialogVisible.value = false
    loadTags()
  } catch (error) {
    console.error('更新标签失败:', error)
    MessagePlugin.error(error.response?.data?.message || '更新失败')
  }
}

// 删除标签
async function handleDeleteTag(id) {
  try {
    await api.blog.deleteTag(id)
    MessagePlugin.success('删除成功')
    loadTags()
  } catch (error) {
    console.error('删除标签失败:', error)
    MessagePlugin.error('删除失败')
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
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.posts-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
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

.empty-state .t-icon {
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
}

/* 编辑器样式 */
.editor-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: calc(100vh - 100px);
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
.category-manager,
.tag-manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.manager-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}

.category-list,
.tag-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
}

.category-item,
.tag-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #f6f8fa;
  border-radius: 8px;
  transition: background 0.3s;
}

.category-item:hover,
.tag-item:hover {
  background: #f0f3ff;
}

.category-info,
.tag-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.category-name,
.tag-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.tag-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
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
