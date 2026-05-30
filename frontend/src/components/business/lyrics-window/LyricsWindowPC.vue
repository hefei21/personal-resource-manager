<template>
  <div class="lyrics-window-pc" @click.self="$emit('close')">
    <!-- 关闭按钮 -->
    <button class="close-button" @click="$emit('close')" title="关闭">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>

    <div class="lyrics-container">
      <!-- 左侧：唱片封面区域 -->
      <div class="left-section">
        <div class="disc-wrapper" :class="{ playing: isPlaying }">
          <div class="disc-cover">
            <img
              v-if="currentSong && currentSong.has_cover && coverData"
              :src="coverData"
              alt="封面"
              @error="handleCoverError"
            />
            <div v-else class="disc-placeholder">
              <NativeIcon name="music" size="120" />
            </div>
          </div>
        </div>

        <div class="song-info">
          <h2 class="song-title">{{ currentSong?.title || '未播放' }}</h2>
          <p class="song-artist">{{ currentSong?.artist || '未知艺术家' }}</p>
          <p class="song-album" v-if="currentSong?.album">{{ currentSong.album }}</p>
        </div>
      </div>

      <!-- 右侧：歌词显示区域 -->
      <div class="right-section">
        <div class="lyrics-header">
          <h3>歌词</h3>
          <NativeSpace>
            <NativeButton
              size="small"
              variant="text"
              @click="downloadLyrics"
              :loading="downloadingLyrics"
              class="white-text-btn"
              :disabled="isGuest"
            >
              <template #icon><NativeIcon name="download" /></template>
              获取歌词
            </NativeButton>
            <NativeButton
              size="small"
              variant="text"
              @click="showUploadLyricsDialog = true"
              class="white-text-btn"
              :disabled="isGuest"
            >
              <template #icon><NativeIcon name="upload" /></template>
              上传歌词
            </NativeButton>
            <NativeButton
              v-if="lyrics.length > 0"
              size="small"
              variant="text"
              @click="showLyricsEditor = true"
              :disabled="isGuest"
              class="white-text-btn"
            >
              <template #icon><NativeIcon name="pencil" /></template>
              编辑歌词
            </NativeButton>
          </NativeSpace>
        </div>

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
              @click="seekToLine(line.time)"
            >
              {{ line.text || '...' }}
            </div>
          </div>

          <div v-else class="lyrics-empty">
            <NativeIcon name="file" size="48" />
            <p>暂无歌词</p>
            <p class="hint">点击顶部"获取歌词"按钮自动搜索</p>
          </div>

          <div v-if="lyrics.length > 0" class="time-adjust-buttons">
            <button class="adjust-btn" @click="adjustLyricTime(-0.5)" :disabled="isGuest" title="-0.5s">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/>
              </svg>
            </button>
            <button class="adjust-btn" @click="adjustLyricTime(0.5)" :disabled="isGuest" title="+0.5s">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部播放栏 -->
    <div class="bottom-player">
      <div class="player-controls">
        <button class="icon-btn" @click="$emit('prev')" :disabled="!hasPrev" title="上一首">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
          </svg>
        </button>

        <NativeButton theme="primary" shape="circle" size="large" @click="$emit('toggle-play')">
          <NativeIcon :name="isPlaying ? 'pause' : 'play'" size="20" />
        </NativeButton>

        <button class="icon-btn" @click="$emit('next')" :disabled="!hasNext" title="下一首">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
          </svg>
        </button>
      </div>

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

      <div class="extra-controls">
        <div class="volume-control">
          <button class="icon-btn" @click="$emit('toggle-mute')" title="静音">
            <svg v-if="!isMuted" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
          </button>
          <input
            type="range"
            min="0"
            max="100"
            :value="volume"
            @input="$emit('volume-change', parseInt($event.target.value))"
            class="volume-slider"
          />
        </div>

        <button class="icon-btn mode-btn" @click="$emit('toggle-play-mode')" :title="playModeText">
          <svg v-if="playMode === 'sequence'" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          <svg v-else-if="playMode === 'loop'" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
            <text x="12" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">1</text>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.16l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
          </svg>
        </button>

        <div class="equalizer-wrapper" ref="equalizerWrapperRef">
          <button class="icon-btn mode-btn" :class="{ active: showEqualizer }" title="均衡器" @click="toggleEqualizer">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z"/>
            </svg>
          </button>
          <Teleport to="body">
            <Transition name="fade-down">
              <div 
                v-if="showEqualizer" 
                class="equalizer-popup-panel" 
                :style="equalizerPopupStyle"
                v-click-outside="() => showEqualizer = false"
              >
                <EqualizerPanel />
              </div>
            </Transition>
          </Teleport>
        </div>
      </div>
    </div>

    <!-- 歌词编辑器对话框 -->
    <NativeDialog v-model="showLyricsEditor" title="编辑歌词" width="600px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="saveLyrics">
      <NativeTextarea v-model="lyricsText" placeholder="请输入LRC格式歌词，例如：&#10;[00:00.00]歌曲名称&#10;[00:10.50]第一句歌词" :rows="10" />
    </NativeDialog>

    <!-- 手动上传歌词对话框 -->
    <NativeDialog v-model="showUploadLyricsDialog" title="上传歌词" width="600px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleUploadLyrics">
      <div style="margin-bottom: 12px;">
        <input
          type="file"
          ref="lyricsFileInput"
          accept=".lrc,.txt"
          @change="handleLyricsFileChange"
          style="display: none"
        />
        <NativeButton variant="outline" @click="$refs.lyricsFileInput.click()">
          <template #icon><NativeIcon name="upload" /></template>
          选择歌词文件
        </NativeButton>
        <span v-if="lyricsFileName" style="margin-left: 8px; color: #666;">{{ lyricsFileName }}</span>
      </div>
      <NativeTextarea v-model="lyricsText" placeholder="或手动粘贴LRC格式歌词，例如：&#10;[00:00.00]歌曲名称&#10;[00:10.50]第一句歌词" :rows="10" />
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useLyrics } from './useLyrics'
import EqualizerPanel from '@/components/EqualizerPanel.vue'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeIcon, NativeSpace, NativeTextarea } from '@/components/native'
import { vClickOutside } from '@/components/native/directives'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

const props = defineProps({
  visible: { type: Boolean, default: false },
  currentSong: { type: Object, default: null },
  isPlaying: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  volume: { type: Number, default: 70 },
  isMuted: { type: Boolean, default: false },
  playMode: { type: String, default: 'sequence' },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'toggle-play', 'prev', 'next', 'seek', 'volume-change', 'toggle-mute', 'toggle-play-mode'])

const showEqualizer = ref(false)
const isDraggingProgress = ref(false)
const dragProgress = ref(0)

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
    zIndex: 10001
  }
}

function handleWindowResize() {
  if (showEqualizer.value) {
    updateEqualizerPosition()
  }
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
})

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

// 歌词容器引用 - 必须在 useLyrics 之前定义
const lyricsContainer = ref(null)

const {
  lyrics, coverData,
  downloadingLyrics, showLyricsEditor, showUploadLyricsDialog, lyricsText, lyricsFile,
  isLineActive, handleUserScroll, seekToLine, downloadLyrics,
  saveLyrics, adjustLyricTime, handleCoverError, saveUploadedLyrics
} = useLyrics(props, emit, lyricsContainer)

// 歌词文件上传相关
const lyricsFileName = ref('')
const lyricsFileInput = ref(null)

function handleLyricsFileChange(event) {
  const file = event.target.files[0]
  if (file) {
    lyricsFileName.value = file.name
    const reader = new FileReader()
    reader.onload = (e) => {
      lyricsText.value = e.target.result
    }
    reader.readAsText(file)
  }
}

async function handleUploadLyrics() {
  if (!props.currentSong) return
  if (lyricsText.value.trim()) {
    await saveUploadedLyrics()
    lyricsFileName.value = ''
  } else {
    toast.warning('请选择文件或输入歌词')
  }
}



function handleProgressMouseDown(e) { isDraggingProgress.value = true; updateDragProgress(e) }
function handleProgressMouseMove(e) { if (isDraggingProgress.value) updateDragProgress(e) }
function handleProgressMouseUp(e) {
  if (isDraggingProgress.value) {
    isDraggingProgress.value = false
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    emit('seek', percent * props.duration)
  }
}
function handleProgressMouseLeave() { if (isDraggingProgress.value) isDraggingProgress.value = false }
function updateDragProgress(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const percent = ((e.clientX - rect.left) / rect.width) * 100
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
.lyrics-window-pc {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}

.lyrics-container {
  width: 100%;
  max-width: 1200px;
  height: 70vh;
  display: flex;
  gap: 60px;
  padding: 40px 60px;
}

.close-button {
  position: fixed;
  top: 30px;
  right: 40px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.8);
  transition: all 0.3s ease;
  z-index: 10000;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  transform: scale(1.1);
}

.left-section {
  flex: 0 0 400px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.disc-wrapper {
  position: relative;
  width: 300px;
  height: 300px;
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
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 10px 0;
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-artist {
  font-size: 16px;
  margin: 5px 0;
  opacity: 0.8;
}

.song-album {
  font-size: 14px;
  margin: 5px 0;
  opacity: 0.6;
}

.right-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.lyrics-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.lyrics-header h3 {
  color: #fff;
  font-size: 18px;
  margin: 0;
  white-space: nowrap;
  flex-shrink: 0;
}

.lyrics-header :deep(.native-space) {
  margin-left: auto;
  flex-wrap: nowrap;
  flex-shrink: 0;
  width: auto !important;
  justify-content: flex-end;
}

.lyrics-wrapper {
  flex: 1;
  display: flex;
  gap: 12px;
  overflow: hidden;
}

.lyrics-content {
  flex: 1;
  overflow-y: auto;
  padding-right: 20px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
}

.lyrics-content::-webkit-scrollbar {
  width: 6px;
}

.lyrics-content::-webkit-scrollbar-track {
  background: transparent;
}

.lyrics-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
}

.lyrics-line {
  padding: 12px 0;
  font-size: 18px;
  color: rgba(255, 255, 255, 0.5);
  transition: all 0.3s ease;
  cursor: pointer;
  user-select: none;
}

.lyrics-line:hover {
  color: rgba(255, 255, 255, 0.7);
}

.lyrics-line.active {
  font-size: 22px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
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
  margin: 20px 0;
  font-size: 16px;
}

.lyrics-empty .hint {
  margin: 10px 0;
  font-size: 14px;
  opacity: 0.6;
}

.time-adjust-buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 8px;
  flex-shrink: 0;
}

.adjust-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.adjust-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
  transform: scale(1.15);
}

.adjust-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.adjust-btn:first-child svg {
  transform: rotate(-90deg);
}

.adjust-btn:last-child svg {
  transform: rotate(90deg);
}

.bottom-player {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(10px);
  padding: 20px 40px;
  display: flex;
  align-items: center;
  gap: 30px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.player-controls {
  display: flex;
  align-items: center;
  gap: 15px;
}

.icon-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-btn.play-btn {
  padding: 6px;
}

.icon-btn.play-btn svg {
  width: 28px;
  height: 28px;
}

.mode-btn {
  opacity: 0.7;
}

.mode-btn:hover {
  opacity: 1;
}

.mode-btn.active {
  background: rgba(255, 255, 255, 0.15);
  opacity: 1;
}

.progress-section {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 15px;
}

.time {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  font-family: 'Courier New', monospace;
  min-width: 50px;
}

.progress-bar {
  flex: 1;
  height: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.progress-track {
  position: relative;
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
  border-radius: 2px;
  transition: width 0.1s linear;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.2s;
}

.progress-bar:hover .progress-thumb {
  opacity: 1;
}

.progress-bar:active .progress-thumb,
.progress-bar.dragging .progress-thumb {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1.2);
  box-shadow: 0 0 8px rgba(24, 144, 255, 0.6);
}

.extra-controls {
  display: flex;
  align-items: center;
  gap: 15px;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.volume-slider {
  width: 100px;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  -webkit-appearance: none;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
}

.white-text-btn {
  color: rgba(255, 255, 255, 0.9) !important;
}

.white-text-btn:hover {
  color: #fff !important;
  background-color: rgba(255, 255, 255, 0.1) !important;
}

@media (max-width: 1200px) {
  .lyrics-container { padding: 30px 40px; }
  .left-section { flex: 0 0 300px; }
  .disc-wrapper { width: 240px; height: 240px; }
}

@media (max-width: 900px) {
  .lyrics-container { flex-direction: column; height: 60vh; gap: 30px; }
  .left-section { flex: 0 0 auto; }
  .disc-wrapper { width: 200px; height: 200px; }
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