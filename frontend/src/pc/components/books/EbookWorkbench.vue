<template>
  <div class="ebook-workbench">
    <header class="ebook-workbench__toolbar">
      <NativeInput
        :model-value="filters.keyword"
        class="ebook-workbench__search"
        placeholder="搜索书名、作者或 ISBN"
        clearable
        @update:model-value="updateFilter('keyword', $event)"
        @enter="emit('apply')"
        @clear="emit('apply')"
      >
        <template #prefix-icon><NativeIcon name="magnifying-glass" /></template>
      </NativeInput>
      <div class="ebook-workbench__format"><NativeSelect :model-value="filters.fileType" clearable placeholder="全部格式" :options="fileTypes" @update:model-value="updateFilter('fileType', $event)" @change="emit('apply')" /></div>
      <div class="ebook-workbench__sort">
        <NativeSelect :model-value="filters.sortBy" :options="sortOptions" @update:model-value="updateFilter('sortBy', $event)" @change="emit('apply')" />
        <NativeButton variant="outline" :title="filters.sortOrder === 'desc' ? '降序' : '升序'" @click="updateFilter('sortOrder', filters.sortOrder === 'desc' ? 'asc' : 'desc'); emit('apply')">
          <NativeIcon :name="filters.sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" />
        </NativeButton>
      </div>
      <div class="ebook-workbench__views" role="group" aria-label="视图方式">
        <button type="button" :class="{ active: viewMode === 'cover' }" aria-label="封面视图" @click="emit('update:viewMode', 'cover')"><NativeIcon name="view-grid" /></button>
        <button type="button" :class="{ active: viewMode === 'list' }" aria-label="列表视图" @click="emit('update:viewMode', 'list')"><NativeIcon name="list-dashes" /></button>
      </div>
      <NativeButton theme="primary" :disabled="isGuest" @click="emit('upload')"><template #icon><NativeIcon name="upload" /></template>上传书籍</NativeButton>
    </header>

    <div class="ebook-workbench__body">
      <aside class="ebook-workbench__sidebar">
        <div class="ebook-workbench__sidebar-heading"><strong>书库</strong><NativeButton variant="text" size="small" title="新建分类" :disabled="isGuest" @click="emit('create-category')"><NativeIcon name="folder-plus" /></NativeButton></div>
        <nav class="ebook-workbench__nav" aria-label="书库视图">
          <button v-for="item in smartViews" :key="item.key" type="button" :class="{ active: activeView === item.key }" @click="selectSmartView(item.key)">
            <NativeIcon :name="item.icon" /><span>{{ item.label }}</span><small v-if="item.key === 'all'">{{ pagination.total }}</small>
          </button>
        </nav>
        <div class="ebook-workbench__sidebar-heading ebook-workbench__sidebar-heading--categories"><strong>分类</strong><span>{{ categories.length }}</span></div>
        <nav class="ebook-workbench__nav ebook-workbench__categories" aria-label="书籍分类">
          <button v-for="category in categories" :key="category.id" type="button" :class="{ active: String(filters.category || '') === String(category.id) }" @click="selectCategory(category)">
            <NativeIcon name="folder" /><span>{{ category.name }}</span><small class="category-count">{{ category.bookCount }}</small>
            <span v-if="!isGuest" class="category-actions">
              <i role="button" tabindex="0" title="重命名分类" @click.stop="emit('rename-category', category)" @keydown.enter.stop="emit('rename-category', category)"><NativeIcon name="pencil" /></i>
              <i role="button" tabindex="0" title="删除分类" @click.stop="emit('delete-category', category)" @keydown.enter.stop="emit('delete-category', category)"><NativeIcon name="trash" /></i>
            </span>
          </button>
        </nav>
        <button type="button" class="ebook-workbench__trash" @click="emit('trash')"><NativeIcon name="trash" /><span>统一回收站</span></button>
      </aside>

      <main class="ebook-workbench__content">
        <div class="ebook-workbench__content-heading">
          <div><h2>{{ currentTitle }}</h2><p>{{ currentDescription }}</p></div>
          <div v-if="selectedKeys.length" class="ebook-workbench__selection"><span>已选 {{ selectedKeys.length }} 项</span><NativeButton theme="danger" variant="outline" size="small" :disabled="isGuest" @click="emit('batch-delete')"><NativeIcon name="trash" />移入回收站</NativeButton><NativeButton variant="text" size="small" @click="emit('clear-selection')">取消</NativeButton></div>
        </div>

        <div v-if="loading" class="ebook-workbench__skeleton" aria-label="正在加载书籍"><span v-for="index in 8" :key="index" /></div>
        <div v-else-if="books.length === 0" class="ebook-workbench__empty">
          <span><NativeIcon name="book-open" size="34" /></span><strong>{{ filters.keyword ? '没有找到匹配的书籍' : '这里还没有书籍' }}</strong><p>{{ filters.keyword ? '尝试缩短关键词或清除筛选条件。' : '上传第一本书，阅读位置会在 PC 与移动端之间同步。' }}</p><NativeButton v-if="!filters.keyword" theme="primary" :disabled="isGuest" @click="emit('upload')">上传书籍</NativeButton>
        </div>

        <div v-else-if="viewMode === 'cover'" class="ebook-workbench__grid">
          <article v-for="book in books" :key="book.id" class="ebook-card" tabindex="0" @click="emit('detail', book)" @keydown.enter="emit('detail', book)">
            <label class="ebook-card__select" @click.stop><input type="checkbox" :checked="selectedKeys.includes(book.id)" :aria-label="`选择 ${book.title}`" @change="emit('toggle-select', book.id)" /></label>
            <div class="ebook-card__cover" :class="`ebook-card__cover--${tone(book)}`">
              <img v-if="book.coverImage" :src="coverUrl(book)" :alt="book.title" loading="lazy" @error="$event.currentTarget.style.display = 'none'" />
              <div v-else><NativeIcon :name="fileIcon(book)" size="36" /><span>{{ fileLabel(book) }}</span></div>
            </div>
            <div class="ebook-card__info"><strong :title="book.title">{{ book.title }}</strong><span>{{ book.author || '作者未知' }}</span><small>{{ book.categoryName || '未分类' }} · {{ fileLabel(book) }}</small></div>
            <div v-if="book.progress > 0" class="ebook-card__progress"><span><i :style="{ width: `${Math.min(100, book.progress)}%` }" /></span><small>{{ Math.round(book.progress) }}%</small></div>
            <NativeButton class="ebook-card__read" :disabled="!isReadable(book)" :theme="book.progress > 0 ? 'primary' : 'default'" :variant="book.progress > 0 ? 'base' : 'outline'" @click.stop="emit('read', book)">{{ isReadable(book) ? (book.progress > 0 ? '继续阅读' : '开始阅读') : '仅可下载' }}</NativeButton>
          </article>
        </div>

        <div v-else class="ebook-workbench__list">
          <div class="ebook-list-row ebook-list-row--header"><span></span><span>书名</span><span>作者</span><span>分类 / 格式</span><span>阅读进度</span><span>最近阅读</span><span>操作</span></div>
          <div v-for="book in books" :key="book.id" class="ebook-list-row" @dblclick="isReadable(book) && emit('read', book)">
            <span><input type="checkbox" :checked="selectedKeys.includes(book.id)" :aria-label="`选择 ${book.title}`" @change="emit('toggle-select', book.id)" /></span>
            <button type="button" class="ebook-list-row__title" @click="emit('detail', book)"><i :class="`tone-${tone(book)}`"><NativeIcon :name="fileIcon(book)" /></i><strong>{{ book.title }}</strong></button>
            <span>{{ book.author || '-' }}</span><span>{{ book.categoryName || '未分类' }} · {{ fileLabel(book) }}</span>
            <span class="ebook-list-row__progress"><i><b :style="{ width: `${Math.min(100, book.progress)}%` }" /></i>{{ Math.round(book.progress || 0) }}%</span>
            <span>{{ book.lastReadAt ? shortDate(book.lastReadAt) : '未阅读' }}</span>
            <span class="ebook-list-row__actions"><NativeButton size="small" theme="primary" :disabled="!isReadable(book)" @click="emit('read', book)"><NativeIcon name="book-open" />{{ isReadable(book) ? '阅读' : '不可读' }}</NativeButton><NativeButton size="small" variant="outline" @click="emit('detail', book)"><NativeIcon name="eye" />详情</NativeButton></span>
          </div>
        </div>

        <footer v-if="pagination.totalPages > 1" class="ebook-workbench__pagination">
          <span>共 {{ pagination.total }} 本</span><div><NativeButton variant="outline" :disabled="pagination.page <= 1" @click="emit('page', pagination.page - 1)"><NativeIcon name="chevron-left" />上一页</NativeButton><strong>{{ pagination.page }} / {{ pagination.totalPages }}</strong><NativeButton variant="outline" :disabled="pagination.page >= pagination.totalPages" @click="emit('page', pagination.page + 1)">下一页<NativeIcon name="chevron-right" /></NativeButton></div>
        </footer>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { NativeButton, NativeIcon, NativeInput, NativeSelect } from '@/components/native'
import { authenticatedAssetUrl } from '@/utils/authentication'

const props = defineProps({
  books: { type: Array, default: () => [] }, categories: { type: Array, default: () => [] }, loading: Boolean,
  pagination: { type: Object, default: () => ({ page: 1, pageSize: 24, total: 0, totalPages: 1 }) },
  filters: { type: Object, required: true }, selectedKeys: { type: Array, default: () => [] }, viewMode: { type: String, default: 'cover' }, isGuest: Boolean
})
const emit = defineEmits(['update:filters','update:viewMode','apply','upload','create-category','rename-category','delete-category','trash','detail','read','toggle-select','clear-selection','batch-delete','page'])
const fileTypes = ['epub','pdf','txt','mobi','azw','azw3','fb2'].map(value => ({ value, label: value.toUpperCase() }))
const sortOptions = [{value:'last_read_at',label:'最近阅读'},{value:'updated_at',label:'最近上传'},{value:'title',label:'书名'},{value:'author',label:'作者'},{value:'year',label:'出版年份'}]
const smartViews = [{key:'all',label:'全部书籍',icon:'books'},{key:'reading',label:'继续阅读',icon:'book-open'},{key:'unread',label:'未开始',icon:'bookmark'},{key:'finished',label:'已读完',icon:'check-circle'},{key:'uncategorized',label:'未分类',icon:'folder-open'}]
const activeView = computed(() => props.filters.category === 'uncategorized' ? 'uncategorized' : props.filters.category ? `category-${props.filters.category}` : props.filters.readingStatus || 'all')
const selectedCategory = computed(() => props.categories.find(category => String(category.id) === String(props.filters.category)))
const currentTitle = computed(() => selectedCategory.value?.name || smartViews.find(item => item.key === activeView.value)?.label || '全部书籍')
const currentDescription = computed(() => props.filters.keyword ? `“${props.filters.keyword}”的搜索结果` : selectedCategory.value ? `${selectedCategory.value.bookCount} 本书` : activeView.value === 'reading' ? '从上次位置继续阅读' : `${props.pagination.total} 本书`)
function updateFilter(key,value){ emit('update:filters',{...props.filters,[key]:value || ''}) }
function selectSmartView(key){ const next={...props.filters,category:'',readingStatus:''}; if(['reading','unread','finished'].includes(key)) next.readingStatus=key; if(key==='uncategorized') next.category='uncategorized'; emit('update:filters',next); emit('apply') }
function selectCategory(category){ emit('update:filters',{...props.filters,category:String(category.id),readingStatus:''}); emit('apply') }
function fileLabel(book){ return String(book.fileType || 'book').toUpperCase() }
function fileIcon(book){ const value=String(book.fileType||'').toLowerCase(); return value==='pdf'?'file-pdf':value==='txt'?'file-txt':'book-open' }
function isReadable(book){ return ['epub','pdf','txt'].includes(String(book.fileType||'').toLowerCase()) }
function tone(book){ const value=String(book.fileType||'').toLowerCase(); return value==='pdf'?'pdf':value==='txt'?'text':'book' }
function coverUrl(book){ return authenticatedAssetUrl(`/api/ebooks/${book.id}/cover`) }
function shortDate(value){ const date=new Date(value); return Number.isNaN(date.getTime())?value:date.toLocaleDateString('zh-CN') }
</script>

<style scoped>
.ebook-workbench{display:flex;flex-direction:column;gap:14px}.ebook-workbench__toolbar{min-height:64px;display:grid;grid-template-columns:minmax(260px,1fr) 130px 270px auto auto;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--color-border-subtle);border-radius:var(--radius-lg);background:var(--color-surface-raised);box-shadow:var(--shadow-sm)}.ebook-workbench__search{width:100%}.ebook-workbench__sort{display:grid;grid-template-columns:1fr 42px;gap:6px}.ebook-workbench__views{display:flex;padding:3px;border:1px solid var(--color-border-subtle);border-radius:9px;background:var(--color-surface-subtle)}.ebook-workbench__views button{width:36px;height:34px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--color-text-muted);cursor:pointer}.ebook-workbench__views button.active{background:var(--color-surface-raised);color:var(--color-primary);box-shadow:var(--shadow-xs)}.ebook-workbench__body{min-height:620px;display:grid;grid-template-columns:216px minmax(0,1fr);overflow:hidden;border:1px solid var(--color-border-subtle);border-radius:var(--radius-lg);background:var(--color-surface-raised)}.ebook-workbench__sidebar{display:flex;min-height:0;flex-direction:column;padding:14px 10px;border-right:1px solid var(--color-border-subtle);background:color-mix(in srgb,var(--color-surface-subtle) 76%,var(--color-surface-raised))}.ebook-workbench__sidebar-heading{height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 9px;color:var(--color-text-primary)}.ebook-workbench__sidebar-heading--categories{margin-top:10px;color:var(--color-text-secondary);font-size:12px}.ebook-workbench__nav{display:grid;gap:3px}.ebook-workbench__nav button,.ebook-workbench__trash{position:relative;width:100%;min-height:40px;display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--color-text-secondary);text-align:left;cursor:pointer}.ebook-workbench__nav button:hover,.ebook-workbench__trash:hover{background:var(--color-surface-raised)}.ebook-workbench__nav button.active{background:var(--color-primary-surface);color:var(--color-primary)}.ebook-workbench__nav span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ebook-workbench__nav small{color:var(--color-text-muted)}.ebook-workbench__categories{max-height:280px;overflow:auto}.category-more{display:none}.ebook-workbench__categories button:hover .category-more{display:inline-flex}.ebook-workbench__trash{margin-top:auto}.ebook-workbench__content{min-width:0;padding:20px}.ebook-workbench__content-heading{min-height:54px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.ebook-workbench__content-heading h2,.ebook-workbench__content-heading p{margin:0}.ebook-workbench__content-heading h2{font-size:19px}.ebook-workbench__content-heading p{margin-top:4px;font-size:12px;color:var(--color-text-muted)}.ebook-workbench__selection{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--color-primary-border);border-radius:9px;background:var(--color-primary-surface);color:var(--color-primary);font-size:12px}.ebook-workbench__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:16px}.ebook-card{position:relative;min-width:0;display:grid;grid-template-rows:230px auto auto auto;gap:10px;padding:12px;border:1px solid var(--color-border-subtle);border-radius:12px;background:var(--color-surface-raised);cursor:pointer;transition:border-color .16s ease,transform .16s ease,box-shadow .16s ease}.ebook-card:hover{transform:translateY(-2px);border-color:var(--color-primary-border);box-shadow:var(--shadow-md)}.ebook-card:focus-visible{outline:2px solid var(--color-focus-ring);outline-offset:2px}.ebook-card__select{position:absolute;top:18px;left:18px;z-index:2;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;background:rgba(255,255,255,.9);box-shadow:0 2px 8px rgba(34,42,58,.14)}.ebook-card__cover{overflow:hidden;display:grid;place-items:center;border-radius:9px;background:#eef0ff;color:#5262d9}.ebook-card__cover--pdf{background:#fff0f2;color:#ad3b55}.ebook-card__cover--text{background:#eff2f6;color:#5d687a}.ebook-card__cover img{width:100%;height:100%;object-fit:cover}.ebook-card__cover>div{display:grid;place-items:center;gap:8px}.ebook-card__cover span{font-size:11px;font-weight:700}.ebook-card__info{min-width:0;display:grid;gap:3px}.ebook-card__info strong,.ebook-card__info span,.ebook-card__info small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ebook-card__info strong{font-size:14px}.ebook-card__info span{font-size:12px;color:var(--color-text-secondary)}.ebook-card__info small{font-size:11px;color:var(--color-text-muted)}.ebook-card__progress{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px}.ebook-card__progress>span{height:4px;overflow:hidden;border-radius:99px;background:var(--color-border-subtle)}.ebook-card__progress i{display:block;height:100%;background:var(--color-primary)}.ebook-card__progress small{font-size:11px;color:var(--color-text-muted)}.ebook-card__read{width:100%}.ebook-workbench__list{overflow-x:auto;border:1px solid var(--color-border-subtle);border-radius:10px}.ebook-list-row{min-width:920px;display:grid;grid-template-columns:34px minmax(220px,1.4fr) minmax(120px,.75fr) minmax(140px,.85fr) 140px 120px 170px;align-items:center;gap:10px;min-height:64px;padding:8px 12px;border-bottom:1px solid var(--color-border-subtle);font-size:12px;color:var(--color-text-secondary)}.ebook-list-row:last-child{border-bottom:0}.ebook-list-row--header{min-height:42px;background:var(--color-surface-subtle);color:var(--color-text-primary);font-weight:600}.ebook-list-row__title{min-width:0;display:flex;align-items:center;gap:9px;border:0;background:transparent;color:var(--color-text-primary);text-align:left;cursor:pointer}.ebook-list-row__title i{width:34px;height:40px;display:grid;place-items:center;border-radius:6px;background:#eef0ff;color:#5262d9}.ebook-list-row__title i.tone-pdf{background:#fff0f2;color:#ad3b55}.ebook-list-row__title i.tone-text{background:#eff2f6;color:#5d687a}.ebook-list-row__title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ebook-list-row__progress{display:grid;grid-template-columns:80px auto;align-items:center;gap:7px}.ebook-list-row__progress>i{height:4px;overflow:hidden;border-radius:99px;background:var(--color-border-subtle)}.ebook-list-row__progress b{display:block;height:100%;background:var(--color-primary)}.ebook-list-row__actions{display:flex;gap:6px}.ebook-workbench__pagination{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding-top:14px;border-top:1px solid var(--color-border-subtle);font-size:12px;color:var(--color-text-muted)}.ebook-workbench__pagination>div{display:flex;align-items:center;gap:12px}.ebook-workbench__pagination strong{color:var(--color-text-primary)}.ebook-workbench__empty{min-height:420px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:var(--color-text-muted)}.ebook-workbench__empty>span{width:64px;height:64px;display:grid;place-items:center;border-radius:18px;background:var(--color-primary-surface);color:var(--color-primary)}.ebook-workbench__empty strong{color:var(--color-text-primary)}.ebook-workbench__empty p{margin:0 0 5px;font-size:13px}.ebook-workbench__skeleton{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.ebook-workbench__skeleton span{height:320px;border-radius:12px;background:linear-gradient(100deg,var(--color-surface-subtle) 30%,var(--color-surface-raised) 50%,var(--color-surface-subtle) 70%);background-size:220% 100%;animation:ebook-shimmer 1.4s infinite}@keyframes ebook-shimmer{to{background-position-x:-220%}}@media(max-width:1200px){.ebook-workbench__toolbar{grid-template-columns:minmax(220px,1fr) 120px 230px auto}.ebook-workbench__views{display:none}.ebook-workbench__body{grid-template-columns:188px minmax(0,1fr)}.ebook-workbench__grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}.ebook-card{grid-template-rows:210px auto auto auto}}
.category-actions{position:absolute;right:5px;display:none;align-items:center;gap:2px;padding-left:8px;background:linear-gradient(90deg,transparent,var(--color-surface-raised) 22%)}
.category-actions i{width:28px;height:28px;display:grid;place-items:center;border-radius:6px}
.category-actions i:hover{background:var(--color-surface-subtle);color:var(--color-primary)}
.ebook-workbench__categories button:hover .category-actions{display:flex}
.ebook-workbench__categories button:hover .category-count{visibility:hidden}
@media(max-width:1200px){.ebook-workbench__toolbar{display:flex;flex-wrap:wrap}.ebook-workbench__search{flex:1 0 100%}.ebook-workbench__format{width:130px;flex:0 0 130px}.ebook-workbench__format :deep(.native-select){width:100%}.ebook-workbench__sort{width:230px}.ebook-workbench__toolbar>.native-button:last-child{margin-left:auto}}
</style>
