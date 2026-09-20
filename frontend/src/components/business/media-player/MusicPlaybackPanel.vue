<template>
  <Transition name="music-bar">
    <section v-if="currentSong" ref="bar" class="media-player" aria-label="音乐播放器">
      <button class="track-summary" @click="showNowPlaying = true" aria-label="展开播放页">
        <span class="cover"><img v-if="playerCoverData && !coverLoadFailed" :src="playerCoverData" alt="" @error="handleCoverError" /><NativeIcon v-else name="music" size="22" /></span>
        <span class="track-copy"><strong>{{ currentSong.title }}</strong><small :class="{ error: playbackError }" role="status">{{ statusText }}</small></span>
      </button>
      <div class="transport">
        <button class="icon-button desktop-only" aria-label="上一首" :disabled="!hasPrev" @click="playPrev"><NativeIcon name="skip-back" /></button>
        <button class="icon-button primary" :aria-label="isPlaying || ['loading','buffering'].includes(playbackState) ? '暂停' : '播放'" @click="togglePlay"><NativeIcon :name="isPlaying || ['loading','buffering'].includes(playbackState) ? 'pause' : 'play'" /></button>
        <button class="icon-button" aria-label="下一首" :disabled="!hasNext" @click="playNext"><NativeIcon name="skip-forward" /></button>
      </div>
      <div class="timeline desktop-only"><span>{{ formatTime(currentTime) }}</span><input aria-label="播放进度" type="range" min="0" :max="duration || 1" step=".1" :value="currentTime" :disabled="!duration" @change="seekToTime($event.target.value)" /><span>{{ formatTime(duration) }}</span></div>
      <div class="secondary-controls">
        <button v-if="playbackError" class="text-button" @click="retryPlayback">重试</button>
        <button class="icon-button desktop-only" :aria-label="playModeText" :title="playModeText" @click="togglePlayMode"><NativeIcon :name="playMode === 'shuffle' ? 'shuffle' : 'repeat'" /><span v-if="playMode === 'loop'" class="loop-one">1</span></button>
        <label class="volume desktop-only"><button class="icon-button" :aria-label="isMuted ? '取消静音' : '静音'" @click="toggleMute"><NativeIcon :name="isMuted ? 'speaker-slash' : 'speaker-high'" /></button><input aria-label="音量" type="range" min="0" max="100" :value="volume" @input="changeVolume($event.target.value)" /></label>
        <button class="icon-button" aria-label="播放队列" @click="showPlaylist = true"><NativeIcon name="list" /></button>
        <button class="icon-button desktop-only" aria-label="关闭播放器并清空队列" @click="closePlayer"><NativeIcon name="x" /></button>
      </div>
    </section>
  </Transition>
  <NativeDrawer v-model="showNowPlaying" title="正在播放" :top-offset="0" :size="mobile ? '100%' : '440px'" :z-index="1600">
    <div v-if="currentSong" class="now-playing">
      <div class="large-cover"><img v-if="playerCoverData && !coverLoadFailed" :src="playerCoverData" alt="" /><NativeIcon v-else name="music" size="64" /></div>
      <h2>{{ currentSong.title }}</h2><p>{{ currentSong.artist || '未知艺术家' }}<template v-if="currentSong.album"> · {{ currentSong.album }}</template></p>
      <p class="playback-status" role="status">{{ playbackState === 'playing' ? '' : statusText }}</p>
      <button v-if="playbackError" class="text-button" @click="retryPlayback">重新加载此曲目</button>
      <div class="expanded-timeline"><input aria-label="播放页进度" type="range" min="0" :max="duration || 1" step=".1" :value="currentTime" :disabled="!duration" @change="seekToTime($event.target.value)" /><div><span>{{ formatTime(currentTime) }}</span><span>{{ formatTime(duration) }}</span></div></div>
      <div class="expanded-controls"><button class="icon-button" :aria-label="playModeText" @click="togglePlayMode"><NativeIcon :name="playMode === 'shuffle' ? 'shuffle' : 'repeat'" /><span v-if="playMode === 'loop'">1</span></button><button class="icon-button" aria-label="上一首" :disabled="!hasPrev" @click="playPrev"><NativeIcon name="skip-back" /></button><button class="icon-button primary" :aria-label="isPlaying ? '暂停' : '播放'" @click="togglePlay"><NativeIcon :name="isPlaying ? 'pause' : 'play'" size="26" /></button><button class="icon-button" aria-label="下一首" :disabled="!hasNext" @click="playNext"><NativeIcon name="skip-forward" /></button><button class="icon-button" aria-label="播放队列" @click="showPlaylist = true"><NativeIcon name="list" /></button></div>
      <div class="playback-links"><button class="text-button" @click="openLyricsWindow">查看歌词</button><button v-if="!mobile" class="text-button" @click="openEqualizer">均衡器</button><button class="text-button" @click="closePlayer">结束播放</button></div>
      <small class="device-note">队列和播放位置仅保存在当前设备</small>
    </div>
  </NativeDrawer>
  <NativeDrawer v-model="showPlaylist" title="播放队列" :placement="mobile ? 'bottom' : 'right'" :top-offset="mobile ? 0 : 72" :size="mobile ? '70dvh' : '380px'" :z-index="1700">
    <div class="queue-heading"><span>{{ playlist.length }} 首 · 临时队列</span><button class="text-button" :disabled="!playlist.length" @click="clearPlaylist">清空</button></div>
    <p v-if="!playlist.length" class="empty-queue">队列为空，从音频库选择一首音乐开始。</p>
    <div v-for="(song, index) in playlist" :key="song.id" class="queue-row" :class="{ active: song.id === currentSong?.id }">
      <button class="queue-track" :aria-current="song.id === currentSong?.id ? 'true' : undefined" @click="playSongAtIndex(index)"><span>{{ index + 1 }}</span><span><strong>{{ song.title }}</strong><small>{{ song.artist || '未知艺术家' }}</small></span></button>
      <button class="icon-button" :aria-label="'从队列移除 ' + song.title" @click="removeFromPlaylist(index)"><NativeIcon name="x" size="16" /></button>
    </div>
  </NativeDrawer>
  <NativeDrawer v-model="showEqualizer" title="均衡器" :top-offset="72" size="480px" :z-index="1750"><EqualizerPanel v-if="showEqualizer" /></NativeDrawer>
</template>
<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from 'vue'
import { NativeDrawer, NativeIcon } from '@/components/native'
import { usePlayer } from './usePlayer'
const EqualizerPanel = defineAsyncComponent(() => import('@/components/EqualizerPanel.vue'))
defineProps({ mobile: Boolean })
const { currentSong, isPlaying, currentTime, duration, volume, isMuted, playMode, playModeText, hasPrev, hasNext,
  showNowPlaying, showPlaylist, playlist, playerCoverData, coverLoadFailed, statusText, playbackState, playbackError,
  handleCoverError, togglePlay, playPrev, playNext, seekToTime, changeVolume, toggleMute, togglePlayMode,
  closePlayer, clearPlaylist, removeFromPlaylist, playSongAtIndex, openLyricsWindow, retryPlayback, formatTime,
  openEqualizer, showEqualizer } = usePlayer()
const bar = ref(null)
let observer
const updateHeight = () => document.documentElement.style.setProperty('--player-height', (bar.value?.offsetHeight || 0) + 'px')
watch(currentSong, async () => { await nextTick(); observer?.disconnect(); if (bar.value) observer?.observe(bar.value); updateHeight() })
onMounted(() => { observer = new ResizeObserver(updateHeight); if (bar.value) observer.observe(bar.value); updateHeight() })
onUnmounted(() => { observer?.disconnect(); document.documentElement.style.setProperty('--player-height', '0px') })
</script>
<style scoped>
.media-player{position:fixed;bottom:0;left:256px;right:0;z-index:130;display:flex;align-items:center;gap:20px;padding:12px 24px;background:var(--color-surface-raised,#fffdfa);color:var(--color-text-primary,#202938);border-top:1px solid var(--color-border-subtle,#e2e5eb);box-shadow:0 -3px 12px #17203308}
button{font:inherit;color:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--color-primary,#6266da);outline-offset:3px}
.track-summary{display:flex;gap:12px;align-items:center;min-width:0;width:26%;border:0;background:none;text-align:left;padding:0}
.cover{width:44px;height:44px;flex-shrink:0;display:grid;place-items:center;background:var(--color-surface-subtle,#eff1f4);border-radius:6px;overflow:hidden}.cover img,.large-cover img{width:100%;height:100%;object-fit:cover}
.track-copy{min-width:0;display:grid;gap:4px}.track-copy strong,.track-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track-copy strong{font-size:14px;font-weight:600}.track-copy small{font-size:12px;color:var(--color-text-secondary,#657184)}.track-copy small.error{color:var(--color-danger,#ae3948)}
.transport,.secondary-controls,.volume{display:flex;align-items:center;gap:6px}.icon-button{position:relative;border:0;background:transparent;border-radius:6px;min-width:36px;height:36px;padding:6px;display:inline-flex;align-items:center;justify-content:center}.icon-button:hover{background:var(--color-surface-subtle,#eff1f4)}.icon-button.primary{background:var(--color-primary,#6266da);color:var(--color-text-inverse);border-radius:50%;width:40px;height:40px}.timeline{flex:1;min-width:120px;display:flex;align-items:center;gap:10px;font-size:12px;font-variant-numeric:tabular-nums;color:var(--color-text-secondary,#657184)}
input[type=range]{accent-color:var(--color-primary,#6266da);min-width:0;height:24px;cursor:pointer}.timeline input{width:100%}.volume input{width:70px}.loop-one{position:absolute;right:0;top:0;font-size:10px}
.text-button{padding:8px 10px;border:0;background:none;color:var(--color-primary,#6266da);font-size:13px;white-space:nowrap}
.now-playing{padding:16px 8px;max-width:430px;margin:auto;text-align:center;color:var(--color-text-primary,#202938)}.large-cover{width:min(65vw,260px);aspect-ratio:1;margin:4px auto 28px;display:grid;place-items:center;border-radius:8px;background:var(--color-surface-subtle,#eff1f4);overflow:hidden;box-shadow:0 4px 18px #17203310}.now-playing h2{font-size:20px;line-height:1.5;margin:0;overflow-wrap:anywhere}.now-playing p{font-size:14px;color:var(--color-text-secondary,#657184)}.playback-status{min-height:22px}.expanded-timeline{margin:24px 0}.expanded-timeline input{width:100%}.expanded-timeline>div{display:flex;justify-content:space-between;font-size:12px;font-variant-numeric:tabular-nums}.expanded-controls{display:flex;justify-content:space-between;align-items:center}.expanded-controls .icon-button{width:44px;height:44px}.expanded-controls .primary{width:56px;height:56px}.playback-links{display:flex;justify-content:center;gap:20px;margin:28px 0 12px}.device-note{font-size:12px;color:var(--color-text-secondary,#657184)}
.queue-heading{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--color-text-secondary,#657184)}.queue-row{display:flex;align-items:center;border-bottom:1px solid var(--color-border-subtle,#e2e5eb)}.queue-row.active{background:var(--color-primary-surface)}.queue-track{border:0;background:none;display:flex;align-items:center;gap:14px;flex:1;min-width:0;text-align:left;padding:14px 8px}.queue-track>span:last-child{display:grid;gap:4px;min-width:0}.queue-track strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue-track small,.queue-track>span:first-child{font-size:12px;color:var(--color-text-secondary,#657184)}.empty-queue{font-size:14px;color:var(--color-text-secondary,#657184)}
.music-bar-enter-active,.music-bar-leave-active{transition:transform .18s ease,opacity .18s ease}.music-bar-enter-from,.music-bar-leave-to{transform:translateY(12px);opacity:0}
@media(max-width:1200px){.volume{display:none}.media-player{gap:12px;padding-inline:16px}.track-summary{width:28%}}
@media(max-width:768px){.media-player{left:0;bottom:calc(68px + env(safe-area-inset-bottom,0px));padding:8px 12px;gap:4px}.desktop-only{display:none!important}.track-summary{flex:1;width:auto;gap:10px}.track-copy strong{font-size:13px}.track-copy small{font-size:12px}.cover{width:40px;height:40px}.icon-button{min-width:44px;height:44px}.transport,.secondary-controls{gap:0}.now-playing{padding-bottom:env(safe-area-inset-bottom,16px)}.text-button{min-height:44px}.queue-row .icon-button{min-width:44px}}
@media(prefers-reduced-motion:reduce){.music-bar-enter-active,.music-bar-leave-active{transition:none}}
</style>
