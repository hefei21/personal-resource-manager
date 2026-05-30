<template>
  <div>
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
    <MediaPlayerPC v-if="!isMobile" />
    <MediaPlayerMobile v-else />
    <audio
      ref="audioRef"
      style="position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none;"
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
import { ref, onMounted, onUnmounted } from 'vue'
import { usePlayer } from './usePlayer'
import LyricsWindow from '../lyrics-window/index.vue'
import MediaPlayerPC from './MediaPlayerPC.vue'
import MediaPlayerMobile from './MediaPlayerMobile.vue'

const player = usePlayer()
const {
  audioRef, currentSong, isPlaying, currentTime, duration, volume, isMuted,
  playMode, showLyricsWindow, hasPrev, hasNext,
  closeLyricsWindow, togglePlay, playPrev, playNext, seekToTime,
  changeVolume, toggleMute, togglePlayMode,
  handleTimeUpdate, handleEnded, handleLoaded, handleError, handleCanPlay
} = player

// 独立的移动端检测（不依赖单例中的 isMobile）
const isMobile = ref(false)

// 挂载后检测窗口大小
onMounted(() => {
  isMobile.value = window.innerWidth <= 768
  console.log('[MediaPlayer] isMobile:', isMobile.value, 'windowWidth:', window.innerWidth)
  window.addEventListener('resize', handleResize)
})

function handleResize() {
  isMobile.value = window.innerWidth <= 768
  console.log('[MediaPlayer] resize isMobile:', isMobile.value)
}

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
})
</script>