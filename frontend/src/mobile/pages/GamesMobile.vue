<template>
  <div class="mobile-games">
    <!-- Steam 配置栏（游客不显示） -->
    <div v-if="!isGuest" class="config-section">
      <!-- 未配置 - 折叠状态 -->
      <div v-if="!editMode && !hasConfig" class="config-bar">
        <div class="config-bar-left">
          <button class="config-btn compact primary" @click="editMode = true">配置 Steam</button>
          <button class="config-btn compact" disabled>批量下载封面</button>
        </div>
        <button class="config-btn icon-btn" disabled title="同步游戏库">
          <svg class="sync-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
        </button>
      </div>
      <!-- 已配置 - 折叠状态 -->
      <div v-else-if="!editMode && hasConfig" class="config-bar">
        <div class="config-bar-left">
          <button class="config-btn compact primary" @click="editMode = true">修改 Steam 配置</button>
          <button class="config-btn compact" :class="{ loading: downloadingCovers }" @click="handleBatchDownloadCovers" :disabled="downloadingCovers">
            {{ downloadingCovers ? '下载中...' : '批量下载封面' }}
          </button>
        </div>
        <button class="config-btn icon-btn" :class="{ loading: syncing }" @click="syncGames" :disabled="syncing" title="同步游戏库">
          <svg class="sync-icon" :class="{ spinning: syncing }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
        </button>
      </div>
      <!-- 展开编辑状态 -->
      <div v-else class="config-expanded">
        <input v-model="steamId" placeholder="Steam ID (64位)" class="native-input" />
        <input v-model="apiKey" placeholder="Steam API Key" type="password" class="native-input" />
        <div class="config-actions">
          <button class="btn-primary" @click="saveConfig" :disabled="saving">
            {{ saving ? '保存中...' : '保存' }}
          </button>
          <button class="btn-secondary" @click="cancelEdit">取消</button>
        </div>
      </div>
      <div v-if="lastSync && !editMode" class="last-sync">最后同步: {{ lastSync }}</div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading && games.length === 0" class="loading-state">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="games.length === 0" class="empty-state">
      <p>还没有游戏数据，请先配置 Steam 并同步游戏库</p>
    </div>

    <!-- 游戏列表 -->
    <div v-else class="games-list">
      <div
        v-for="game in games"
        :key="game.id"
        class="game-card"
        @click="openGameDetail(game)"
      >
        <!-- 左侧：横向封面 -->
        <div class="cover-wrap">
          <img
            :src="getMobileCoverUrl(game)"
            class="game-cover"
            loading="lazy"
            @error="handleImageError"
          />
        </div>
        <!-- 右侧内容区 -->
        <div class="game-content">
          <!-- 标题：可跨越成就区域 -->
          <div class="game-title">{{ game.title }}</div>
          <!-- 下方：左侧主列 + 右侧成就列 -->
          <div class="info-row">
            <!-- 左侧主列：时长 + 进度条 -->
            <div class="main-area">
              <div class="time-row">
                <span class="time-total">{{ formatPlaytime(game.playtime_forever) }}</span>
                <span v-if="game.playtime_2weeks > 0" class="time-2weeks">{{ formatPlaytime(game.playtime_2weeks) }}</span>
              </div>
              <div class="progress-track" v-if="game.playtime_forever > 0">
                <div
                  class="progress-fill"
                  :style="{ width: `${Math.min((game.playtime_2weeks / Math.max(game.playtime_forever, 1)) * 100, 100)}%` }"
                ></div>
              </div>
              <div v-else class="progress-track-placeholder"></div>
            </div>
            <!-- 右侧成就列 -->
            <div class="achievements-wrap">
              <template v-if="game.achievements_total > 0">
                <span v-if="game.achievements_completed === game.achievements_total" class="achievement-crown">🏆</span>
                <span class="achievement-numbers">
                  <span class="achievement-completed">{{ game.achievements_completed }}</span>
                  <span class="achievement-separator">/</span>
                  <span class="achievement-total">{{ game.achievements_total }}</span>
                </span>
              </template>
              <span v-else class="achievement-dash">-</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 加载更多 / 无更多 -->
      <div v-if="isLoadingMore" class="load-more">
        <div class="spinner-small"></div>
        <span>加载中...</span>
      </div>
      <div v-else-if="!hasMore && games.length > 0" class="no-more">没有更多了</div>
    </div>

    <!-- 无限滚动触发器 -->
    <div ref="loadMoreTriggerRef" class="load-more-trigger"></div>

    <!-- 游戏详情弹窗（与 PC 端保持一致） -->
    <NativeDialog
      v-model="detailVisible"
      :title="currentGame?.title || '游戏详情'"
      width="100%"
      :show-footer="false"
      class="game-detail-dialog"
    >
      <div class="detail-content" v-if="currentGame">
        <div class="detail-header">
          <div class="cover-container">
            <img
              :src="getMobileCoverUrl(currentGame)"
              class="detail-cover"
              @error="handleImageError"
            />
            <!-- 游客不显示更新封面按钮 -->
            <NativeButton
              v-if="!isGuest"
              size="small"
              variant="text"
              theme="primary"
              :loading="refreshingCover"
              @click="handleRefreshCover"
              class="refresh-cover-btn"
            >
              <template #icon><NativeIcon name="arrow-clockwise" /></template>
              更新封面
            </NativeButton>
          </div>
          <div class="detail-info">
            <h2 class="detail-title">{{ currentGame.title }}</h2>
            <div class="detail-stats">
              <div class="detail-stat-item">
                <span class="detail-stat-label">总游玩时长</span>
                <span class="detail-stat-value">{{ formatPlaytime(currentGame.playtime_forever) }}</span>
              </div>
              <div class="detail-stat-item" v-if="currentGame.playtime_2weeks > 0">
                <span class="detail-stat-label">两周内游玩</span>
                <span class="detail-stat-value highlight">{{ formatPlaytime(currentGame.playtime_2weeks) }}</span>
              </div>
              <div class="detail-stat-item" v-if="currentGame.last_played">
                <span class="detail-stat-label">最后运行</span>
                <span class="detail-stat-value">{{ formatDate(currentGame.last_played) }}</span>
              </div>
              <div class="detail-stat-item" v-if="currentGame.achievements_total > 0">
                <span class="detail-stat-label">成就进度</span>
                <span class="detail-stat-value achievement-progress">
                  🏆 {{ currentGame.achievements_completed }}/{{ currentGame.achievements_total }}
                </span>
                <div class="achievement-progress-bar">
                  <div
                    class="achievement-progress-fill"
                    :style="{ width: `${(currentGame.achievements_completed / currentGame.achievements_total) * 100}%` }"
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 成就列表 -->
        <div class="achievements-section" v-if="achievements.length > 0">
          <div class="section-header">
            <h3 class="section-title">
              🏆 成就列表 ({{ achievements.filter(a => a.isAchieved).length }}/{{ achievements.length }})
            </h3>
            <!-- 游客不显示刷新成就按钮 -->
            <NativeButton
              v-if="!isGuest"
              size="small"
              variant="outline"
              :loading="loadingAchievements"
              @click="fetchAchievementsForGame(currentGame.id)"
            >
              <template #icon><NativeIcon name="arrow-clockwise" /></template>
              刷新成就
            </NativeButton>
          </div>
          <div class="achievements-list">
            <div
              v-for="achievement in achievements"
              :key="achievement.id"
              class="achievement-item"
              :class="{ completed: achievement.isAchieved }"
            >
              <img :src="achievement.icon" class="achievement-icon" @error="handleAchievementIconError" />
              <div class="achievement-info">
                <div class="achievement-name">{{ achievement.name }}</div>
                <div class="achievement-desc">{{ achievement.description || '隐藏成就' }}</div>
                <div class="achievement-meta">
                  <span class="global-percent">
                    <NativeIcon name="chart" size="12" />
                    {{ achievement.globalPercent }}% 玩家达成
                  </span>
                  <span v-if="achievement.unlockTime" class="unlock-time">
                    <NativeIcon name="time" size="12" />
                    {{ formatDate(achievement.unlockTime) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 无成就提示 -->
        <div v-else-if="!loadingAchievements" class="no-achievements">
          <NativeEmpty description="该游戏暂无成就数据">
            <template #action>
              <NativeButton
                v-if="!isGuest"
                theme="primary"
                :loading="loadingAchievements"
                @click="fetchAchievementsForGame(currentGame.id)"
              >
                获取成就数据
              </NativeButton>
            </template>
          </NativeEmpty>
        </div>

        <!-- 加载中 -->
        <div v-if="loadingAchievements" class="loading-achievements">
          <NativeLoading text="加载成就数据中..." />
        </div>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeDialog, NativeLoading, NativeEmpty, NativeIcon } from '@/components/native'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

const loading = ref(false)
const games = ref([])
const pagination = ref({ current: 1, pageSize: 20, total: 0 })
const hasMore = ref(true)
const isLoadingMore = ref(false)

// Steam 配置
const steamId = ref('')
const apiKey = ref('')
const editMode = ref(false)
const hasConfig = ref(false)
const saving = ref(false)
const syncing = ref(false)
const syncProgress = ref(0)
const lastSync = ref('')
const downloadingCovers = ref(false)

// 游戏详情
const detailVisible = ref(false)
const currentGame = ref(null)
const achievements = ref([])
const loadingAchievements = ref(false)
const refreshingCover = ref(false)

// 无限滚动
const loadMoreTriggerRef = ref(null)
let loadMoreObserver = null

// 加载 Steam 配置
async function loadConfig() {
  try {
    const response = await api.games.getSteamConfig()
    const config = response.data?.data
    if (config) {
      steamId.value = config.steam_id || ''
      apiKey.value = config.api_key || ''
      lastSync.value = config.last_sync || ''
      hasConfig.value = !!(config.steam_id && config.api_key)
    }
  } catch (error) {
    console.error('加载配置失败:', error)
  }
}

// 保存配置
async function saveConfig() {
  if (!steamId.value || !apiKey.value) {
    toast.warning('请填写完整的 Steam 配置')
    return
  }
  saving.value = true
  try {
    await api.games.saveSteamConfig({ steamId: steamId.value, apiKey: apiKey.value })
    toast.success('配置保存成功')
    editMode.value = false
    hasConfig.value = true
    await loadConfig()
  } catch (error) {
    toast.error(error.response?.data?.message || '配置保存失败')
  } finally {
    saving.value = false
  }
}

// 取消编辑
function cancelEdit() {
  editMode.value = false
  loadConfig()
}

// 同步游戏库
async function syncGames() {
  syncing.value = true
  syncProgress.value = 0
  try {
    const startResponse = await api.games.syncSteam()
    const taskId = startResponse.data.taskId
    const pollInterval = setInterval(async () => {
      try {
        const statusResponse = await api.games.getSyncStatus(taskId)
        const task = statusResponse.data?.data
        if (task) {
          syncProgress.value = task.progress || 0
          if (task.status === 'completed') {
            clearInterval(pollInterval)
            syncing.value = false
            toast.success(task.message)
            await loadConfig()
            pagination.value.current = 1 // 重置到第一页
            hasMore.value = true // 重置加载更多状态
            loadGames()
          } else if (task.status === 'failed') {
            clearInterval(pollInterval)
            syncing.value = false
            toast.error(task.message)
          }
        }
      } catch (error) {
        console.error('[同步] 查询状态失败:', error)
      }
    }, 2000)
  } catch (error) {
    syncing.value = false
    toast.error(error.response?.data?.message || '启动同步失败')
  }
}

// 加载游戏列表
async function loadGames(append = false) {
  if (append) {
    isLoadingMore.value = true
  } else {
    loading.value = true
  }
  try {
    const response = await api.games.list({
      sortBy: 'playtime_2weeks', // 按近两周时长优先排序，相同时按总时长排序
      sortOrder: 'DESC',
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    })
    const data = response.data.data || []
    const total = response.data.total || 0
    if (append) {
      games.value.push(...data)
    } else {
      games.value = data
    }
    pagination.value.total = total
    hasMore.value = games.value.length < total
  } catch (error) {
    toast.error('加载游戏失败')
  } finally {
    loading.value = false
    isLoadingMore.value = false
    nextTick(() => {
      setTimeout(() => initLoadMoreObserver(), 200)
    })
  }
}

// 打开游戏详情
async function openGameDetail(game) {
  currentGame.value = game
  detailVisible.value = true
  achievements.value = []
  loadingAchievements.value = true
  try {
    const response = await api.games.getAchievements(game.id)
    const data = response.data?.data
    if (data) {
      currentGame.value = data.game
      achievements.value = data.achievements || []
      if (data.game.steam_appid && (!data.achievements || data.achievements.length === 0)) {
        await fetchAchievementsForGame(game.id)
      }
    }
  } catch (error) {
    console.error('加载成就详情失败:', error)
  } finally {
    loadingAchievements.value = false
  }
}

// 刷新成就
async function fetchAchievementsForGame(gameId) {
  loadingAchievements.value = true
  try {
    const response = await api.games.fetchAchievements(gameId)
    const data = response.data?.data
    if (data) {
      currentGame.value = { ...currentGame.value, ...data.game }
      achievements.value = data.achievements || []
      toast.success('成就数据获取成功')
    }
  } catch (error) {
    toast.error(error.response?.data?.message || '获取成就数据失败')
  } finally {
    loadingAchievements.value = false
  }
}

// 更新封面
async function handleRefreshCover() {
  if (!currentGame.value) return
  refreshingCover.value = true
  try {
    const response = await api.games.refreshCover(currentGame.value.id)
    if (response.data?.data) {
      currentGame.value = {
        ...currentGame.value,
        cover_image: response.data.data.cover_image,
        cover_image_data: response.data.data.cover_image_data,
        header_cover_image: response.data.data.header_cover_image,
        header_cover_image_data: response.data.data.header_cover_image_data
      }
      toast.success('封面更新成功')
      loadGames()
    }
  } catch (error) {
    toast.error(error.response?.data?.message || '封面更新失败')
  } finally {
    refreshingCover.value = false
  }
}

// 批量下载封面
async function handleBatchDownloadCovers() {
  downloadingCovers.value = true
  try {
    const response = await api.games.batchDownloadCovers()
    toast.success(response.data.message)
    loadGames()
  } catch (error) {
    toast.error(error.response?.data?.message || '批量下载封面失败')
  } finally {
    downloadingCovers.value = false
  }
}

// 格式化游玩时长：XX.Xh（小数点后一位，不显示分钟）
function formatPlaytime(minutes) {
  if (!minutes) return '0h'
  const hours = (minutes / 60).toFixed(1)
  // 去掉末尾的 .0
  return hours.endsWith('.0') ? `${parseInt(hours)}h` : `${hours}h`
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

// 详情页大图（优先纵向，空缺时用横向降级）
function getCoverUrl(row) {
  if (row.cover_image_data) return row.cover_image_data
  if (row.header_cover_image_data) return row.header_cover_image_data
  if (row.steam_appid) {
    return `${import.meta.env.VITE_API_BASE_URL || ''}/api/games/cover-proxy?appid=${row.steam_appid}`
  }
  return row.cover_image || row.header_cover_image || defaultCover()
}

// 移动端封面：只使用横向 header 封面，没有则显示占位图
function getMobileCoverUrl(row) {
  if (row.header_cover_image_data) return row.header_cover_image_data
  if (row.steam_appid) {
    return `${import.meta.env.VITE_API_BASE_URL || ''}/api/games/cover-proxy?appid=${row.steam_appid}&type=header`
  }
  return row.header_cover_image || defaultCover()
}

function defaultCover() {
  return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMzQwIiB2aWV3Qm94PSIwIDAgMjQwIDM0MCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIzNDAiIGZpbGw9IiMyYjJiMmIiLz48ZyBmaWxsPSIjNDQ0Ij48cGF0aCBkPSJNODAgMTQwYzAgMTEgOSAxOSAyMCAxOWgyMGw2IDYgNi02aDIwYzExIDAgMjAtOCAyMC0xOXYtNDBjMC0xMS05LTE5LTIwLTE5SDEwMGMtMTEgMC0yMCA4LTIwIDE5em0xNS00NWMtOCAwLTE1IDctMTUgMTVzNyAxNSAxNSAxNSAxNS03IDE1LTE1LTctMTUtMTUtMTV6bTYwIDBjLTggMC0xNSA3LTE1IDE1czcgMTUgMTUgMTUgMTUtNyAxNS0xNS03LTE1LTE1LTE1eiIvPjwvZz48L3N2Zz4='
}

// 图片加载失败
function handleImageError(e) {
  const src = e.target.src
  if (src.includes('/cover-proxy?')) {
    const appid = src.match(/appid=(\d+)/)?.[1]
    if (appid && !src.includes('type=header')) {
      e.target.src = `${import.meta.env.VITE_API_BASE_URL || ''}/api/games/cover-proxy?appid=${appid}&type=header`
      return
    }
  }
  if (!src.includes('data:image/svg+xml')) {
    e.target.src = defaultCover()
  }
}

// 成就图标加载失败
function handleAchievementIconError(e) {
  const currentSrc = e.target.src
  if (!currentSrc.includes('data:image/svg+xml')) {
    e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIzMiIgeT0iMzYiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiPuWbveeJh+WIhuaekDwvdGV4dD48L3N2Zz4='
  }
}

// 加载更多
function loadMore() {
  pagination.value.current += 1
  loadGames(true)
}

// 无限滚动：使用 IntersectionObserver
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

onMounted(() => {
  loadConfig()
  loadGames()
  setTimeout(() => initLoadMoreObserver(), 500)
})

onUnmounted(() => {
  if (loadMoreObserver) loadMoreObserver.disconnect()
})
</script>

<style scoped>
.mobile-games {
  padding: 12px;
  min-height: 100vh;
  background: #f5f7fa;
}

/* ====== 配置栏 ====== */
.config-section {
  background: #fff;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 12px;
}

.config-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.config-bar-left {
  display: flex;
  gap: 8px;
  align-items: center;
}

.config-btn {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid #dcdcdc;
  background: #fff;
  color: #333;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  box-sizing: border-box;
}

.config-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: #f5f5f5;
}

.config-btn.primary {
  background: #0052d9;
  border-color: #0052d9;
  color: #fff;
}

.config-btn.primary:disabled {
  opacity: 0.5;
}

.config-btn.compact {
  padding: 4px 8px;
  font-size: 12px;
  flex: none;
}

.config-btn.icon-btn {
  width: 26px;
  padding: 0;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.config-btn.icon-btn svg {
  width: 14px;
  height: 14px;
}

.config-btn.icon-btn:disabled svg {
  opacity: 0.4;
}

.sync-icon.spinning {
  animation: spin 1s linear infinite;
}

.config-expanded {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  border-color: #0052d9;
}

.config-actions {
  display: flex;
  gap: 10px;
}

.btn-primary,
.btn-secondary {
  flex: 1;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  height: 28px;
}

.btn-primary {
  background: #0052d9;
  color: #fff;
}

.btn-secondary {
  background: #f5f5f5;
  color: #333;
}

.last-sync {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
}

/* ====== 加载 / 空状态 ====== */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #999;
  font-size: 14px;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ====== 游戏列表 ====== */
.games-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.game-card {
  display: flex;
  gap: 10px;
  align-items: stretch;
  padding: 8px 0;
  border-bottom: 1px solid #eee;
  cursor: pointer;
}

.game-card:active {
  opacity: 0.8;
}

.cover-wrap {
  flex-shrink: 0;
  width: 33.33%;
  max-width: 130px;
  border-radius: 4px;
  overflow: hidden;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  display: flex;
  align-items: center;
}

.game-cover {
  width: 100%;
  height: 100%;
  object-fit: fill;
  display: block;
}

.game-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 2px 0;
}

.game-title {
  font-size: 15px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

/* 主信息行：左侧主列 + 右侧成就列 */
.info-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.main-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  line-height: 1.2;
}

.time-total {
  color: #333;
  font-weight: 500;
}

.time-2weeks {
  color: #999;
}

.progress-track {
  width: 100%;
  height: 3px;
  background: #f0f0f0;
  border-radius: 2px;
  overflow: hidden;
}

.progress-track-placeholder {
  width: 100%;
  height: 3px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #0052d9, #00a8ff);
  border-radius: 2px;
  transition: width 0.3s;
}

/* 右侧成就列：独立区域 */
.achievements-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  min-width: 44px;
  padding-bottom: 1px;
}

.achievement-crown {
  font-size: 12px;
  line-height: 1;
  margin-bottom: 2px;
}

.achievement-numbers {
  font-size: 12px;
  white-space: nowrap;
  line-height: 1;
}

.achievement-completed {
  color: #333;
  font-weight: 500;
}

.achievement-separator,
.achievement-total {
  color: #999;
}

.achievement-dash {
  font-size: 13px;
  color: #999;
}

/* ====== 加载更多 ====== */
.load-more,
.no-more {
  text-align: center;
  padding: 16px 0;
  font-size: 13px;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.load-more-trigger {
  height: 1px;
}

/* ====== 详情弹窗 ====== */
.detail-content {
  padding: 0;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 40px;
}

.detail-header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #eee;
  margin-bottom: 16px;
}

.cover-container {
  position: relative;
  width: 100%;
}

.detail-cover {
  width: 100%;
  max-height: 200px;
  object-fit: cover;
  border-radius: 8px;
  display: block;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

.refresh-cover-btn {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  color: #fff !important;
}

.refresh-cover-btn:deep(.native-btn) {
  border: none !important;
  background: rgba(0, 0, 0, 0.5) !important;
  color: #fff !important;
}

.refresh-cover-btn:deep(.native-btn:hover:not(:disabled)) {
  background: rgba(0, 0, 0, 0.7) !important;
}

.detail-title {
  font-size: 20px;
  font-weight: 600;
  color: #333;
  margin: 0;
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.detail-stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-stat-label {
  font-size: 12px;
  color: #999;
}

.detail-stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.detail-stat-value.highlight {
  color: #0052d9;
}

.achievement-progress {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #ffd700;
}

.achievement-progress-bar {
  width: 100%;
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
  margin-top: 4px;
}

.achievement-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ffd700, #ffb800);
  border-radius: 3px;
}

/* 成就列表 */
.achievements-section {
  margin-top: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  margin: 0;
}

.achievements-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.achievement-item {
  display: flex;
  gap: 10px;
  padding: 10px;
  background: #f9f9f9;
  border-radius: 8px;
}

.achievement-item.completed {
  background: #fff8e6;
  border: 1px solid #ffd700;
}

.achievement-icon {
  width: 44px;
  height: 44px;
  border-radius: 4px;
  flex-shrink: 0;
}

.achievement-info {
  flex: 1;
  min-width: 0;
}

.achievement-name {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.achievement-desc {
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.achievement-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: #999;
}

.global-percent {
  color: #0052d9;
}

.unlock-time {
  color: #52c41a;
}

.no-achievements,
.loading-achievements {
  padding: 30px 0;
  text-align: center;
}

/* 覆盖 NativeDialog 在移动端的全宽 */
:deep(.native-dialog) {
  max-width: calc(100vw - 32px) !important;
}
</style>
