<template>
  <section class="mobile-books">
    <form class="mobile-books__search" role="search" @submit.prevent="applyFilters">
      <div class="mobile-books__search-field"><NativeIcon name="magnifying-glass" size="19" /><input v-model="keyword" type="search" aria-label="搜索书名、作者或 ISBN" placeholder="搜索书名、作者" enterkeyhint="search" /></div>
      <button v-if="canUpload" type="button" class="mobile-books__upload" aria-label="上传书籍" @click="uploadVisible = true"><NativeIcon name="plus" size="22" /></button>
    </form>
    <nav class="mobile-books__views" aria-label="阅读状态">
      <button v-for="view in views" :key="view.value" :aria-pressed="readingStatus === view.value" :class="{ active: readingStatus === view.value }" @click="readingStatus = view.value; applyFilters()">{{ view.label }}</button>
    </nav>
    <div class="mobile-books__toolbar">
      <button class="mobile-books__category" @click="categoryVisible = true"><NativeIcon name="folder" size="17" /><span>{{ categoryLabel }}</span><NativeIcon name="chevron-down" size="13" /></button>
      <div class="mobile-books__tools"><button aria-label="排序与格式筛选" :class="{ active: fileType }" @click="filtersVisible = true"><NativeIcon name="sliders-horizontal" size="19" /></button><button aria-label="书籍回收站" @click="router.push({ name: 'Trash', query: { type: 'ebook' } })"><NativeIcon name="trash" size="18" /></button></div>
    </div>
    <div class="mobile-books__summary"><span>{{ fileType ? fileType.toUpperCase() + ' · ' : '' }}{{ loading ? '正在整理书架…' : `${pagination.total} 本书` }}</span><span>{{ sortLabel }}</span></div>
    <div v-if="loading" class="mobile-books__skeleton" role="status" aria-label="正在加载书籍"><span v-for="n in 4" :key="n" /></div>
    <div v-else-if="error" class="mobile-books__empty" role="alert"><NativeIcon name="warning-circle" size="30" /><strong>书库暂时无法加载</strong><p>{{ error }}</p><NativeButton variant="outline" @click="loadBooks()">重试</NativeButton></div>
    <div v-else-if="!books.length" class="mobile-books__empty"><NativeIcon name="book-open" size="32" /><strong>{{ canUpload ? '从第一本书开始' : '没有符合条件的书籍' }}</strong><p>{{ canUpload ? '添加想读的书，随时从上次的位置继续。' : '试试其他分类或阅读状态。' }}</p><NativeButton v-if="canUpload" theme="primary" @click="uploadVisible = true">上传书籍</NativeButton><NativeButton v-else variant="outline" @click="clearFilters">查看全部书籍</NativeButton></div>
    <div v-else class="mobile-books__grid">
      <article v-for="book in books" :key="book.id" class="mobile-book">
        <button class="mobile-book__cover" :class="`mobile-book__cover--${book.fileType}`" :aria-label="`${isReadable(book) ? '阅读' : '查看'} ${book.title}`" @click="isReadable(book) ? openReader(book) : openDetails(book)">
          <img v-if="book.coverImage && !brokenCovers.has(book.id)" :src="coverUrl(book)" :alt="book.title" loading="lazy" @error="brokenCovers.add(book.id)" />
          <span v-else class="mobile-book__placeholder"><NativeIcon :name="fileIcon(book)" size="30" /><strong>{{ book.title }}</strong><small>{{ (book.fileType || 'BOOK').toUpperCase() }}</small></span>
        </button>
        <div class="mobile-book__heading"><button @click="isReadable(book) ? openReader(book) : openDetails(book)">{{ book.title }}</button><button class="mobile-book__more" :aria-label="`${book.title} 的更多操作`" @click="openDetails(book)"><NativeIcon name="more" size="20" /></button></div>
        <p>{{ book.author || '作者未知' }}</p>
        <div class="mobile-book__progress"><span v-if="book.progress > 0"><i :style="{ width: `${Math.min(100, book.progress)}%` }" /></span><small>{{ book.progress >= 99.5 ? '已读完' : book.progress > 0 ? `已读 ${Math.round(book.progress)}%` : '未开始' }}</small></div>
      </article>
    </div>
    <footer v-if="books.length && !loading" class="mobile-books__pagination">
      <NativeButton v-if="books.length < pagination.total" variant="outline" :loading="loadingMore" @click="loadBooks(true)">{{ loadingMore ? '正在加载…' : '加载下一批' }}</NativeButton>
      <span>{{ books.length < pagination.total ? `已显示 ${books.length} / ${pagination.total} 本` : `共 ${pagination.total} 本 · 已加载全部` }}</span>
      <button v-if="moreError" class="mobile-books__retry" @click="loadBooks(true)">{{ moreError }}，点击重试</button>
    </footer>

    <NativeDrawer v-model="categoryVisible" class="mobile-books-sheet" placement="bottom" title="选择分类" size="min(70dvh, 560px)" :top-offset="0">
      <div class="mobile-books-sheet__choices"><button v-for="item in categoryChoices" :key="item.value" :class="{ active: category === item.value }" @click="category = item.value; categoryVisible = false; applyFilters()"><NativeIcon name="folder" size="19" /><span>{{ item.label }}</span><small v-if="item.count != null">{{ item.count }} 本</small><NativeIcon v-if="category === item.value" name="check" size="18" /></button></div>
    </NativeDrawer>
    <NativeDrawer v-model="filtersVisible" class="mobile-books-sheet" placement="bottom" title="排序与筛选" size="min(78dvh, 600px)" :top-offset="0">
      <div class="mobile-books-sheet__filter"><h4>排列顺序</h4><div class="mobile-books-sheet__choices"><button v-for="item in sortOptions" :key="item.value" :class="{ active: sortBy === item.value }" @click="sortBy = item.value; applyFilters()"><span>{{ item.label }}</span><NativeIcon v-if="sortBy === item.value" name="check" size="17" /></button></div><button class="mobile-books-sheet__direction" @click="sortOrder = sortOrder === 'desc' ? 'asc' : 'desc'; applyFilters()"><NativeIcon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" size="18" />{{ sortOrder === 'desc' ? '降序排列' : '升序排列' }}</button><h4>文件格式</h4><div class="mobile-books-sheet__formats"><button v-for="type in ['', 'epub', 'pdf', 'txt', 'mobi', 'azw3']" :key="type" :class="{ active: fileType === type }" @click="fileType = type; applyFilters()">{{ type ? type.toUpperCase() : '全部' }}</button></div></div>
      <template #footer><NativeButton theme="primary" block @click="filtersVisible = false">查看书籍</NativeButton></template>
    </NativeDrawer>
    <NativeDrawer v-model="detailVisible" class="mobile-books-sheet mobile-books-detail-sheet" placement="bottom" title="书籍信息" size="auto" :top-offset="0">
      <div v-if="detailBook" class="mobile-book-detail">
        <header><div class="mobile-book-detail__cover"><img v-if="detailBook.coverImage && !brokenCovers.has(detailBook.id)" :src="coverUrl(detailBook)" alt="" @error="brokenCovers.add(detailBook.id)" /><NativeIcon v-else :name="fileIcon(detailBook)" size="27" /></div><div><h3>{{ detailBook.title }}</h3><p>{{ detailBook.author || '作者未知' }}</p><small>{{ String(detailBook.fileType || '').toUpperCase() }} · {{ formatSize(detailBook.fileSize) }}</small></div></header>
        <NativeButton v-if="isReadable(detailBook)" theme="primary" block @click="openReader(detailBook)"><NativeIcon name="book-open" size="18" />{{ detailBook.progress > 0 ? '继续阅读' : '开始阅读' }}<span v-if="detailBook.progress > 0"> · {{ Math.round(detailBook.progress) }}%</span></NativeButton>
        <dl><dt>分类</dt><dd>{{ detailBook.categoryName || '未分类' }}</dd><dt>资料索引</dt><dd>{{ indexLabel(detailBook) }}</dd><template v-if="detailBook.publisher"><dt>出版社</dt><dd>{{ detailBook.publisher }}</dd></template></dl>
        <p v-if="detailLoading" class="mobile-book-detail__hint" role="status">正在读取详细信息…</p>
        <p v-if="detailError" class="mobile-book-detail__hint" role="alert">{{ detailError }}</p>
        <p v-if="detailBook.description" class="mobile-book-detail__description">{{ detailBook.description }}</p>
        <div class="mobile-books-sheet__choices mobile-book-detail__actions"><button @click="downloadBook(detailBook)"><NativeIcon name="download" size="20" /><span>下载原件</span></button><button v-if="!isGuest" :disabled="detailLoading || !!detailError" @click="openEdit"><NativeIcon name="pencil" size="20" /><span>编辑信息</span></button><button v-if="!isGuest" class="danger" @click="detailVisible = false; deleteVisible = true"><NativeIcon name="trash" size="20" /><span>移入回收站</span></button></div>
      </div>
    </NativeDrawer>
    <NativeDialog v-model="editVisible" title="编辑书籍信息" width="540px" :confirm-loading="saving" @confirm="saveBook"><NativeForm label-width="68px"><NativeFormItem label="书名" required><NativeInput v-model="editForm.title" /></NativeFormItem><NativeFormItem label="作者"><NativeInput v-model="editForm.author" /></NativeFormItem><NativeFormItem label="分类"><NativeSelect v-model="editForm.categoryId" clearable placeholder="未分类" :options="categories.map(item => ({ value: item.id, label: item.name }))" /></NativeFormItem></NativeForm></NativeDialog>
    <NativeDialog v-model="deleteVisible" title="移入回收站？" width="440px" confirm-text="移入回收站" confirm-theme="danger" :confirm-loading="deleting" @confirm="deleteBook"><p class="mobile-books__delete-copy">“{{ detailBook?.title }}”将从书库移除，之后仍可在回收站恢复。</p></NativeDialog>
    <EbookUploadDialog v-model="uploadVisible" :categories="categories" @uploaded="afterUpload" />
    <BookReader :visible="readerVisible" :book="readerBook" :is-guest="isGuest" @close="readerVisible = false" @progress-saved="refreshProgress" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { NativeButton, NativeDialog, NativeDrawer, NativeForm, NativeFormItem, NativeIcon, NativeInput, NativeSelect } from '@/components/native'
import EbookUploadDialog from '@/components/books/EbookUploadDialog.vue'
import BookReader from '@/mobile/components/BookReader.vue'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { authenticatedAssetUrl } from '@/utils/authentication'

const route = useRoute(), router = useRouter(), toast = useToast()
const { isGuest } = usePermission()
const books = ref([]), categories = ref([]), brokenCovers = ref(new Set())
const keyword = ref(String(route.query.keyword || '')), category = ref(String(route.query.category || ''))
const readingStatus = ref(String(route.query.readingStatus || '')), fileType = ref(String(route.query.fileType || ''))
const sortBy = ref(String(route.query.sortBy || 'last_read_at')), sortOrder = ref(String(route.query.sortOrder || 'desc'))
const views = [{ value: '', label: '全部' }, { value: 'reading', label: '在读' }, { value: 'unread', label: '未开始' }, { value: 'finished', label: '已读完' }]
const sortOptions = [{ value: 'last_read_at', label: '最近阅读' }, { value: 'updated_at', label: '最近上传' }, { value: 'title', label: '书名' }, { value: 'author', label: '作者' }]
const sortLabel = computed(() => sortOptions.find(item => item.value === sortBy.value)?.label || '最近阅读')
const pagination = ref({ page: 1, pageSize: 24, total: 0, totalPages: 1 })
const loading = ref(false), loadingMore = ref(false), error = ref(''), moreError = ref('')
const categoryVisible = ref(false), filtersVisible = ref(false), uploadVisible = ref(false)
const detailVisible = ref(false), detailBook = ref(null), detailLoading = ref(false), detailError = ref('')
const editVisible = ref(false), editForm = ref({}), saving = ref(false), deleteVisible = ref(false), deleting = ref(false)
const readerVisible = ref(false), readerBook = ref(null)
let listSequence = 0, detailSequence = 0, searchTimer = null
const canUpload = computed(() => !isGuest.value && !keyword.value && !category.value && !readingStatus.value && !fileType.value)
const categoryLabel = computed(() => category.value === 'uncategorized' ? '未分类' : categories.value.find(item => String(item.id) === category.value)?.name || '全部分类')
const categoryChoices = computed(() => [{ value: '', label: '全部分类' }, { value: 'uncategorized', label: '未分类' }, ...categories.value.map(item => ({ value: String(item.id), label: item.name, count: item.bookCount }))])
function currentFilters() { return { keyword: keyword.value.trim(), category: category.value, readingStatus: readingStatus.value, fileType: fileType.value, sortBy: sortBy.value, sortOrder: sortOrder.value } }
async function loadBooks(append = false) {
  if (append && (loadingMore.value || loading.value)) return
  const sequence = ++listSequence
  if (append) loadingMore.value = true
  else { loading.value = true; loadingMore.value = false }
  error.value = ''; moreError.value = ''
  try {
    const response = await api.books.list({ ...currentFilters(), page: append ? pagination.value.page + 1 : 1, pageSize: 24 })
    if (sequence !== listSequence) return
    const items = response.data?.data || []
    books.value = append ? [...new Map([...books.value, ...items].map(item => [item.id, item])).values()] : items
    pagination.value = response.data?.pagination || { page: 1, pageSize: 24, total: items.length, totalPages: 1 }
  } catch (failure) {
    if (sequence !== listSequence) return
    const message = failure.response?.data?.message || '请检查连接后重试'
    if (append) moreError.value = message
    else error.value = message
  } finally { if (sequence === listSequence) { loading.value = false; loadingMore.value = false } }
}
async function loadCategories() {
  try { categories.value = (await api.books.getCategories()).data?.data || [] }
  catch { toast.error('分类加载失败，请稍后重试') }
}
async function applyFilters() {
  clearTimeout(searchTimer)
  const query = Object.fromEntries(Object.entries(currentFilters()).filter(([, value]) => value))
  void router.replace({ query })
  await loadBooks()
  document.querySelector('.layout-mobile .scrollable-content')?.scrollTo({ top: 0, behavior: 'auto' })
}
function clearFilters() { keyword.value = ''; category.value = ''; readingStatus.value = ''; fileType.value = ''; void applyFilters() }
watch(keyword, () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 350) })
function fileIcon(book) { return book.fileType === 'pdf' ? 'file-pdf' : book.fileType === 'txt' ? 'file-txt' : 'book-open' }
function isReadable(book) { return ['epub', 'pdf', 'txt'].includes(String(book.fileType || '').toLowerCase()) }
function coverUrl(book) { return authenticatedAssetUrl(`/api/ebooks/${book.id}/cover`) }
function downloadBook(book) { window.open(authenticatedAssetUrl(`/api/ebooks/download/${book.id}`), '_blank', 'noopener') }
function formatSize(value) { if (value == null || !Number.isFinite(Number(value))) return '大小未知'; const bytes = Number(value); if (bytes < 1024) return `${bytes} B`; const power = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return `${Number((bytes / 1024 ** power).toFixed(1))} ${['B', 'KB', 'MB', 'GB'][power]}` }
function indexLabel(book) { return ({ ready: '可问', partial: '部分可问', pending: '索引中', failed: '索引失败', stale: '待刷新', missing: '未索引', empty: '未索引' })[book.ragStatus?.status || book.ragStatus || book.indexStatus] || '未索引' }
async function openDetails(book) {
  const sequence = ++detailSequence
  detailBook.value = { ...book }; detailVisible.value = true; detailLoading.value = true; detailError.value = ''
  try { const response = await api.books.getDetail(book.id); if (sequence === detailSequence) detailBook.value = response.data?.data || book }
  catch { if (sequence === detailSequence) detailError.value = '详细信息暂未加载，请关闭后重试。' }
  finally { if (sequence === detailSequence) detailLoading.value = false }
}
function openReader(book) { detailVisible.value = false; readerBook.value = { ...book }; readerVisible.value = true }
async function refreshProgress() {
  if (!readerBook.value) return
  try { const response = await api.books.getDetail(readerBook.value.id); const updated = response.data?.data; if (updated) { const index = books.value.findIndex(book => book.id === updated.id); if (index >= 0) books.value[index] = updated } } catch { /* Keep loaded covers and scroll position when offline. */ }
}
function openEdit() { editForm.value = { id: detailBook.value.id, title: detailBook.value.title, author: detailBook.value.author || '', categoryId: detailBook.value.categoryId || null, year: detailBook.value.year || '', publisher: detailBook.value.publisher || '', isbn: detailBook.value.isbn || '', description: detailBook.value.description || '' }; detailVisible.value = false; editVisible.value = true }
async function saveBook() {
  if (saving.value) return
  if (!editForm.value.title?.trim()) { toast.warning('请填写书名'); return }
  saving.value = true
  try { const { id, ...payload } = editForm.value; await api.books.update(id, payload); editVisible.value = false; toast.success('书籍信息已更新'); await Promise.all([loadBooks(), loadCategories()]) }
  catch (failure) { toast.error(failure.response?.data?.message || '保存失败') }
  finally { saving.value = false }
}
async function deleteBook() {
  if (deleting.value) return
  deleting.value = true
  try { await api.books.delete(detailBook.value.id); deleteVisible.value = false; toast.success('已移入回收站'); await Promise.all([loadBooks(), loadCategories()]) }
  catch (failure) { toast.error(failure.response?.data?.message || '操作失败') }
  finally { deleting.value = false }
}
async function afterUpload() { await Promise.all([loadBooks(), loadCategories()]) }
onMounted(async () => {
  await Promise.all([loadBooks(), loadCategories()])
  const id = Number(route.query.bookId)
  if (!Number.isSafeInteger(id) || id <= 0) return
  try { const book = (await api.books.getDetail(id)).data?.data; if (!book) return; const index = Number(route.query.chapterIndex); openReader({ ...book, ...(Number.isSafeInteger(index) && index >= 0 ? { searchChapterIndex: index } : {}) }) }
  catch { toast.error('该书籍暂时无法打开') }
})
onBeforeUnmount(() => { clearTimeout(searchTimer); listSequence += 1; detailSequence += 1 })
</script>

<style scoped>
.mobile-books{padding:16px 18px 28px;color:var(--color-text-primary);-webkit-tap-highlight-color:transparent}
.mobile-books button{font:inherit;cursor:pointer}.mobile-books__search{display:flex;gap:10px}.mobile-books__search-field{display:flex;align-items:center;flex:1;min-width:0;gap:8px;padding:0 12px;border:1px solid var(--color-border-default);border-radius:10px;background:var(--color-surface-raised);color:var(--color-text-muted)}.mobile-books__search input{width:100%;min-width:0;height:44px;padding:0;border:0;outline:0;background:transparent;color:var(--color-text-primary);font:inherit;font-size:14px}.mobile-books__search-field:focus-within{border-color:var(--color-text-muted)}.mobile-books__upload{width:44px;height:44px;flex-shrink:0;display:grid;place-items:center;border:0;border-radius:10px;background:var(--color-primary);color:#fff}
.mobile-books__views{display:flex;gap:22px;margin-top:18px;border-bottom:1px solid var(--color-border-subtle)}.mobile-books__views button{position:relative;min-height:44px;padding:0 2px;border:0;background:transparent;color:var(--color-text-secondary);font-size:14px;white-space:nowrap}.mobile-books__views button.active{color:var(--color-text-primary);font-weight:600}.mobile-books__views button.active:after{position:absolute;content:'';height:2px;bottom:-1px;left:0;right:0;background:var(--color-primary)}
.mobile-books__toolbar{display:flex;justify-content:space-between;align-items:center;padding-top:8px;gap:8px}.mobile-books__toolbar button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;border:0;background:transparent;color:var(--color-text-secondary)}.mobile-books__category{min-width:0;padding:0;font-size:13px!important}.mobile-books__category span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-books__tools{display:flex;flex-shrink:0}.mobile-books__tools button{width:44px}.mobile-books__tools button.active{color:var(--color-primary)}.mobile-books__summary{display:flex;justify-content:space-between;gap:12px;margin:4px 0 18px;color:var(--color-text-muted);font-size:12px}
.mobile-books__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:26px 20px}.mobile-book{min-width:0}.mobile-book__cover{position:relative;display:block;width:100%;aspect-ratio:2/3;overflow:hidden;padding:0;border:0;border-radius:3px 7px 7px 3px;background:#e6e9f0;box-shadow:1px 3px 7px #17233318;text-align:left;color:#475671;transition:transform 160ms ease}.mobile-book__cover:before{position:absolute;z-index:1;inset:0;content:'';pointer-events:none;box-shadow:inset 2px 0 3px #ffffff35,inset -1px 0 2px #00000015}.mobile-book__cover img{width:100%;height:100%;object-fit:cover}.mobile-book__cover--pdf{background:#eee5e3;color:#84564e}.mobile-book__cover--txt{background:#e4e8e1;color:#4f665b}.mobile-book__placeholder{display:flex;height:100%;box-sizing:border-box;flex-direction:column;align-items:flex-start;justify-content:space-between;padding:20px 18px}.mobile-book__placeholder strong{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font-family:serif;font-size:18px;font-weight:600;line-height:1.5}.mobile-book__placeholder small{font-size:10px;letter-spacing:.1em;opacity:.6}
.mobile-book__heading{display:flex;align-items:flex-start;margin:10px -8px 0 0}.mobile-book__heading>button:first-child{flex:1;min-width:0;padding:2px 0;border:0;background:transparent;color:var(--color-text-primary);font-size:14px;font-weight:600;line-height:1.5;text-align:left;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:44px}.mobile-book__more{display:grid;place-items:center;flex-shrink:0;width:44px;min-height:44px;padding:0;border:0;background:transparent;color:var(--color-text-muted)}.mobile-book>p{overflow:hidden;margin:2px 0 7px;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--color-text-secondary)}.mobile-book__progress{display:flex;align-items:center;gap:8px;min-height:16px}.mobile-book__progress>span{height:2px;max-width:48px;flex:1;overflow:hidden;background:var(--color-border-subtle)}.mobile-book__progress i{display:block;height:100%;background:var(--color-primary)}.mobile-book__progress small{font-size:11px;color:var(--color-text-muted)}
.mobile-books__empty{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;min-height:300px;text-align:center;color:var(--color-text-muted)}.mobile-books__empty strong{color:var(--color-text-primary);font-size:16px}.mobile-books__empty p{max-width:270px;margin:0 0 10px;line-height:1.6;font-size:13px}.mobile-books__skeleton{display:grid;grid-template-columns:repeat(2,1fr);gap:32px 20px}.mobile-books__skeleton span{aspect-ratio:2/3;background:var(--color-surface-subtle);border-radius:4px;animation:book-breathe 1.4s ease-in-out infinite alternate}.mobile-books__pagination{display:flex;align-items:center;flex-direction:column;gap:12px;margin-top:34px;font-size:12px;color:var(--color-text-muted)}.mobile-books__pagination :deep(button){min-height:44px}.mobile-books__retry{border:0;background:transparent;color:var(--color-text-secondary);min-height:44px}.mobile-books__delete-copy{font-size:14px;line-height:1.7}
:global(.mobile-books-sheet){font-size:14px;-webkit-tap-highlight-color:transparent}:global(.mobile-books-sheet .native-drawer__content){max-width:640px;left:0;right:0;margin-inline:auto;border-radius:18px 18px 0 0}:global(.mobile-books-sheet .native-drawer__body){padding:12px 20px calc(20px + env(safe-area-inset-bottom))}:global(.mobile-books-sheet .native-drawer__title){font-size:16px}:global(.mobile-books-sheet .native-drawer__close){min-width:44px;min-height:44px}:global(.mobile-books-sheet .native-drawer__footer){padding-bottom:calc(12px + env(safe-area-inset-bottom))}.mobile-books-sheet__choices{display:grid;gap:2px}.mobile-books-sheet__choices button{display:flex;align-items:center;gap:12px;min-height:48px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:var(--color-text-secondary);font:inherit;text-align:left;cursor:pointer}.mobile-books-sheet__choices button>span{flex:1}.mobile-books-sheet__choices small{font-size:12px;color:var(--color-text-muted)}.mobile-books-sheet__choices button.active{background:var(--color-primary-surface);color:var(--color-primary)}.mobile-books-sheet__choices button:disabled{opacity:.5;cursor:wait}.mobile-books-sheet__filter h4{font-size:12px;font-weight:500;color:var(--color-text-muted);margin:12px 0}.mobile-books-sheet__direction{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border:0;background:transparent;color:var(--color-text-secondary)}.mobile-books-sheet__formats{display:flex;flex-wrap:wrap;gap:8px}.mobile-books-sheet__formats button{min-height:44px;min-width:64px;padding:8px 12px;border:1px solid var(--color-border-subtle);border-radius:8px;background:transparent;color:var(--color-text-secondary)}.mobile-books-sheet__formats button.active{border-color:var(--color-primary-border);color:var(--color-primary);background:var(--color-primary-surface)}
.mobile-book-detail{display:grid;gap:18px}.mobile-book-detail>header{display:flex;gap:16px;align-items:center}.mobile-book-detail__cover{width:56px;height:78px;flex-shrink:0;display:grid;place-items:center;border-radius:3px;overflow:hidden;background:var(--color-surface-subtle);color:var(--color-primary)}.mobile-book-detail__cover img{width:100%;height:100%;object-fit:cover}.mobile-book-detail h3{font-size:16px;line-height:1.5;margin:0;overflow-wrap:anywhere}.mobile-book-detail header p{font-size:13px;color:var(--color-text-secondary);margin:5px 0}.mobile-book-detail header small{font-size:12px;color:var(--color-text-muted)}.mobile-book-detail :deep(.native-btn){min-height:44px;width:100%}.mobile-book-detail dl{display:grid;grid-template-columns:70px 1fr;gap:12px;margin:0;padding:18px 0;border-block:1px solid var(--color-border-subtle);font-size:13px}.mobile-book-detail dt{color:var(--color-text-muted)}.mobile-book-detail dd{margin:0;overflow-wrap:anywhere}.mobile-book-detail__description{font-size:13px;line-height:1.8;white-space:pre-wrap;color:var(--color-text-secondary);margin:0}.mobile-book-detail__hint{font-size:12px;color:var(--color-text-muted);margin:0}.mobile-book-detail__actions .danger{color:var(--color-danger)}
.mobile-books button:active,.mobile-books-sheet button:active{filter:brightness(.96)}.mobile-books button:focus:not(:focus-visible),:global(.mobile-books-sheet button:focus:not(:focus-visible)){outline:none;box-shadow:none}.mobile-books button:focus-visible{outline:2px solid var(--color-focus-ring);outline-offset:3px}
@keyframes book-breathe{from{opacity:.5}to{opacity:1}}@media(min-width:540px){.mobile-books__grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){.mobile-books__skeleton span{animation:none}.mobile-book__cover{transition:none}}
:global(.mobile-books-detail-sheet .native-drawer__content){max-height:min(82dvh,680px)}
</style>
