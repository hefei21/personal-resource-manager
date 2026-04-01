<template>
  <div>
    <!-- 歌词窗口 -->
    <LyricsWindow
      :visible="showLyricsWindow"
      :current-song="currentSong"
      :is-playing="isPlaying"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      :is-muted="isMuted"
      :play-mode="playMode"
      :has-prev="hasPrev"
      :has-next="hasNext"
      @close="closeLyricsWindow"
      @toggle-play="togglePlay"
      @prev="playPrev"
      @next="playNext"
      @seek="seekToTime"
      @volume-change="changeVolume"
      @toggle-mute="toggleMute"
      @toggle-play-mode="togglePlayMode"
    />
    
    <!-- 原有播放器 -->
    <Transition name="player-slide">
      <div 
        v-if="currentSong && !showLyricsWindow" 
        class="media-player"
        :class="{ 'sidebar-mode': isSidebarMode }"
      >
        <div class="player-content">
          <!-- 歌曲信息 -->
          <div class="song-info">
            <div class="song-cover" @click="openLyricsWindow" style="cursor: pointer;">
              <t-icon name="music" v-if="!currentSong.has_cover || coverLoadFailed || !playerCoverData" />
              <img 
                v-else 
                :src="playerCoverData" 
                alt="cover" 
                @error="handleCoverError"
              />
            </div>
            <div class="song-meta">
              <div class="song-title-wrapper">
                <div class="song-title" :class="{ 'scrolling': currentSong.title && currentSong.title.length > 15 }" @click="openLyricsWindow" style="cursor: pointer;">
                  <span class="song-title-text">{{ currentSong.title }}</span>
                </div>
              </div>
              <div class="song-artist">{{ currentSong.artist || '未知艺术家' }}</div>
            </div>
            <t-button 
              v-if="isSidebarMode" 
              size="small" 
              variant="text"
              class="close-btn-white"
              @click="closePlayer"
            >
              <t-icon name="close" />
            </t-button>
          </div>

        <!-- 播放控制 -->
        <div class="player-controls">
          <button class="icon-btn" @click="playPrev" :disabled="!hasPrev" title="上一首">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          <t-button
            theme="primary"
            shape="circle"
            size="large"
            @click="togglePlay"
          >
            <t-icon :name="isPlaying ? 'pause' : 'play'" size="24px" />
          </t-button>
          <button class="icon-btn" @click="playNext" :disabled="!hasNext" title="下一首">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>

        <!-- 进度条 -->
        <div class="progress-section">
          <span class="time">{{ formatTime(currentTime) }}</span>
          <div class="progress-bar" @click="seekTo">
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${progress}%` }"></div>
              <div class="progress-thumb" :style="{ left: `${progress}%` }"></div>
            </div>
          </div>
          <span class="time">{{ formatTime(duration) }}</span>
        </div>

        <!-- 音量和播放模式 -->
        <div class="extra-controls">
          <div class="volume-control">
            <button class="icon-btn" @click="toggleMute" title="静音">
              <svg v-if="!isMuted" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            </button>
            <input
              type="range"
              min="0"
              max="100"
              v-model="volume"
              @input="changeVolume"
              class="volume-slider"
            />
            <!-- 侧边栏模式：播放模式按钮在音量条右侧 -->
            <button v-if="isSidebarMode" class="icon-btn mode-btn" @click="togglePlayMode" :title="playModeText">
              <svg v-if="playMode === 'sequence'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
              </svg>
              <svg v-else-if="playMode === 'loop'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                <text x="12" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">1</text>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
              </svg>
            </button>
          </div>

          <!-- 非侧边栏模式：播放模式按钮 -->
          <button v-if="!isSidebarMode" class="icon-btn mode-btn" @click="togglePlayMode" :title="playModeText">
            <!-- 列表循环 -->
            <svg v-if="playMode === 'sequence'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
            </svg>
            <!-- 单曲循环：带数字1 -->
            <svg v-else-if="playMode === 'loop'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
              <text x="12" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">1</text>
            </svg>
            <!-- 随机播放 -->
            <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
            </svg>
            <span class="mode-text">{{ playModeText }}</span>
          </button>

          <button 
            v-if="!isSidebarMode"
            class="icon-btn mode-btn" 
            @click="showPlaylist = !showPlaylist" 
            title="播放列表"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
            </svg>
            <span class="mode-text">{{ playlist.length }}</span>
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 播放列表 -->
  <Transition name="slide-up">
    <div v-if="showPlaylist && !isSidebarMode" class="playlist-panel">
      <div class="playlist-header">
        <span>播放列表 ({{ playlist.length }} 首)</span>
        <t-button size="small" variant="text" @click="clearPlaylist">清空</t-button>
      </div>
      <div class="playlist-songs">
        <div 
          v-for="(song, index) in playlist"
          :key="song.id"
          class="playlist-item"
          :class="{ active: currentSong?.id === song.id }"
          @click="playSongAtIndex(index)"
        >
          <div class="item-index">
            <span v-if="currentSong?.id !== song.id">{{ index + 1 }}</span>
            <t-icon v-else name="volume" class="playing-icon" />
          </div>
          <div class="item-info">
            <div class="item-title">{{ song.title }}</div>
            <div class="item-artist">{{ song.artist || '未知艺术家' }}</div>
          </div>
          <t-button 
            size="small" 
            variant="text"
            @click.stop="removeFromPlaylist(index)"
          >
            <t-icon name="close" />
          </t-button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 音频元素 -->
  <audio
    ref="audioRef"
    @timeupdate="handleTimeUpdate"
    @ended="handleEnded"
    @loadedmetadata="handleLoaded"
    @error="handleError"
    @play="isPlaying = true"
    @pause="isPlaying = false"
    @canplay="handleCanPlay"
  />
</div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import api from '@/api'
import { getCoverFromCache, saveCoverToCache, initCoverDB } from '@/utils/coverCache'
import LyricsWindow from './LyricsWindow.vue'

// 状态
const audioRef = ref(null)
const currentSong = ref(null)
const playlist = ref([])
const currentIndex = ref(-1)
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(parseInt(localStorage.getItem('playerVolume')) || 80) // 从localStorage读取音量，默认80
const isMuted = ref(false)
const playMode = ref(localStorage.getItem('playMode') || 'sequence') // sequence, loop, shuffle - 从localStorage读取
const showPlaylist = ref(false)
const isSidebarMode = ref(false)
const coverLoadFailed = ref(false) // 封面加载失败标志
const playerCoverData = ref(null) // 当前播放歌曲的封面数据
const showLyricsWindow = ref(false) // 歌词窗口显示状态

// 计算属性
const progress = computed(() => {
  if (!duration.value) return 0
  return (currentTime.value / duration.value) * 100
})

const hasPrev = computed(() => playlist.value.length > 1)
const hasNext = computed(() => playlist.value.length > 1)

const playModeIcon = computed(() => {
  const icons = {
    sequence: 'order',
    loop: 'refresh',
    shuffle: 'random'
  }
  return icons[playMode.value] || 'order'
})

const playModeText = computed(() => {
  const texts = {
    sequence: '列表循环',
    loop: '单曲循环',
    shuffle: '随机播放'
  }
  return texts[playMode.value] || '列表循环'
})

// 播放控制
async function playSong(song, list = null) {
  if (list) {
    playlist.value = list
    currentIndex.value = list.findIndex(s => s.id === song.id)
  } else if (!playlist.value.find(s => s.id === song.id)) {
    playlist.value.push(song)
    currentIndex.value = playlist.value.length - 1
  } else {
    currentIndex.value = playlist.value.findIndex(s => s.id === song.id)
  }
  
  currentSong.value = song
  coverLoadFailed.value = false // 切换歌曲时重置封面加载状态
  playerCoverData.value = null // 重置封面数据
  loadPlayerCover(song) // 加载封面
  
  // 等待DOM更新（audio元素可能在v-if条件下还未渲染）
  await nextTick()
  loadAndPlay()
}

function playSongAtIndex(index) {
  if (index >= 0 && index < playlist.value.length) {
    currentIndex.value = index
    currentSong.value = playlist.value[index]
    coverLoadFailed.value = false // 切换歌曲时重置封面加载状态
    playerCoverData.value = null
    loadPlayerCover(currentSong.value)
    loadAndPlay()
  }
}

// 加载播放器封面
async function loadPlayerCover(song) {
  if (!song || !song.has_cover) {
    playerCoverData.value = null
    return
  }
  
  try {
    // 先从缓存读取
    const cached = await getCoverFromCache(song.id)
    if (cached) {
      playerCoverData.value = cached
      return
    }
    
    // 从服务器获取
    const response = await api.music.getCover(song.id)
    const cover = response.data.cover
    if (cover) {
      playerCoverData.value = cover
      // 保存到缓存
      await saveCoverToCache(song.id, cover)
    }
  } catch (e) {
    console.error('[MediaPlayer] 加载封面失败:', e)
    coverLoadFailed.value = true
  }
}

// 封面加载失败处理
function handleCoverError() {
  console.log('[MediaPlayer] 封面加载失败:', currentSong.value?.title)
  coverLoadFailed.value = true
}

function loadAndPlay() {
  if (!currentSong.value || !audioRef.value) return

  const token = localStorage.getItem('token')
  audioRef.value.src = `/api/music/play/${currentSong.value.id}?token=${token}`
  audioRef.value.volume = volume.value / 100

  // 加载后自动播放
  audioRef.value.load()
}

function handleCanPlay() {
  // 音频可以播放时，自动开始播放
  if (audioRef.value && currentSong.value) {
    audioRef.value.play().then(() => {
      isPlaying.value = true
    }).catch(err => {
      console.error('自动播放失败:', err)
      // 浏览器可能阻止自动播放，需要用户交互
    })
  }
}

function togglePlay() {
  if (!audioRef.value || !currentSong.value) return

  if (isPlaying.value) {
    audioRef.value.pause()
    isPlaying.value = false
  } else {
    // 如果没有 src，先加载
    if (!audioRef.value.src || audioRef.value.src === window.location.href) {
      loadAndPlay()
    } else {
      audioRef.value.play().then(() => {
        isPlaying.value = true
      }).catch(err => {
        console.error('播放失败:', err)
      })
    }
  }
}

function playPrev() {
  if (playlist.value.length <= 1) return
  
  if (playMode.value === 'shuffle') {
    const randomIndex = Math.floor(Math.random() * playlist.value.length)
    playSongAtIndex(randomIndex)
  } else {
    const newIndex = currentIndex.value - 1
    playSongAtIndex(newIndex < 0 ? playlist.value.length - 1 : newIndex)
  }
}

function playNext() {
  if (playlist.value.length <= 1) return
  
  if (playMode.value === 'shuffle') {
    const randomIndex = Math.floor(Math.random() * playlist.value.length)
    playSongAtIndex(randomIndex)
  } else {
    const newIndex = currentIndex.value + 1
    playSongAtIndex(newIndex >= playlist.value.length ? 0 : newIndex)
  }
}

function togglePlayMode() {
  const modes = ['sequence', 'loop', 'shuffle']
  const currentModeIndex = modes.indexOf(playMode.value)
  playMode.value = modes[(currentModeIndex + 1) % modes.length]
  // 保存播放模式到localStorage
  localStorage.setItem('playMode', playMode.value)
}

// 歌词窗口控制
function openLyricsWindow() {
  if (currentSong.value) {
    showLyricsWindow.value = true
  }
}

function closeLyricsWindow() {
  showLyricsWindow.value = false
}

function seekToTime(time) {
  if (audioRef.value) {
    audioRef.value.currentTime = time
  }
}

// 进度控制
function handleTimeUpdate() {
  if (audioRef.value) {
    currentTime.value = audioRef.value.currentTime
  }
}

function handleLoaded() {
  if (audioRef.value) {
    duration.value = audioRef.value.duration
  }
}

function handleEnded() {
  if (playMode.value === 'loop') {
    // 单曲循环
    audioRef.value.currentTime = 0
    audioRef.value.play()
  } else if (playlist.value.length === 1) {
    // 只有一首歌时，重新播放当前歌曲
    audioRef.value.currentTime = 0
    audioRef.value.play()
  } else {
    playNext()
  }
}

function handleError(e) {
  console.error('音频加载错误:', e)
}

function seekTo(e) {
  if (!audioRef.value) return
  
  const rect = e.currentTarget.getBoundingClientRect()
  const percent = (e.clientX - rect.left) / rect.width
  audioRef.value.currentTime = percent * duration.value
}

// 音量控制
function changeVolume(vol) {
  // 支持从歌词窗口传递音量值
  if (vol !== undefined) {
    volume.value = vol
  }
  if (audioRef.value) {
    audioRef.value.volume = volume.value / 100
    // 保存音量到localStorage
    localStorage.setItem('playerVolume', volume.value)
  }
}

function toggleMute() {
  if (audioRef.value) {
    isMuted.value = !isMuted.value
    audioRef.value.muted = isMuted.value
  }
}

// 播放列表管理
function removeFromPlaylist(index) {
  if (index === currentIndex.value) {
    playNext()
  }
  playlist.value.splice(index, 1)
  if (index < currentIndex.value) {
    currentIndex.value--
  }
}

// 根据 ID 从播放列表移除歌曲（用于删除音乐时同步）
function removeSongById(songId) {
  const index = playlist.value.findIndex(s => s.id === songId)
  if (index !== -1) {
    removeFromPlaylist(index)
  }
}

// 批量根据 ID 从播放列表移除歌曲
function removeSongsByIds(songIds) {
  const idSet = new Set(songIds)
  // 从后往前删除，避免索引问题
  for (let i = playlist.value.length - 1; i >= 0; i--) {
    if (idSet.has(playlist.value[i].id)) {
      removeFromPlaylist(i)
    }
  }
}

function clearPlaylist() {
  playlist.value = []
  currentSong.value = null
  currentIndex.value = -1
  isPlaying.value = false
  if (audioRef.value) {
    audioRef.value.pause()
    audioRef.value.src = ''
  }
}

function closePlayer() {
  currentSong.value = null
  isPlaying.value = false
  if (audioRef.value) {
    audioRef.value.pause()
  }
}

// 格式化时间
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// 监听播放事件
function handlePlayMusic(e) {
  const { song, list } = e.detail
  isSidebarMode.value = false
  playSong(song, list)
}

// 监听删除音乐事件
function handleRemoveMusic(e) {
  const { songId, songIds } = e.detail
  if (songIds && Array.isArray(songIds)) {
    removeSongsByIds(songIds)
  } else if (songId) {
    removeSongById(songId)
  }
}

// 监听路由变化（切换标签页时移动播放器）
function checkRouteChange() {
  const currentPath = window.location.pathname
  // 如果当前不在音乐页面，播放器移动到侧边栏模式
  isSidebarMode.value = currentSong.value !== null && currentPath !== '/music'
}

// 挂载
onMounted(async () => {
  // 初始化封面缓存
  try {
    await initCoverDB()
  } catch (e) {
    console.error('[MediaPlayer] 初始化封面缓存失败:', e)
  }
  
  window.addEventListener('play-music', handlePlayMusic)
  window.addEventListener('remove-music', handleRemoveMusic)
  
  // 初始检查
  checkRouteChange()
  
  // 监听路由变化（用于 SPA 路由）
  window.addEventListener('popstate', checkRouteChange)
  
  // 定期检查路径变化
  setInterval(checkRouteChange, 500)
})

onUnmounted(() => {
  window.removeEventListener('play-music', handlePlayMusic)
  window.removeEventListener('remove-music', handleRemoveMusic)
  window.removeEventListener('popstate', checkRouteChange)
})
</script>

<style scoped>
.media-player {
  position: fixed;
  bottom: 0;
  left: 240px;
  right: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: white;
  z-index: 1000;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.media-player.sidebar-mode {
  left: 0;
  width: 240px;
  bottom: 0;
}

.player-content {
  display: flex;
  align-items: center;
  padding: 12px 24px;
  gap: 24px;
}

.sidebar-mode .player-content {
  flex-direction: column;
  padding: 12px;
  gap: 12px;
}

/* 歌曲信息 */
.song-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 200px;
}

.sidebar-mode .song-info {
  width: 100%;
  justify-content: space-between;
}

.song-cover {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.song-meta {
  overflow: hidden;
}

.song-title-wrapper {
  overflow: hidden;
  max-width: 180px;
}

.sidebar-mode .song-title-wrapper {
  max-width: 140px;
}

.song-title {
  font-weight: 600;
  font-size: 14px;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.song-title.scrolling {
  display: inline-block;
  animation: marquee 8s linear infinite;
  text-overflow: unset;
}

.song-title.scrolling .song-title-text {
  display: inline-block;
  padding-right: 50px;
}

@keyframes marquee {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-50%);
  }
}

.song-artist {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 播放控制 */
.player-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* 进度条 */
.progress-section {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.sidebar-mode .progress-section {
  width: 100%;
}

.sidebar-mode .progress-bar {
  flex: 1;
}

.time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  min-width: 40px;
}

.progress-bar {
  flex: 1;
  cursor: pointer;
  padding: 4px 0;
}

.progress-track {
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  position: relative;
}

.progress-fill {
  height: 100%;
  background: #1890ff;
  border-radius: 2px;
  transition: width 0.1s;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.2s;
}

.progress-bar:hover .progress-thumb {
  opacity: 1;
}

/* 额外控制 */
.extra-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

.sidebar-mode .extra-controls {
  width: 100%;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-mode .volume-control {
  width: 100%;
}

.volume-slider {
  width: 80px;
  height: 4px;
  -webkit-appearance: none;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  cursor: pointer;
}

/* 侧边栏模式：音量条和进度条一样长 */
.sidebar-mode .volume-slider {
  flex: 1;
  width: auto;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
}

.mode-text {
  font-size: 12px;
  margin-left: 4px;
}

.sidebar-mode .mode-text {
  display: none;
}

/* 自定义图标按钮样式 */
.icon-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s;
}

.icon-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
}

.icon-btn:disabled {
  color: rgba(255, 255, 255, 0.3);
  cursor: not-allowed;
}

.icon-btn svg {
  display: block;
  color: rgba(255, 255, 255, 0.9);
}

.icon-btn:hover svg {
  color: #ffffff;
}

.mode-btn {
  font-size: 12px;
}

/* 播放列表面板白色样式 */
.playlist-panel {
  position: absolute;
  bottom: 100%;
  right: 24px;
  width: 400px;
  max-height: 400px;
  background: #1a1a2e;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
}

.playlist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.playlist-header .t-button {
  color: rgba(255, 255, 255, 0.8) !important;
}

.playlist-header .t-button:hover {
  color: #ffffff !important;
}

.playlist-songs {
  max-height: 350px;
  overflow-y: auto;
}

.playlist-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  gap: 12px;
  cursor: pointer;
  transition: background 0.2s;
  color: rgba(255, 255, 255, 0.9);
}

.playlist-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.playlist-item.active {
  background: rgba(24, 144, 255, 0.2);
}

.item-index {
  width: 24px;
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
}

.playing-icon {
  color: #1890ff;
}

.item-info {
  flex: 1;
  overflow: hidden;
}

.item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ffffff;
}

.item-artist {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.playlist-item .t-button {
  color: rgba(255, 255, 255, 0.6) !important;
}

.playlist-item .t-button:hover {
  color: #ffffff !important;
}

/* 动画 */
.player-slide-enter-active {
  transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.player-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.player-slide-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

.player-slide-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(20px);
  opacity: 0;
}

/* 侧边栏模式关闭按钮白色样式 */
.close-btn-white {
  color: rgba(255, 255, 255, 0.9) !important;
}

.close-btn-white:hover {
  color: #ffffff !important;
  background: rgba(255, 255, 255, 0.1) !important;
}
</style>
