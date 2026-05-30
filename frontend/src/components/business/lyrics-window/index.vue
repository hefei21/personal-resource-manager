<template>
  <Transition name="lyrics-fade">
    <LyricsWindowPC
      v-if="visible && !isMobile"
      v-bind="$props"
      @close="$emit('close')"
      @toggle-play="$emit('toggle-play')"
      @prev="$emit('prev')"
      @next="$emit('next')"
      @seek="$emit('seek', $event)"
      @volume-change="$emit('volume-change', $event)"
      @toggle-mute="$emit('toggle-mute')"
      @toggle-play-mode="$emit('toggle-play-mode')"
    />
    <LyricsWindowMobile
      v-else-if="visible && isMobile"
      v-bind="$props"
      @close="$emit('close')"
      @toggle-play="$emit('toggle-play')"
      @prev="$emit('prev')"
      @next="$emit('next')"
      @seek="$emit('seek', $event)"
      @toggle-play-mode="$emit('toggle-play-mode')"
    />
  </Transition>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import LyricsWindowPC from './LyricsWindowPC.vue'
import LyricsWindowMobile from './LyricsWindowMobile.vue'

defineProps({
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

defineEmits(['close', 'toggle-play', 'prev', 'next', 'seek', 'volume-change', 'toggle-mute', 'toggle-play-mode'])

const isMobile = ref(false)

function checkMobile() {
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})
</script>

<style scoped>
.lyrics-fade-enter-active,
.lyrics-fade-leave-active {
  transition: all 0.3s ease;
}

.lyrics-fade-enter-from,
.lyrics-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>