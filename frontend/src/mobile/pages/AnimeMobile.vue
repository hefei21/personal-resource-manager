<template>
  <div class="mobile-anime">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <button
        class="toolbar-btn"
        :class="{ active: showFilterDrawer }"
        @click="showFilterDrawer = !showFilterDrawer"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/></svg>
      </button>
    </div>

    <!-- 加载中 -->
    <ResourceListState
      v-if="(loading && animeList.length === 0) || loadError || animeList.length === 0"
      :state="loading ? 'loading' : loadError ? 'error' : 'empty'"
      loading-text="加载动漫中..."
      empty-text="还没有动漫数据"
      :error-text="loadError"
      @retry="loadAnime(false)"
    />

    <!-- 动漫库列表 -->
    <div v-else class="anime-list">
      <div
        v-for="anime in animeList"
        :key="anime.id"
        class="anime-card"
        @click="handleCardClick(anime)"
      >
        <!-- 左侧封面 -->
        <div class="cover-wrap" :ref="el => { if (el) observeCover(el, anime) }">
          <img v-if="coverCache[anime.id]" :src="coverCache[anime.id]" class="anime-cover" @error="handleImageError" />
          <div v-else class="cover-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#bbb" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          </div>
        </div>

        <!-- 右侧内容 -->
        <div class="anime-info">
          <!-- 顶部：标题块 -->
          <div class="title-block">
            <div class="title-row">
              <span class="anime-title" :title="anime.name_cn || anime.title">{{ anime.name_cn || anime.title }}</span>
              <span class="favorite-star" @click.stop="!isGuest && toggleFavorite(anime)">
                <svg v-if="anime.is_favorite || anime.isFavorite" width="18" height="18" viewBox="0 0 24 24" fill="#f5a623" stroke="#f5a623" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#bbb" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </span>
            </div>
            <div v-if="anime.name_original && anime.name_original !== (anime.name_cn || anime.title)" class="anime-original">
              {{ anime.name_original }}
            </div>
            <div v-else-if="anime.name && anime.name !== (anime.name_cn || anime.title)" class="anime-original">
              {{ anime.name }}
            </div>
          </div>
          <!-- 中部：日期 -->
          <div class="air-date">{{ anime.air_date || '-' }}</div>
          <!-- 底部：评分 -->
          <div class="rating-row">
            <div v-if="anime.user_rating" class="user-stars">
              <span v-for="i in 5" :key="i" class="star">
                <svg width="12" height="12" viewBox="0 0 24 24" class="star-empty">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <div class="star-fill" :style="{ width: getUserStarWidth(anime.user_rating, i) }">
                  <svg width="12" height="12" viewBox="0 0 24 24" class="star-full">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </div>
              </span>
            </div>
            <div v-else class="user-stars-placeholder"></div>
            <div class="total-rating">
              <span class="score">{{ anime.rating?.toFixed(1) || '-' }}</span>
              <span class="count" v-if="anime.rating_count">({{ anime.rating_count }}人)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 加载更多 -->
      <div v-if="isLoadingMore" class="load-more">
        <div class="spinner-small"></div>
        <span>加载中...</span>
      </div>
      <div v-else-if="!hasMore && animeList.length > 0" class="no-more">没有更多了</div>
    </div>

    <!-- 无限滚动触发器 -->
    <div ref="loadMoreTriggerRef" class="load-more-trigger"></div>

    <!-- 筛选抽屉 -->
    <div v-if="showFilterDrawer" class="drawer-overlay" @click.self="showFilterDrawer = false">
      <div class="filter-drawer">
        <div class="drawer-header">
          <span>筛选</span>
          <button class="close-btn" @click="showFilterDrawer = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="drawer-body">
          <!-- 状态筛选 -->
          <div class="filter-group">
            <span class="filter-label">观看状态</span>
            <div class="filter-options">
              <div class="filter-chip" :class="{ active: filterStatus === '' }" @click="filterStatus = ''; applyFilter()">全部</div>
              <div class="filter-chip" :class="{ active: filterStatus === 'none' }" @click="filterStatus = 'none'; applyFilter()">未标记</div>
              <div class="filter-chip" :class="{ active: filterStatus === 'want_to_watch' }" @click="filterStatus = 'want_to_watch'; applyFilter()">想看</div>
              <div class="filter-chip" :class="{ active: filterStatus === 'watching' }" @click="filterStatus = 'watching'; applyFilter()">在看</div>
              <div class="filter-chip" :class="{ active: filterStatus === 'watched' }" @click="filterStatus = 'watched'; applyFilter()">看过</div>
            </div>
          </div>
          <!-- 只看收藏 -->
          <div class="filter-group">
            <span class="filter-label">其他</span>
            <label class="filter-checkbox">
              <input type="checkbox" v-model="filterFavorite" @change="applyFilter" />
              <span>只看收藏</span>
            </label>
          </div>
          <!-- 排序 -->
          <div class="filter-group">
            <span class="filter-label">排序</span>
            <div class="filter-options">
              <div class="filter-chip" :class="{ active: sortBy === 'updated_at' }" @click="sortBy = 'updated_at'; applyFilter()">更新时间</div>
              <div class="filter-chip" :class="{ active: sortBy === 'air_date' }" @click="sortBy = 'air_date'; applyFilter()">上映日期</div>
              <div class="filter-chip" :class="{ active: sortBy === 'rating' }" @click="sortBy = 'rating'; applyFilter()">总评分</div>
              <div class="filter-chip" :class="{ active: sortBy === 'user_rating' }" @click="sortBy = 'user_rating'; applyFilter()">我的评分</div>
              <div class="filter-chip" :class="{ active: sortBy === 'status' }" @click="sortBy = 'status'; applyFilter()">标记状态</div>
            </div>
            <button class="sort-order-toggle" @click="toggleSortOrder">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path v-if="sortOrder === 'DESC'" d="M12 5v14M5 12l7 7 7-7"/>
                <path v-else d="M12 19V5M5 12l7-7 7 7"/>
              </svg>
              {{ sortOrder === 'DESC' ? '降序' : '升序' }}
            </button>
          </div>
        </div>
        <div class="drawer-footer">
          <button class="btn-secondary" @click="resetFilter">重置</button>
          <button class="btn-primary" @click="showFilterDrawer = false">完成</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <AnimeDetailMobile
      v-model="detailVisible"
      :bangumi-id="selectedBangumiId"
      :anime-data="selectedAnime"
      @updated="onUpdated"
      @openRelation="handleOpenRelation"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { initAnimeCoverDB, getAnimeCoverFromCache, saveAnimeCoverToCache } from '@/utils/animeCoverCache'
import AnimeDetailMobile from './AnimeDetailMobile.vue'
import ResourceListState from '@/components/common/ResourceListState.vue'

const toast = useToast()
const { isGuest } = usePermission()

// 加载状态
const loading = ref(false)
const loadError = ref('')
const animeList = ref([])

// 筛选
const filterStatus = ref('')
const filterFavorite = ref(false)
const sortBy = ref('updated_at')
const sortOrder = ref('DESC')

// 分页/无限滚动
const pagination = ref({ current: 1, pageSize: 20, total: 0 })
const hasMore = ref(true)
const isLoadingMore = ref(false)
const loadMoreTriggerRef = ref(null)
let loadMoreObserver = null

// 封面缓存
const coverCache = ref({})
const coverLoadingSet = new Set()
let coverObserver = null

// 详情弹窗
const detailVisible = ref(false)
const selectedBangumiId = ref(null)
const selectedAnime = ref(null)

// 折叠控制
const showFilterDrawer = ref(false)

// 加载数据

async function loadAnime(append = false) {
  if (append) {
    isLoadingMore.value = true
  } else {
    loading.value = true
    loadError.value = ''
    pagination.value.current = 1
  }
  try {
    const response = await api.anime.list({
      status: filterStatus.value,
      favorite: filterFavorite.value ? 'true' : undefined,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize,
      hideHidden: isGuest.value ? 'true' : undefined
    })
    const data = response.data.data || []
    if (append) {
      animeList.value.push(...data)
    } else {
      animeList.value = data
    }
    pagination.value.total = response.data.total || 0
    hasMore.value = animeList.value.length < pagination.value.total
  } catch (error) {
    if (!append) loadError.value = error.response?.data?.message || '加载动漫失败，请稍后重试'
    toast.error('加载动漫失败')
  } finally {
    loading.value = false
    isLoadingMore.value = false
    nextTick(() => setTimeout(() => initLoadMoreObserver(), 200))
  }
}

// 筛选排序

function handleFilterChange() {
  loadAnime()
}

function handleSortByChange() {
  loadAnime()
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'DESC' ? 'ASC' : 'DESC'
  loadAnime()
}

function applyFilter() {
  loadAnime()
}

function resetFilter() {
  filterStatus.value = ''
  filterFavorite.value = false
  sortBy.value = 'updated_at'
  sortOrder.value = 'DESC'
  loadAnime()
}

// 无限滚动

function loadMore() {
  pagination.value.current += 1
  loadAnime(true)
}

function initLoadMoreObserver() {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect()
    loadMoreObserver = null
  }
  if (!hasMore.value) return
  const triggerEl = loadMoreTriggerRef.value
  if (!triggerEl) return
  const scrollContainer = document.querySelector('.scrollable-content')
  loadMoreObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !isLoadingMore.value && hasMore.value && !loading.value) {
        loadMore()
      }
    })
  }, {
    root: scrollContainer || null,
    rootMargin: '0px 0px 100px 0px',
    threshold: 0
  })
  loadMoreObserver.observe(triggerEl)
}

// 封面懒加载

async function initCoverCache() {
  try {
    await initAnimeCoverDB()
  } catch (e) {
    console.error('[动漫封面缓存] 初始化失败:', e)
  }
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

function observeCover(el, anime) {
  if (!coverObserver) return
  el.__anime__ = anime
  if (!coverCache.value[anime.id]) {
    coverObserver.observe(el)
  }
}

async function loadCover(id) {
  if (coverLoadingSet.has(id) || coverCache.value[id]) return
  coverLoadingSet.add(id)
  try {
    const cached = await getAnimeCoverFromCache(id)
    if (cached) {
      coverCache.value[id] = cached
      return
    }
    const response = await api.anime.getCover(id)
    const cover = response.data.cover || response.data.coverUrl
    if (cover) {
      coverCache.value[id] = cover
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

// 收藏

async function toggleFavorite(row) {
  try {
    await api.anime.toggleFavorite(row.id)
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

// 详情

function handleCardClick(anime) {
  selectedBangumiId.value = anime.bangumi_id
  selectedAnime.value = anime
  detailVisible.value = true
}

function onUpdated() {
  loadAnime()
}

function handleOpenRelation(data) {
  selectedBangumiId.value = data.bangumiId
  selectedAnime.value = data.animeData
  // 延迟打开，确保当前弹窗已关闭
  setTimeout(() => {
    detailVisible.value = true
  }, 100)
}

// 工具函数

function handleImageError(e) {
  e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI4MCIgdmlld0JveD0iMCAwIDYwIDgwIj48cmVjdCB3aWR0aD0iNjAiIGhlaWdodD0iODAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIzMCIgeT0iNDAiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7ml6Dlm77niYc8L3RleHQ+PC9zdmc+'
}

function toHttps(url) {
  if (!url) return url
  return url.replace(/^http:\/\//, 'https://')
}

function getUserStarWidth(userRating, index) {
  const starValue = userRating / 2
  if (index <= Math.floor(starValue)) return '100%'
  if (index === Math.ceil(starValue) && starValue % 1 >= 0.5) return '50%'
  return '0%'
}

// 生命周期

onMounted(async () => {
  await initCoverCache()
  loadAnime()
  setTimeout(() => initLoadMoreObserver(), 500)
})

onUnmounted(() => {
  if (loadMoreObserver) loadMoreObserver.disconnect()
  if (coverObserver) coverObserver.disconnect()
})
</script>

<style scoped>
.mobile-anime {
  padding: 12px;
  min-height: 100vh;
  background: #f5f7fa;
  -webkit-tap-highlight-color: transparent;
}

/* Token 提醒 */
.token-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}

.token-msg {
  color: #d48806;
  flex: 1;
}

.token-btn {
  padding: 4px 10px;
  border-radius: 4px;
  border: none;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

/* 顶部工具栏 */
.toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 12px;
}

.toolbar-btn {
  width: 36px;
  height: 36px;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  -webkit-tap-highlight-color: transparent;
}

.toolbar-btn.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

/* 搜索栏 */
.search-section {
  background: #fff;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 12px;
}

.search-inputs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.native-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
  outline: none;
}

.native-input:focus {
  border-color: var(--color-primary);
}

.search-btn {
  width: 100%;
  padding: 10px;
  border-radius: 6px;
  border: none;
  background: var(--color-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  -webkit-tap-highlight-color: transparent;
}

.search-btn.loading {
  opacity: 0.7;
}

/* 筛选抽屉 */
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.filter-drawer {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.drawer-header span {
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.drawer-footer {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
}

.drawer-footer button {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  font-size: 15px;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.btn-secondary {
  background: #f5f7fa;
  color: var(--color-text-secondary);
}

.btn-primary {
  background: var(--color-primary);
  color: #fff;
}

.filter-group {
  margin-bottom: 20px;
}

.filter-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
  margin-bottom: 12px;
}

.filter-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-chip {
  padding: 8px 14px;
  background: #f5f7fa;
  border-radius: 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  -webkit-tap-highlight-color: transparent;
}

.filter-chip.active {
  background: var(--color-primary);
  color: #fff;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--color-text-primary);
  cursor: pointer;
}

.sort-order-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* 加载/空状态 */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f0f0f0;
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 动漫列表 */
.anime-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 卡片 */
.anime-card {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #fff;
  border-radius: 10px;
  cursor: pointer;
  transition: transform 0.2s;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
}

.anime-card:active {
  opacity: 0.9;
}

.anime-card.swiped {
  transform: translateX(-60px);
}

/* 滑动删除按钮 */
.delete-btn {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 60px;
  background: var(--color-danger);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  z-index: 0;
  transform: translateX(100%);
  transition: transform 0.2s ease;
}

.anime-card.swiped .delete-btn {
  transform: translateX(0);
}

/* 封面 */
.cover-wrap {
  flex-shrink: 0;
  width: 28%;
  max-width: 110px;
  aspect-ratio: 2 / 3;
  border-radius: 6px;
  overflow: hidden;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

.anime-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 右侧信息 */
.anime-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0;
  padding: 0;
}

.title-block {
  flex-shrink: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.anime-title {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.favorite-star {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.anime-original {
  font-size: 12px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
  margin-top: 2px;
}

/*.anime-info .spacer {
  flex: 1;
  min-height: 2px;
  max-height: 8px;
}*/

.air-date {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.3;
  flex-shrink: 0;
}

.rating-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}

.user-stars {
  display: flex;
  gap: 2px;
}

.star {
  position: relative;
  display: inline-block;
  width: 12px;
  height: 12px;
}

.star-empty {
  position: absolute;
  left: 0;
  top: 0;
  fill: none;
  stroke: #ddd;
  stroke-width: 1.5;
}

.star-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 12px;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
}

.star-full {
  fill: #f5a623;
  stroke: #f5a623;
  stroke-width: 1.5;
  display: block;
  flex-shrink: 0;
}

.user-stars-placeholder {
  flex: 1;
}

.total-rating {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.total-rating .score {
  color: #f5a623;
  font-weight: 600;
}

.total-rating .count {
  color: var(--color-text-muted);
  font-size: 12px;
}

/* 搜索结果窗口 */
.search-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.search-panel {
  background: #fff;
  border-radius: 16px 16px 0 0;
  max-height: 80vh;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.search-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #eee;
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--color-surface-subtle);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.search-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.search-card {
  flex-shrink: 0;
}

.search-card .add-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.search-card .add-icon.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.search-load-more {
  text-align: center;
  padding: 12px;
  font-size: 13px;
  color: var(--color-text-muted);
}

/* 删除确认 */
.confirm-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.confirm-dialog {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  width: 100%;
  max-width: 300px;
  text-align: center;
}

.confirm-dialog p {
  margin: 0 0 20px;
  font-size: 15px;
  color: var(--color-text-primary);
}

.confirm-btns {
  display: flex;
  gap: 12px;
}

.confirm-btns button {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.btn-cancel {
  background: var(--color-surface-subtle);
  color: var(--color-text-primary);
}

.btn-danger {
  background: var(--color-danger);
  color: #fff;
}

/* 加载更多 */
.load-more,
.no-more {
  text-align: center;
  padding: 16px 0;
  font-size: 13px;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid #f0f0f0;
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.load-more-trigger {
  height: 1px;
}
</style>
