import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import api from '@/api'
import { getCoverFromCache, saveCoverToCache, initCoverDB } from '@/utils/coverCache'
import { equalizer } from '@/utils/Equalizer.js'
import { usePermission } from '@/composables/usePermission'

// 创建单例状态
let globalState = null

export function usePlayer() {
  const { isGuest } = usePermission()
  
  if (globalState) {
    // 确保事件监听器始终存在（单例模式下组件重新挂载时）
    window.removeEventListener('play-music', globalState._handlePlayMusic)
    window.removeEventListener('remove-music', globalState._handleRemoveMusic)
    window.removeEventListener('open-playlist', globalState._handleOpenPlaylist)
    window.addEventListener('play-music', globalState._handlePlayMusic)
    window.addEventListener('remove-music', globalState._handleRemoveMusic)
    window.addEventListener('open-playlist', globalState._handleOpenPlaylist)
    return globalState
  }

  // 状态
  const audioRef = ref(null)
  const currentSong = ref(null)
  const playlist = ref([])
  const currentIndex = ref(-1)
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(parseInt(localStorage.getItem('playerVolume')) || 80)
  const isMuted = ref(false)
  const playMode = ref(localStorage.getItem('playMode') || 'sequence')
  const showPlaylist = ref(false)
  const isSidebarMode = ref(false)
  const coverLoadFailed = ref(false)
  const playerCoverData = ref(null)
  const showLyricsWindow = ref(false)
  const showMobilePlaylist = ref(false)
  const isMinimized = ref(false)
  const isDraggingProgress = ref(false)
  const dragProgress = ref(0)
  const showEqualizer = ref(false)
  const equalizerInitialized = ref(false)

  // 计算属性
  const progress = computed(() => {
    if (!duration.value) return 0
    return (currentTime.value / duration.value) * 100
  })

  const displayProgress = computed(() => {
    return isDraggingProgress.value ? dragProgress.value : progress.value
  })

  const hasPrev = computed(() => playlist.value.length > 1)
  const hasNext = computed(() => playlist.value.length > 1)
  
  // 移动端检测 - 使用 ref 以便响应窗口变化
  const isMobile = ref(window.innerWidth <= 768)
  
  // 监听窗口大小变化
  function handleResize() {
    isMobile.value = window.innerWidth <= 768
  }
  
  onMounted(() => {
    window.addEventListener('resize', handleResize)
  })
  
  onUnmounted(() => {
    window.removeEventListener('resize', handleResize)
  })

  const shouldScrollTitle = computed(() => {
    if (!currentSong.value?.title) return false
    const threshold = isSidebarMode.value ? 11 : 15
    return currentSong.value.title.length > threshold
  })

  const playModeText = computed(() => {
    const texts = { sequence: '列表循环', loop: '单曲循环', shuffle: '随机播放' }
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
    coverLoadFailed.value = false
    playerCoverData.value = null
    if (song.duration && song.duration > 0) duration.value = song.duration
    loadPlayerCover(song)
    await nextTick()
    window.dispatchEvent(new CustomEvent('player-appeared'))
    loadAndPlay()
  }

  function playSongAtIndex(index) {
    if (index >= 0 && index < playlist.value.length) {
      currentIndex.value = index
      currentSong.value = playlist.value[index]
      coverLoadFailed.value = false
      playerCoverData.value = null
      loadPlayerCover(currentSong.value)
      loadAndPlay()
    }
  }

  async function loadPlayerCover(song) {
    if (!song || !song.has_cover) {
      playerCoverData.value = null
      return
    }
    try {
      const cached = await getCoverFromCache(song.id)
      if (cached) { playerCoverData.value = cached; return }
      const response = await api.music.getCover(song.id)
      const cover = response.data.cover
      if (cover) { playerCoverData.value = cover; await saveCoverToCache(song.id, cover) }
    } catch (e) { coverLoadFailed.value = true }
  }

  function handleCoverError() { coverLoadFailed.value = true }

  async function loadAndPlay() {
    if (!currentSong.value || !audioRef.value) return
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    audioRef.value.src = `/api/music/play/${currentSong.value.id}?token=${token}`
    audioRef.value.volume = volume.value / 100
    audioRef.value.load()
    
    // 移动端需要在用户手势中直接调用 play，不能等 canplay 事件
    try {
      await audioRef.value.play()
      isPlaying.value = true
    } catch (e) {
      // 播放失败（如浏览器阻止自动播放），等待用户手动点击
      isPlaying.value = false
    }
  }

  async function handleCanPlay() {
    if (!equalizerInitialized.value && audioRef.value) {
      try { equalizerInitialized.value = await equalizer.init(audioRef.value) } catch (e) {}
    }
    if (audioRef.value && currentSong.value) {
      audioRef.value.play().then(() => isPlaying.value = true).catch(() => {})
    }
  }

  function togglePlay() {
    if (!audioRef.value || !currentSong.value) return
    if (isPlaying.value) { audioRef.value.pause(); isPlaying.value = false }
    else {
      if (!audioRef.value.src || audioRef.value.src === window.location.href) loadAndPlay()
      else audioRef.value.play().then(() => isPlaying.value = true).catch(() => {})
    }
  }

  function playPrev() {
    if (playlist.value.length <= 1) return
    if (playMode.value === 'shuffle') playSongAtIndex(Math.floor(Math.random() * playlist.value.length))
    else playSongAtIndex(currentIndex.value - 1 < 0 ? playlist.value.length - 1 : currentIndex.value - 1)
  }

  function playNext() {
    if (playlist.value.length <= 1) return
    if (playMode.value === 'shuffle') playSongAtIndex(Math.floor(Math.random() * playlist.value.length))
    else playSongAtIndex(currentIndex.value + 1 >= playlist.value.length ? 0 : currentIndex.value + 1)
  }

  function togglePlayMode() {
    const modes = ['sequence', 'loop', 'shuffle']
    playMode.value = modes[(modes.indexOf(playMode.value) + 1) % modes.length]
    if (!isGuest.value) localStorage.setItem('playMode', playMode.value)
  }

  // 歌词窗口控制
  function openLyricsWindow() { if (currentSong.value) showLyricsWindow.value = true }
  function closeLyricsWindow() { showLyricsWindow.value = false }
  function seekToTime(time) { if (audioRef.value) audioRef.value.currentTime = time }

  // 进度控制
  function handleTimeUpdate() {
    if (audioRef.value) {
      currentTime.value = audioRef.value.currentTime
      if (isMobile.value && duration.value === 0 && audioRef.value.duration && !isNaN(audioRef.value.duration)) {
        duration.value = audioRef.value.duration
      }
    }
  }

  function handleLoaded() { if (audioRef.value) duration.value = audioRef.value.duration }

  function handleEnded() {
    if (playMode.value === 'loop') { audioRef.value.currentTime = 0; audioRef.value.play() }
    else if (playlist.value.length === 1) { audioRef.value.currentTime = 0; audioRef.value.play() }
    else playNext()
  }

  function handleError(e) { console.error('音频加载错误:', e) }

  // 音量控制
  function changeVolume(vol) {
    if (vol !== undefined) volume.value = vol
    if (audioRef.value) {
      audioRef.value.volume = volume.value / 100
      if (!isGuest.value) localStorage.setItem('playerVolume', volume.value)
    }
  }

  function toggleMute() { if (audioRef.value) { isMuted.value = !isMuted.value; audioRef.value.muted = isMuted.value } }

  // 播放列表管理
  function removeFromPlaylist(index) {
    if (index === currentIndex.value) playNext()
    playlist.value.splice(index, 1)
    if (index < currentIndex.value) currentIndex.value--
  }

  function removeSongById(songId) {
    const index = playlist.value.findIndex(s => s.id === songId)
    if (index !== -1) removeFromPlaylist(index)
  }

  function removeSongsByIds(songIds) {
    const idSet = new Set(songIds)
    for (let i = playlist.value.length - 1; i >= 0; i--) {
      if (idSet.has(playlist.value[i].id)) removeFromPlaylist(i)
    }
  }

  function clearPlaylist() {
    playlist.value = []
    currentSong.value = null
    currentIndex.value = -1
    isPlaying.value = false
    if (audioRef.value) { audioRef.value.pause(); audioRef.value.src = '' }
  }

  function closePlayer() {
    currentSong.value = null
    isPlaying.value = false
    isMinimized.value = false
    if (audioRef.value) audioRef.value.pause()
    window.dispatchEvent(new CustomEvent('player-closed'))
  }

  // 最小化/恢复（移动端）
  function minimizePlayer() {
    isMinimized.value = true
    window.dispatchEvent(new CustomEvent('player-minimized'))
    document.documentElement.style.setProperty('--player-height', '0px')
    document.body.style.paddingBottom = '0px'
    const mainContent = document.querySelector('.main-content')
    if (mainContent) mainContent.style.paddingBottom = '0px'
    const scrollContent = document.querySelector('.scrollable-content')
    if (scrollContent) scrollContent.style.paddingBottom = '20px'
  }

  function restorePlayer() {
    isMinimized.value = false
    window.dispatchEvent(new CustomEvent('player-restored'))
    setTimeout(() => {
      const playerHeight = document.querySelector('.media-player')?.offsetHeight || 70
      document.body.style.paddingBottom = playerHeight + 'px'
      const mainContent = document.querySelector('.main-content')
      if (mainContent) mainContent.style.paddingBottom = playerHeight + 'px'
      const scrollContent = document.querySelector('.scrollable-content')
      if (scrollContent) scrollContent.style.paddingBottom = (playerHeight + 20) + 'px'
    }, 100)
  }

  // 格式化时间
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // 事件监听
  function handlePlayMusic(e) { isSidebarMode.value = false; playSong(e.detail.song, e.detail.list) }
  function handleRemoveMusic(e) {
    if (e.detail.songIds) removeSongsByIds(e.detail.songIds)
    else if (e.detail.songId) removeSongById(e.detail.songId)
  }
  function handleOpenPlaylist() { if (isMobile.value) showMobilePlaylist.value = true }
  function checkRouteChange() {
    isSidebarMode.value = currentSong.value !== null && window.location.pathname !== '/music' && !isMobile.value
  }

  onMounted(async () => {
    try { await initCoverDB() } catch (e) {}
    if (isGuest.value) { volume.value = 80; playMode.value = 'sequence' }
    else {
      volume.value = parseInt(localStorage.getItem('playerVolume')) || 80
      playMode.value = localStorage.getItem('playMode') || 'sequence'
    }
    window.addEventListener('play-music', handlePlayMusic)
    window.addEventListener('remove-music', handleRemoveMusic)
    window.addEventListener('open-playlist', handleOpenPlaylist)
    checkRouteChange()
    window.addEventListener('popstate', checkRouteChange)
    setInterval(checkRouteChange, 500)
  })

  onUnmounted(() => {
    // 单例模式下不移除事件监听器，确保其他组件或重新挂载后仍能接收事件
    // 只清理均衡器等资源
    if (equalizerInitialized.value) equalizer.destroy()
  })

  // 保存全局状态（包含事件处理函数引用，用于单例模式下重新挂载时恢复监听）
  globalState = {
    audioRef, currentSong, playlist, currentIndex, isPlaying, currentTime, duration,
    volume, isMuted, playMode, showPlaylist, isSidebarMode, coverLoadFailed, playerCoverData,
    showLyricsWindow, showMobilePlaylist, isMinimized, isDraggingProgress, dragProgress,
    showEqualizer, equalizerInitialized,
    progress, displayProgress, hasPrev, hasNext, isMobile, shouldScrollTitle, playModeText,
    playSong, playSongAtIndex, loadPlayerCover, handleCoverError, loadAndPlay, handleCanPlay,
    togglePlay, playPrev, playNext, togglePlayMode, openLyricsWindow, closeLyricsWindow, seekToTime,
    handleTimeUpdate, handleLoaded, handleEnded, handleError, changeVolume, toggleMute,
    removeFromPlaylist, removeSongById, removeSongsByIds, clearPlaylist, closePlayer,
    minimizePlayer, restorePlayer, formatTime,
    // 保存处理函数引用
    _handlePlayMusic: handlePlayMusic,
    _handleRemoveMusic: handleRemoveMusic,
    _handleOpenPlaylist: handleOpenPlaylist
  }

  return globalState
}
