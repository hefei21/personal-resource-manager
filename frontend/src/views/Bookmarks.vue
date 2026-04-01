<template>
  <div class="bookmarks">
    <div class="page-header">
      <p>管理常用网站和在线资源</p>
    </div>

    <t-card>
      <t-space>
        <t-input
          v-model="searchKeyword"
          placeholder="搜索标题、URL..."
          style="width: 200px"
          @enter="handleSearch"
        >
          <template #suffix-icon>
            <t-icon name="search" />
          </template>
        </t-input>
        <t-select
          v-model="selectedTags"
          placeholder="选择标签"
          multiple
          clearable
          style="width: 180px"
          @change="handleFilterChange"
        >
          <t-option v-for="tag in allTags" :key="tag" :value="tag" :label="tag" />
        </t-select>
        <t-select
          v-model="sortBy"
          placeholder="排序方式"
          style="width: 140px"
          @change="handleFilterChange"
        >
          <t-option value="updated_at" label="按添加时间" />
          <t-option value="title" label="按标题名" />
        </t-select>
        <t-button theme="primary" @click="handleAdd">
          <template #icon><t-icon name="add" /></template>
          添加书签
        </t-button>
        <t-button
          theme="default"
          variant="outline"
          :loading="downloadingIcons"
          @click="handleBatchDownloadIcons"
        >
          <template #icon><t-icon name="download" /></template>
          批量下载图标
        </t-button>
        <t-button
          theme="danger"
          variant="outline"
          :disabled="selectedRows.length === 0"
          @click="handleBatchDelete"
        >
          <template #icon><t-icon name="delete" /></template>
          批量删除 ({{ selectedRows.length }})
        </t-button>
      </t-space>
    </t-card>

    <t-card style="margin-top: 16px">
      <t-table
        :data="bookmarks"
        :columns="columns"
        :loading="loading"
        row-key="id"
        :selected-row-keys="selectedRowKeys"
        @select-change="handleSelectChange"
      >
        <template #title="{ row }">
          <div class="bookmark-title-cell">
            <img 
              :src="getIconUrl(row)" 
              class="bookmark-icon"
              loading="lazy"
              @error="handleIconError"
              alt=""
            />
            <a :href="row.url" target="_blank" rel="noopener noreferrer" class="bookmark-title-link">
              <span class="bookmark-title-text" :title="row.title">{{ row.title }}</span>
            </a>
          </div>
        </template>
        <template #operation="{ row }">
          <t-space>
            <t-button theme="default" size="small" @click="handleEdit(row)">编辑</t-button>
            <t-popconfirm content="确定删除吗？" @confirm="handleDelete(row.id)">
              <t-button theme="danger" size="small">删除</t-button>
            </t-popconfirm>
          </t-space>
        </template>
      </t-table>
      <div class="pagination-wrapper">
        <t-pagination
          v-model="pagination.current"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          show-page-number
          show-page-size
          :page-size-options="[15, 30, 50]"
          @change="handlePageChange"
          @page-size-change="handlePageSizeChange"
        />
      </div>
    </t-card>

    <t-dialog
      v-model:visible="dialogVisible"
      :header="isEdit ? '编辑书签' : '添加书签'"
      @confirm="handleConfirm"
    >
        <t-form :data="formData">
        <t-form-item label="URL">
          <t-input v-model="formData.url" placeholder="https://..." @blur="fetchTitle">
            <template #suffix-icon>
              <t-loading v-if="fetchingTitle" size="small" />
              <span v-else></span>
            </template>
          </t-input>
        </t-form-item>
        <t-form-item label="标题">
          <t-input v-model="formData.title" placeholder="书签标题">
            <template #suffix-icon>
              <t-loading v-if="fetchingTitle" size="small" />
            </template>
          </t-input>
        </t-form-item>
        <t-form-item label="标签">
          <t-input v-model="formData.tags" placeholder="用逗号分隔" />
        </t-form-item>
        <t-form-item label="描述">
          <t-textarea v-model="formData.description" placeholder="描述" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'

const loading = ref(false)
const bookmarks = ref([])
const dialogVisible = ref(false)
const isEdit = ref(false)
const searchKeyword = ref('')
const selectedTags = ref([])
const allTags = ref([])
const sortBy = ref('updated_at')
const downloadingIcons = ref(false)
const selectedRowKeys = ref([])
const selectedRows = ref([])
const fetchingTitle = ref(false)

const pagination = ref({
  current: 1,
  pageSize: 15,
  total: 0
})

const formData = ref({
  id: null,
  title: '',
  url: '',
  icon: '',
  iconData: '',
  tags: '',
  description: ''
})

const columns = [
  { colKey: 'row-select', type: 'multiple', width: 50 },
  { colKey: 'title', title: '标题' },
  { colKey: 'tags', title: '标签', width: 150 },
  { colKey: 'operation', title: '操作', align: 'right', width: 150 }
]

// 获取图标URL
function getIconUrl(row) {
  // 优先使用本地存储的base64数据
  if (row.icon_data) {
    return row.icon_data
  }
  if (row.icon) {
    return row.icon
  }
  // 使用Google的favicon服务作为备选
  try {
    const urlObj = new URL(row.url)
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`
  } catch {
    return ''
  }
}

// 图标加载失败处理
function handleIconError(e) {
  // 使用Google favicon服务作为备选
  const img = e.target
  const src = img.src
  if (!src.includes('google.com')) {
    try {
      // 尝试从当前URL提取域名
      const row = bookmarks.value.find(b => b.icon === src || getIconUrl(b) === src)
      if (row) {
        const urlObj = new URL(row.url)
        img.src = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`
        return
      }
    } catch {}
  }
  // 最终隐藏图标
  img.style.display = 'none'
}



// 自动获取标题和图标
// 自动获取标题和图标
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

async function loadBookmarks() {
  loading.value = true
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
    bookmarks.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    MessagePlugin.error('加载书签失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(pageInfo) {
  pagination.value.current = pageInfo.current
  loadBookmarks()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange(pageSize) {
  pagination.value.pageSize = pageSize
  pagination.value.current = 1
  loadBookmarks()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handleSearch() {
  pagination.value.current = 1
  loadBookmarks()
}

function handleFilterChange() {
  pagination.value.current = 1
  loadBookmarks()
}

async function loadAllTags() {
  try {
    const response = await api.bookmarks.getTags()
    allTags.value = response.data?.data || []
  } catch (error) {
    console.error('加载标签失败:', error)
  }
}

function handleSelectChange(selectedKeys, { selectedRowData }) {
  selectedRowKeys.value = selectedKeys
  selectedRows.value = selectedRowData
}

function handleAdd() {
  isEdit.value = false
  formData.value = { id: null, title: '', url: '', icon: '', iconData: '', tags: '', description: '' }
  dialogVisible.value = true
}

function handleEdit(row) {
  isEdit.value = true
  formData.value = { ...row }
  dialogVisible.value = true
}

async function handleConfirm() {
  try {
    if (isEdit.value) {
      await api.bookmarks.update(formData.value.id, formData.value)
      MessagePlugin.success('更新成功')
    } else {
      await api.bookmarks.create(formData.value)
      MessagePlugin.success('添加成功')
    }
    dialogVisible.value = false
    loadBookmarks()
  } catch (error) {
    MessagePlugin.error('操作失败')
  }
}

async function handleDelete(id) {
  try {
    await api.bookmarks.delete(id)
    MessagePlugin.success('删除成功')
    loadBookmarks()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

async function handleBatchDelete() {
  if (selectedRows.value.length === 0) {
    MessagePlugin.warning('请选择要删除的书签')
    return
  }
  
  try {
    const ids = selectedRows.value.map(row => row.id)
    await api.bookmarks.batchDelete({ ids })
    MessagePlugin.success('批量删除成功')
    selectedRowKeys.value = []
    selectedRows.value = []
    loadBookmarks()
  } catch (error) {
    MessagePlugin.error('批量删除失败')
  }
}

// 批量下载图标
async function handleBatchDownloadIcons() {
  downloadingIcons.value = true
  try {
    const response = await api.bookmarks.batchDownloadIcons()
    MessagePlugin.success(response.data.message)
    loadBookmarks() // 刷新列表以显示新图标
  } catch (error) {
    MessagePlugin.error('批量下载图标失败')
  } finally {
    downloadingIcons.value = false
  }
}

onMounted(() => {
  loadBookmarks()
  loadAllTags()
})
</script>

<style scoped>
.bookmarks {
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

.bookmark-title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.bookmark-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  object-fit: contain;
}

.bookmark-title-link {
  flex: 1;
  min-width: 0;
  color: #333;
  text-decoration: none;
  cursor: pointer;
}

.bookmark-title-link:hover {
  text-decoration: underline;
}

.bookmark-title-link:visited {
  color: #333;
}

.bookmark-title-text {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
