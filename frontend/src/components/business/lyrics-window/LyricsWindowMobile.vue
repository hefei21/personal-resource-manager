<template>
  <div class="lyrics-window-mobile">
    <!-- 关闭按钮 -->
    <button class="close-button" @click="handleClose" title="关闭">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>

    <!-- 封面视图 -->
    <div v-if="!showLyricsView" class="cover-view" @click="handleCoverViewClick">
      <div class="disc-wrapper" :class="{ playing: isPlaying }" @click.stop="toggleView">
        <div class="disc-cover">
          <img
            v-if="currentSong && currentSong.has_cover && coverData"
            :src="coverData"
            alt="封面"
            @error="handleCoverError"
          />
          <div v-else class="disc-placeholder">
            <svg viewBox="0 0 24 24" width="80" height="80" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
        </div>
      </div>

      <div class="song-info" @click.stop>
        <h2 class="song-title">{{ currentSong?.title || '未播放' }}</h2>
        <p class="song-artist">{{ currentSong?.artist || '未知艺术家' }}</p>
        <p class="song-album" v-if="currentSong?.album">{{ currentSong.album }}</p>
      </div>
    </div>

    <!-- 歌词视图 -->
    <div v-else class="lyrics-view" @click="handleLyricsViewClick">
      <div class="lyrics-container">
        <div class="lyrics-wrapper">
          <div
            class="lyrics-content"
            ref="lyricsContainer"
            v-if="lyrics.length > 0"
            @scroll="handleUserScroll"
          >
          <div
            v-for="(line, index) in lyrics"
            :key="index"
            :class="['lyrics-line', { active: isLineActive(index) }]"
          >
            <span class="lyrics-text" @click.stop="seekToLine(line.time)">{{ line.text || '...' }}</span>
          </div>
          </div>

          <div v-else class="lyrics-empty" @click.stop>
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
            <p>暂无歌词</p>
            <p class="hint">点击底部"获取歌词"按钮</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部播放栏（移动端简化版） -->
    <div class="mobile-player-bar">
      <!-- 进度条 -->
      <div class="progress-section">
        <span class="time">{{ formatTime(currentTime) }}</span>
        <div
          class="progress-bar"
          :class="{ dragging: isDraggingProgress }"
          @touchstart="handleProgressTouchStart"
          @touchmove="handleProgressTouchMove"
          @touchend="handleProgressTouchEnd"
        >
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${displayProgress}%` }"></div>
            <div class="progress-thumb" :style="{ left: `${displayProgress}%` }"></div>
          </div>
        </div>
        <span class="time">{{ formatTime(duration) }}</span>
      </div>
      
      <!-- 播放控制按钮 -->
      <div class="player-controls">
        <button class="icon-btn" @click="$emit('toggle-play-mode')" :title="playModeText">
          <svg v-if="playMode === 'sequence'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          <svg v-else-if="playMode === 'loop'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
            <text x="12" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">1</text>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.16l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
          </svg>
        </button>
        
        <button class="icon-btn" @click="$emit('prev')" :disabled="!hasPrev" title="上一首">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
          </svg>
        </button>
        
        <button class="icon-btn play-btn" @click="$emit('toggle-play')" :title="isPlaying ? '暂停' : '播放'">
          <svg v-if="isPlaying" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        
        <button class="icon-btn" @click="$emit('next')" :disabled="!hasNext" title="下一首">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
          </svg>
        </button>
        
        <button class="icon-btn" @click="openPlaylist" title="播放列表">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
          </svg>
        </button>
      </div>

    </div>

  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useLyrics } from './useLyrics'
import { usePermission } from '@/composables/usePermission'

const { isGuest } = usePermission()

const props = defineProps({
  visible: { type: Boolean, default: false },
  currentSong: { type: Object, default: null },
  isPlaying: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  playMode: { type: String, default: 'sequence' },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'toggle-play', 'prev', 'next', 'seek', 'toggle-play-mode'])

const showLyricsView = ref(false)
const isDraggingProgress = ref(false)
const dragProgress = ref(0)

const progress = computed(() => {
  if (!props.duration) return 0
  return (props.currentTime / props.duration) * 100
})

const displayProgress = computed(() => {
  return isDraggingProgress.value ? dragProgress.value : progress.value
})

const playModeText = computed(() => {
  const modeMap = { 'sequence': '顺序播放', 'loop': '单曲循环', 'random': '随机播放' }
  return modeMap[props.playMode] || '顺序播放'
})

const {
  lyrics, lyricsContainer, coverData,
  downloadingLyrics, lyricsText,
  isLineActive, handleUserScroll, seekToLine,
  handleCoverError, openPlaylist
} = useLyrics(props, emit)

function handleClose() {
  showLyricsView.value = false
  emit('close')
}

function toggleView() {
  showLyricsView.value = !showLyricsView.value
}

// 封面视图点击处理：点击非封面区域退出
function handleCoverViewClick() {
  emit('close')
}

// 歌词视图点击处理：返回封面视图
function handleLyricsViewClick() {
  showLyricsView.value = false
}

// 进度条触摸事件
function handleProgressTouchStart(e) { isDraggingProgress.value = true; updateDragProgressFromTouch(e) }
function handleProgressTouchMove(e) { if (isDraggingProgress.value) { e.preventDefault(); updateDragProgressFromTouch(e) } }
function handleProgressTouchEnd() {
  if (isDraggingProgress.value) {
    isDraggingProgress.value = false
    emit('seek', (dragProgress.value / 100) * props.duration)
  }
}
function updateDragProgressFromTouch(e) {
  const touch = e.touches[0]
  const rect = e.currentTarget.getBoundingClientRect()
  const percent = ((touch.clientX - rect.left) / rect.width) * 100
  dragProgress.value = Math.max(0, Math.min(100, percent))
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.lyrics-window-mobile {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 50px;
  padding-bottom: calc(var(--player-height, 70px) + 20px);
  -webkit-tap-highlight-color: transparent;
}

.close-button {
  position: fixed;
  top: 12px;
  right: 12px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.8);
  z-index: 10000;
}

.cover-view,
.lyrics-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: calc(100vh - 140px);
  padding: 20px 15px;
}

.cover-view {
  cursor: pointer;
  justify-content: center;
}

.lyrics-view {
  overflow: hidden;
}

.disc-wrapper {
  position: relative;
  width: 260px;
  height: 260px;
  margin-bottom: 30px;
}

.disc-cover {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  animation: rotate 20s linear infinite paused;
}

.disc-wrapper.playing .disc-cover {
  animation-play-state: running;
}

@keyframes rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.disc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.disc-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: rgba(255, 255, 255, 0.8);
}

.song-info {
  text-align: center;
  color: #fff;
}

.song-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 auto 10px auto;
  max-width: 280px;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.song-artist {
  font-size: 14px;
  margin: 4px 0;
  opacity: 0.85;
}

.song-album {
  font-size: 12px;
  margin: 4px 0;
  opacity: 0.6;
}

.lyrics-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.lyrics-wrapper {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.lyrics-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 10px;
  text-align: center;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.lyrics-line {
  font-size: 15px;
  padding: 10px 16px;
  color: rgba(255, 255, 255, 0.5);
  transition: all 0.3s ease;
  display: block;
  cursor: pointer;
  border-radius: 4px;
  line-height: 1.5;
}

.lyrics-text {
  display: inline;
  cursor: pointer;
}

.lyrics-line.active {
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}

.lyrics-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.4);
}

.lyrics-empty p {
  margin: 10px 0;
  font-size: 16px;
}

.lyrics-empty .hint {
  margin: 8px 0;
  font-size: 12px;
  opacity: 0.6;
}

.mobile-player-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  padding: 12px 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 10000;
}

.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.progress-section .time {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  min-width: 36px;
  text-align: center;
}

.progress-bar {
  flex: 1;
  height: 40px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}

.progress-track {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  position: relative;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
  border-radius: 2px;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.player-controls {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 24px;
}

.icon-btn {
  background: transparent;
  border: none;
  color: white;
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-btn.play-btn {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
}

.lyrics-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: rgba(255, 255, 255, 0.9);
  padding: 8px 14px;
  border-radius: 16px;
  font-size: 13px;
  cursor: pointer;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mobile-dialog {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.dialog-content {
  background: #1a1a2e;
  border-radius: 16px;
  width: 100%;
  max-width: 400px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.dialog-header h3 {
  color: #fff;
  margin: 0;
  font-size: 18px;
}

.dialog-close {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog-body {
  padding: 16px 20px;
  flex: 1;
  overflow-y: auto;
}

.lyrics-textarea {
  width: 100%;
  min-height: 200px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px;
  color: #fff;
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}

.lyrics-textarea::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.file-input-wrapper {
  margin-bottom: 16px;
}

.file-input {
  display: none;
}

.btn-file {
  width: 100%;
  padding: 12px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px dashed rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  cursor: pointer;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.btn-secondary,
.btn-primary {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  border: none;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
}

.btn-primary {
  background: #1890ff;
  color: #fff;
}
</style>