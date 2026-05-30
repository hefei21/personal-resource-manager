<template>
  <div class="bookmarks">
    <div class="page-header">
      <p>管理常用网站和在线资源</p>
    </div>

    <NativeCard>
      <div class="filter-bar">
        <NativeInput
          v-model="searchKeyword"
          placeholder="搜索标题、URL..."
          style="width: 200px"
          @enter="handleSearch"
        >
          <template #suffix-icon>
            <NativeIcon name="magnifying-glass" />
          </template>
        </NativeInput>
        <NativeSelect
          v-model="selectedTags"
          placeholder="选择标签"
          :multiple="true"
          :options="allTags.map(tag => ({ value: tag, label: tag }))"
          style="width: 180px"
          @change="handleFilterChange"
        />
        <NativeSelect
          v-model="sortBy"
          placeholder="排序方式"
          :options="[
            { value: 'updated_at', label: '按添加时间' },
            { value: 'title', label: '按标题名' }
          ]"
          style="width: 140px"
          @change="handleFilterChange"
        />
        <NativeButton theme="primary" @click="handleAdd" :disabled="isGuest">
          <template #icon><NativeIcon name="plus" /></template>
          添加书签
        </NativeButton>
        <NativeButton
          theme="default"
          variant="outline"
          :loading="downloadingIcons"
          @click="handleBatchDownloadIcons"
          :disabled="isGuest"
        >
          <template #icon><NativeIcon name="download" /></template>
          批量下载图标
        </NativeButton>
        <NativeButton
          v-if="selectedRows.length > 0"
          theme="danger"
          variant="outline"
          @click="handleBatchDelete"
          :disabled="isGuest"
        >
          <template #icon><NativeIcon name="trash" /></template>
          批量删除 ({{ selectedRows.length }})
        </NativeButton>
      </div>
    </NativeCard>

    <NativeCard style="margin-top: 16px">
      <NativeTable
        :dataSource="bookmarks"
        :columns="columns"
        :loading="loading"
        rowKey="id"
        selectable
        :selectedKeys="selectedRowKeys"
        :allRowKeys="allBookmarkIds"
        @selectionChange="handleSelectChange"
      >
        <template #cell-title="{ row }">
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
        <template #cell-operation="{ row }">
          <div class="operation-btns">
            <NativeButton theme="default" size="small" iconSize="1.2em" @click="handleEdit(row)" :disabled="isGuest">编辑</NativeButton>
            <NativePopconfirm content="确定删除吗？" @confirm="handleDelete(row.id)">
              <template #trigger>
                <NativeButton theme="danger" size="small" iconSize="1.2em" :disabled="isGuest">删除</NativeButton>
              </template>
            </NativePopconfirm>
          </div>
        </template>
      </NativeTable>
      <div class="pagination-wrapper">
        <NativePagination
          v-model:current="pagination.current"
          v-model:pageSize="pagination.pageSize"
          :total="pagination.total"
          @change="handlePageChange"
        />
      </div>
    </NativeCard>

    <NativeDialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑书签' : '添加书签'"
      @confirm="handleConfirm"
    >
      <NativeForm :modelValue="formData">
        <NativeFormItem label="URL">
          <NativeInput v-model="formData.url" placeholder="https://..." @blur="fetchTitle">
            <template #suffix>
              <NativeLoading v-if="fetchingTitle" size="small" />
            </template>
          </NativeInput>
        </NativeFormItem>
        <NativeFormItem label="标题">
          <NativeInput v-model="formData.title" placeholder="书签标题">
            <template #suffix>
              <NativeLoading v-if="fetchingTitle" size="small" />
            </template>
          </NativeInput>
        </NativeFormItem>
        <NativeFormItem label="标签">
          <NativeInput v-model="formData.tags" placeholder="用逗号分隔" />
        </NativeFormItem>
        <NativeFormItem label="描述">
          <NativeTextarea v-model="formData.description" placeholder="描述" />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeLoading, NativePagination, NativeSelect, NativeTextarea, NativeIcon, NativePopconfirm, NativeTable, NativeForm, NativeFormItem } from '@/components/native'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()
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
  { key: 'title', dataIndex: 'title', title: '标题', minWidth: 300 },
  { key: 'tags', dataIndex: 'tags', title: '标签', width: 150 },
  { key: 'operation', title: '操作', align: 'left', width: 150 }
]

const allBookmarkIds = ref([])

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
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`
  } catch {
    return ''
  }
}

// 图标加载失败处理
function handleIconError(e) {
  const img = e.target
  const src = img.src
  if (!src.includes('google.com')) {
    try {
      const row = bookmarks.value.find(b => b.icon === src || getIconUrl(b) === src)
      if (row) {
        const urlObj = new URL(row.url)
        img.src = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`
        return
      }
    } catch {}
  }
  img.style.display = 'none'
}

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
    const [response, allIdsResponse] = await Promise.all([
      api.bookmarks.list(params),
      api.bookmarks.list({ ...params, page: 1, pageSize: 10000 })
    ])
    bookmarks.value = response.data.data || []
    pagination.value.total = response.data.total || 0
    const allData = allIdsResponse.data?.data || []
    allBookmarkIds.value = (Array.isArray(allData) ? allData : []).map(b => b.id)
  } catch (error) {
    toast.error('加载书签失败')
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

function handleSelectChange(selectedKeys) {
  selectedRowKeys.value = selectedKeys
  selectedRows.value = bookmarks.value.filter(row => selectedKeys.includes(row.id))
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
      toast.success('更新成功')
    } else {
      await api.bookmarks.create(formData.value)
      toast.success('添加成功')
    }
    dialogVisible.value = false
    loadBookmarks()
  } catch (error) {
    toast.error('操作失败')
  }
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
  if (selectedRows.value.length === 0) {
    toast.warning('请选择要删除的书签')
    return
  }
  
  try {
    const ids = selectedRows.value.map(row => row.id)
    await api.bookmarks.batchDelete({ ids })
    toast.success('批量删除成功')
    selectedRowKeys.value = []
    selectedRows.value = []
    loadBookmarks()
  } catch (error) {
    toast.error('批量删除失败')
  }
}

// 批量下载图标
async function handleBatchDownloadIcons() {
  downloadingIcons.value = true
  try {
    const response = await api.bookmarks.batchDownloadIcons()
    toast.success(response.data.message)
    loadBookmarks()
  } catch (error) {
    toast.error('批量下载图标失败')
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

.filter-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: flex-start;
}

.operation-btns {
  display: flex;
  gap: 8px;
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
  max-width: 720px;
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

/* 第10项：条目不换行 */
::deep(.native-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 第12项：操作列左对齐 */
::deep(.native-table .native-table__body td:last-child) {
  text-align: left;
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
