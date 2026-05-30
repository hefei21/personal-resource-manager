<template>
  <div>
    <!-- 最小化浮动按钮 -->
    <Transition name="minimize-float">
      <div v-if="currentSong && isMinimized && !showLyricsWindow" class="player-float-btn" @click="restorePlayer" :class="{ 'is-playing': isPlaying }">
        <div class="float-cover">
          <svg v-if="!currentSong.has_cover || coverLoadFailed || !playerCoverData" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
          <img v-else :src="playerCoverData" alt="cover" @error="handleCoverError" />
        </div>
        <button class="float-play-btn" @click.stop="togglePlay">
          <svg v-if="isPlaying" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    </Transition>

    <!-- 主播放器 -->
    <Transition name="player-slide">
      <div v-if="currentSong && !showLyricsWindow && !isMinimized" class="media-player">
        <div class="player-content">
          <!-- 歌曲信息 -->
          <div class="song-info">
            <div class="song-cover" :class="{ 'rotating': isPlaying }" @click="openLyricsWindow">
              <svg v-if="!currentSong.has_cover || coverLoadFailed || !playerCoverData" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
              <img v-else :src="playerCoverData" alt="cover" @error="handleCoverError" />
            </div>
            <div class="song-meta">
              <div class="song-title-wrapper">
                <div class="song-title" :class="{ 'scrolling': shouldScrollTitle }" @click="openLyricsWindow">
                  <span class="song-title-text">{{ currentSong.title }}</span>
                </div>
              </div>
              <div class="song-artist">{{ currentSong.artist || '未知艺术家' }}</div>
            </div>
            <button class="minimize-btn-mobile" @click="minimizePlayer" title="最小化">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 14l5-5 5 5z"/></svg>
            </button>
            <button class="close-btn-mobile" @click="closePlayer" title="关闭">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>

          <!-- 进度条 -->
          <div class="progress-section">
            <span class="time">{{ formatTime(isDraggingProgress ? (dragProgress / 100) * duration : currentTime) }}</span>
            <div class="progress-bar" :class="{ dragging: isDraggingProgress }"
              @touchstart="handleProgressTouchStart" @touchmove="handleProgressTouchMove" @touchend="handleProgressTouchEnd">
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${displayProgress}%` }"></div>
                <div class="progress-thumb" :style="{ left: `${displayProgress}%` }"></div>
              </div>
            </div>
            <span class="time">{{ formatTime(duration) }}</span>
          </div>

          <!-- 播放控制 -->
          <div class="player-controls">
            <button class="icon-btn" @click="togglePlayMode" :title="playModeText">
              <svg v-if="playMode === 'sequence'" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
              </svg>
              <svg v-else-if="playMode === 'loop'" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                <text x="12" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">1</text>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
              </svg>
            </button>
            <button class="icon-btn" @click="playPrev" :disabled="!hasPrev">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button class="icon-btn play-btn" @click="togglePlay">
              <svg v-if="isPlaying" viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              <svg v-else viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="icon-btn" @click="playNext" :disabled="!hasNext">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
            <button class="icon-btn" @click="showMobilePlaylist = true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 移动端播放列表抽屉 -->
    <Transition name="drawer-slide">
      <div v-if="showMobilePlaylist" class="mobile-playlist-drawer" @click.self="showMobilePlaylist = false">
        <div class="drawer-content">
          <div class="drawer-header">
            <span class="drawer-title">当前播放 ({{ playlist.length }})</span>
            <div class="drawer-actions">
              <button class="drawer-btn" @click="clearPlaylist" :disabled="playlist.length === 0">清空</button>
              <button class="drawer-close" @click="showMobilePlaylist = false">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
          </div>
          <div class="drawer-songs" ref="drawerSongsRef">
            <div v-for="(song, index) in playlist" :key="song.id" class="drawer-item" :class="{ active: currentSong?.id === song.id }" @click="playSongAtIndex(index); showMobilePlaylist = false">
              <div class="drawer-item-index">
                <span v-if="currentSong?.id !== song.id">{{ index + 1 }}</span>
                <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="#1890ff"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              </div>
              <div class="drawer-item-info">
                <div class="drawer-item-title">{{ song.title }}</div>
                <div class="drawer-item-artist">{{ song.artist || '未知艺术家' }}</div>
              </div>
              <button class="drawer-item-remove" @click.stop="removeFromPlaylist(index)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <div v-if="playlist.length === 0" class="drawer-empty"><p>播放列表为空</p></div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { usePlayer } from './usePlayer'

const player = usePlayer()
const drawerSongsRef = ref(null)

const {
  currentSong, isPlaying, currentTime, duration, playMode, showMobilePlaylist,
  isMinimized, coverLoadFailed, playerCoverData, shouldScrollTitle, playlist,
  hasPrev, hasNext, playModeText, displayProgress, isDraggingProgress, dragProgress,
  openLyricsWindow, handleCoverError, togglePlay, playPrev, playNext, togglePlayMode,
  minimizePlayer, restorePlayer, closePlayer, clearPlaylist, playSongAtIndex, removeFromPlaylist, formatTime
} = player

function handleProgressTouchStart(e) { isDraggingProgress.value = true; updateDragProgressFromTouch(e) }
function handleProgressTouchMove(e) { if (isDraggingProgress.value) { e.preventDefault(); updateDragProgressFromTouch(e) } }
function handleProgressTouchEnd() {
  if (isDraggingProgress.value) {
    isDraggingProgress.value = false
    if (player.audioRef.value && duration.value) player.audioRef.value.currentTime = (dragProgress.value / 100) * duration.value
  }
}
function updateDragProgressFromTouch(e) {
  const touch = e.touches[0]
  const rect = e.currentTarget.getBoundingClientRect()
  dragProgress.value = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100))
}
</script>

<style scoped>
.media-player {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: white;
  z-index: 1000;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
}

.player-content {
  display: flex;
  flex-direction: column;
  padding: 6px 12px 10px;
  gap: 8px;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.song-cover {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  animation: coverRotate 20s linear infinite paused;
  flex-shrink: 0;
}

.song-cover.rotating { animation-play-state: running; }

@keyframes coverRotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.song-cover img { width: 100%; height: 100%; object-fit: cover; }

.song-meta { flex: 1; min-width: 0; padding-left: 8px; }

.song-title-wrapper { max-width: calc(100vw - 120px); overflow: hidden; }

.song-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-artist { font-size: 12px; color: rgba(255, 255, 255, 0.75); margin-top: 2px; }

.minimize-btn-mobile, .close-btn-mobile {
  position: absolute;
  right: 32px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-btn-mobile { right: 0; }

.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.time { font-size: 10px; color: rgba(255, 255, 255, 0.7); min-width: 32px; text-align: center; }

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
  height: 3px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  position: relative;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: #1890ff;
  border-radius: 2px;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.player-controls {
  display: flex;
  justify-content: space-around;
  align-items: center;
  width: 100%;
  padding: 0;
}

.icon-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.icon-btn.play-btn svg { width: 28px; height: 28px; }

.player-float-btn {
  display: flex;
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  background: rgba(30, 30, 30, 0.95);
  backdrop-filter: blur(10px);
  border-radius: 20px;
  padding: 6px 12px;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  max-width: 200px;
  transition: all 0.3s ease;
}

.player-float-btn.is-playing .float-cover { animation: coverRotate 10s linear infinite; }

.float-cover {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.float-cover img { width: 100%; height: 100%; object-fit: cover; }

.float-play-btn {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}

.mobile-playlist-drawer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 10002;
}

.drawer-content {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  max-height: 60vh;
  background: #1a1a2e;
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.drawer-title { color: #fff; font-size: 16px; font-weight: 500; }

.drawer-actions { display: flex; align-items: center; gap: 12px; }

.drawer-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}

.drawer-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.drawer-close {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.drawer-songs {
  flex: 1;
  overflow-y: auto;
  padding-bottom: env(safe-area-inset-bottom, 20px);
}

.drawer-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  gap: 12px;
  cursor: pointer;
}

.drawer-item:active { background: rgba(255, 255, 255, 0.05); }
.drawer-item.active { background: rgba(24, 144, 255, 0.15); }

.drawer-item-index { width: 24px; color: rgba(255, 255, 255, 0.4); font-size: 14px; text-align: center; }

.drawer-item-info { flex: 1; overflow: hidden; }

.drawer-item-title { color: #fff; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.drawer-item-artist { color: rgba(255, 255, 255, 0.5); font-size: 12px; margin-top: 2px; }

.drawer-item-remove {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
}

.drawer-item:active .drawer-item-remove, .drawer-item:hover .drawer-item-remove { opacity: 1; }

.drawer-empty { padding: 40px 16px; text-align: center; color: rgba(255, 255, 255, 0.4); }

.player-slide-enter-active { transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.player-slide-leave-active { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.player-slide-enter-from { transform: translateY(100%); opacity: 0; }
.player-slide-leave-to { transform: translateY(100%); opacity: 0; }

.minimize-float-enter-active { transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.minimize-float-leave-active { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.minimize-float-enter-from { transform: translateX(-50%) translateY(-100%); opacity: 0; }
.minimize-float-leave-to { transform: translateX(-50%) translateY(-100%); opacity: 0; }

.drawer-slide-enter-active, .drawer-slide-leave-active { transition: all 0.3s ease; }
.drawer-slide-enter-from, .drawer-slide-leave-to { opacity: 0; }
.drawer-slide-enter-active .drawer-content, .drawer-slide-leave-active .drawer-content { transition: transform 0.3s ease; }
.drawer-slide-enter-from .drawer-content, .drawer-slide-leave-to .drawer-content { transform: translateY(100%); }
</style>