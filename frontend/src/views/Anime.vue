<template>
  <AnimeMobile v-if="isMobile" />
  <div v-else class="anime">
    <div class="page-header">
      <p>管理和收藏动漫剧集</p>
    </div>

    <!-- Bangumi Token 失效提醒 -->
    <NativeCard v-if="tokenStatus && tokenStatus.hasToken && !tokenStatus.isValid" theme="warning" style="margin-bottom: 16px">
      <div class="token-alert">
        <NativeIcon name="warning-circle" size="18" />
        <span>{{ tokenStatus.message }}</span>
        <NativeButton
          size="small"
          theme="primary"
          @click="openTokenPage"
        >
          更新 Token
        </NativeButton>
      </div>
    </NativeCard>

    <NativeCard>
      <div class="search-bar">
        <NativeInput
          v-model="searchKeyword"
          placeholder="搜索 Bangumi..."
          style="width: 300px"
          @enter="handleSearch"
        >
          <template #suffix-icon>
            <NativeIcon name="magnifying-glass" />
          </template>
        </NativeInput>
        <NativeInput
          v-model="searchTag"
          placeholder="标签（如：恋爱、奇幻）"
          style="width: 180px"
          @enter="handleSearch"
          clearable
        >
          <template #suffix-icon>
            <NativeIcon name="tag" />
          </template>
        </NativeInput>
        <NativeButton theme="primary" @click="handleSearch" :loading="searching">
          <template #icon><NativeIcon name="magnifying-glass" /></template>
          搜索
        </NativeButton>
        <NativeSelect
          v-model="resourceSearchMode"
          style="width: 140px;"
          placeholder="搜索模式"
          :options="[
            { value: 'parallel', label: '同时多源搜索' },
            { value: 'sequential', label: '顺序优先搜索' }
          ]"
        />
      </div>
    </NativeCard>

    <!-- Bangumi 搜索结果 -->
    <NativeCard v-if="searchResults.length > 0" style="margin-top: 16px">
      <template #header>
        <div class="search-result-title">
          <span>搜索结果</span>
          <NativeButton
            size="small"
            variant="text"
            @click="clearSearchResults"
            title="关闭搜索结果"
          >
            <template #icon><NativeIcon name="x" /></template>
          </NativeButton>
        </div>
      </template>
      <div class="search-grid">
        <div
          v-for="anime in searchResults"
          :key="anime.id"
          class="search-card"
          @click="showDetail(anime)"
        >
          <div class="cover-wrapper">
            <img :src="toHttps(anime.images?.large || anime.images?.common)" :alt="anime.name" />
            <div class="rating-badge" v-if="anime.rating?.score">
              <span class="score">{{ anime.rating.score.toFixed(1) }}</span>
              <span class="count">{{ anime.rating_count || anime.rating?.total || 0 }}人</span>
            </div>
          </div>
              <div class="card-content">
            <div class="title-row">
              <h4 class="title-cn" :title="anime.name_cn || anime.name">{{ anime.name_cn || anime.name }}</h4>
              <h5 v-if="anime.name && anime.name_cn && anime.name !== anime.name_cn" class="title-original" :title="anime.name">{{ anime.name }}</h5>
            </div>
            <div class="meta-info">
              <div class="meta-row" v-if="anime.air_date">
                <NativeIcon name="calendar" size="14" />
                <span>{{ anime.air_date }}</span>
              </div>
              <div class="meta-row" v-if="anime.eps || anime.eps_total">
                <NativeIcon name="video" size="14" />
                <span>{{ anime.eps || '?' }} / {{ anime.eps_total || '?' }} 集</span>
              </div>
            </div>
            <div class="staff-info">
              <div class="staff-item" v-if="anime.author">
                <span class="staff-label">作者:</span>
                <span class="staff-value">{{ anime.author }}</span>
              </div>
              <div class="staff-item" v-if="anime.director">
                <span class="staff-label">监督:</span>
                <span class="staff-value">{{ anime.director }}</span>
              </div>
              <div class="staff-item" v-if="anime.studio">
                <span class="staff-label">制作:</span>
                <span class="staff-value">{{ anime.studio }}</span>
              </div>
            </div>
            <div class="tags-row" v-if="anime.tags?.length">
              <NativeTag
                v-for="tag in anime.tags.slice(0, 4)"
                :key="tag"
                size="small"
                theme="primary"
                variant="light"
              >
                {{ tag.name || tag }}
              </NativeTag>
              <span v-if="anime.tags.length > 4" class="more-tags">+{{ anime.tags.length - 4 }}</span>
            </div>
            <div class="card-actions">
            <NativeButton
              size="small"
              :disabled="isInLibrary(anime.id) || isGuest"
              :theme="isInLibrary(anime.id) ? 'default' : 'primary'"
              @click.stop="handleImport(anime)"
              :loading="anime.importing"
            >
              <template #icon><NativeIcon :name="isInLibrary(anime.id) ? 'check' : 'plus'" /></template>
              {{ isInLibrary(anime.id) ? '已添加' : '添加' }}
            </NativeButton>
              <NativeButton size="small" variant="outline" @click.stop="showDetail(anime)">
                <template #icon><NativeIcon name="list-dashes" /></template>
                详情
              </NativeButton>
            </div>
          </div>
        </div>
      </div>
      <!-- 搜索结果分页 -->
      <div class="search-pagination" v-if="searchPagination.total > 0">
        <NativePagination
          :current="searchPagination.current"
          :page-size="searchPagination.pageSize"
          :total="searchPagination.total"
          :page-size-options="[15, 20, 30, 50]"
          show-page-size
          @change="handleSearchPageChange"
          @page-size-change="handleSearchPageSizeChange"
        />
      </div>
    </NativeCard>

    <!-- 我的动漫库 -->
    <NativeCard style="margin-top: 16px">
      <template #header>
        <div class="card-title-row">
          <span class="card-title">我的动漫库</span>
          <div class="filter-bar">
            <NativeSelect v-model="filterStatus" class="filter-select-24" placeholder="状态筛选" style="width: 120px;" size="small" clearable @change="handleFilterChange" :options="[
              { value: '', label: '全部' },
              { value: 'none', label: '未标记' },
              { value: 'want_to_watch', label: '想看' },
              { value: 'watching', label: '在看' },
              { value: 'watched', label: '看过' }
            ]" />
            <NativeCheckbox v-model="filterFavorite" @change="handleFilterChange">只看收藏</NativeCheckbox>
            <div class="divider-vertical" />
            <NativeSelect v-model="sortBy" class="filter-select-24" placeholder="排序" style="width: 120px;" size="small" @change="handleSortByChange" :options="[
              { value: 'updated_at', label: '更新时间' },
              { value: 'air_date', label: '上映日期' },
              { value: 'rating', label: '总评分' },
              { value: 'user_rating', label: '我的评分' },
              { value: 'status', label: '标记状态' }
            ]" />
            <NativeButton
              :variant="sortOrder === 'DESC' ? 'base' : 'outline'"
              size="small"
              @click="toggleSortOrder"
              style="height: 28px;"
            >
              <template #icon><NativeIcon :name="sortOrder === 'DESC' ? 'arrow-down' : 'arrow-up'" /></template>
              {{ sortOrder === 'DESC' ? '降序' : '升序' }}
            </NativeButton>
            <div class="spacer" style="flex: 1;"></div>
            <NativeButton
              variant="outline"
              size="small"
              :loading="downloadingCovers"
              @click="handleBatchDownloadCovers"
              :disabled="isGuest"
              class="right-btn"
              style="height: 28px;"
            >
              <template #icon><NativeIcon name="download" /></template>
              批量下载封面
            </NativeButton>
            <NativeButton
              variant="outline"
              size="small"
              :loading="testingResources"
              @click="testResourceSites"
              class="test-resources-btn right-btn"
              :disabled="isGuest"
              style="height: 28px;"
            >
              <template #icon><NativeIcon name="link-break" /></template>
              测试资源站点
            </NativeButton>
          </div>
        </div>
      </template>
      <NativeTable
        :dataSource="animeList"
        :columns="tableColumns"
        :loading="loading"
        rowKey="id"
        hover
        v-model:sortKey="tableSortKey"
        v-model:sortOrder="tableSortOrder"
        @sortChange="handleSortChange"
      >
        <template #cell-coverImage="{ row }">
          <div class="cover-wrapper" :ref="el => { if (el) observeCover(el, row) }">
            <img
              v-if="coverCache[row.id]"
              :src="coverCache[row.id]"
              class="cover-image"
              @error="handleImageError"
            />
            <div v-else class="cover-placeholder">
              <NativeIcon name="image" size="24" />
            </div>
          </div>
        </template>
        <template #cell-title="{ row }">
          <div class="table-title">
            <span class="main-title" :title="row.name_cn || row.title">{{ row.name_cn || row.title }}</span>
            <span v-if="row.title && row.name_cn && row.title !== row.name_cn" class="sub-title" :title="row.title">{{ row.title }}</span>
            <span v-else-if="row.name_original && row.name_original !== (row.name_cn || row.title)" class="sub-title" :title="row.name_original">{{ row.name_original }}</span>
          </div>
        </template>
        <template #cell-year="{ row }">
          <span class="year-cell">{{ row.air_date?.substring(0, 4) || '-' }}</span>
        </template>
        <template #cell-rating="{ row }">
          <div class="rating-cell">
            <span class="score">{{ row.rating?.toFixed(1) || '-' }}</span>
            <span class="count" v-if="row.rating_count">({{ row.rating_count }})</span>
          </div>
        </template>
        <template #cell-userRating="{ row }">
          <div class="user-rating-cell">
            <NativeRate
              :modelValue="row.user_rating ? row.user_rating / 2 : 0"
              :count="5"
              allow-half
              size="small"
              :disabled="isGuest"
              @change="(val) => !isGuest && updateUserRating(row, val * 2)"
            />
          </div>
        </template>
        <template #cell-status="{ row }">
          <NativeDropdown
            v-if="!isGuest"
            trigger="hover"
            :options="[
              { value: 'none', label: '未标记' },
              { value: 'want_to_watch', label: '想看' },
              { value: 'watching', label: '在看' },
              { value: 'watched', label: '看过' }
            ]"
            @command="(val) => updateStatus(row, val)"
          >
            <NativeTag v-if="row.status === 'want_to_watch'" theme="warning" variant="light" style="cursor: pointer;">想看</NativeTag>
            <NativeTag v-else-if="row.status === 'watching'" theme="primary" variant="light" style="cursor: pointer;">在看</NativeTag>
            <NativeTag v-else-if="row.status === 'watched'" theme="success" variant="light" style="cursor: pointer;">看过</NativeTag>
            <NativeTag v-else theme="default" variant="light" style="cursor: pointer;">未标记</NativeTag>
          </NativeDropdown>
          <NativeTag v-else-if="row.status === 'want_to_watch'" theme="warning" variant="light">想看</NativeTag>
          <NativeTag v-else-if="row.status === 'watching'" theme="primary" variant="light">在看</NativeTag>
          <NativeTag v-else-if="row.status === 'watched'" theme="success" variant="light">看过</NativeTag>
          <NativeTag v-else theme="default" variant="light">未标记</NativeTag>
        </template>
        <template #cell-isFavorite="{ row }">
          <span class="favorite-icon" @click.stop="!isGuest && toggleFavorite(row)">
            <NativeIcon v-if="row.is_favorite || row.isFavorite" name="heart-fill" size="16" :style="{ color: '#e34d59', cursor: isGuest ? 'not-allowed' : 'pointer' }" />
            <NativeIcon v-else name="heart" size="16" :style="{ color: '#bbb', cursor: isGuest ? 'not-allowed' : 'pointer' }" />
          </span>
        </template>
        <template #cell-operation="{ row }">
          <div class="operation-btns">
            <NativeButton size="small" variant="text" iconSize="1.2em" @click.stop="showLocalDetail(row)" class="anime-op-btn">
              <template #icon><NativeIcon name="list-dashes" size="18" weight="bold" /></template>
            </NativeButton>
            <NativeButton 
              size="small" 
              variant="text"
              iconSize="1.2em"
              :theme="row.is_hidden ? 'warning' : 'default'"
              @click.stop="handleToggleHidden(row)"
              :title="row.is_hidden ? '取消隐藏' : '隐藏'"
              v-if="!isGuest"
              class="anime-op-btn"
            >
              <template #icon><NativeIcon :name="row.is_hidden ? 'eye-slash' : 'eye'" size="18" weight="bold" /></template>
            </NativeButton>
            <NativePopconfirm content="确定删除吗？" @confirm="handleDelete(row.id)" v-if="!isGuest">
              <template #trigger>
                <NativeButton theme="danger" size="small" variant="text" iconSize="1.2em" @click.stop class="anime-op-btn">
                  <template #icon><NativeIcon name="trash" size="18" weight="bold" /></template>
                </NativeButton>
              </template>
            </NativePopconfirm>
          </div>
        </template>
      </NativeTable>
      <div class="pagination-wrapper">
        <NativePagination
          :current="pagination.current"
          :page-size="pagination.pageSize"
          :total="pagination.total"
          :page-size-options="[15, 20, 30, 50]"
          @change="handlePageChange"
          @page-size-change="handlePageSizeChange"
        />
      </div>
    </NativeCard>

    <!-- 动漫详情对话框 -->
    <AnimeDetailDialog
      v-model="detailVisible"
      :bangumi-id="selectedBangumiId"
      :anime-data="selectedAnime"
      @imported="loadAnime"
      @updated="loadAnime"
      @deleted="loadAnime"
      @openRelation="handleOpenRelation"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onActivated, onUnmounted, watch } from 'vue'
import api from '@/api'
import AnimeDetailDialog from '@/components/AnimeDetailDialog.vue'
import AnimeMobile from '@/mobile/pages/AnimeMobile.vue'
import { initAnimeCoverDB, getAnimeCoverFromCache, saveAnimeCoverToCache } from '@/utils/animeCoverCache'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeCheckbox, NativeSelect, NativeTag, NativePagination, NativeIcon, NativeTable, NativeRate, NativeDropdown, NativePopconfirm } from '@/components/native'
import { useToast } from '@/composables/useToast'

// 移动端判断
const getIsMobile = () => {
  if (typeof window === 'undefined') return false
  return window.innerWidth <= 768
}
const isMobile = ref(getIsMobile())
const checkMobile = () => { isMobile.value = getIsMobile() }
onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})
onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})

const toast = useToast()
const { isGuest } = usePermission()

const loading = ref(false)
const searching = ref(false)
const animeList = ref([])
const allBangumiIds = ref(new Set()) // 存储所有的 Bangumi ID，用于判断搜索结果是否已在库中
const searchResults = ref([])
const searchKeyword = ref('')

// 封面缓存（使用 IndexedDB 持久化）
const coverCache = ref({})
const coverLoadingSet = new Set()
let coverObserver = null

// 初始化封面缓存
async function initCoverCache() {
  try {
    await initAnimeCoverDB()
    console.log('[动漫封面缓存] IndexedDB 初始化完成')
  } catch (e) {
    console.error('[动漫封面缓存] 初始化失败:', e)
  }

  // 创建 IntersectionObserver 用于懒加载
  coverObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const animeData = entry.target.__anime__
        if (animeData && !coverCache.value[animeData.id] && !coverLoadingSet.has(animeData.id)) {
          loadCover(animeData.id)
        }
        coverObserver.unobserve(entry.target)
      }
    })
  }, { rootMargin: '50px' })
}

// 观察封面元素（懒加载）
function observeCover(el, anime) {
  if (!coverObserver) return
  el.__anime__ = anime
  if (!coverCache.value[anime.id]) {
    coverObserver.observe(el)
  }
}

// 加载封面（使用 IndexedDB 缓存）
async function loadCover(id) {
  if (coverLoadingSet.has(id) || coverCache.value[id]) return

  coverLoadingSet.add(id)
  try {
    // 先从 IndexedDB 缓存读取
    const cached = await getAnimeCoverFromCache(id)
    if (cached) {
      coverCache.value[id] = cached
      return
    }
    
    // 缓存未命中，从服务器获取
    const response = await api.anime.getCover(id)
    const cover = response.data.cover || response.data.coverUrl
    if (cover) {
      coverCache.value[id] = cover
      // 如果是base64数据，保存到 IndexedDB 缓存
      if (response.data.cover) {
        await saveAnimeCoverToCache(id, cover)
      }
    }
  } catch (error) {
    console.error('[动漫封面] 加载失败:', error)
  } finally {
    coverLoadingSet.delete(id)
  }
}
const searchTag = ref('')
const filterStatus = ref('')
const filterFavorite = ref(false)
const downloadingCovers = ref(false)
const testingResources = ref(false)
const resourceTestResults = ref(null)
const showResourceTestDialog = ref(false)
const resourceSearchMode = ref(localStorage.getItem('resourceSearchMode') || 'sequential') // 资源搜索模式（默认顺序优先）
const pagination = ref({ current: 1, pageSize: 15, total: 0 })
const searchPagination = ref({ current: 1, pageSize: 20, total: 0 })  // 搜索结果分页（默认20条，匹配后端）

// Bangumi Token 状态
const tokenStatus = ref(null)

// 详情对话框
const detailVisible = ref(false)
const selectedBangumiId = ref(null)
const selectedAnime = ref(null)

const tableColumns = computed(() => {
  // 不设置 width，完全由 CSS 控制列宽
  const baseColumns = [
    { key: 'coverImage', title: '封面', align: 'left' },
    { key: 'title', title: '标题', align: 'left' },
    { key: 'year', title: '年份', align: 'left', sorter: true },
    { key: 'rating', title: '评分', align: 'left', sorter: true },
    { key: 'userRating', title: '我的评分', align: 'left', sorter: true },
    { key: 'status', title: '状态', align: 'left', sorter: true },
    { key: 'isFavorite', title: '♥', align: 'center' }
  ]

  // 游客模式下操作列宽度更小
  if (isGuest.value) {
    baseColumns.push({ key: 'operation', title: '操作', align: 'left' })
  } else {
    baseColumns.push({ key: 'operation', title: '操作', align: 'left' })
  }

  return baseColumns
})

// 排序相关
const sortBy = ref('updated_at')
const sortOrder = ref('DESC')
const tableSortKey = ref('')
const tableSortOrder = ref('')

// 字段映射：列 key -> 后端字段名
const sortFieldMap = {
  'year': 'air_date',
  'rating': 'rating',
  'userRating': 'user_rating',
  'status': 'status'
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'DESC' ? 'ASC' : 'DESC'
  pagination.value.current = 1
  loadAnime()
}

// 下拉栏排序改变时
function handleSortByChange() {
  pagination.value.current = 1
  loadAnime()
}

// 处理表头排序变化 (NativeTable)
function handleSortChange(context) {
  console.log('[表头排序] 参数:', context)

  // NativeTable 返回 { sortBy, descending }
  if (!context || !context.sortBy) {
    console.log('[表头排序] 取消排序，恢复默认排序')
    // 取消排序时，恢复默认排序（更新时间降序）
    sortBy.value = 'updated_at'
    sortOrder.value = 'DESC'
    tableSortKey.value = ''
    tableSortOrder.value = ''
    pagination.value.current = 1
    loadAnime()
    return
  }

  const field = sortFieldMap[context.sortBy] || context.sortBy
  if (!field) return

  sortBy.value = field
  sortOrder.value = context.descending ? 'DESC' : 'ASC'
  // 同步更新 tableSortKey 和 tableSortOrder
  tableSortKey.value = context.sortBy
  tableSortOrder.value = context.descending ? 'desc' : 'asc'
  pagination.value.current = 1
  loadAnime()
}

// 筛选改变时重置分页
function handleFilterChange() {
  pagination.value.current = 1
  loadAnime()
}

// 分页处理
function handlePageChange(pageInfo) {
  pagination.value.current = pageInfo.current
  loadAnime()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange(pageSize) {
  pagination.value.pageSize = pageSize
  pagination.value.current = 1
  loadAnime()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 图片加载失败处理
function handleImageError(e) {
  e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI4MCIgdmlld0JveD0iMCAwIDYwIDgwIj48cmVjdCB3aWR0aD0iNjAiIGhlaWdodD0iODAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIzMCIgeT0iNDAiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7ml6Dlm77niYc8L3RleHQ+PC9zdmc+'
}

async function loadAnime() {
  loading.value = true
  try {
    const response = await api.anime.list({
      status: filterStatus.value,
      favorite: filterFavorite.value ? 'true' : undefined,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize,
      hideHidden: isGuest.value ? 'true' : undefined // 游客模式下隐藏已标记为隐藏的动画
    })
    animeList.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    toast.error('加载动漫失败')
  } finally {
    loading.value = false
  }
}

// 检查动漫是否已在库中
function isInLibrary(bangumiId) {
  return allBangumiIds.value.has(bangumiId)
}

// 加载所有 Bangumi ID
async function loadAllBangumiIds() {
  try {
    const response = await api.anime.getAllBangumiIds()
    allBangumiIds.value = new Set(response.data.data || [])
  } catch (error) {
    console.error('加载Bangumi ID列表失败:', error)
  }
}

// 搜索动漫（带分页）
async function handleSearch(page = 1) {
  if (!searchKeyword.value.trim() && !searchTag.value.trim()) {
    searchResults.value = []
    searchPagination.value.total = 0
    return
  }

    searching.value = true
    try {
      const response = await api.anime.search(searchKeyword.value, searchTag.value, page)
      searchResults.value = response.data.data || []
      // 限制最多显示5页（100条）
      const maxTotal = 100
      searchPagination.value.total = Math.min(response.data.total || 0, maxTotal)
      searchPagination.value.current = page
  } catch (error) {
    // 检查是否是Token失效错误
    if (error.response?.status === 401 || error.response?.data?.tokenExpired) {
      toast.warning('Bangumi Token已失效，请重新配置')
      // 刷新Token状态
      getTokenStatus()
    } else {
      toast.error('搜索失败')
    }
  } finally {
    searching.value = false
  }
}

// 搜索结果分页改变
function handleSearchPageChange(pageInfo) {
  handleSearch(pageInfo.current)
}

function handleSearchPageSizeChange(pageSize) {
  searchPagination.value.pageSize = pageSize
  searchPagination.value.current = 1
  handleSearch(1)
}

// 清空搜索结果
function clearSearchResults() {
  searchResults.value = []
  searchKeyword.value = ''
  searchTag.value = ''
  searchPagination.value = { current: 1, pageSize: 20, total: 0 }
}

async function handleImport(anime) {
  anime.importing = true
  try {
    // 传递完整的搜索结果数据，避免后端再次调用 API
    await api.anime.import(anime.id, {
      id: anime.id,
      name: anime.name,
      name_cn: anime.name_cn,
      images: anime.images,
      rating: anime.rating,
      rating_count: anime.rating_count,
      summary: anime.summary,
      tags: anime.tags,
      date: anime.air_date || anime.date,
      eps: anime.eps,
      eps_count: anime.eps_total,
      author: anime.author,
      director: anime.director,
      studio: anime.studio,
      infobox: anime.infobox
    })
    toast.success('添加成功')
    // 刷新动漫列表和 Bangumi ID 列表（确保搜索结果按钮状态更新）
    loadAnime()
    loadAllBangumiIds()
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
  } finally {
    anime.importing = false
  }
}

// 显示详情（搜索结果）- 直接使用搜索结果数据，不再调用 API
function showDetail(anime) {
  selectedBangumiId.value = anime.id
  // 将搜索结果转换为对话框需要的格式（不设置 bangumi_id，因为这是搜索结果不是本地数据）
  selectedAnime.value = {
    id: anime.id,
    // 注意：不设置 bangumi_id，让 AnimeDetailDialog 通过 API 检查是否已在库中
    title: anime.name,
    name_cn: anime.name_cn,
    name_original: anime.name,
    cover_image: anime.images?.large || anime.images?.common,
    rating: anime.rating?.score || anime.rating,
    rating_count: anime.rating_count || anime.rating?.total || 0,
    summary: anime.summary,
    tags: anime.tags?.map(t => t.name).join(',') || anime.tags,
    air_date: anime.air_date || anime.date,
    eps: anime.eps,
    eps_total: anime.eps_total,
    author: anime.author,
    director: anime.director,
    studio: anime.studio,
    characters: anime.characters || [],
    staff: anime.staff || [],
    infobox: anime.infobox
  }
  detailVisible.value = true
}

// 显示详情（本地收藏）- TDesign row-click 参数是 { row, index, e }
function showLocalDetail(context) {
  const row = context?.row || context
  if (!row) return
  selectedBangumiId.value = row.bangumi_id
  selectedAnime.value = row
  detailVisible.value = true
}

// 处理关联作品点击
function handleOpenRelation(data) {
  selectedBangumiId.value = data.bangumiId
  selectedAnime.value = data.animeData
  // 延迟打开，确保当前对话框已关闭
  setTimeout(() => {
    detailVisible.value = true
  }, 100)
}

async function updateStatus(row, status) {
  try {
    await api.anime.updateStatus(row.id, status)
    // 立即更新本地数据，确保响应式更新
    const index = animeList.value.findIndex(item => item.id === row.id)
    if (index !== -1) {
      animeList.value[index].status = status
    }
    toast.success('更新成功')
  } catch (error) {
    toast.error('更新失败')
  }
}

async function updateUserRating(row, rating) {
  try {
    await api.anime.updateRating(row.id, rating)
    // 立即更新本地数据，确保响应式更新
    const index = animeList.value.findIndex(item => item.id === row.id)
    if (index !== -1) {
      animeList.value[index].user_rating = rating
    }
    toast.success('评分成功')
  } catch (error) {
    toast.error('评分失败')
  }
}

async function toggleFavorite(row) {
  try {
    await api.anime.toggleFavorite(row.id)
    // 立即更新本地数据，确保响应式更新
    const index = animeList.value.findIndex(item => item.id === row.id)
    if (index !== -1) {
      animeList.value[index].is_favorite = !animeList.value[index].is_favorite
      row.isFavorite = animeList.value[index].is_favorite
    }
    toast.success(row.is_favorite ? '已收藏' : '已取消收藏')
  } catch (error) {
    toast.error('操作失败')
  }
}

async function handleDelete(id) {
  try {
    await api.anime.delete(id)
    toast.success('删除成功')
    loadAnime()
  } catch (error) {
    toast.error('删除失败')
  }
}

// 切换动漫隐藏状态
async function handleToggleHidden(row) {
  try {
    const response = await api.anime.toggleHidden(row.id)
    toast.success(response.data.message)
    // 更新本地状态
    row.is_hidden = response.data.is_hidden
    // 重新加载列表以保持一致性
    loadAnime()
  } catch (error) {
    toast.error('操作失败')
  }
}

// 批量下载封面
async function handleBatchDownloadCovers() {
  downloadingCovers.value = true
  try {
    const response = await api.anime.batchDownloadCovers()
    toast.success(response.data.message)
    loadAnime() // 刷新列表以显示新封面
  } catch (error) {
    toast.error('批量下载封面失败')
  } finally {
    downloadingCovers.value = false
  }
}

// 测试资源站点连通性
async function testResourceSites() {
  testingResources.value = true
  try {
    const response = await api.anime.testResources()
    resourceTestResults.value = response.data
    showResourceTestDialog.value = true
    
    const successCount = response.data.summary.success
    const failedCount = response.data.summary.total - successCount
    
    if (failedCount === 0) {
      toast.success(`所有站点连接正常 (${successCount}/${response.data.summary.total})`)
    } else {
      toast.warning(`${successCount} 个站点正常，${failedCount} 个站点失败`)
    }
  } catch (error) {
    toast.error('测试资源站点失败')
    console.error(error)
  } finally {
    testingResources.value = false
  }
}

// HTTP 转 HTTPS
function toHttps(url) {
  if (!url) return url
  return url.replace(/^http:\/\//, 'https://')
}

// 获取Bangumi Token状态
async function getTokenStatus() {
  try {
    const response = await api.anime.getTokenStatus()
    tokenStatus.value = response.data
  } catch (error) {
    console.error('获取Token状态失败:', error)
  }
}

// 打开Bangumi Token配置页面
function openTokenPage() {
  window.open('https://next.bgm.tv/demo/access-token', '_blank')
}

// 监听搜索模式配置变化，保存到 localStorage
watch(resourceSearchMode, (newMode) => {
  localStorage.setItem('resourceSearchMode', newMode)
})

// 组件首次加载
onMounted(async () => {
  await initCoverCache() // 初始化封面缓存（IndexedDB）
  loadAnime()
  loadAllBangumiIds() // 加载所有 Bangumi ID
  getTokenStatus()
})

// 组件激活时（从缓存中恢复）
onActivated(() => {
  loadAnime()
  loadAllBangumiIds() // 刷新 Bangumi ID 列表
})

// 组件卸载时清理
onUnmounted(() => {
  if (coverObserver) {
    coverObserver.disconnect()
  }
})
</script>

<style scoped>
.anime {
  padding: 0;
}

/* Token 提醒 */
.token-alert {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 搜索栏样式 */
.search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 垂直分隔线 */
.divider-vertical {
  width: 1px;
  height: 24px;
  background: #e0e0e0;
}

/* 操作按钮组 */
.operation-btns {
  display: flex;
  gap: 4px;
}

.operation-btns .anime-op-btn {
  width: 32px;
  height: 32px;
  padding: 0;
}

/* 卡片标题行样式 */
.card-title-row {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  width: 100%;
  padding-right: 16px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  flex-shrink: 0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 20px;  /* 与标题间隔20px */
  flex-shrink: 0;
  flex: 1;  /* 占据剩余空间 */
}

/* 左侧筛选组 */
.filter-bar > *:not(.test-resources-btn):not([variant="outline"][size="small"]) {
  flex-shrink: 0;
}

/* 右侧按钮组靠右对齐 */
.filter-bar .test-resources-btn,
.filter-bar > [variant="outline"][size="small"]:not(.anime-op-btn) {
  margin-left: auto;
}

/* 批量下载和测试资源站点按钮靠右 */
.filter-bar > .native-button[variant="outline"][size="small"]:nth-last-child(-n+2) {
  margin-left: 0;
}

/* 调整复选框对齐 */
.filter-bar :deep(.native-checkbox) {
  margin-top: 2px;
}

/* 覆盖 TDesign 卡片标题样式 */
:deep(.native-card__header) {
  width: 100%;
}

:deep(.native-card__title) {
  width: 100%;
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

/* 搜索结果卡片 */
.search-result-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.search-card {
  display: flex;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s;
}

.search-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  border-color: #0052d9;
}

.cover-wrapper {
  position: relative;
  flex-shrink: 0;
  width: 120px;
  height: 168px;
}

.cover-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.rating-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 4px 8px;
  border-radius: 4px;
  text-align: center;
}

.rating-badge .score {
  display: block;
  font-size: 16px;
  font-weight: bold;
  color: #fbbf24;
}

.rating-badge .count {
  display: block;
  font-size: 10px;
  opacity: 0.8;
}

.card-content {
  flex: 1;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.title-row {
  min-height: 40px;
}

.title-cn {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title-original {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: normal;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-info {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #666;
}

.staff-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.staff-item {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.staff-label {
  color: #999;
}

.staff-value {
  color: #666;
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.more-tags {
  font-size: 12px;
  color: #999;
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

/* 我的动漫库表格 */
.cover-image {
  width: 50px;
  height: 70px;
  object-fit: cover;
  border-radius: 4px;
}

/* 表格封面容器 */
.anime .native-table .cover-wrapper {
  width: 50px;
  height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-placeholder {
  width: 50px;
  height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
  border-radius: 4px;
  color: #bbb;
}

.table-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

/* NativeTable 列间距调整 - 所有列固定宽度 */
.anime :deep(.native-table) {
  table-layout: fixed !important;
  width: 100% !important;
}

/* 第一列：封面 */
.anime :deep(.native-table > thead > tr > th:first-child),
.anime :deep(.native-table > tbody > tr > td:first-child) {
  width: 58px !important;
  min-width: 58px !important;
  max-width: 58px !important;
  padding: 12px 4px 12px 12px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}

/* 第二列：标题 - 自适应剩余空间 */
.anime :deep(.native-table > thead > tr > th:nth-child(2)),
.anime :deep(.native-table > tbody > tr > td:nth-child(2)) {
  width: auto !important;
  min-width: 200px !important;
  padding-left: 8px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}

/* 第三列：年份 */
.anime :deep(.native-table > thead > tr > th:nth-child(3)),
.anime :deep(.native-table > tbody > tr > td:nth-child(3)) {
  width: 100px !important;
  min-width: 100px !important;
  max-width: 100px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  text-align: center !important;
}

/* 第四列：评分 */
.anime :deep(.native-table > thead > tr > th:nth-child(4)),
.anime :deep(.native-table > tbody > tr > td:nth-child(4)) {
  width: 130px !important;
  min-width: 130px !important;
  max-width: 130px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  text-align: center !important;
}

/* 第五列：我的评分 */
.anime :deep(.native-table > thead > tr > th:nth-child(5)),
.anime :deep(.native-table > tbody > tr > td:nth-child(5)) {
  width: 150px !important;
  min-width: 150px !important;
  max-width: 150px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  text-align: center !important;
}

/* 第六列：状态 */
.anime :deep(.native-table > thead > tr > th:nth-child(6)),
.anime :deep(.native-table > tbody > tr > td:nth-child(6)) {
  width: 100px !important;
  min-width: 100px !important;
  max-width: 100px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  text-align: center !important;
}

/* 第七列：收藏 - 居中，与状态、操作保持等距 */
.anime :deep(.native-table > thead > tr > th:nth-child(7)),
.anime :deep(.native-table > tbody > tr > td:nth-child(7)) {
  width: 80px !important;
  min-width: 80px !important;
  max-width: 80px !important;
  padding: 12px 8px !important;
  text-align: center !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}

/* 第八列：操作 */
.anime :deep(.native-table > thead > tr > th:nth-child(8)),
.anime :deep(.native-table > tbody > tr > td:nth-child(8)) {
  width: 160px !important;
  min-width: 160px !important;
  max-width: 180px !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}

/* 封面图片容器 */
.anime :deep(.native-table > tbody > tr > td:first-child .cover-wrapper) {
  width: 42px !important;
  height: 58px !important;
  margin: 0 auto !important;
}

.main-title {
  font-weight: 500;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-title {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 28px 高度的下拉框 - 使用深度选择器覆盖 */
.filter-select-24 :deep(.native-select__trigger) {
  height: 28px !important;
  min-height: 28px !important;
  padding: 4px 8px !important;
  font-size: 13px !important;
}

/* filter-bar 中的所有按钮统一 28px 高度 */
.filter-bar :deep(.native-button),
.filter-bar :deep(.native-button--small) {
  height: 28px !important;
  min-height: 28px !important;
  padding: 4px 12px !important;
  font-size: 13px !important;
}

.rating-cell {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
}

.rating-cell .score {
  font-weight: 600;
  color: #fbbf24;
}

.rating-cell .count {
  font-size: 12px;
  color: #999;
}

.year-cell {
  font-size: 14px;
  color: #666;
  white-space: nowrap;
  display: inline-block;
}

/* 可排序列样式 */
:deep(.sortable-col) {
  cursor: pointer;
}

:deep(.sortable-col:hover) {
  background-color: rgba(0, 82, 217, 0.05);
}

/* 确保表头单元格允许点击 */
.native-table th {
  user-select: none;
}

/* 搜索结果分页 */
.search-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

/* NativeTooltip 样式 */
.native-tooltip {
  color: #fff;
  background-color: rgba(0, 0, 0, 0.85);
}

/* 测试资源站点按钮图标颜色 */
.test-resources-btn:not(:disabled) {
  color: #333 !important;
}

.test-resources-btn:not(:disabled) .native-icon {
  color: #333 !important;
}

/* 收藏图标强制缩小 */
.favorite-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.favorite-icon .native-icon {
  width: 14px !important;
  height: 14px !important;
  min-width: 14px !important;
  min-height: 14px !important;
}
</style>
