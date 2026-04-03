<template>
  <div class="games">
    <div class="page-header">
      <p>管理和追踪你的游戏库</p>
    </div>

    <!-- Steam 配置区域 -->
    <t-card class="config-card">
      <div class="steam-config">
        <div class="config-form">
          <t-input
            v-model="steamId"
            placeholder="Steam ID (64位)"
            style="width: 280px"
            :disabled="!editMode"
          />
          <t-input
            v-model="apiKey"
            placeholder="Steam API Key"
            type="password"
            style="width: 280px"
            :disabled="!editMode"
          />
          <t-space>
            <t-button v-if="!editMode && !hasConfig" theme="primary" @click="editMode = true" :disabled="isGuest">
              配置 Steam
            </t-button>
            <t-button v-if="editMode" theme="primary" @click="saveConfig" :loading="saving" :disabled="isGuest">
              保存
            </t-button>
            <t-button v-if="editMode" theme="default" @click="cancelEdit">
              取消
            </t-button>
            <t-button v-if="hasConfig && !editMode" theme="primary" @click="syncGames" :loading="syncing" :disabled="isGuest">
              {{ syncing ? `同步中 ${syncProgress}%` : '同步游戏库' }}
            </t-button>
            <t-button v-if="hasConfig && !editMode" theme="default" variant="outline" @click="editMode = true" :disabled="isGuest">
              修改配置
            </t-button>
          </t-space>
        </div>
        <div class="config-info" v-if="lastSync">
          <t-icon name="time" />
          <span>最后同步: {{ lastSync }}</span>
        </div>
      </div>
    </t-card>

    <!-- 筛选栏 -->
    <t-card class="filter-card">
      <t-space>
        <t-input
          v-model="searchKeyword"
          placeholder="搜索游戏..."
          style="width: 250px"
          @enter="handleSearch"
        >
          <template #suffix-icon>
            <t-icon name="search" />
          </template>
        </t-input>
        <t-button
          variant="outline"
          size="small"
          :loading="downloadingCovers"
          @click="handleBatchDownloadCovers"
          :disabled="isGuest"
        >
          <template #icon><t-icon name="download" /></template>
          批量下载封面
        </t-button>
        <t-button
          variant="outline"
          size="small"
          theme="warning"
          @click="handleClearCovers"
          :disabled="isGuest"
        >
          <template #icon><t-icon name="delete" /></template>
          清除封面
        </t-button>
      </t-space>
    </t-card>

    <!-- 加载状态 -->
    <div v-if="loading" class="content-loading">
      <t-loading size="small" />
    </div>

    <!-- 游戏列表 -->
    <div v-else class="games-list">
      <div
        v-for="game in games"
        :key="game.id"
        class="game-card"
        @click="openGameDetail(game)"
      >
        <div class="cover-wrapper">
          <img
            :src="getCoverUrl(game)"
            class="game-cover"
            :class="{ 'horizontal-cover': horizontalCovers.has(game.id) }"
            loading="lazy"
            @error="handleImageError"
            @load="(e) => handleCoverLoad(e, game.id)"
          />
        </div>
        <div class="game-info">
          <div class="game-title">{{ game.title }}</div>

          <div class="game-stats">
            <div class="stat-item">
              <span class="stat-label">总游玩</span>
              <span class="stat-value">{{ formatPlaytime(game.playtime_forever) }}</span>
            </div>
            <div class="stat-item" v-if="game.playtime_2weeks > 0">
              <span class="stat-label">近两周</span>
              <span class="stat-value highlight">{{ formatPlaytime(game.playtime_2weeks) }}</span>
            </div>
          </div>

          <div class="progress-bar" v-if="game.playtime_forever > 0">
            <div
              class="progress-fill"
              :style="{ width: `${(game.playtime_2weeks / game.playtime_forever) * 100}%` }"
            ></div>
          </div>

          <div class="game-meta">
            <span v-if="game.genres">{{ game.genres.split(',')[0] }}</span>
            <span v-if="game.release_date">{{ game.release_date }}</span>
            <!-- 成就信息在卡片右下角 -->
            <span class="achievement-badge" v-if="game.achievements_total > 0">
              🏆
              {{ game.achievements_completed }}/{{ game.achievements_total }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div class="pagination-wrapper" v-if="!loading && pagination.total > 0">
      <t-pagination
        v-model="pagination.current"
        v-model:page-size="pagination.pageSize"
        :total="pagination.total"
        show-page-number
        show-page-size
        :page-size-options="[30, 50, 100]"
        @change="handlePageChange"
        @page-size-change="handlePageSizeChange"
      />
    </div>

    <!-- 空状态 -->
    <t-card v-if="!loading && games.length === 0" class="empty-state">
      <t-empty description="还没有游戏数据，请先配置 Steam 并同步游戏库" />
    </t-card>

    <!-- 游戏详情弹窗 -->
    <t-dialog
      v-model:visible="detailVisible"
      :header="currentGame?.title || '游戏详情'"
      width="1000px"
      :footer="false"
      class="game-detail-dialog"
    >
      <div class="detail-content" v-if="currentGame">
        <!-- 游戏基本信息 -->
        <div class="detail-header">
          <div class="cover-container">
            <img
              :src="getCoverUrl(currentGame)"
              class="detail-cover"
              :class="{ 'horizontal-cover': currentGame && horizontalCovers.has(currentGame.id) }"
              @load="(e) => currentGame && handleCoverLoad(e, currentGame.id)"
            />
            <t-button
              size="small"
              variant="outline"
              theme="primary"
              :loading="refreshingCover"
              @click="handleRefreshCover"
              class="refresh-cover-btn"
              :disabled="isGuest"
            >
              <template #icon><t-icon name="refresh" /></template>
              更新封面
            </t-button>
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
                  🏆
                  {{ currentGame.achievements_completed }}/{{ currentGame.achievements_total }}
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
              🏆
              成就列表 ({{ achievements.filter(a => a.isAchieved).length }}/{{ achievements.length }})
            </h3>
            <t-button 
              size="small" 
              variant="outline"
              :loading="loadingAchievements"
              @click="fetchAchievementsForGame(currentGame.id)"
              :disabled="isGuest"
            >
              <template #icon><t-icon name="refresh" /></template>
              刷新成就
            </t-button>
          </div>
          <div class="achievements-grid">
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
                    <t-icon name="chart" size="12px" />
                    {{ achievement.globalPercent }}% 玩家达成
                  </span>
                  <span v-if="achievement.unlockTime" class="unlock-time">
                    <t-icon name="time" size="12px" />
                    {{ formatDate(achievement.unlockTime) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 无成就提示 -->
        <div v-else-if="!loadingAchievements" class="no-achievements">
          <t-empty description="该游戏暂无成就数据">
            <template #action>
              <t-button 
                theme="primary" 
                :loading="loadingAchievements"
                @click="fetchAchievementsForGame(currentGame.id)"
              >
                获取成就数据
              </t-button>
            </template>
          </t-empty>
        </div>

        <!-- 加载中 -->
        <div v-if="loadingAchievements" class="loading-achievements">
          <t-loading text="加载成就数据中..." />
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'

const { isGuest } = usePermission()
const loading = ref(false)
const games = ref([])
const pagination = ref({ current: 1, pageSize: 15, total: 0 })
const searchKeyword = ref('')
const downloadingCovers = ref(false)

// 记录横向封面的游戏 ID（用于适配显示）
const horizontalCovers = ref(new Set())

// Steam 配置
const steamId = ref('')
const apiKey = ref('')
const editMode = ref(false)
const hasConfig = ref(false)
const saving = ref(false)
const syncing = ref(false)
const syncProgress = ref(0)
const syncMessage = ref('')
const lastSync = ref('')

// 游戏详情
const detailVisible = ref(false)
const currentGame = ref(null)
const achievements = ref([])
const loadingAchievements = ref(false)
const refreshingCover = ref(false)

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
    MessagePlugin.warning('请填写完整的 Steam 配置')
    return
  }

  saving.value = true
  try {
    await api.games.saveSteamConfig({ steamId: steamId.value, apiKey: apiKey.value })
    MessagePlugin.success('配置保存成功')
    editMode.value = false
    hasConfig.value = true
    await loadConfig()
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '配置保存失败')
  } finally {
    saving.value = false
  }
}

// 取消编辑
function cancelEdit() {
  editMode.value = false
  loadConfig()
}

// 同步游戏库（只同步游戏列表，成就按需获取）
async function syncGames() {
  syncing.value = true
  syncProgress.value = 0
  syncMessage.value = '启动同步任务...'
  console.log('[同步] 启动 Steam 游戏库同步任务...')

  try {
    // 启动同步任务
    const startResponse = await api.games.syncSteam()
    const taskId = startResponse.data.taskId
    console.log('[同步] 任务已启动:', taskId)

    // 轮询任务状态
    const pollInterval = setInterval(async () => {
      try {
        const statusResponse = await api.games.getSyncStatus(taskId)
        const task = statusResponse.data?.data
        
        if (task) {
          syncProgress.value = task.progress || 0
          syncMessage.value = task.message || '同步中...'

          if (task.status === 'completed') {
            clearInterval(pollInterval)
            syncing.value = false
            console.log('[同步] 同步完成:', task.result)
            MessagePlugin.success(task.message)
            await loadConfig()
            loadGames()
          } else if (task.status === 'failed') {
            clearInterval(pollInterval)
            syncing.value = false
            console.error('[同步] 同步失败:', task.error)
            MessagePlugin.error(task.message)
          }
        }
      } catch (error) {
        console.error('[同步] 查询状态失败:', error)
      }
    }, 2000) // 每2秒轮询一次
  } catch (error) {
    syncing.value = false
    console.error('[同步] 启动任务失败:', error)
    MessagePlugin.error(error.response?.data?.message || '启动同步失败')
  }
}

// 加载游戏列表
async function loadGames() {
  loading.value = true
  try {
    const response = await api.games.list({
      keyword: searchKeyword.value || undefined,
      sortBy: 'playtime_2weeks', // 默认按两周内游玩时长排序
      sortOrder: 'DESC',
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    })
    games.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    MessagePlugin.error('加载游戏失败')
  } finally {
    loading.value = false
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
      
      // 如果没有成就数据，自动获取
      if (data.game.steam_appid && (!data.achievements || data.achievements.length === 0)) {
        console.log('[成就] 没有成就数据，自动获取...')
        await fetchAchievementsForGame(game.id)
      }
    }
  } catch (error) {
    console.error('加载成就详情失败:', error)
  } finally {
    loadingAchievements.value = false
  }
}

// 手动获取/刷新成就数据
async function fetchAchievementsForGame(gameId) {
  loadingAchievements.value = true
  try {
    const response = await api.games.fetchAchievements(gameId)
    const data = response.data?.data
    if (data) {
      currentGame.value = { ...currentGame.value, ...data.game }
      achievements.value = data.achievements || []
      MessagePlugin.success('成就数据获取成功')
    }
  } catch (error) {
    console.error('获取成就数据失败:', error)
    MessagePlugin.error(error.response?.data?.message || '获取成就数据失败')
  } finally {
    loadingAchievements.value = false
  }
}

// 更新当前游戏封面
async function handleRefreshCover() {
  if (!currentGame.value) return
  refreshingCover.value = true
  try {
    const response = await api.games.refreshCover(currentGame.value.id)
    if (response.data?.data) {
      currentGame.value = {
        ...currentGame.value,
        cover_image: response.data.data.cover_image,
        cover_image_data: response.data.data.cover_image_data
      }
      MessagePlugin.success('封面更新成功')
      // 同时更新列表中的数据
      loadGames()
    }
  } catch (error) {
    console.error('更新封面失败:', error)
    MessagePlugin.error(error.response?.data?.message || '封面更新失败')
  } finally {
    refreshingCover.value = false
  }
}

// 格式化游玩时长
function formatPlaytime(minutes) {
  if (!minutes) return '0小时'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

// 获取封面URL
function getCoverUrl(row) {
  // 优先使用 Steam CDN 的封面图（对于 Steam 游戏总是可用）
  if (row.steam_appid) {
    // 如果有本地存储的封面数据，优先使用
    if (row.cover_image_data) return row.cover_image_data
    // 使用 Steam 官方封面图
    return `https://steamcdn-a.akamaihd.net/steam/apps/${row.steam_appid}/library_600x900_2x.jpg`
  }

  // 非 Steam 游戏
  if (row.cover_image_data) return row.cover_image_data
  return row.cover_image || 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMzQwIiB2aWV3Qm94PSIwIDAgMjQwIDM0MCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIzNDAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIxMjAiIHk9IjE3MCIgZmlsbD0iIzk5OSIgZm9udC1zaXplPSIxNiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPuaYn+epuuihqOagvDwvdGV4dD48L3N2Zz4='
}

// 图片加载失败
function handleImageError(e) {
  // Steam 封面加载失败，尝试使用 header 图片
  const src = e.target.src
  if (src.includes('library_600x900_2x.jpg')) {
    const appid = src.match(/\/apps\/(\d+)\//)?.[1]
    if (appid) {
      e.target.src = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/header.jpg`
      return
    }
  }
  // 最终回退到默认图
  if (!src.includes('data:image/svg+xml')) {
    e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMzQwIiB2aWV3Qm94PSIwIDAgMjQwIDM0MCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIzNDAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIxMjAiIHk9IjE3MCIgZmlsbD0iIzk5OSIgZm9udC1zaXplPSIxNiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPuaYn+epuuihqOagvDwvdGV4dD48L3N2Zz4='
  }
}

// 检测封面图片宽高比，标记横向封面
function handleCoverLoad(e, gameId) {
  const img = e.target
  const ratio = img.naturalWidth / img.naturalHeight
  // 宽大于高则是横向封面
  if (ratio > 1) {
    horizontalCovers.value.add(gameId)
    // 触发响应式更新
    horizontalCovers.value = new Set(horizontalCovers.value)
  }
}

// 成就图标加载失败
function handleAchievementIconError(e) {
  const img = e.target
  const currentSrc = img.src

  // 如果当前不是占位图，尝试使用默认占位图
  if (!currentSrc.includes('data:image/svg+xml')) {
    img.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIzMiIgeT0iMzYiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiPuWbveeJh+WIhuaekDwvdGV4dD48L3N2Zz4='
  }
}

// 搜索
function handleSearch() {
  pagination.value.current = 1
  loadGames()
}

// 分页
function handlePageChange(pageInfo) {
  pagination.value.current = pageInfo.current
  loadGames()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange(pageSize) {
  pagination.value.pageSize = pageSize
  pagination.value.current = 1
  loadGames()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 批量下载封面
async function handleBatchDownloadCovers() {
  downloadingCovers.value = true
  console.log('[批量下载] 开始下载封面...')
  try {
    const response = await api.games.batchDownloadCovers()
    console.log('[批量下载] 下载成功:', response.data)
    MessagePlugin.success(response.data.message)
    loadGames()
  } catch (error) {
    console.error('[批量下载] 下载失败:', error)
    console.error('[批量下载] 错误详情:', error.response?.data)
    MessagePlugin.error(error.response?.data?.message || '批量下载封面失败')
  } finally {
    downloadingCovers.value = false
  }
}

// 清除所有封面数据
async function handleClearCovers() {
  const dialog = await DialogPlugin.confirm({
    header: '确认清除',
    body: '确定要清除所有封面数据吗？清除后可以重新下载正确的封面。',
    onConfirm: async () => {
      try {
        const response = await api.games.clearCovers()
        MessagePlugin.success(response.data.message)
        loadGames()
      } catch (error) {
        MessagePlugin.error(error.response?.data?.message || '清除封面失败')
      }
    }
  })
}

onMounted(() => {
  loadConfig()
  loadGames()
})
</script>

<style scoped>
.games {
  padding: 0;
}

/* 内容区域加载状态 */
.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
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

.config-card,
.filter-card {
  margin-bottom: 16px;
}

.steam-config {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.config-form {
  display: flex;
  gap: 12px;
  align-items: center;
}

.config-info {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #666;
  font-size: 14px;
}

/* 游戏列表 */
.games-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(480px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.game-card {
  display: flex;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s;
  cursor: pointer;
}

.game-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

.cover-wrapper {
  position: relative;
  flex-shrink: 0;
}

.game-cover {
  width: 180px;
  height: 255px;
  object-fit: cover;
  display: block;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

/* 横向封面适配：使用 contain 保持完整显示 */
.game-cover.horizontal-cover {
  object-fit: contain;
  background: linear-gradient(135deg, #2a2a3e 0%, #263050 100%);
}

.achievement-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: #ffd700;
  color: #333;
  font-size: 12px;
  font-weight: 600;
  border-radius: 10px;
  margin-left: auto;
}

.game-info {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.game-title {
  font-size: 18px;
  font-weight: 600;
  color: #333;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.game-stats {
  display: flex;
  gap: 20px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: 12px;
  color: #999;
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.stat-value.highlight {
  color: #0052d9;
}

.progress-bar {
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #0052d9, #00a8ff);
  border-radius: 3px;
  transition: width 0.3s;
}

.game-meta {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: #999;
  margin-top: auto;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}

.empty-state {
  padding: 40px;
}

/* 响应式 */
@media (max-width: 520px) {
  .games-list {
    grid-template-columns: 1fr;
  }

  .game-cover {
    width: 140px;
    height: 198px;
  }

  .game-cover.horizontal-cover {
    /* 移动端横向封面保持 contain */
    object-fit: contain;
  }

  .achievement-badge {
    padding: 3px 6px;
    font-size: 11px;
  }
}

/* 游戏详情弹窗 */
.detail-content {
  padding: 0;
}

.detail-header {
  display: flex;
  gap: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid #eee;
  margin-bottom: 20px;
}

.detail-cover {
  width: 200px;
  height: 283px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

/* 详情页横向封面适配 */
.detail-cover.horizontal-cover {
  object-fit: contain;
  background: linear-gradient(135deg, #2a2a3e 0%, #263050 100%);
}

.cover-container {
  position: relative;
  display: inline-block;
}

.refresh-cover-btn {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  border: none;
  color: #fff;
}

.refresh-cover-btn:hover {
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
}

.detail-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.detail-title {
  font-size: 24px;
  font-weight: 600;
  color: #333;
  margin: 0 0 20px 0;
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.detail-stat-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-stat-label {
  font-size: 13px;
  color: #999;
}

.detail-stat-value {
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.detail-stat-value.highlight {
  color: #0052d9;
}

.detail-stat-value.achievement-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #ffd700;
}

.achievement-progress-bar {
  width: 100%;
  height: 8px;
  background: #f0f0f0;
  border-radius: 4px;
  overflow: hidden;
  margin-top: 4px;
}

.achievement-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ffd700, #ffb800);
  border-radius: 4px;
  transition: width 0.3s;
}

/* 成就列表 */
.achievements-section {
  margin-top: 20px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 600;
  color: #333;
  margin: 0;
}

.achievements-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 12px;
  max-height: 500px;
  overflow-y: auto;
}

.achievement-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f9f9f9;
  border-radius: 8px;
  transition: all 0.2s;
}

.achievement-item:hover {
  background: #f0f0f0;
}

.achievement-item.completed {
  background: #fff8e6;
  border: 1px solid #ffd700;
}

.achievement-icon {
  width: 48px;
  height: 48px;
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
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.achievement-desc {
  font-size: 12px;
  color: #666;
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.achievement-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: #999;
}

.achievement-meta span {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 第10项：条目不换行 */
::deep(.t-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.game-title {
  font-size: 18px;
  font-weight: 600;
  color: #333;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-percent {
  color: #0052d9;
}

.unlock-time {
  color: #52c41a;
}

.no-achievements,
.loading-achievements {
  padding: 40px 0;
  text-align: center;
}

/* 响应式 - 详情弹窗 */
@media (max-width: 768px) {
  .detail-header {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .detail-stats {
    grid-template-columns: 1fr;
  }

  .achievements-grid {
    grid-template-columns: 1fr;
  }
}
</style>
