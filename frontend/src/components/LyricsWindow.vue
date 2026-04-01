<template>
  <Transition name="lyrics-fade">
    <div v-if="visible" class="lyrics-window" @click.self="handleClose">
      <!-- 关闭按钮 -->
      <button class="close-button" @click="handleClose" title="关闭">
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
                <t-icon name="music" size="120px" />
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
            <t-space>
              <t-button
                size="small"
                variant="text"
                @click="downloadLyrics"
                :loading="downloadingLyrics"
                class="white-text-btn"
              >
                <template #icon><t-icon name="download" /></template>
                获取歌词
              </t-button>
              <t-button
                size="small"
                variant="text"
                @click="showUploadLyricsDialog = true"
                class="white-text-btn"
              >
                <template #icon><t-icon name="upload" /></template>
                上传歌词
              </t-button>
              <t-button
                v-if="currentSong?.has_lyrics"
                size="small"
                variant="text"
                @click="showLyricsEditor = true"
              >
                <template #icon><t-icon name="edit" /></template>
                编辑
              </t-button>
            </t-space>
          </div>
          
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
            <t-icon name="file-text" size="48px" />
            <p>暂无歌词</p>
            <p class="hint">点击顶部"获取歌词"按钮自动搜索</p>
          </div>
        </div>
      </div>
      
      <!-- 底部播放栏 -->
      <div class="bottom-player">
        <div class="player-controls">
          <button class="icon-btn" @click="playPrev" :disabled="!hasPrev" title="上一首">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          
          <t-button
            theme="primary"
            shape="circle"
            size="large"
            @click="togglePlay"
          >
            <t-icon :name="isPlaying ? 'pause' : 'play'" size="20px" />
          </t-button>
          
          <button class="icon-btn" @click="playNext" :disabled="!hasNext" title="下一首">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>
        
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
        
        <div class="extra-controls">
          <div class="volume-control">
            <button class="icon-btn" @click="toggleMute" title="静音">
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
              v-model="localVolume"
              @input="changeVolume"
              class="volume-slider"
            />
          </div>
          
          <button class="icon-btn mode-btn" @click="togglePlayMode" :title="playModeText">
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
        </div>
      </div>
      
      <!-- 歌词编辑器对话框 -->
      <t-dialog
        v-model:visible="showLyricsEditor"
        header="编辑歌词"
        width="600px"
        :confirm-btn="{ content: '保存', theme: 'primary' }"
        @confirm="saveLyrics"
      >
        <t-textarea
          v-model="lyricsText"
          placeholder="请输入LRC格式歌词，例如：&#10;[00:00.00]歌曲名称&#10;[00:10.50]第一句歌词"
          :autosize="{ minRows: 10, maxRows: 20 }"
        />
      </t-dialog>

      <!-- 手动上传歌词对话框 -->
      <t-dialog
        v-model:visible="showUploadLyricsDialog"
        header="上传歌词"
        width="600px"
        :confirm-btn="{ content: '保存', theme: 'primary' }"
        @confirm="handleUploadLyrics"
      >
        <div style="margin-bottom: 12px;">
          <t-upload
            v-model="lyricsFile"
            accept=".lrc,.txt"
            :auto-upload="false"
            :multiple="false"
            theme="file-input"
            placeholder="选择LRC歌词文件"
          />
        </div>
        <t-textarea
          v-model="lyricsText"
          placeholder="或手动粘贴LRC格式歌词，例如：&#10;[00:00.00]歌曲名称&#10;[00:10.50]第一句歌词"
          :autosize="{ minRows: 10, maxRows: 20 }"
        />
      </t-dialog>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '../api'

// Props
const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  currentSong: {
    type: Object,
    default: null
  },
  isPlaying: {
    type: Boolean,
    default: false
  },
  currentTime: {
    type: Number,
    default: 0
  },
  duration: {
    type: Number,
    default: 0
  },
  volume: {
    type: Number,
    default: 70
  },
  isMuted: {
    type: Boolean,
    default: false
  },
  playMode: {
    type: String,
    default: 'sequence'
  },
  hasPrev: {
    type: Boolean,
    default: false
  },
  hasNext: {
    type: Boolean,
    default: false
  }
})

// Emits
const emit = defineEmits([
  'close',
  'toggle-play',
  'prev',
  'next',
  'seek',
  'volume-change',
  'toggle-mute',
  'toggle-play-mode'
])

// 状态
const lyrics = ref([])
const currentLineIndex = ref(0)
const lyricsContainer = ref(null)
const coverData = ref(null)
const coverLoadFailed = ref(false)
const downloadingLyrics = ref(false)
const showLyricsEditor = ref(false)
const showUploadLyricsDialog = ref(false)
const lyricsText = ref('')
const lyricsFile = ref([])
const userScrolling = ref(false)
const localVolume = ref(props.volume) // 本地音量状态，避免 props 响应式冲突
let scrollTimer = null

// 计算属性
const progress = computed(() => {
  if (!props.duration) return 0
  return (props.currentTime / props.duration) * 100
})

const playModeText = computed(() => {
  const modeMap = {
    'sequence': '顺序播放',
    'loop': '单曲循环',
    'random': '随机播放'
  }
  return modeMap[props.playMode] || '顺序播放'
})

// 监听当前歌曲变化，加载歌词
watch(() => props.currentSong, async (newSong) => {
  if (newSong && newSong.id) {
    await loadLyrics()
    await loadCover()
  }
}, { immediate: true })

// 监听 props.volume 变化，同步到本地音量
watch(() => props.volume, (newVol) => {
  localVolume.value = newVol
})

// 监听播放时间，更新当前行索引
watch(() => props.currentTime, (time) => {
  if (lyrics.value.length > 0) {
    updateCurrentLine(time)
  }
})

// 监听歌词窗口关闭，清除定时器
watch(() => props.visible, (val) => {
  if (!val && scrollTimer) {
    clearTimeout(scrollTimer)
    scrollTimer = null
    userScrolling.value = false
  }
})

// 加载歌词
async function loadLyrics() {
  if (!props.currentSong || !props.currentSong.id) return
  
  try {
    const response = await api.music.getLyrics(props.currentSong.id)
    
    if (response.data.lyrics) {
      lyrics.value = parseLRC(response.data.lyrics)
      lyricsText.value = response.data.lyrics
    } else {
      lyrics.value = []
      lyricsText.value = ''
    }
  } catch (error) {
    console.error('加载歌词失败:', error)
    lyrics.value = []
  }
}

// 加载封面
async function loadCover() {
  if (!props.currentSong || !props.currentSong.has_cover) {
    coverData.value = null
    return
  }
  
  try {
    const response = await api.music.getCover(props.currentSong.id)
    coverData.value = response.data.cover
    coverLoadFailed.value = false
  } catch (error) {
    console.error('加载封面失败:', error)
    coverLoadFailed.value = true
  }
}

// 解析LRC歌词
function parseLRC(lrcText) {
  if (!lrcText) return []
  
  const lines = lrcText.split('\n')
  const result = []
  
  for (const line of lines) {
    const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
    if (match) {
      const minutes = parseInt(match[1])
      const seconds = parseInt(match[2])
      const milliseconds = parseInt(match[3])
      const time = minutes * 60 + seconds + milliseconds / 1000
      const text = match[4].trim()
      
      result.push({ time, text })
    }
  }
  
  return result.sort((a, b) => a.time - b.time)
}

// 更新当前行索引（二分查找）
function updateCurrentLine(currentTime) {
  if (lyrics.value.length === 0) return
  
  let left = 0
  let right = lyrics.value.length - 1
  
  while (left < right) {
    const mid = Math.ceil((left + right) / 2)
    if (lyrics.value[mid].time <= currentTime) {
      left = mid
    } else {
      right = mid - 1
    }
  }
  
  currentLineIndex.value = left
  
  // 只有用户没有在滚动时才自动滚动
  if (!userScrolling.value) {
    scrollToCurrentLine()
  }
}

// 判断行是否应该高亮（双语歌词：相同时间戳的行都高亮）
function isLineActive(index) {
  if (lyrics.value.length === 0) return false
  
  const currentTime = lyrics.value[currentLineIndex.value]?.time
  if (currentTime === undefined) return false
  
  // 当前索引高亮
  if (index === currentLineIndex.value) return true
  
  // 检查是否有相同时间戳的相邻行（双语歌词）
  // 向前查找
  if (index === currentLineIndex.value - 1 && lyrics.value[index]?.time === currentTime) {
    return true
  }
  // 向后查找
  if (index === currentLineIndex.value + 1 && lyrics.value[index]?.time === currentTime) {
    return true
  }
  
  return false
}

// 用户滚动处理
function handleUserScroll() {
  // 标记用户正在滚动
  userScrolling.value = true
  
  // 清除之前的定时器
  if (scrollTimer) {
    clearTimeout(scrollTimer)
  }
  
  // 设置新的定时器：3秒后恢复自动滚动
  scrollTimer = setTimeout(() => {
    userScrolling.value = false
  }, 3000)
}

// 滚动到当前行
function scrollToCurrentLine() {
  if (!lyricsContainer.value) return
  
  const activeEl = lyricsContainer.value.querySelector('.lyrics-line.active')
  if (activeEl) {
    activeEl.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  }
}

// 点击歌词行跳转
function seekToLine(time) {
  emit('seek', time)
}

// 下载歌词（异步任务，强制重新下载）
async function downloadLyrics() {
  if (!props.currentSong) return
  
  downloadingLyrics.value = true
  
  try {
    // force=true 强制重新下载，即使已有歌词
    const response = await api.music.downloadLyrics([props.currentSong.id], true)
    
    if (response.data.success) {
      const taskId = response.data.taskId
      // 轮询任务进度
      await pollTaskProgress(taskId)
    } else {
      MessagePlugin.warning(response.data.message || '未找到歌词')
    }
  } catch (error) {
    console.error('下载歌词失败:', error)
    MessagePlugin.error('下载歌词失败')
  } finally {
    downloadingLyrics.value = false
  }
}

// 轮询任务进度
async function pollTaskProgress(taskId) {
  try {
    const response = await api.music.getLyricsTask(taskId)
    const task = response.data.task
    
    if (task.status === 'completed') {
      if (task.success > 0) {
        MessagePlugin.success('歌词下载成功')
        await loadLyrics()
      } else {
        MessagePlugin.warning('未找到歌词')
      }
    } else if (task.status === 'failed') {
      MessagePlugin.error('歌词下载失败')
    } else {
      // 继续轮询
      setTimeout(() => pollTaskProgress(taskId), 1000)
    }
  } catch (error) {
    console.error('查询进度失败:', error)
    MessagePlugin.error('查询进度失败')
  }
}

// 保存歌词
async function saveLyrics() {
  if (!props.currentSong || !lyricsText.value.trim()) {
    MessagePlugin.warning('歌词不能为空')
    return
  }
  
  try {
    await api.music.updateLyrics(props.currentSong.id, lyricsText.value)
    MessagePlugin.success('歌词保存成功')
    await loadLyrics()
    showLyricsEditor.value = false
  } catch (error) {
    console.error('保存歌词失败:', error)
    MessagePlugin.error('保存失败')
  }
}

// 手动上传歌词
async function handleUploadLyrics() {
  if (!props.currentSong) return
  
  // 如果有文件上传，读取文件内容
  if (lyricsFile.value && lyricsFile.value.length > 0) {
    const file = lyricsFile.value[0].raw
    if (file) {
      const reader = new FileReader()
      reader.onload = async (e) => {
        lyricsText.value = e.target.result
        await saveUploadedLyrics()
      }
      reader.readAsText(file)
    }
  } else if (lyricsText.value.trim()) {
    // 如果是手动粘贴的歌词
    await saveUploadedLyrics()
  } else {
    MessagePlugin.warning('请选择文件或输入歌词')
    return false
  }
}

// 保存上传的歌词
async function saveUploadedLyrics() {
  if (!lyricsText.value.trim()) {
    MessagePlugin.warning('歌词不能为空')
    return
  }
  
  try {
    await api.music.updateLyrics(props.currentSong.id, lyricsText.value, '手动上传')
    MessagePlugin.success('歌词上传成功')
    await loadLyrics()
    showUploadLyricsDialog.value = false
    lyricsFile.value = []
    lyricsText.value = ''
  } catch (error) {
    console.error('上传歌词失败:', error)
    MessagePlugin.error('上传失败')
  }
}

// 播放控制
function togglePlay() {
  emit('toggle-play')
}

function playPrev() {
  emit('prev')
}

function playNext() {
  emit('next')
}

function seekTo(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const percent = (e.clientX - rect.left) / rect.width
  emit('seek', percent * props.duration)
}

function changeVolume(e) {
  const vol = parseInt(e.target.value)
  localVolume.value = vol
  emit('volume-change', vol)
}

function toggleMute() {
  emit('toggle-mute')
}

function togglePlayMode() {
  emit('toggle-play-mode')
}

function handleClose() {
  emit('close')
}

function handleCoverError() {
  coverLoadFailed.value = true
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.lyrics-window {
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
  backdrop-filter: blur(20px);
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

.lyrics-container {
  width: 100%;
  max-width: 1200px;
  height: 70vh;
  display: flex;
  gap: 60px;
  padding: 40px 60px;
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

.mode-btn {
  opacity: 0.7;
}

.mode-btn:hover {
  opacity: 1;
}

/* 过渡动画 */
.lyrics-fade-enter-active,
.lyrics-fade-leave-active {
  transition: all 0.3s ease;
}

.lyrics-fade-enter-from,
.lyrics-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

/* 响应式设计 */
@media (max-width: 1200px) {
  .lyrics-container {
    padding: 30px 40px;
  }
  
  .left-section {
    flex: 0 0 300px;
  }
  
  .disc-wrapper {
    width: 240px;
    height: 240px;
  }
}

@media (max-width: 900px) {
  .lyrics-container {
    flex-direction: column;
    height: 60vh;
    gap: 30px;
  }
  
  .left-section {
    flex: 0 0 auto;
  }
  
  .disc-wrapper {
    width: 200px;
    height: 200px;
  }
}

/* 白色文字按钮 */
.white-text-btn {
  color: rgba(255, 255, 255, 0.9) !important;
}

.white-text-btn:hover {
  color: #fff !important;
  background-color: rgba(255, 255, 255, 0.1) !important;
}
</style>
