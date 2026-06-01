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

    <!-- 播放器主体 -->
    <Transition name="player-slide">
      <div
        v-if="currentSong && !showLyricsWindow"
        class="media-player"
        :class="{ 'sidebar-mode': isSidebarMode }"
        @click="handlePlayerClick"
      >
      <div class="player-content">
        <!-- 歌曲信息 -->
        <div class="song-info">
          <div class="song-cover" @click="openLyricsWindow" style="cursor: pointer;">
            <NativeIcon name="music" v-if="!currentSong.has_cover || coverLoadFailed || !playerCoverData" />
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
          <button 
            v-if="isSidebarMode" 
            class="close-btn-plain"
            @click="closePlayer"
          >
            <NativeIcon name="x" size="12" />
          </button>
        </div>

        <!-- 播放控制 -->
        <div class="player-controls">
          <button class="icon-btn skip-btn" @click="playPrev" :disabled="!hasPrev" title="上一首">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          <button
            class="play-btn-circle"
            @click="togglePlay"
          >
            <NativeIcon v-if="isPlaying" name="pause" size="24" />
            <NativeIcon v-else name="play" size="24" />
          </button>
          <button class="icon-btn skip-btn" @click="playNext" :disabled="!hasNext" title="下一首">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>

        <!-- 进度条 -->
        <div class="progress-section">
          <span class="time">{{ formatTime(currentTime) }}</span>
          <div
            class="progress-bar"
            :class="{ dragging: isDraggingProgress }"
            @mousedown="handleProgressMouseDown"
            @mousemove="handleProgressMouseMove"
            @mouseup="handleProgressMouseUp"
            @mouseleave="handleProgressMouseLeave"
          >
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${displayProgress}%` }"></div>
              <div class="progress-thumb" :style="{ left: `${displayProgress}%` }"></div>
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
              :value="volume"
              @input="e => changeVolume(Number(e.target.value))"
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
            class="icon-btn mode-btn playlist-toggle-btn"
            @click="showPlaylist = !showPlaylist"
            title="播放列表"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
            </svg>
            <span class="mode-text">{{ playlist.length }}</span>
          </button>

          <!-- 均衡器按钮（非侧边栏模式） -->
          <div v-if="!isSidebarMode" class="equalizer-wrapper" ref="equalizerWrapperRef">
            <button
              class="icon-btn mode-btn equalizer-toggle-btn"
              :class="{ active: showEqualizer }"
              title="均衡器"
              @click="toggleEqualizer"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z"/>
              </svg>
              <span class="mode-text">均衡器</span>
            </button>
            <!-- 均衡器浮动面板 -->
            <Teleport to="body">
              <Transition name="fade-down">
                <div 
                  v-if="showEqualizer" 
                  class="equalizer-popup-panel" 
                  :style="equalizerPopupStyle"
                  @click.stop
                >
                  <EqualizerPanel />
                </div>
              </Transition>
            </Teleport>
          </div>
        </div>
      </div>

      <!-- 播放列表 -->
      <Transition name="slide-up">
        <div v-if="showPlaylist" class="playlist-panel" @click.self="showPlaylist = false">
          <div class="playlist-header">
            <span>播放列表 ({{ playlist.length }} 首)</span>
            <button class="clear-btn" @click="clearPlaylist">清空</button>
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
                <NativeIcon v-else name="speaker-high" class="playing-icon" />
              </div>
              <div class="item-info">
                <div class="item-title">{{ song.title }}</div>
                <div class="item-artist">{{ song.artist || '未知艺术家' }}</div>
              </div>
              <button
                class="remove-btn"
                @click.stop="removeFromPlaylist(index)"
                title="删除"
              >
                <NativeIcon name="x" size="14" />
              </button>
            </div>
          </div>
        </div>
      </Transition>
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
    @waiting="isPlaying = false"
    @playing="isPlaying = true"
    @canplay="handleCanPlay"
  />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { usePlayer } from './usePlayer'
import EqualizerPanel from '@/components/EqualizerPanel.vue'
import LyricsWindow from '../lyrics-window/index.vue'
import { NativeButton, NativeIcon } from '@/components/native'
import { vClickOutside } from '@/components/native/directives'

// 直接解构 usePlayer 返回的对象，就像旧版 MediaPlayer.vue 一样
const {
  audioRef, currentSong, playlist, currentIndex, isPlaying, currentTime, duration,
  volume, isMuted, playMode, showPlaylist, isSidebarMode, coverLoadFailed, playerCoverData,
  showLyricsWindow, isDraggingProgress, dragProgress, showEqualizer,
  progress, displayProgress, hasPrev, hasNext, playModeText,
  playSong, playSongAtIndex, loadPlayerCover, handleCoverError, loadAndPlay, handleCanPlay,
  togglePlay, playPrev, playNext, togglePlayMode, openLyricsWindow, closeLyricsWindow, seekToTime,
  handleTimeUpdate, handleLoaded, handleEnded, handleError, changeVolume, toggleMute,
  removeFromPlaylist, clearPlaylist, closePlayer, formatTime
} = usePlayer()

// 均衡器弹窗位置计算
const equalizerWrapperRef = ref(null)
const equalizerPopupStyle = ref({})

function toggleEqualizer() {
  showEqualizer.value = !showEqualizer.value
  if (showEqualizer.value) {
    nextTick(() => {
      updateEqualizerPosition()
    })
  }
}

function updateEqualizerPosition() {
  if (!equalizerWrapperRef.value) return
  
  const triggerRect = equalizerWrapperRef.value.getBoundingClientRect()
  const popupWidth = 480 // EqualizerPanel 实际宽度
  const spacing = 8
  
  // 计算水平居中位置
  let left = triggerRect.left + (triggerRect.width - popupWidth) / 2
  
  // 右边界检测
  const viewportWidth = window.innerWidth
  const rightEdge = left + popupWidth
  
  if (rightEdge > viewportWidth - 10) {
    // 如果超出右边界，则右对齐（保留边距）
    left = viewportWidth - popupWidth - 10
  }
  
  // 左边界检测
  if (left < 10) {
    left = 10
  }
  
  equalizerPopupStyle.value = {
    position: 'fixed',
    bottom: `${window.innerHeight - triggerRect.top + spacing}px`,
    left: `${left}px`,
    zIndex: 9999
  }
}

function handleProgressMouseDown(e) { isDraggingProgress.value = true; updateDragProgress(e) }
function handleProgressMouseMove(e) { if (isDraggingProgress.value) updateDragProgress(e) }
function handleProgressMouseUp() {
  if (isDraggingProgress.value) {
    isDraggingProgress.value = false
    if (audioRef.value && duration.value) audioRef.value.currentTime = (dragProgress.value / 100) * duration.value
  }
}
function handleProgressMouseLeave() { if (isDraggingProgress.value) isDraggingProgress.value = false }
function updateDragProgress(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  dragProgress.value = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
}

// 点击播放器空白处关闭播放列表和均衡器 - 使用document监听实现
function handleDocumentClick(e) {
  // 处理播放列表
  if (showPlaylist.value) {
    // 获取播放列表面板和播放列表按钮
    const playlistPanel = document.querySelector('.playlist-panel')
    const playlistBtn = document.querySelector('.playlist-toggle-btn')
    
    // 如果点击的是播放列表面板内部或播放列表按钮，不关闭
    if (playlistPanel?.contains(e.target) || playlistBtn?.contains(e.target)) {
      return
    }
    
    // 否则关闭播放列表
    showPlaylist.value = false
  }
  
  // 处理均衡器面板
  if (showEqualizer.value) {
    const equalizerPanel = document.querySelector('.equalizer-popup-panel')
    const equalizerBtn = document.querySelector('.equalizer-toggle-btn')
    const selectDropdown = document.querySelector('.native-select__dropdown')
    
    // 如果点击的是均衡器面板内部、均衡器按钮或 Select dropdown，不关闭
    if (equalizerPanel?.contains(e.target) || 
        equalizerBtn?.contains(e.target) ||
        selectDropdown?.contains(e.target)) {
      return
    }
    
    // 否则关闭均衡器
    showEqualizer.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick, true)
  window.addEventListener('resize', handleWindowResize)
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick, true)
  window.removeEventListener('resize', handleWindowResize)
})

function handleWindowResize() {
  if (showEqualizer.value) {
    updateEqualizerPosition()
  }
}
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
  cursor: pointer;
}

.song-cover img { width: 100%; height: 100%; object-fit: cover; }

.song-meta { overflow: hidden; }

.song-title-wrapper { overflow: hidden; max-width: 180px; }

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
  cursor: pointer;
}

.song-title.scrolling {
  display: inline-block;
  animation: marquee 8s linear infinite;
  text-overflow: unset;
}

.song-title.scrolling .song-title-text { display: inline-block; padding-right: 50px; }

@keyframes marquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

.song-artist {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-controls { display: flex; align-items: center; gap: 16px; }

.play-pause-btn :deep(.native-icon) {
  width: 24px !important;
  height: 24px !important;
  display: flex !important;
  align-items: center;
  justify-content: center;
}

.play-pause-btn :deep(.native-icon svg) {
  width: 100% !important;
  height: 100% !important;
  fill: currentColor;
}

.skip-icon {
  width: 20px;
  height: 20px;
  display: block;
}

.skip-icon path {
  fill: currentColor;
}

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

.time { font-size: 12px; color: rgba(255, 255, 255, 0.6); min-width: 40px; }

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

.progress-bar:hover .progress-thumb { opacity: 1; }

.progress-bar.dragging .progress-thumb {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1.2);
  box-shadow: 0 0 8px rgba(24, 144, 255, 0.6);
}

.extra-controls { display: flex; align-items: center; gap: 16px; }

.sidebar-mode .extra-controls {
  width: 100%;
}

.volume-control { display: flex; align-items: center; gap: 8px; }

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

.icon-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.1); }
.icon-btn:disabled { color: rgba(255, 255, 255, 0.3); cursor: not-allowed; }

.play-btn-circle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #1890ff;
  border: none;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.play-btn-circle:hover { background: #40a9ff; transform: scale(1.05); }

.mode-text { font-size: 12px; margin-left: 4px; }

.sidebar-mode .mode-text {
  display: none;
}

.mode-btn.active { background: rgba(255, 255, 255, 0.15); color: #fff; }

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
  z-index: 1001;
}

.playlist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.playlist-header button {
  color: rgba(255, 255, 255, 0.8) !important;
}

.playlist-header button:hover {
  color: #ffffff !important;
}

.playlist-songs { max-height: 350px; overflow-y: auto; }

.playlist-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  gap: 12px;
  cursor: pointer;
  transition: background 0.2s;
  color: rgba(255, 255, 255, 0.9);
}

.playlist-item:hover { background: rgba(255, 255, 255, 0.05); }
.playlist-item.active { background: rgba(24, 144, 255, 0.2); }

.item-index { width: 24px; text-align: center; color: rgba(255, 255, 255, 0.4); }

.item-info { flex: 1; overflow: hidden; }

.item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ffffff; }

.item-artist { font-size: 12px; color: rgba(255, 255, 255, 0.6); }

/* 清空按钮 */
.clear-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s, background 0.2s;
}

.clear-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
}

.clear-btn:focus {
  outline: none;
}

/* 删除按钮 */
.remove-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s;
}

.remove-btn:hover {
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.1);
}

.remove-btn:focus {
  outline: none;
}

.player-slide-enter-active { transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.player-slide-leave-active { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.player-slide-enter-from { transform: translateY(100%); opacity: 0; }
.player-slide-leave-to { transform: translateY(100%); opacity: 0; }

.slide-up-enter-active, .slide-up-leave-active { transition: all 0.3s ease; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateY(20px); opacity: 0; }

/* 侧边栏模式关闭按钮样式 - 无阴影无outline */
.close-btn-plain {
  background: transparent !important;
  border: none !important;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  outline: none !important;
  box-shadow: none !important;
  width: 18px;
  height: 18px;
  font-size: 12px;
  line-height: 1;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
}

.close-btn-plain:hover {
  color: #ffffff;
  background: transparent !important;
  border: none !important;
}

.close-btn-plain:focus,
.close-btn-plain:active,
.close-btn-plain:focus-visible,
.close-btn-plain:focus-within {
  outline: none !important;
  box-shadow: none !important;
  border: none !important;
}




/* 均衡器 wrapper */
.equalizer-wrapper {
  position: relative;
  display: inline-block;
}

/* 均衡器浮动面板 */
.equalizer-popup-panel {
  background: rgba(30, 30, 30, 0.95);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
  min-width: 320px;
  max-width: calc(100vw - 20px);
  max-height: none;
  overflow: visible;
}

/* 淡入淡出动画 */
.fade-down-enter-active,
.fade-down-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.fade-down-enter-from,
.fade-down-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>