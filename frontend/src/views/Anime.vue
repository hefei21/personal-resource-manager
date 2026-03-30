<template>
  <div class="anime">
    <div class="page-header">
      <p>管理和收藏动漫剧集</p>
    </div>

    <!-- Bangumi Token 失效提醒 -->
    <t-card v-if="tokenStatus && tokenStatus.hasToken && !tokenStatus.isValid" theme="warning" style="margin-bottom: 16px">
      <t-space align="center">
        <t-icon name="error-circle" size="18px" />
        <span>{{ tokenStatus.message }}</span>
        <t-button
          size="small"
          theme="primary"
          @click="openTokenPage"
        >
          更新 Token
        </t-button>
      </t-space>
    </t-card>

    <t-card>
      <t-space>
        <t-input
          v-model="searchKeyword"
          placeholder="搜索 Bangumi..."
          style="width: 300px"
          @enter="handleSearch"
        >
          <template #suffix-icon>
            <t-icon name="search" />
          </template>
        </t-input>
        <t-input
          v-model="searchTag"
          placeholder="标签（如：恋爱、奇幻）"
          style="width: 180px"
          @enter="handleSearch"
          clearable
        >
          <template #suffix-icon>
            <t-icon name="discount" />
          </template>
        </t-input>
        <t-button @click="handleSearch" :loading="searching">搜索</t-button>
      </t-space>
    </t-card>

    <!-- Bangumi 搜索结果 -->
    <t-card v-if="searchResults.length > 0" title="搜索结果" style="margin-top: 16px">
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
              <h5 class="title-original" v-if="anime.name && anime.name_cn && anime.name !== anime.name_cn" :title="anime.name">
                {{ anime.name }}
              </h5>
            </div>
            <div class="meta-info">
              <div class="meta-row" v-if="anime.air_date">
                <t-icon name="calendar" size="14px" />
                <span>{{ anime.air_date }}</span>
              </div>
              <div class="meta-row" v-if="anime.eps || anime.eps_total">
                <t-icon name="video" size="14px" />
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
              <t-tag
                v-for="tag in anime.tags.slice(0, 4)"
                :key="tag"
                size="small"
                theme="primary"
                variant="light"
              >
                {{ tag.name || tag }}
              </t-tag>
              <span v-if="anime.tags.length > 4" class="more-tags">+{{ anime.tags.length - 4 }}</span>
            </div>
            <div class="card-actions">
              <t-button
                size="small"
                :disabled="isInLibrary(anime.id)"
                :theme="isInLibrary(anime.id) ? 'default' : 'primary'"
                @click.stop="handleImport(anime)"
                :loading="anime.importing"
              >
                <template #icon><t-icon :name="isInLibrary(anime.id) ? 'check' : 'add'" /></template>
                {{ isInLibrary(anime.id) ? '已添加' : '添加' }}
              </t-button>
              <t-button size="small" variant="outline" @click.stop="showDetail(anime)">
                <template #icon><t-icon name="view-list" /></template>
                详情
              </t-button>
            </div>
          </div>
        </div>
      </div>
      <!-- 搜索结果分页 -->
      <div class="search-pagination" v-if="searchPagination.total > 0">
        <t-pagination
          v-model="searchPagination.current"
          :page-size="searchPagination.pageSize"
          :total="searchPagination.total"
          show-page-number
          @change="handleSearchPageChange"
        />
      </div>
    </t-card>

    <!-- 我的动漫库 -->
    <t-card style="margin-top: 16px">
      <template #title>
        <div class="card-title-row">
          <span class="card-title">我的动漫库</span>
          <t-space class="filter-bar">
            <t-select v-model="filterStatus" placeholder="状态筛选" style="width: 120px" clearable @change="handleFilterChange">
              <t-option value="" label="全部" />
              <t-option value="none" label="未标记" />
              <t-option value="watching" label="想看" />
              <t-option value="watched" label="看过" />
            </t-select>
            <t-checkbox v-model="filterFavorite" @change="handleFilterChange">只看收藏</t-checkbox>
            <t-divider layout="vertical" />
            <t-select v-model="sortBy" placeholder="排序" style="width: 120px" @change="handleSortByChange">
              <t-option value="updated_at" label="更新时间" />
              <t-option value="air_date" label="上映日期" />
              <t-option value="rating" label="总评分" />
              <t-option value="user_rating" label="我的评分" />
              <t-option value="status" label="标记状态" />
            </t-select>
            <t-button
              :variant="sortOrder === 'DESC' ? 'base' : 'outline'"
              size="small"
              @click="toggleSortOrder"
            >
              <template #icon><t-icon :name="sortOrder === 'DESC' ? 'arrow-down' : 'arrow-up'" /></template>
              {{ sortOrder === 'DESC' ? '降序' : '升序' }}
            </t-button>
            <t-divider layout="vertical" />
            <t-button
              variant="outline"
              size="small"
              :loading="downloadingCovers"
              @click="handleBatchDownloadCovers"
            >
              <template #icon><t-icon name="download" /></template>
              批量下载封面
            </t-button>
          </t-space>
        </div>
      </template>
      <t-table
        :data="animeList"
        :columns="tableColumns"
        :loading="loading"
        row-key="id"
        hover
        :sort="tableSort"
        @sort-change="handleSortChange"
      >
        <template #coverImage="{ row }">
          <div class="cover-wrapper" :ref="el => { if (el) observeCover(el, row) }">
            <img
              v-if="coverCache[row.id]"
              :src="coverCache[row.id]"
              class="cover-image"
              @error="handleImageError"
            />
            <div v-else class="cover-placeholder">
              <t-icon name="image" size="24px" />
            </div>
          </div>
        </template>
        <template #title="{ row }">
          <div class="table-title">
            <span class="main-title">{{ row.title }}</span>
            <span class="sub-title" v-if="row.name_cn && row.name_cn !== row.title">{{ row.name_cn }}</span>
          </div>
        </template>
        <template #year="{ row }">
          <span class="year-cell">{{ row.air_date?.substring(0, 4) || '-' }}</span>
        </template>
        <template #rating="{ row }">
          <div class="rating-cell">
            <span class="score">{{ row.rating?.toFixed(1) || '-' }}</span>
            <span class="count" v-if="row.rating_count">({{ row.rating_count }})</span>
          </div>
        </template>
        <template #userRating="{ row }">
          <div class="user-rating-cell">
            <t-rate
              :value="row.user_rating ? row.user_rating / 2 : 0"
              :count="5"
              allow-half
              size="small"
              @change="(val) => updateUserRating(row, val * 2)"
            />
          </div>
        </template>
        <template #status="{ row }">
          <t-dropdown trigger="hover">
            <t-tag v-if="row.status === 'watching'" theme="primary" variant="light" style="cursor: pointer;">想看</t-tag>
            <t-tag v-else-if="row.status === 'watched'" theme="success" variant="light" style="cursor: pointer;">看过</t-tag>
            <t-tag v-else theme="default" variant="light" style="cursor: pointer;">未标记</t-tag>
            <t-dropdown-menu>
              <t-dropdown-item @click="updateStatus(row, 'none')">未标记</t-dropdown-item>
              <t-dropdown-item @click="updateStatus(row, 'watching')">想看</t-dropdown-item>
              <t-dropdown-item @click="updateStatus(row, 'watched')">看过</t-dropdown-item>
            </t-dropdown-menu>
          </t-dropdown>
        </template>
        <template #isFavorite="{ row }">
          <span class="favorite-icon" @click.stop="toggleFavorite(row)">
            <t-icon v-if="row.is_favorite || row.isFavorite" name="heart-filled" style="color: #e34d59; cursor: pointer;" />
            <t-icon v-else name="heart" style="color: #bbb; cursor: pointer;" />
          </span>
        </template>
        <template #operation="{ row }">
          <t-space size="small">
            <t-button size="small" variant="text" @click.stop="showLocalDetail({ row })">
              <t-icon name="view-list" />
            </t-button>
            <t-popconfirm content="确定删除吗？" @confirm="handleDelete(row.id)">
              <t-button theme="danger" size="small" variant="text" @click.stop>
                <t-icon name="delete" />
              </t-button>
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
import { ref, computed, onMounted, onActivated, onUnmounted } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'
import AnimeDetailDialog from '@/components/AnimeDetailDialog.vue'
import { initAnimeCoverDB, getAnimeCoverFromCache, saveAnimeCoverToCache } from '@/utils/animeCoverCache'

const loading = ref(false)
const searching = ref(false)
const animeList = ref([])
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
const pagination = ref({ current: 1, pageSize: 15, total: 0 })
const searchPagination = ref({ current: 1, pageSize: 20, total: 0 })  // 搜索结果分页（匹配 Bangumi API 限制）

// Bangumi Token 状态
const tokenStatus = ref(null)

// 详情对话框
const detailVisible = ref(false)
const selectedBangumiId = ref(null)
const selectedAnime = ref(null)

const tableColumns = computed(() => [
  { colKey: 'coverImage', title: '封面', width: 60, align: 'center' },
  { colKey: 'title', title: '标题', ellipsis: true, minWidth: 200 },
  { colKey: 'year', title: '年份', width: 85, align: 'center', sorter: true },
  { colKey: 'rating', title: '评分', width: 100, align: 'left', sorter: true },
  { colKey: 'userRating', title: '我的评分', width: 130, align: 'left', sorter: true },
  { colKey: 'status', title: '状态', width: 95, align: 'center', sorter: true },
  { colKey: 'isFavorite', title: '♥', width: 50, align: 'center' },
  { colKey: 'operation', title: '操作', width: 95, align: 'center' }
])

// 排序相关

// 排序相关
const sortBy = ref('updated_at')
const sortOrder = ref('DESC')

// 字段映射：列 colKey -> 后端字段名
const sortFieldMap = {
  'year': 'air_date',
  'rating': 'rating',
  'userRating': 'user_rating',
  'status': 'status'
}

// 反向映射：后端字段名 -> 列 colKey
const sortColKeyMap = {
  'air_date': 'year',
  'rating': 'rating',
  'user_rating': 'userRating',
  'status': 'status'
}

// 计算表格排序状态（双向同步）
const tableSort = computed(() => {
  const colKey = sortColKeyMap[sortBy.value]
  if (!colKey) {
    // 下拉栏选择的是表头没有的字段（如 updated_at），清空表头高亮
    return null
  }
  return {
    sortBy: colKey,
    descending: sortOrder.value === 'DESC'
  }
})

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

// 处理表头排序变化
function handleSortChange(context) {
  console.log('[表头排序] 完整参数:', context)
  
  // TDesign 排序参数可能是：{ sort: {...} } 或直接是排序对象
  // 取消排序时可能是 undefined 或 { sortBy: undefined }
  const sort = context?.sort || context
  
  if (!sort || !sort.sortBy) {
    console.log('[表头排序] 取消排序，恢复默认排序')
    // 取消排序时，恢复默认排序（更新时间降序）
    sortBy.value = 'updated_at'
    sortOrder.value = 'DESC'
    pagination.value.current = 1
    loadAnime()
    return
  }

  const field = sortFieldMap[sort.sortBy] || sort.sortBy
  if (!field) return

  sortBy.value = field
  sortOrder.value = sort.descending ? 'DESC' : 'ASC'
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
      pageSize: pagination.value.pageSize
    })
    animeList.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    MessagePlugin.error('加载动漫失败')
  } finally {
    loading.value = false
  }
}

// 检查动漫是否已在库中
function isInLibrary(bangumiId) {
  return animeList.value.some(anime => anime.bangumi_id === bangumiId)
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
      MessagePlugin.warning('Bangumi Token已失效，请重新配置')
      // 刷新Token状态
      getTokenStatus()
    } else {
      MessagePlugin.error('搜索失败')
    }
  } finally {
    searching.value = false
  }
}

// 搜索结果分页改变
function handleSearchPageChange(pageInfo) {
  handleSearch(pageInfo.current)
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
    MessagePlugin.success('添加成功')
    loadAnime()
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '添加失败')
  } finally {
    anime.importing = false
  }
}

// 显示详情（搜索结果）- 直接使用搜索结果数据，不再调用 API
function showDetail(anime) {
  selectedBangumiId.value = anime.id
  // 将搜索结果转换为对话框需要的格式
  selectedAnime.value = {
    id: anime.id,
    bangumi_id: anime.id,
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
    row.status = status
    MessagePlugin.success('更新成功')
  } catch (error) {
    MessagePlugin.error('更新失败')
  }
}

async function updateUserRating(row, rating) {
  try {
    await api.anime.updateRating(row.id, rating)
    row.user_rating = rating
    MessagePlugin.success('评分成功')
  } catch (error) {
    MessagePlugin.error('评分失败')
  }
}

async function toggleFavorite(row) {
  try {
    await api.anime.toggleFavorite(row.id)
    row.is_favorite = !row.is_favorite
    row.isFavorite = row.is_favorite
    MessagePlugin.success(row.is_favorite ? '已收藏' : '已取消收藏')
  } catch (error) {
    MessagePlugin.error('操作失败')
  }
}

async function handleDelete(id) {
  try {
    await api.anime.delete(id)
    MessagePlugin.success('删除成功')
    loadAnime()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 批量下载封面
async function handleBatchDownloadCovers() {
  downloadingCovers.value = true
  try {
    const response = await api.anime.batchDownloadCovers()
    MessagePlugin.success(response.data.message)
    loadAnime() // 刷新列表以显示新封面
  } catch (error) {
    MessagePlugin.error('批量下载封面失败')
  } finally {
    downloadingCovers.value = false
  }
}

// HTTP 转 HTTPS
function toHttps(url) {
  if (!url) return url
  return url.replace(/^http:\/\//, 'https://')
}

// 获取封面图片URL（优先使用本地存储的base64数据）
function getCoverUrl(row) {
  if (row.cover_image_data) return row.cover_image_data
  return toHttps(row.cover_image) || toHttps(row.coverImage)
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

// 组件首次加载
onMounted(async () => {
  await initCoverCache() // 初始化封面缓存（IndexedDB）
  loadAnime()
  getTokenStatus()
})

// 组件激活时（从缓存中恢复）
onActivated(() => {
  loadAnime()
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
  margin-left: auto;
  flex-shrink: 0;
}

/* 调整复选框对齐 */
.filter-bar :deep(.t-checkbox) {
  margin-top: 2px;
}

/* 覆盖 TDesign 卡片标题样式 */
:deep(.t-card__header) {
  width: 100%;
}

:deep(.t-card__title) {
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
.anime .t-table .cover-wrapper {
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
}

.main-title {
  font-weight: 500;
  color: #333;
}

.sub-title {
  font-size: 12px;
  color: #999;
}

.rating-cell {
  display: flex;
  align-items: baseline;
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
::v-deep(.t-table-th) {
  user-select: none !important;
}

/* 搜索结果分页 */
.search-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}
</style>
