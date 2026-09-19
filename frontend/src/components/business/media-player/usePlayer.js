import { ref, computed, watch } from 'vue'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { equalizer } from '@/utils/Equalizer'
import { normalizeQueue, nextQueueIndex, playbackSnapshot, readPlaybackSnapshot } from '@/utils/musicPlaybackState'

let globalState
export function usePlayer() {
  if (globalState) return globalState
  const auth = useAuthStore()
  const audioRef = ref(null), currentSong = ref(null), playlist = ref([]), currentIndex = ref(-1)
  const isPlaying = ref(false), currentTime = ref(0), duration = ref(0), volume = ref(80), isMuted = ref(false)
  const playMode = ref('sequence'), showPlaylist = ref(false), showMobilePlaylist = ref(false)
  const showLyricsWindow = ref(false), showNowPlaying = ref(false)
  const showEqualizer = ref(false)
  const playerCoverData = ref(null), coverLoadFailed = ref(false)
  const playbackState = ref('idle'), playbackError = ref('')
  const isDraggingProgress = ref(false), dragProgress = ref(0)
  const progress = computed(() => duration.value > 0 ? Math.min(100, currentTime.value / duration.value * 100) : 0)
  const displayProgress = computed(() => isDraggingProgress.value ? dragProgress.value : progress.value)
  const hasPrev = computed(() => playlist.value.length > 1), hasNext = computed(() => playlist.value.length > 1)
  const playModeText = computed(() => ({ sequence: '列表循环', loop: '单曲循环', shuffle: '随机播放' })[playMode.value])
  const statusText = computed(() => playbackError.value || ({ loading: '加载中…', buffering: '缓冲中…', restored: '已恢复，点击播放', paused: '已暂停' })[playbackState.value] || currentSong.value?.artist || '未知艺术家')
  let generation = 0, coverGeneration = 0, wantsPlayback = false, pendingSeek = null, lastSaved = 0
  let storageKey = null, stopAuthWatch = null, mounted = false

  function persist() {
    if (!storageKey || !auth.isAuthenticated || auth.isGuest()) return
    try { localStorage.setItem(storageKey, JSON.stringify(playbackSnapshot(playlist.value, currentSong.value?.id, currentTime.value, volume.value, playMode.value))) } catch { /* storage unavailable: current session still works */ }
    lastSaved = Date.now()
  }
  function restore() {
    const identity = auth.user?.id ?? auth.user?.username
    const nextKey = auth.isAuthenticated && identity != null && !auth.isGuest() ? 'pr-manager:music:v1:' + encodeURIComponent(identity) : null
    if (storageKey === nextKey) return
    if (storageKey && !nextKey) { try { localStorage.removeItem(storageKey) } catch {} }
    reset(false)
    storageKey = nextKey
    if (!storageKey) return
    let snapshot
    try { snapshot = readPlaybackSnapshot(localStorage.getItem(storageKey)) } catch {}
    if (!snapshot) return
    playlist.value = snapshot.queue
    currentIndex.value = playlist.value.findIndex(song => song.id === snapshot.songId)
    currentSong.value = playlist.value[currentIndex.value] || null
    currentTime.value = snapshot.position
    volume.value = snapshot.volume
    playMode.value = snapshot.mode
    duration.value = currentSong.value?.duration || 0
    if (currentSong.value) { playbackState.value = 'restored'; loadPlayerCover(currentSong.value) }
  }
  async function loadPlayerCover(song) {
    const request = ++coverGeneration
    playerCoverData.value = null; coverLoadFailed.value = false
    if (!song?.has_cover) return
    try {
      const response = await api.music.getCover(song.id)
      if (request === coverGeneration && song.id === currentSong.value?.id) playerCoverData.value = response.data.cover || null
    } catch { if (request === coverGeneration) coverLoadFailed.value = true }
  }
  function handleCoverError() { coverLoadFailed.value = true }
  async function requestPlay(request = generation) {
    const audio = audioRef.value
    if (!audio) return
    wantsPlayback = true
    try {
      await audio.play()
      if (request !== generation || !wantsPlayback) return
      isPlaying.value = true; playbackState.value = 'playing'; playbackError.value = ''
    } catch (error) {
      if (request !== generation || !wantsPlayback) return
      wantsPlayback = false; isPlaying.value = false
      playbackState.value = 'error'
      playbackError.value = error?.name === 'NotAllowedError' ? '浏览器暂未允许播放，请点击重试' : '无法播放此曲目，请重试或切换下一首'
    }
  }
  function loadAndPlay(position = 0) {
    const audio = audioRef.value
    if (!audio || !currentSong.value) return
    const request = ++generation
    audio.pause()
    wantsPlayback = true; isPlaying.value = false; playbackError.value = ''; playbackState.value = 'loading'
    pendingSeek = Math.max(0, position)
    audio.src = authenticatedAssetUrl('/api/music/play/' + currentSong.value.id)
    audio.volume = volume.value / 100; audio.muted = isMuted.value
    audio.load()
    // Invoke play in the originating user gesture; canplay never initiates playback.
    requestPlay(request)
  }
  function playSong(song, list = null) {
    const target = normalizeQueue([song])[0]
    if (!target) return
    playlist.value = normalizeQueue(list || playlist.value)
    if (!playlist.value.some(item => item.id === target.id)) playlist.value.push(target)
    currentIndex.value = playlist.value.findIndex(item => item.id === target.id)
    currentSong.value = target; currentTime.value = 0; duration.value = target.duration
    loadPlayerCover(target); loadAndPlay(); persist()
  }
  function playSongAtIndex(index) {
    const song = playlist.value[index]
    if (song) playSong(song)
  }
  function togglePlay() {
    if (!currentSong.value || !audioRef.value) return
    if (wantsPlayback || isPlaying.value) {
      wantsPlayback = false; ++generation; audioRef.value.pause()
      isPlaying.value = false; playbackState.value = 'paused'; persist()
    } else if (!audioRef.value.getAttribute('src') || playbackState.value === 'error' || playbackState.value === 'restored') {
      loadAndPlay(currentTime.value)
    } else { playbackState.value = 'loading'; requestPlay(++generation) }
  }
  function retryPlayback() { loadAndPlay(currentTime.value) }
  function playPrev() { playSongAtIndex(nextQueueIndex(currentIndex.value, playlist.value.length, -1, playMode.value === 'shuffle')) }
  function playNext() { playSongAtIndex(nextQueueIndex(currentIndex.value, playlist.value.length, 1, playMode.value === 'shuffle')) }
  function togglePlayMode() {
    const modes = ['sequence', 'loop', 'shuffle']
    playMode.value = modes[(modes.indexOf(playMode.value) + 1) % modes.length]; persist()
  }
  function seekToTime(value) {
    const time = Number(value)
    if (!Number.isFinite(time) || !Number.isFinite(duration.value) || duration.value <= 0) return
    currentTime.value = Math.max(0, Math.min(time, duration.value))
    if (audioRef.value?.readyState > 0) audioRef.value.currentTime = currentTime.value
    else pendingSeek = currentTime.value
    persist()
  }
  function handleLoaded() {
    const audio = audioRef.value
    if (!currentSong.value || !audio) return
    duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
    if (pendingSeek !== null && duration.value > 0) {
      audio.currentTime = Math.min(pendingSeek, Math.max(0, duration.value - .1))
      currentTime.value = audio.currentTime; pendingSeek = null
    }
  }
  function handleTimeUpdate() {
    if (!currentSong.value || !audioRef.value || pendingSeek !== null) return
    currentTime.value = Number.isFinite(audioRef.value.currentTime) ? audioRef.value.currentTime : 0
    if (Date.now() - lastSaved > 5000) persist()
  }
  function handlePlaying() {
    if (!wantsPlayback) { audioRef.value?.pause(); return }
    isPlaying.value = true; playbackState.value = 'playing'; playbackError.value = ''
  }
  function handlePause() { isPlaying.value = false; if (!wantsPlayback && currentSong.value) playbackState.value = 'paused' }
  function handleWaiting() { if (wantsPlayback) playbackState.value = 'buffering' }
  function handleEnded() {
    if (!wantsPlayback) return
    if (playMode.value === 'loop') loadAndPlay()
    else playNext()
  }
  function handleError() {
    if (!currentSong.value || !audioRef.value?.getAttribute('src')) return
    wantsPlayback = false; isPlaying.value = false; playbackState.value = 'error'
    playbackError.value = '音频加载失败，请检查连接后重试；若仍失败，可切换其他曲目'
  }
  function changeVolume(value) {
    const number = Number(value ?? volume.value)
    if (!Number.isFinite(number)) return
    volume.value = Math.min(100, Math.max(0, number))
    if (audioRef.value) audioRef.value.volume = volume.value / 100
    persist()
  }
  function toggleMute() { isMuted.value = !isMuted.value; if (audioRef.value) audioRef.value.muted = isMuted.value }
  function removeFromPlaylist(index) {
    if (!playlist.value[index]) return
    const wasCurrent = index === currentIndex.value, wasPlaying = wantsPlayback
    playlist.value.splice(index, 1)
    if (!playlist.value.length) { clearPlaylist(); return }
    if (wasCurrent) {
      const next = Math.min(index, playlist.value.length - 1)
      if (wasPlaying) playSongAtIndex(next)
      else {
        ++generation; wantsPlayback = false; audioRef.value?.pause(); audioRef.value?.removeAttribute('src')
        currentIndex.value = next; currentSong.value = playlist.value[next]
        currentTime.value = 0; duration.value = currentSong.value.duration; playbackState.value = 'restored'
        playbackError.value = ''; loadPlayerCover(currentSong.value)
      }
    } else currentIndex.value = playlist.value.findIndex(song => song.id === currentSong.value?.id)
    persist()
  }
  function removeSongsByIds(ids) {
    const remove = new Set(ids.map(Number))
    for (let i = playlist.value.length - 1; i >= 0; i--) if (remove.has(playlist.value[i].id)) removeFromPlaylist(i)
  }
  function reset(save = true) {
    ++generation; ++coverGeneration; wantsPlayback = false; pendingSeek = null
    audioRef.value?.pause(); audioRef.value?.removeAttribute('src')
    currentSong.value = null; currentIndex.value = -1; playlist.value = []; currentTime.value = 0; duration.value = 0
    isPlaying.value = false; playbackState.value = 'idle'; playbackError.value = ''; playerCoverData.value = null
    showNowPlaying.value = false; showLyricsWindow.value = false; showPlaylist.value = false; showMobilePlaylist.value = false
    showEqualizer.value = false
    if (save) persist()
  }
  function clearPlaylist() { reset() }
  function closePlayer() { reset() }
  function openLyricsWindow() { if (currentSong.value) showLyricsWindow.value = true }
  async function openEqualizer() {
    if (!audioRef.value) return
    if (!equalizer.isInitialized && !await equalizer.init(audioRef.value)) {
      playbackError.value = '此浏览器暂不支持均衡器'; return
    }
    try { await equalizer.audioContext?.resume(); showEqualizer.value = true }
    catch { playbackError.value = '均衡器暂不可用，请稍后重试' }
  }
  function closeLyricsWindow() { showLyricsWindow.value = false }
  function formatTime(value) {
    const seconds = Number.isFinite(value) ? Math.max(0, value) : 0
    return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
  }
  function handlePlayMusic(event) { playSong(event.detail.song, event.detail.list) }
  function handleRemoveMusic(event) { removeSongsByIds(event.detail.songIds || [event.detail.songId]) }
  function handleOpenPlaylist() { showPlaylist.value = true }
  function attach() {
    if (mounted) return
    mounted = true
    restore()
    stopAuthWatch = watch(() => [auth.isAuthenticated, auth.user?.id, auth.user?.username, auth.demoMode], restore, { flush: 'sync' })
    window.addEventListener('play-music', handlePlayMusic)
    window.addEventListener('remove-music', handleRemoveMusic)
    window.addEventListener('open-playlist', handleOpenPlaylist)
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', persist)
  }
  function detach() {
    persist(); wantsPlayback = false; ++generation; audioRef.value?.pause(); isPlaying.value = false
    if (currentSong.value) playbackState.value = 'restored'
    stopAuthWatch?.(); mounted = false
    if (equalizer.isInitialized) equalizer.destroy()
    showEqualizer.value = false
    window.removeEventListener('play-music', handlePlayMusic)
    window.removeEventListener('remove-music', handleRemoveMusic)
    window.removeEventListener('open-playlist', handleOpenPlaylist)
    window.removeEventListener('pagehide', persist)
    document.removeEventListener('visibilitychange', persist)
  }
  globalState = { audioRef, currentSong, playlist, currentIndex, isPlaying, currentTime, duration, volume, isMuted,
    playMode, playModeText, progress, displayProgress, isDraggingProgress, dragProgress, hasPrev, hasNext,
    showPlaylist, showMobilePlaylist, showNowPlaying, showLyricsWindow, showEqualizer, openEqualizer, playerCoverData, coverLoadFailed,
    playbackState, playbackError, statusText, playSong, playSongAtIndex, togglePlay, retryPlayback, playPrev, playNext,
    togglePlayMode, seekToTime, changeVolume, toggleMute, clearPlaylist, closePlayer, removeFromPlaylist,
    removeSongsByIds, handleCoverError, openLyricsWindow, closeLyricsWindow, formatTime, handleLoaded, handleTimeUpdate,
    handlePlaying, handlePause, handleWaiting, handleEnded, handleError, attach, detach }
  return globalState
}
