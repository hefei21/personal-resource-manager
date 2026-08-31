<template>
  <div class="books-page">
    <EbookWorkbench
      :books="books" :categories="categories" :loading="loading" :pagination="pagination"
      :filters="filters" :selected-keys="selectedBookIds" :selection-mode="selectionMode" :view-mode="viewMode" :is-guest="isGuest"
      @update:filters="filters = $event" @update:view-mode="setViewMode" @apply="applyFilters"
      @upload="uploadVisible = true" @create-category="openCreateCategory" @rename-category="openRenameCategory"
      @delete-category="openDeleteCategory" @trash="openTrash" @detail="openDetail" @read="openReader"
      @toggle-select="toggleSelection" @toggle-select-all="toggleCurrentPageSelection"
      @enter-selection="enterSelectionMode" @exit-selection="exitSelectionMode"
      @batch-delete="batchConfirmVisible = true" @page="changePage"
    />

    <EbookDetailDrawer
      v-model:visible="detailVisible" :book="detailBook" :can-write="!isGuest"
      :reparse-loading="Boolean(detailBook && metadataReparseLoading[detailBook.id])"
      @read="openReader" @download="downloadBook" @edit="openEditBook" @reparse="reparseMetadata" @delete="deleteBook"
    />
    <EbookReaderDialog v-model="readerVisible" :book="readerBook" :is-guest="isGuest" @closed="loadBooks" />
    <EbookUploadDialog v-model="uploadVisible" :categories="categories" :initial-category-id="uploadCategoryId" @uploaded="afterUpload" />

    <NativeDialog v-model="categoryDialogVisible" :title="categoryDialogMode === 'create' ? '创建分类' : '重命名分类'" width="440px" @confirm="saveCategory">
      <div class="books-page__dialog-intro"><NativeIcon name="folder-open" size="22" /><div><strong>{{ categoryDialogMode === 'create' ? '新建书架分类' : '修改分类名称' }}</strong><span>分类只用于整理书库，不改变原件和阅读进度。</span></div></div>
      <NativeForm><NativeFormItem label="分类名称" required><NativeInput v-model="categoryName" maxlength="60" placeholder="请输入分类名称" @enter="saveCategory" /></NativeFormItem></NativeForm>
    </NativeDialog>

    <NativeDialog v-model="deleteCategoryVisible" title="删除分类" width="480px" confirm-text="删除分类" confirm-theme="danger" @confirm="deleteCategory">
      <div class="books-page__warning"><NativeIcon name="warning-circle" size="24" /><div><strong>删除“{{ pendingCategory?.name }}”分类？</strong><p>分类下的书籍不会被删除，将统一移动到“未分类”；阅读位置和资料索引不受影响。</p></div></div>
    </NativeDialog>

    <NativeDialog v-model="editVisible" title="编辑书籍信息" width="720px" :confirm-loading="editSaving" @confirm="saveBook">
      <NativeForm v-if="editForm" label-width="90px">
        <div class="books-page__form-grid">
          <NativeFormItem label="书名" required><NativeInput v-model="editForm.title" /></NativeFormItem>
          <NativeFormItem label="作者"><NativeInput v-model="editForm.author" /></NativeFormItem>
          <NativeFormItem label="分类"><NativeSelect v-model="editForm.categoryId" clearable placeholder="未分类" :options="categoryOptions" /></NativeFormItem>
          <NativeFormItem label="出版年份"><NativeInput v-model="editForm.year" /></NativeFormItem>
          <NativeFormItem label="出版社"><NativeInput v-model="editForm.publisher" /></NativeFormItem>
          <NativeFormItem label="ISBN"><NativeInput v-model="editForm.isbn" /></NativeFormItem>
        </div>
        <NativeFormItem label="内容简介"><NativeTextarea v-model="editForm.description" :rows="5" :maxlength="1000" /></NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <NativeDialog v-model="batchConfirmVisible" title="批量移入回收站" width="480px" confirm-text="移入回收站" confirm-theme="danger" @confirm="deleteSelectedBooks">
      <div class="books-page__warning"><NativeIcon name="trash" size="24" /><div><strong>将选中的 {{ selectedBookIds.length }} 本书移入统一回收站？</strong><p>该操作不会立即永久删除原件，之后可以在统一回收站中恢复。</p></div></div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { NativeDialog, NativeForm, NativeFormItem, NativeIcon, NativeInput, NativeSelect, NativeTextarea } from '@/components/native'
import EbookDetailDrawer from '@/pc/components/books/EbookDetailDrawer.vue'
import EbookReaderDialog from '@/pc/components/books/EbookReaderDialog.vue'
import EbookUploadDialog from '@/pc/components/books/EbookUploadDialog.vue'
import EbookWorkbench from '@/pc/components/books/EbookWorkbench.vue'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { authenticatedAssetUrl } from '@/utils/authentication'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { isGuest } = usePermission()
const books = ref([])
const categories = ref([])
const loading = ref(false)
const pagination = ref({ page: Math.max(1, Number.parseInt(route.query.page, 10) || 1), pageSize: 24, total: 0, totalPages: 1 })
const filters = ref({
  keyword: String(route.query.keyword || ''), category: String(route.query.category || ''),
  readingStatus: String(route.query.readingStatus || ''), fileType: String(route.query.fileType || ''),
  sortBy: String(route.query.sortBy || 'last_read_at'), sortOrder: String(route.query.sortOrder || 'desc')
})
const viewMode = ref(localStorage.getItem('pr-manager:ebook-pc-view:v1') === 'list' ? 'list' : 'cover')
const selectedBookIds = ref([])
const selectionMode = ref(false)
const detailVisible = ref(false)
const detailBook = ref(null)
const readerVisible = ref(false)
const readerBook = ref(null)
const uploadVisible = ref(false)
const categoryDialogVisible = ref(false)
const categoryDialogMode = ref('create')
const categoryName = ref('')
const pendingCategory = ref(null)
const deleteCategoryVisible = ref(false)
const editVisible = ref(false)
const editForm = ref(null)
const editSaving = ref(false)
const batchConfirmVisible = ref(false)
const metadataReparseLoading = ref({})
const categoryOptions = computed(() => categories.value.map(category => ({ value: category.id, label: category.name })))
const uploadCategoryId = computed(() => /^\d+$/u.test(filters.value.category) ? Number(filters.value.category) : null)

async function loadCategories() {
  try { categories.value = (await api.books.getCategories()).data?.data || [] }
  catch (error) { console.error('加载书籍分类失败:', error); toast.error('加载分类失败') }
}

async function loadBooks() {
  loading.value = true
  try {
    const response = await api.books.list({ ...filters.value, page: pagination.value.page, pageSize: pagination.value.pageSize })
    books.value = response.data?.data || []
    pagination.value = response.data?.pagination || pagination.value
    if (pagination.value.page > pagination.value.totalPages) {
      pagination.value.page = pagination.value.totalPages
      return await loadBooks()
    }
  } catch (error) {
    console.error('加载书库失败:', error)
    toast.error(error.response?.data?.message || '加载书库失败')
  } finally { loading.value = false }
}

async function syncUrl() {
  const query = {}
  for (const [key, value] of Object.entries(filters.value)) {
    if (value && !((key === 'sortBy' && value === 'last_read_at') || (key === 'sortOrder' && value === 'desc'))) query[key] = value
  }
  if (pagination.value.page > 1) query.page = String(pagination.value.page)
  await router.replace({ query })
}

async function applyFilters() { pagination.value.page = 1; exitSelectionMode(); await syncUrl(); await loadBooks() }
async function changePage(page) { pagination.value.page = page; exitSelectionMode(); await syncUrl(); await loadBooks(); document.querySelector('.ebook-workbench__content')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
function setViewMode(mode) { viewMode.value = mode; localStorage.setItem('pr-manager:ebook-pc-view:v1', mode) }
function toggleSelection(id) { selectedBookIds.value = selectedBookIds.value.includes(id) ? selectedBookIds.value.filter(value => value !== id) : [...selectedBookIds.value, id] }
function enterSelectionMode() { selectionMode.value = true; selectedBookIds.value = [] }
function exitSelectionMode() { selectionMode.value = false; selectedBookIds.value = [] }
function toggleCurrentPageSelection() {
  const pageIds = books.value.map(book => book.id)
  const allSelected = pageIds.length > 0 && pageIds.every(id => selectedBookIds.value.includes(id))
  selectedBookIds.value = allSelected ? selectedBookIds.value.filter(id => !pageIds.includes(id)) : [...new Set([...selectedBookIds.value, ...pageIds])]
}
function openTrash() { void router.push({ name: 'Trash', query: { type: 'ebook' } }) }
function downloadBook(book) { window.open(authenticatedAssetUrl(`/api/ebooks/download/${book.id}`), '_blank') }

async function openDetail(book) {
  exitSelectionMode()
  detailBook.value = { ...book }
  detailVisible.value = true
  try { detailBook.value = (await api.books.getDetail(book.id)).data?.data || detailBook.value }
  catch (error) { toast.error(error.response?.data?.message || '加载书籍详情失败') }
}
function openReader(book) { exitSelectionMode(); detailVisible.value = false; readerBook.value = { ...book }; readerVisible.value = true }
function openCreateCategory() { categoryDialogMode.value = 'create'; pendingCategory.value = null; categoryName.value = ''; categoryDialogVisible.value = true }
function openRenameCategory(category) { categoryDialogMode.value = 'rename'; pendingCategory.value = category; categoryName.value = category.name; categoryDialogVisible.value = true }
function openDeleteCategory(category) { pendingCategory.value = category; deleteCategoryVisible.value = true }

async function saveCategory() {
  const name = categoryName.value.trim()
  if (!name) return toast.error('请输入分类名称')
  try {
    if (categoryDialogMode.value === 'create') await api.books.createCategory({ name })
    else await api.books.updateCategory(pendingCategory.value.id, { name })
    categoryDialogVisible.value = false
    toast.success(categoryDialogMode.value === 'create' ? '分类已创建' : '分类已重命名')
    await loadCategories()
  } catch (error) { toast.error(error.response?.data?.message || '保存分类失败') }
}

async function deleteCategory() {
  if (!pendingCategory.value) return
  try {
    await api.books.deleteCategory(pendingCategory.value.id)
    if (String(filters.value.category) === String(pendingCategory.value.id)) filters.value = { ...filters.value, category: '' }
    deleteCategoryVisible.value = false
    toast.success('分类已删除，原有书籍已归入未分类')
    await Promise.all([loadCategories(), applyFilters()])
  } catch (error) { toast.error(error.response?.data?.message || '删除分类失败') }
}

function openEditBook(book) {
  detailVisible.value = false
  editForm.value = { id: book.id, title: book.title, author: book.author || '', year: book.year || '', publisher: book.publisher || '', isbn: book.isbn || '', description: book.description || '', categoryId: book.categoryId || null }
  editVisible.value = true
}

async function saveBook() {
  if (!editForm.value?.title?.trim()) return toast.error('请输入书名')
  editSaving.value = true
  try {
    await api.books.update(editForm.value.id, editForm.value)
    editVisible.value = false
    toast.success('书籍信息已更新')
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) { toast.error(error.response?.data?.message || '更新失败') }
  finally { editSaving.value = false }
}

async function reparseMetadata(book) {
  if (metadataReparseLoading.value[book.id]) return
  metadataReparseLoading.value = { ...metadataReparseLoading.value, [book.id]: true }
  try { await api.books.reparseMetadata(book.id); toast.success('元数据重解析任务已加入队列') }
  catch (error) {
    const conflict = error.response?.status === 409 && error.response?.data?.activeConflict
    toast[conflict ? 'info' : 'error'](conflict ? '该书的元数据重解析任务已在运行' : (error.response?.data?.message || '创建重解析任务失败'))
  } finally { metadataReparseLoading.value = { ...metadataReparseLoading.value, [book.id]: false }; await loadBooks() }
}

async function deleteBook(id) {
  try {
    await api.books.delete(id)
    detailVisible.value = false; detailBook.value = null
    toast.success('已移入统一回收站')
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) { toast.error(error.response?.data?.message || '移入回收站失败') }
}

async function deleteSelectedBooks() {
  if (selectedBookIds.value.length === 0) return
  try {
    await api.books.batchDelete({ ids: selectedBookIds.value })
    exitSelectionMode(); batchConfirmVisible.value = false
    toast.success('已批量移入统一回收站')
    await Promise.all([loadCategories(), loadBooks()])
  } catch (error) { toast.error(error.response?.data?.message || '批量操作失败') }
}

async function afterUpload() { await Promise.all([loadCategories(), loadBooks()]) }

onMounted(async () => {
  await Promise.all([loadCategories(), loadBooks()])
  const bookId = Number(route.query.bookId)
  if (Number.isSafeInteger(bookId) && bookId > 0) {
    let book = books.value.find(item => Number(item.id) === bookId)
    if (!book) { try { book = (await api.books.getDetail(bookId)).data?.data } catch {} }
    if (book) {
      const chapterIndex = Number(route.query.chapterIndex)
      openReader({ ...book, ...(Number.isSafeInteger(chapterIndex) && chapterIndex >= 0 ? { searchChapterIndex: chapterIndex } : {}) })
    }
  }
})
</script>

<style scoped>
.books-page{padding:0}.books-page__dialog-intro,.books-page__warning{display:flex;gap:12px;margin-bottom:18px;padding:14px;border:1px solid var(--color-primary-border);border-radius:var(--radius-md);background:var(--color-primary-surface)}.books-page__dialog-intro>svg,.books-page__warning>svg{flex:0 0 auto;color:var(--color-primary)}.books-page__dialog-intro>div,.books-page__warning>div{display:grid;gap:3px}.books-page__dialog-intro span,.books-page__warning p{margin:0;font-size:12px;line-height:1.55;color:var(--color-text-secondary)}.books-page__warning{border-color:var(--color-warning-border);background:var(--color-warning-surface)}.books-page__warning>svg{color:var(--color-warning-text)}.books-page__form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}
</style>
