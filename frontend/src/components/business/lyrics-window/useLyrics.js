import { ref, computed, watch } from 'vue'
import api from '@/api'

// 歌词相关逻辑
// lyricsContainerRef: 外部传入的容器引用（可选，用于歌词滚动）
export function useLyrics(props, emit, lyricsContainerRef) {
  const lyrics = ref([])
  const currentLineIndex = ref(0)
  // 使用外部传入的 ref 或内部创建的 ref
  const lyricsContainer = lyricsContainerRef || ref(null)
  const coverData = ref(null)
  const coverLoadFailed = ref(false)
  const downloadingLyrics = ref(false)
  const showLyricsEditor = ref(false)
  const showUploadLyricsDialog = ref(false)
  const lyricsText = ref('')
  const lyricsFile = ref([])
  const userScrolling = ref(false)
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
    if (!userScrolling.value) {
      scrollToCurrentLine()
    }
  }

  // 判断行是否应该高亮
  function isLineActive(index) {
    if (lyrics.value.length === 0) return false
    const currentTime = lyrics.value[currentLineIndex.value]?.time
    if (currentTime === undefined) return false
    if (index === currentLineIndex.value) return true
    if (index === currentLineIndex.value - 1 && lyrics.value[index]?.time === currentTime) return true
    if (index === currentLineIndex.value + 1 && lyrics.value[index]?.time === currentTime) return true
    return false
  }

  // 用户滚动处理
  function handleUserScroll() {
    userScrolling.value = true
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => { userScrolling.value = false }, 3000)
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
  function seekToLine(time) { emit('seek', time) }

  // 下载歌词
  async function downloadLyrics() {
    if (!props.currentSong) return
    downloadingLyrics.value = true
    try {
      const response = await api.music.downloadLyrics([props.currentSong.id], true)
      if (response.data.success) {
        await pollTaskProgress(response.data.taskId)
      }
    } catch (error) {
      console.error('下载歌词失败:', error)
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
        if (task.success > 0) await loadLyrics()
      } else if (task.status !== 'failed') {
        setTimeout(() => pollTaskProgress(taskId), 1000)
      }
    } catch (error) {
      console.error('查询进度失败:', error)
    }
  }

  // 保存歌词
  async function saveLyrics() {
    if (!props.currentSong || !lyricsText.value.trim()) return
    try {
      await api.music.updateLyrics(props.currentSong.id, lyricsText.value)
      await loadLyrics()
      showLyricsEditor.value = false
    } catch (error) {
      console.error('保存歌词失败:', error)
    }
  }

  // 调整歌词时间轴
  async function adjustLyricTime(delta) {
    if (lyrics.value.length === 0 || currentLineIndex.value < 0) return
    const currentLine = lyrics.value[currentLineIndex.value]
    if (!currentLine) return
    const newTime = Math.max(0, currentLine.time + delta)
    currentLine.time = newTime
    const newLyricsText = lyrics.value.map(line => {
      const minutes = Math.floor(line.time / 60)
      const seconds = Math.floor(line.time % 60)
      const milliseconds = Math.round((line.time - Math.floor(line.time)) * 100)
      const timeTag = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
      return `${timeTag}${line.text}`
    }).join('\n')
    try {
      await api.music.updateLyrics(props.currentSong.id, newLyricsText)
      lyricsText.value = newLyricsText
      if (props.isPlaying) emit('seek', newTime)
    } catch (error) {
      console.error('调整时间轴失败:', error)
      currentLine.time -= delta
    }
  }

  // 手动上传歌词
  async function handleUploadLyrics() {
    if (!props.currentSong) return
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
      await saveUploadedLyrics()
    }
  }

  // 保存上传的歌词
  async function saveUploadedLyrics() {
    if (!lyricsText.value.trim()) return
    try {
      await api.music.updateLyrics(props.currentSong.id, lyricsText.value, '手动上传')
      await loadLyrics()
      showUploadLyricsDialog.value = false
      lyricsFile.value = []
      lyricsText.value = ''
    } catch (error) {
      console.error('上传歌词失败:', error)
    }
  }

  function handleCoverError() { coverLoadFailed.value = true }

  function openPlaylist() { window.dispatchEvent(new CustomEvent('open-playlist')) }

  return {
    lyrics, currentLineIndex, lyricsContainer, coverData, coverLoadFailed,
    downloadingLyrics, showLyricsEditor, showUploadLyricsDialog, lyricsText,
    lyricsFile, progress, playModeText, loadLyrics, loadCover, isLineActive,
    handleUserScroll, scrollToCurrentLine, seekToLine, downloadLyrics,
    saveLyrics, adjustLyricTime, handleUploadLyrics, handleCoverError, openPlaylist
  }
}