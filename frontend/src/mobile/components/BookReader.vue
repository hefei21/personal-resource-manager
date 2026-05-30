<template>
  <Transition name="reader-fade">
    <div v-if="visible" class="book-reader" :class="{ 'menu-hidden': !showMenu }">
      <!-- 初始加载遮罩 -->
      <div v-if="initialLoading" class="initial-loading-overlay" @click.stop>
        <div class="loading-spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 顶部栏 -->
      <div class="reader-header" :class="{ 'header-visible': showMenu }">
        <button class="back-btn" @click="handleClose">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
          </svg>
        </button>
        <span class="book-title">{{ book?.title || '阅读器' }}</span>
        <div class="placeholder"></div>
      </div>

      <!-- 正文内容区 -->
      <div ref="contentRef" class="reader-content" 
           @scroll="handleScroll" 
           @wheel="handleWheel"
           @touchstart="handleTouchStart"
           @touchmove="handleTouchMove"
           @click="handleContentClick">
        <!-- 顶部加载提示 -->
        <div v-if="topLoading" class="edge-loading top-loading">
          <div class="loading-spinner-small"></div>
          <span>加载中...</span>
        </div>

        <div
          v-for="chapter in visibleChapters"
          :key="chapter.id"
          class="chapter-block"
          :data-chapter-id="chapter.id"
          :data-chapter-index="getChapterIndex(chapter.id)"
        >
          <h2 class="chapter-title">{{ chapter.title }}</h2>
          <!-- 内容元素直接承载 data-chapter-id，与PC端 .book-text 保持一致 -->
          <div
            class="chapter-content"
            :class="{ 'content-hidden': chapter.isLoading }"
            :style="contentStyle"
            :data-chapter-id="chapter.id"
            v-html="chapter.content"
          />
          <div v-if="chapter.isLoading" class="chapter-loading-overlay">
            <div class="loading-spinner-small"></div>
            <span>加载中...</span>
          </div>
        </div>

        <!-- 底部加载提示 -->
        <div v-if="bottomLoading" class="edge-loading bottom-loading">
          <div class="loading-spinner-small"></div>
          <span>加载中...</span>
        </div>

        <!-- 加载更多 -->
        <div v-if="!topLoading && !bottomLoading" class="load-more">
          <span v-if="loadingMore">加载中...</span>
          <span v-else-if="visibleRange.end >= bookChapters.length && !initialLoading" class="book-end">- 全书完 -</span>
          <span v-else-if="!initialLoading">继续下拉加载</span>
        </div>
      </div>

      <!-- 底部栏 -->
      <div class="reader-footer" :class="{ 'footer-visible': showMenu }">
        <button class="footer-btn" @click.stop="!initialLoading && (showTocDrawer = true)">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
          </svg>
          <span>目录</span>
        </button>

        <div class="progress-text" @click.stop>
          {{ displayProgress.toFixed(2) }}%
        </div>

        <button class="footer-btn" @click.stop="showFontPanel = true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M9 4v3h5v12h3V7h5V4H9zm-6 8h3v7h3v-7h3V9H3v3z"/>
          </svg>
          <span>字号</span>
        </button>
      </div>

      <!-- 目录抽屉（原生实现） -->
      <div v-if="showTocDrawer" class="drawer-overlay" @click.self="showTocDrawer = false">
        <div class="drawer-content drawer-left">
          <div class="drawer-header">
            <h3>目录</h3>
            <button class="close-btn" @click="showTocDrawer = false">×</button>
          </div>
          <div class="drawer-body">
            <div class="toc-list">
              <div
                v-for="(item, index) in bookToc"
                :key="index"
                class="toc-item"
                :class="{ active: currentChapterIndex === item.chapterIndex }"
                @click="jumpToChapter(item)"
              >
                {{ item.title }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 字号设置面板（原生实现） -->
      <div v-if="showFontPanel" class="drawer-overlay" @click.self="showFontPanel = false">
        <div class="drawer-content drawer-bottom">
          <div class="drawer-header">
            <h3>字号设置</h3>
            <button class="close-btn" @click="showFontPanel = false">×</button>
          </div>
          <div class="drawer-body">
            <div class="font-size-control">
              <button class="size-btn" @click="decreaseFontSize">A-</button>
              <span class="size-value">{{ fontSize }}px</span>
              <button class="size-btn" @click="increaseFontSize">A+</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 提示消息（原生实现） -->
      <div v-if="toastMessage" class="toast" :class="toastType">
        {{ toastMessage }}
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import { scrollToCFI, getCurrentCFI, CharacterOffsetProgress } from '@/utils/epub-cfi'

const props = defineProps({
  visible: Boolean,
  book: Object
})

const emit = defineEmits(['update:visible', 'close'])

const authStore = useAuthStore()
const isGuest = computed(() => authStore.isGuest())

// 阅读器状态
const contentRef = ref(null)
const showMenu = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const isProgressLoaded = ref(false)
const initialLoading = ref(false)
const topLoading = ref(false)      // 顶部加载提示
const bottomLoading = ref(false)   // 底部加载提示

// 边界加载控制（防止快速滚动时的重复请求和异常跳转）
const isEdgeLoading = ref(false)   // 是否正在边界加载
const edgeLoadingDirection = ref(null) // 'up' | 'down' | null
const lastEdgeLoadTime = ref(0)    // 上次边界加载时间
const EDGE_LOAD_COOLDOWN = 500     // 边界加载冷却时间(ms)

// 滚动屏蔽控制（loading时屏蔽同方向滚动）
const scrollBlockState = ref({
  isBlocking: false,       // 是否正在屏蔽
  direction: null,         // 'up' | 'down' | null，屏蔽的方向
  blockPosition: null,     // 开始屏蔽时的 scrollTop
  loadingIndex: null       // 正在加载的章节索引
})
const EDGE_THRESHOLD = 100 // 边界阈值(px)

// 书籍内容
const bookChapters = ref([])
const loadedChapters = ref(new Map())
const loadedImages = ref(new Set()) // 已加载图片的章节
const bookToc = ref([])
const currentChapterIndex = ref(0)
const totalChapterCount = ref(0)

// 缓冲配置
const BUFFER_CHAPTERS = 1
const visibleRange = ref({ start: 0, end: 1 })

// 阅读设置
const fontSize = ref(18)
const showTocDrawer = ref(false)
const showFontPanel = ref(false)

// 原生提示
const toastMessage = ref('')
const toastType = ref('success')
let toastTimer = null

// 进度
const displayProgress = ref(0)
let currentCFI = null

// 滚动控制
let isRestoringPosition = false
let isProgrammaticScrolling = false  // 是否正在进行程序控制的滚动（跳转）
let scrollDebounceTimer = null
let saveProgressTimer = null

// 使用 requestAnimationFrame 轮询检测滚动位置
let scrollRafId = null
let lastScrollTop = 0
function startScrollPolling() {
  if (scrollRafId) return
  
  function poll() {
    if (!contentRef.value) {
      scrollRafId = null
      return
    }
    
    const currentScrollTop = contentRef.value.scrollTop
    // 滚动位置变化且不是在恢复位置/程序滚动期间
    if (currentScrollTop !== lastScrollTop && !isRestoringPosition && !isProgrammaticScrolling) {
      lastScrollTop = currentScrollTop
      // 实时更新进度显示
      if (isProgressLoaded.value) {
        displayProgress.value = calculateProgress()
      }
    }
    
    scrollRafId = requestAnimationFrame(poll)
  }
  
  scrollRafId = requestAnimationFrame(poll)
}

function stopScrollPolling() {
  if (scrollRafId) {
    cancelAnimationFrame(scrollRafId)
    scrollRafId = null
  }
}

function showToast(message, type = 'success') {
  toastMessage.value = message
  toastType.value = type
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
  }, 2500)
}

function getChapterIndex(chapterId) {
  return bookChapters.value.findIndex(ch => ch.id === chapterId)
}

const contentStyle = computed(() => ({
  fontSize: fontSize.value + 'px',
  lineHeight: '1.8'
}))

// 可见章节计算
const visibleChapters = computed(() => {
  const start = Math.max(0, visibleRange.value.start)
  const end = Math.min(bookChapters.value.length, visibleRange.value.end)
  return bookChapters.value.slice(start, end).map(ch => {
    const hasContent = loadedChapters.value.has(ch.id)
    return {
      ...ch,
      content: hasContent ? loadedChapters.value.get(ch.id) : '',
      isLoading: !hasContent
    }
  })
})

const charOffsetProgress = ref(new CharacterOffsetProgress())

watch(() => props.visible, (newVal) => {
  if (newVal && props.book) {
    openBook()
  } else if (!newVal) {
    isProgressLoaded.value = false
    charOffsetProgress.value.clear()
    // 清理缓存
    loadedChapters.value.clear()
    loadedImages.value.clear()
  }
})

// 监听目录显示状态，打开时自动滚动到当前章节
watch(() => showTocDrawer.value, async (newVal) => {
  if (newVal) {
    // 等待DOM渲染完成
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 150))

    // 使用 refs 或者 querySelector 查找元素
    const drawerOverlay = document.querySelector('.book-reader .drawer-overlay')
    // 使用 .toc-list 作为滚动容器
    const tocList = drawerOverlay?.querySelector('.toc-list')
    const activeItem = drawerOverlay?.querySelector('.toc-item.active')

    if (tocList && activeItem) {
      // 滚动到当前章节（居中显示）
      const itemTop = activeItem.offsetTop
      const itemHeight = activeItem.offsetHeight
      const tocHeight = tocList.clientHeight
      const scrollTop = itemTop - tocHeight / 2 + itemHeight / 2

      tocList.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'smooth'
      })
      console.log('📖 目录已滚动到当前章节:', currentChapterIndex.value + 1)
    } else {
      console.warn('⚠️ 目录滚动失败:', { tocList: !!tocList, activeItem: !!activeItem })
    }
  }
})

// 打开书籍
async function openBook() {
  initialLoading.value = true
  loading.value = true
  isProgressLoaded.value = false
  showMenu.value = false

  try {
    // 获取章节列表
    const contentResponse = await api.books.getContent(props.book.id)
    if (contentResponse.data?.chapters) {
      bookChapters.value = contentResponse.data.chapters
      totalChapterCount.value = bookChapters.value.length
      bookToc.value = contentResponse.data.toc || []
    } else {
      throw new Error('无法获取章节列表')
    }

    // 初始化字符偏移进度计算器
    charOffsetProgress.value.clear()
    charOffsetProgress.value.init(bookChapters.value)
    console.log('📊 字符偏移进度计算器已初始化，总字符数:', charOffsetProgress.value.totalChars)

    // 确定起始章节
    let startIndex = 0
    let savedCFI = null
    if (!isGuest.value) {
      const progressResponse = await api.books.getProgress(props.book.id)
      if (progressResponse.data?.currentPage !== undefined) {
        startIndex = Math.min(progressResponse.data.currentPage, totalChapterCount.value - 1)
        savedCFI = progressResponse.data.cfi
        console.log('📖 阅读进度已加载:', { 章节: startIndex + 1, CFI: savedCFI || '无' })
      }
    } else {
      console.log('📖 游客模式：不加载阅读进度，从开头开始阅读')
    }

    currentChapterIndex.value = startIndex

    // 同时加载目标章+相邻章
    const loadResult = await loadChaptersUnified(startIndex, {
      loadImages: true,
      loadAdjacent: true,
      showLoading: false  // 使用 initialLoading 控制
    })

    if (!loadResult.success) {
      throw new Error('加载章节失败')
    }

    // 4. 恢复阅读位置（等待图片加载完成后定位）
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 200))

    if (savedCFI && contentRef.value) {
      console.log('📐 开始恢复阅读位置，CFI:', savedCFI.substring(0, 50) + '...')
      isRestoringPosition = true
      // 关键：.chapter-content 元素现在直接有 data-chapter-id
      const success = scrollToCFI(contentRef.value, savedCFI, null, false)
      if (success) {
        currentCFI = savedCFI
        console.log('✅ CFI定位成功')
      } else {
        console.warn('⚠️ CFI定位失败，使用章节起始位置')
      }
      // 延迟恢复isRestoringPosition，确保定位稳定（给足够长时间）
      setTimeout(() => {
        isRestoringPosition = false
        console.log('🔓 位置恢复完成，开始监听滚动')
      }, 500)
    }

    // 5. 计算初始进度
    const initialProgress = charOffsetProgress.value.initialized
      ? charOffsetProgress.value.calculateProgress(startIndex, contentRef.value, null)
      : (startIndex / totalChapterCount.value) * 100
    displayProgress.value = initialProgress

    // 关闭loading，显示内容
    loading.value = false
    initialLoading.value = false
    isProgressLoaded.value = true

    // 启动滚动位置轮询
    startScrollPolling()
    lastScrollTop = contentRef.value?.scrollTop || 0

    console.log('✅ 阅读器准备完成，当前进度:', initialProgress.toFixed(2) + '%')
    console.log('🧠 内存状态:', getMemoryStatus())

  } catch (error) {
    console.error('❌ 打开书籍失败:', error)
    showToast('加载失败', 'error')
    handleClose()
  }
}

// 加载当前章（带图片预加载）
async function loadCurrentChapterWithImages(index) {
  // 只加载当前章
  visibleRange.value = { start: index, end: index + 1 }
  await loadChaptersRange(index, 1)
  await nextTick()

  // 等待DOM渲染
  await new Promise(resolve => setTimeout(resolve, 100))

  // 预加载当前章图片
  const chapterEl = contentRef.value?.querySelector(`[data-chapter-index="${index}"] .chapter-content`)
  if (chapterEl) {
    await preloadChapterImages(chapterEl, 15000)
    loadedImages.value.add(bookChapters.value[index]?.id)
  }
}

// 静默加载相邻章（仅内容，无图片）
async function loadAdjacentChaptersSilent(centerIndex, options = {}) {
  const { preserveScroll = true } = options

  // 如果正在恢复位置，跳过静默加载
  if (isRestoringPosition) {
    console.log('⏸️ 正在恢复位置，跳过静默加载')
    return
  }

  // 静默加载不应该影响当前阅读位置，只是后台加载内容
  // 设置标志防止滚动事件触发
  isProgrammaticScrolling = true

  const start = Math.max(0, centerIndex - BUFFER_CHAPTERS)
  const end = Math.min(totalChapterCount.value, centerIndex + BUFFER_CHAPTERS + 1)

  // 加载相邻章内容（不含当前章）
  const chaptersToLoad = []
  for (let i = start; i < end; i++) {
    if (i === centerIndex) continue // 跳过当前章（已加载）

    const chapter = bookChapters.value[i]
    if (!loadedChapters.value.has(chapter.id)) {
      chaptersToLoad.push(i)
    }
  }

  if (chaptersToLoad.length > 0) {
    console.log(`🔇 静默加载章节: ${chaptersToLoad.map(i => i + 1).join(',')}`)

    // 记录当前滚动位置（如果需要保持）
    const scrollContainer = contentRef.value
    const savedScrollTop = scrollContainer?.scrollTop || 0

    for (const i of chaptersToLoad) {
      // 如果在当前章之前加载内容，需要调整滚动位置
      const isLoadingBeforeCurrent = i < currentChapterIndex.value
      await loadChaptersRange(i, 1)

      // 如果在当前章之前加载了新内容，且需要保持位置，恢复滚动位置
      if (preserveScroll && isLoadingBeforeCurrent && scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop
      }
    }

    // 等待DOM更新（给足够时间让浏览器布局完成）
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 300))

    console.log('🧠 静默加载完成，内存状态:', getMemoryStatus())
  }

  // 更新可见范围（包含缓冲章）
  visibleRange.value = { start, end }

  // 关键：延迟恢复标志，确保DOM稳定
  // 加载完成后，确保当前章节仍在视口内，避免错误切换
  setTimeout(() => {
    // 检查当前章节是否仍在视口中心
    const detectedIndex = detectCurrentChapter()
    if (detectedIndex !== -1 && detectedIndex !== currentChapterIndex.value) {
      // 检测章节变化时，需要等待足够的时间确认是用户滚动而非跳转后的余波
      const timeSinceLastJump = Date.now() - lastEdgeLoadTime.value
      if (timeSinceLastJump > 1500) {
        // 距离上次跳转超过1.5秒，认为是用户滚动导致的，需要修正
        console.log(`⚠️ 静默加载后检测到章节${detectedIndex + 1}，但当前是${currentChapterIndex.value + 1}，强制修正`)
        const chapterEl = contentRef.value?.querySelector(`[data-chapter-index="${currentChapterIndex.value}"]`)
        if (chapterEl) {
          chapterEl.scrollIntoView({ behavior: 'auto', block: 'start' })
        }
      } else {
        console.log(`⏸️ 刚完成跳转${timeSinceLastJump}ms，跳过强制修正`)
      }
    }

    isProgrammaticScrolling = false
    console.log('🔓 程序滚动标志已恢复')
  }, 400)
}

// 加载章节内容
async function loadChaptersRange(startIndex, count) {
  if (startIndex < 0 || startIndex >= totalChapterCount.value) return

  try {
    const response = await api.books.getChapters(props.book.id, startIndex, count)
    if (response.data?.chapters) {
      for (const ch of response.data.chapters) {
        if (ch.id && ch.content) {
          loadedChapters.value.set(ch.id, ch.content)
          const skeletonIndex = bookChapters.value.findIndex(s => s.id === ch.id)
          if (skeletonIndex !== -1) {
            bookChapters.value[skeletonIndex].title = ch.title || bookChapters.value[skeletonIndex].title
          }
        }
      }
    }
  } catch (error) {
    console.error('加载章节失败:', error)
  }
}

// 预加载章节图片
async function preloadChapterImages(container, timeout = 15000) {
  const images = container.querySelectorAll('img')
  if (images.length === 0) return

  // 移除懒加载，强制立即加载
  images.forEach(img => {
    if (img.dataset.src && !img.src) {
      img.src = img.dataset.src
    }
    img.loading = 'eager'
  })

  const promises = Array.from(images).map(img => {
    return new Promise((resolve) => {
      if (img.complete && img.naturalHeight > 0) {
        resolve()
      } else {
        img.onload = () => resolve()
        img.onerror = () => resolve()
      }
    })
  })

  await Promise.race([
    Promise.all(promises),
    new Promise(resolve => setTimeout(resolve, timeout))
  ])
}

// 滚动处理

// 检查是否需要屏蔽滚动
function shouldBlockScroll(deltaY) {
  const state = scrollBlockState.value
  
  // 没有在屏蔽状态
  if (!state.isBlocking) return false
  
  // 检查是否还在边界区域内
  if (!contentRef.value) return false
  
  const scrollTop = contentRef.value.scrollTop
  const scrollHeight = contentRef.value.scrollHeight
  const clientHeight = contentRef.value.clientHeight
  
  // 根据方向检查是否还在边界内
  if (state.direction === 'up') {
    // 向上加载时：如果已经滚出顶部边界（scrollTop >= EDGE_THRESHOLD），解除屏蔽
    if (scrollTop >= EDGE_THRESHOLD) {
      clearScrollBlock()
      return false
    }
    // 在顶部边界内，且试图继续向上滚动（deltaY < 0，注意：wheel事件deltaY正值向下）
    // 触摸事件：deltaY是负值表示向上
    return deltaY < 0
  }
  
  if (state.direction === 'down') {
    // 向下加载时：如果已经滚出底部边界，解除屏蔽
    if (scrollTop + clientHeight <= scrollHeight - EDGE_THRESHOLD) {
      clearScrollBlock()
      return false
    }
    // 在底部边界内，且试图继续向下滚动（deltaY > 0）
    return deltaY > 0
  }
  
  return false
}

// 处理滚轮事件
function handleWheel(e) {
  // 检查是否需要屏蔽
  if (shouldBlockScroll(e.deltaY)) {
    e.preventDefault()
    console.log('⛔ 滚轮滚动被屏蔽（在loading边界）')
    return
  }
  
  // 正常处理滚动
  handleScroll()
}

// 触摸追踪
let lastTouchY = 0

function handleTouchStart(e) {
  lastTouchY = e.touches[0].clientY
}

function handleTouchMove(e) {
  const currentY = e.touches[0].clientY
  const deltaY = lastTouchY - currentY // 正值表示向上，负值表示向下
  lastTouchY = currentY
  
  // 检查是否需要屏蔽（注意：shouldBlockScroll 中 deltaY < 0 表示向上）
  // 这里 deltaY > 0 表示向上，所以取反
  if (shouldBlockScroll(-deltaY)) {
    e.preventDefault()
    console.log('⛔ 触摸滚动被屏蔽（在loading边界）')
    return
  }
  
  // 正常处理滚动
  handleScroll()
}

function handleScroll() {
  // 恢复位置期间或程序滚动期间不处理滚动事件
  if (isRestoringPosition) {
    console.log('⏸️ 恢复位置中，跳过滚动处理')
    return
  }
  if (isProgrammaticScrolling) {
    // 程序滚动期间跳过，不输出日志避免刷屏
    return
  }

  // 实时更新进度显示
  if (isProgressLoaded.value && contentRef.value) {
    displayProgress.value = calculateProgress()
  }

  // 实时边界检测，提前发现滚动到未加载区域
  // 注意：边界检测内部会更新 scrollBlockState
  if (!isEdgeLoading.value && contentRef.value && !isProgrammaticScrolling) {
    checkAndTriggerEdgeLoading()
  }

  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer)
  scrollDebounceTimer = setTimeout(() => {
    handleScrollEnd()
  }, 300)
}

async function handleScrollEnd() {
  if (!contentRef.value || bookChapters.value.length === 0) return

  // 程序滚动期间跳过章节切换检测
  if (isProgrammaticScrolling) {
    return
  }

  // 边界加载期间跳过章节切换检测（防止快速滚动时的异常跳转）
  if (isEdgeLoading.value) {
    console.log('⏸️ 边界加载中，跳过章节检测')
    return
  }

  // 边界加载后 300ms 缓冲期
  // 避免加载完成后立即误判章节
  const timeSinceLastLoad = Date.now() - lastEdgeLoadTime.value
  if (timeSinceLastLoad < 300) {
    console.log(`⏸️ 刚完成边界加载${timeSinceLastLoad}ms，跳过章节切换检测`)
    return
  }

  // 检测当前章节
  const newIndex = detectCurrentChapter()
  
  if (newIndex !== currentChapterIndex.value && newIndex !== -1) {
    console.log(`📖 章节切换: ${currentChapterIndex.value + 1} → ${newIndex + 1}`)
    await handleChapterChange(newIndex)
  }

  // 更新进度和CFI
  if (isProgressLoaded.value) {
    const progress = calculateProgress()
    displayProgress.value = progress
    updateCurrentCFI()
    debouncedSaveProgress()
  }
}

// 检测当前章节（优化边界检测，避免链接跳转时的误判）
function detectCurrentChapter() {
  if (!contentRef.value) return -1

  const containerRect = contentRef.value.getBoundingClientRect()
  const viewportCenter = containerRect.top + containerRect.height / 2
  
  // 使用视口顶部+20%位置作为检测点，而非中心点，避免链接跳转时被误判
  const detectionPoint = containerRect.top + containerRect.height * 0.2

  const chapterElements = contentRef.value.querySelectorAll('.chapter-block')
  let bestMatch = -1
  let bestMatchScore = -1
  
  for (const el of chapterElements) {
    const rect = el.getBoundingClientRect()
    const chapterIndex = parseInt(el.dataset.chapterIndex)
    
    // 检查检测点是否在此章节内
    const isInViewport = rect.top <= detectionPoint && rect.bottom >= detectionPoint
    if (isInViewport) {
      // 计算匹配分数：越靠近检测点中心的分数越高
      const centerOffset = Math.abs((rect.top + rect.height / 2) - detectionPoint)
      const score = rect.height - centerOffset
      if (score > bestMatchScore) {
        bestMatchScore = score
        bestMatch = chapterIndex
      }
    }
  }
  
  return bestMatch
}

// 处理章节切换（用户滚动跨越章节触发）
async function handleChapterChange(newIndex) {
  // 检查冷却时间，防止快速滚动导致重复加载
  const now = Date.now()
  if (now - lastEdgeLoadTime.value < EDGE_LOAD_COOLDOWN) {
    console.log(`⏸️ 章节切换冷却中，跳过此次切换`)
    return
  }

  // 检查是否正在边界加载
  if (isEdgeLoading.value) {
    console.log(`⏸️ 正在边界加载中，跳过章节切换`)
    return
  }

  // 设置边界加载标志
  isEdgeLoading.value = true
  edgeLoadingDirection.value = newIndex > currentChapterIndex.value ? 'down' : 'up'
  lastEdgeLoadTime.value = now

  // 设置程序滚动标志，防止滚动事件干扰
  isProgrammaticScrolling = true

  const oldIndex = currentChapterIndex.value
  currentChapterIndex.value = newIndex

  console.log(`📖 章节切换: ${oldIndex + 1} → ${newIndex + 1}`)

  // 确定滚动方向
  const direction = newIndex > oldIndex ? 'down' : 'up'

  // 检查新章节是否需要加载内容
  const chapter = bookChapters.value[newIndex]
  const hasContent = loadedChapters.value.has(chapter.id)

  // 如果内容未加载，显示loading
  if (!hasContent) {
    console.log(`⏳ 章节${newIndex + 1}内容未加载，显示loading`)
    if (direction === 'down') {
      bottomLoading.value = true
    } else {
      topLoading.value = true
    }

    try {
      await loadChaptersRange(newIndex, 1)
    } catch (error) {
      console.error(`❌ 章节${newIndex + 1}加载失败:`, error)
    } finally {
      if (direction === 'down') {
        bottomLoading.value = false
      } else {
        topLoading.value = false
      }
      console.log(`✅ 章节${newIndex + 1}内容加载完成`)

      // 向上切换章节后，滚动到章节末尾，让用户从章节结尾继续阅读
      if (direction === 'up') {
        await nextTick()
        const chapterEl = contentRef.value?.querySelector(`[data-chapter-index="${newIndex}"]`)
        if (chapterEl) {
          // 滚动到章节底部（末尾）
          chapterEl.scrollIntoView({ behavior: 'auto', block: 'end' })
          console.log(`📐 向上切换章节，自动滚动到章节${newIndex + 1}末尾`)
        }
      }
    }
  }

  // 更新缓冲区（加载新章，卸载旧章）
  try {
    await updateBuffer(newIndex, direction)
  } catch (error) {
    console.error('❌ 更新缓冲区失败:', error)
  }

  // 输出内存状态
  console.log('🧠 章节切换后内存状态:', getMemoryStatus())

  // 延迟恢复标志
  setTimeout(() => {
    isEdgeLoading.value = false
    edgeLoadingDirection.value = null
    isProgrammaticScrolling = false
    console.log('🔓 章节切换完成，恢复滚动监听')
  }, 300)
}

// 更新缓冲区
async function updateBuffer(currentIdx, direction) {
  const newStart = Math.max(0, currentIdx - BUFFER_CHAPTERS)
  const newEnd = Math.min(totalChapterCount.value, currentIdx + BUFFER_CHAPTERS + 1)

  // 确定需要加载的新章
  let chapterToLoad = -1
  if (direction === 'down') {
    // 向下滚动，检查是否需要加载下一章
    const nextIdx = currentIdx + BUFFER_CHAPTERS
    if (nextIdx < totalChapterCount.value) {
      const nextChapter = bookChapters.value[nextIdx]
      if (!loadedChapters.value.has(nextChapter.id)) {
        chapterToLoad = nextIdx
      }
    }
  } else {
    // 向上滚动，检查是否需要加载上一章
    const prevIdx = currentIdx - BUFFER_CHAPTERS
    if (prevIdx >= 0) {
      const prevChapter = bookChapters.value[prevIdx]
      if (!loadedChapters.value.has(prevChapter.id)) {
        chapterToLoad = prevIdx
      }
    }
  }

  // 静默加载新章（仅内容）
  if (chapterToLoad !== -1) {
    console.log(`🔇 预加载${direction === 'down' ? '下' : '上'}一章: ${chapterToLoad + 1}`)
    await loadChaptersRange(chapterToLoad, 1)
  }

  // 更新可见范围
  visibleRange.value = { start: newStart, end: newEnd }

  // 清理超出范围的章节（内存管理）
  cleanupBuffer(currentIdx)
}

// 清理缓冲区
function cleanupBuffer(currentIdx) {
  const keepStart = Math.max(0, currentIdx - BUFFER_CHAPTERS)
  const keepEnd = Math.min(totalChapterCount.value, currentIdx + BUFFER_CHAPTERS + 1)

  const unloadedChapters = []

  // 清理章节内容
  for (const [id] of loadedChapters.value) {
    const chapter = bookChapters.value.find(ch => ch.id === id)
    if (!chapter) continue

    const index = bookChapters.value.indexOf(chapter)
    // 保留当前章及前后各1章
    if (index < keepStart || index >= keepEnd) {
      loadedChapters.value.delete(id)
      loadedImages.value.delete(id)
      unloadedChapters.push(index + 1)
    }
  }

  if (unloadedChapters.length > 0) {
    console.log(`📤 卸载章节: ${unloadedChapters.join(',')}，释放内存`)
  }
}

// 统一加载策略（目标章+前后章）

/**
 * 统一加载章节函数
 * @param {number} targetIndex - 目标章节索引
 * @param {Object} options - 配置选项
 * @param {boolean} options.loadImages - 是否为目标章加载图片
 * @param {boolean} options.loadAdjacent - 是否加载相邻章节
 * @param {string|null} options.anchor - 锚点ID（如果有）
 * @param {boolean} options.showLoading - 是否显示loading遮罩
 * @returns {Promise<{success: boolean, loadedChapters: number[]}>}
 */
async function loadChaptersUnified(targetIndex, options = {}) {
  const {
    loadImages = true,
    loadAdjacent = true,
    anchor = null,
    showLoading = false
  } = options

  console.log(`📚 统一加载: 目标章${targetIndex + 1}`, { loadImages, loadAdjacent, anchor })

  if (showLoading) {
    initialLoading.value = true
  }

  try {
    // 计算需要加载的章节范围
    const chaptersToLoad = []
    
    // 目标章必须加载
    chaptersToLoad.push({ index: targetIndex, isTarget: true, needImages: loadImages })
    
    // 相邻章（仅内容）
    if (loadAdjacent) {
      const prevIndex = targetIndex - 1
      const nextIndex = targetIndex + 1
      
      if (prevIndex >= 0) {
        const prevChapter = bookChapters.value[prevIndex]
        if (!loadedChapters.value.has(prevChapter.id)) {
          chaptersToLoad.push({ index: prevIndex, isTarget: false, needImages: false })
        }
      }
      
      if (nextIndex < totalChapterCount.value) {
        const nextChapter = bookChapters.value[nextIndex]
        if (!loadedChapters.value.has(nextChapter.id)) {
          chaptersToLoad.push({ index: nextIndex, isTarget: false, needImages: false })
        }
      }
    }

    // 并发加载所有章节内容
    console.log(`📖 并发加载章节: ${chaptersToLoad.map(c => c.index + 1).join(',')}`)
    
    const contentPromises = chaptersToLoad.map(async ({ index, isTarget, needImages }) => {
      const chapter = bookChapters.value[index]
      
      // 如果内容已加载且不需要重新加载图片，跳过
      if (loadedChapters.value.has(chapter.id) && !needImages) {
        return { index, loaded: false }
      }
      
      // 加载章节内容
      await loadChaptersRange(index, 1)
      return { index, isTarget, needImages, loaded: true }
    })
    
    const loadResults = await Promise.all(contentPromises)
    const loadedIndices = loadResults.filter(r => r.loaded).map(r => r.index + 1)
    console.log(`✅ 内容加载完成: ${loadedIndices.join(',') || '无新加载'}`)

    // 更新可见范围
    const newStart = Math.max(0, targetIndex - BUFFER_CHAPTERS)
    const newEnd = Math.min(totalChapterCount.value, targetIndex + BUFFER_CHAPTERS + 1)
    visibleRange.value = { start: newStart, end: newEnd }

    // 等待DOM更新
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 100))

    // 如果目标章需要加载图片
    if (loadImages) {
      const targetChapterEl = contentRef.value?.querySelector(`[data-chapter-index="${targetIndex}"] .chapter-content`)
      if (targetChapterEl) {
        console.log(`🖼️ 预加载目标章图片: ${targetIndex + 1}`)
        await preloadChapterImages(targetChapterEl, 15000)
        loadedImages.value.add(bookChapters.value[targetIndex]?.id)
      }
    }

    // 清理超出范围的章节
    cleanupBuffer(targetIndex)

    if (showLoading) {
      initialLoading.value = false
    }

    console.log('🧠 统一加载完成，内存状态:', getMemoryStatus())
    
    return {
      success: true,
      loadedChapters: loadedIndices
    }

  } catch (error) {
    console.error('❌ 统一加载失败:', error)
    if (showLoading) {
      initialLoading.value = false
    }
    return { success: false, loadedChapters: [] }
  }
}

// 实时边界检测：在滚动过程中提前发现即将进入未加载区域
function checkAndTriggerEdgeLoading() {
  if (!contentRef.value) return null

  const container = contentRef.value
  const scrollTop = container.scrollTop
  const scrollHeight = container.scrollHeight
  const clientHeight = container.clientHeight

  // 计算当前可见范围
  const currentStart = visibleRange.value.start
  const currentEnd = visibleRange.value.end

  // 检查是否接近顶部且上一章未加载
  if (scrollTop < EDGE_THRESHOLD && currentStart > 0) {
    const prevIndex = currentStart - 1
    const prevChapter = bookChapters.value[prevIndex]
    
    if (prevChapter && !loadedChapters.value.has(prevChapter.id)) {
      // 检查是否已经在加载中
      if (!isEdgeLoading.value) {
        console.log(`⚡ 实时边界检测：即将进入未加载章节${prevIndex + 1}`)
        triggerEdgeLoad(prevIndex, 'up')
      }
      // 更新屏蔽状态（即使正在加载也要更新位置）
      updateScrollBlock('up', prevIndex, scrollTop)
      return 'up'
    }
  }

  // 检查是否接近底部且下一章未加载
  if (scrollTop + clientHeight > scrollHeight - EDGE_THRESHOLD && currentEnd < totalChapterCount.value) {
    const nextIndex = currentEnd
    const nextChapter = bookChapters.value[nextIndex]
    
    if (nextChapter && !loadedChapters.value.has(nextChapter.id)) {
      if (!isEdgeLoading.value) {
        console.log(`⚡ 实时边界检测：即将进入未加载章节${nextIndex + 1}`)
        triggerEdgeLoad(nextIndex, 'down')
      }
      updateScrollBlock('down', nextIndex, scrollTop)
      return 'down'
    }
  }

  // 不在边界范围内，解除屏蔽
  if (scrollBlockState.value.isBlocking) {
    clearScrollBlock()
  }
  
  return null
}

// 更新滚动屏蔽状态
function updateScrollBlock(direction, chapterIndex, currentScrollTop) {
  scrollBlockState.value = {
    isBlocking: true,
    direction: direction,
    blockPosition: currentScrollTop,
    loadingIndex: chapterIndex
  }
}

// 清除滚动屏蔽状态
function clearScrollBlock() {
  if (scrollBlockState.value.isBlocking) {
    console.log('🔓 滚动屏蔽已解除（已离开loading边界）')
    scrollBlockState.value = {
      isBlocking: false,
      direction: null,
      blockPosition: null,
      loadingIndex: null
    }
  }
}

// 触发边界加载（实时滚动时调用）
async function triggerEdgeLoad(chapterIndex, direction) {
  // 检查冷却时间
  const now = Date.now()
  if (now - lastEdgeLoadTime.value < EDGE_LOAD_COOLDOWN) {
    return
  }

  // 检查是否已在加载中
  if (isEdgeLoading.value) {
    return
  }

  isEdgeLoading.value = true
  edgeLoadingDirection.value = direction
  lastEdgeLoadTime.value = now

  console.log(`⏳ 实时边界加载: 章节${chapterIndex + 1} (${direction})`)

  // 显示 loading
  if (direction === 'down') {
    bottomLoading.value = true
  } else {
    topLoading.value = true
  }

  // 向上加载前记录锚点位置
  let anchorInfo = null
  if (direction === 'up' && contentRef.value) {
    // 找当前视口中最靠上的已加载章节作为锚点（通常是用户正在看的章节）
    const visibleChapters = Array.from(contentRef.value.querySelectorAll('[data-chapter-index]'))
      .filter(el => {
        const rect = el.getBoundingClientRect()
        const containerRect = contentRef.value.getBoundingClientRect()
        // 元素在视口内或刚好在视口下方一点
        return rect.bottom > containerRect.top + 50 && rect.top < containerRect.bottom
      })
    
    if (visibleChapters.length > 0) {
      const anchorEl = visibleChapters[0] // 取最上面的可见章节
      anchorInfo = {
        chapterIndex: parseInt(anchorEl.dataset.chapterIndex),
        offsetTop: anchorEl.offsetTop, // 距离容器顶部的绝对位置
        scrollTop: contentRef.value.scrollTop // 当前滚动位置
      }
      console.log(`📍 记录锚点: 章节${anchorInfo.chapterIndex + 1}, offsetTop=${anchorInfo.offsetTop}, scrollTop=${anchorInfo.scrollTop}`)
    }
  }

  try {
    await loadChaptersRange(chapterIndex, 1)
    console.log(`✅ 实时边界加载完成: 章节${chapterIndex + 1}`)

    // 加载完成后更新可见范围
    if (direction === 'down') {
      visibleRange.value.end = Math.min(totalChapterCount.value, visibleRange.value.end + 1)
    } else {
      visibleRange.value.start = Math.max(0, visibleRange.value.start - 1)
    }

    // 等待 DOM 更新，让新章节显示出来
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 50))

    // 向上加载完成后恢复锚点位置
    if (direction === 'up' && anchorInfo && contentRef.value) {
      const anchorEl = contentRef.value.querySelector(`[data-chapter-index="${anchorInfo.chapterIndex}"]`)
      if (anchorEl) {
        // 计算新位置：保持锚点元素相对于容器的位置不变
        const newOffsetTop = anchorEl.offsetTop
        const heightAdded = newOffsetTop - anchorInfo.offsetTop // 新增内容的高度
        const newScrollTop = anchorInfo.scrollTop + heightAdded
        
        contentRef.value.scrollTop = newScrollTop
        console.log(`📐 恢复锚点位置: 新增高度=${heightAdded}px, 新scrollTop=${newScrollTop}`)
      }
    }

    console.log(`📝 ${chapterIndex + 1}章已显示，继续滚动可切换`)
    // 不解屏蔽状态，让用户继续滚动触发切换
    // 屏蔽会在 shouldBlockScroll 中根据滚动位置自动解除
  } catch (error) {
    console.error(`❌ 实时边界加载失败:`, error)
  } finally {
    if (direction === 'down') {
      bottomLoading.value = false
    } else {
      topLoading.value = false
    }
    isEdgeLoading.value = false
    edgeLoadingDirection.value = null
  }
}

// 统一的章节内容定位函数
// 定位到内容区第一个元素，让标题自然显示在上方
async function scrollToChapterContent(chapterIndex, options = {}) {
  const { anchorElement = null, preserveTitle = true } = options
  
  const chapterEl = contentRef.value?.querySelector(`[data-chapter-index="${chapterIndex}"]`)
  if (!chapterEl) {
    console.warn('⚠️ 未找到章节元素:', chapterIndex)
    return false
  }
  
  const contentEl = chapterEl.querySelector('.chapter-content')
  const titleEl = chapterEl.querySelector('.chapter-title')
  
  // 情况1: 有指定锚点元素且不是标题本身
  if (anchorElement && anchorElement !== titleEl) {
    anchorElement.scrollIntoView({ behavior: 'auto', block: 'start' })
    console.log('✅ 滚动到指定锚点元素')
    return true
  }
  
  // 情况2: 跳转到章节开头（目录跳转或链接到章节开头）
  // 策略：滚动到内容区第一个子元素，让标题自然显示在视口顶部或略上方
  if (contentEl && contentEl.firstElementChild) {
    // 定位到内容的第一个段落/元素
    contentEl.firstElementChild.scrollIntoView({ behavior: 'auto', block: 'start' })
    
    // 稍微向上回滚，让用户能看到标题（约30px，确保标题部分可见）
    if (preserveTitle && titleEl) {
      await nextTick()
      const titleHeight = titleEl.offsetHeight
      // 回滚标题高度+一点间距，让标题完整显示
      contentRef.value.scrollTop = Math.max(0, contentRef.value.scrollTop - titleHeight - 10)
    }
    
    console.log(`✅ 滚动到章节${chapterIndex + 1}内容开头，标题可见`)
  } else {
    // 回退：滚动到章节块开头
    chapterEl.scrollIntoView({ behavior: 'auto', block: 'start' })
    console.log(`✅ 滚动到章节${chapterIndex + 1}开头（回退方案）`)
  }
  
  return true
}

// 计算阅读进度
function calculateProgress() {
  if (bookChapters.value.length === 0) return 0

  if (!charOffsetProgress.value.initialized) {
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 基于已加载章节的实际 DOM 计算进度
  const container = contentRef.value
  if (!container) return (currentChapterIndex.value / bookChapters.value.length) * 100

  // 获取所有已加载的章节元素
  const loadedChapterEls = Array.from(container.querySelectorAll('[data-chapter-index]'))
  if (loadedChapterEls.length === 0) {
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 找到当前章节在DOM中的索引
  const currentEl = container.querySelector(`[data-chapter-index="${currentChapterIndex.value}"]`)
  if (!currentEl) {
    // 当前章节未加载，基于章节索引粗略计算
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 获取章节内容元素
  const chapterContent = currentEl.querySelector('.chapter-content')
  if (!chapterContent) {
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 计算章节内进度：基于视口顶部相对于章节顶部的偏移
  const containerRect = container.getBoundingClientRect()
  const contentRect = chapterContent.getBoundingClientRect()
  const chapterHeight = chapterContent.scrollHeight

  // 如果章节高度为0，回退到基于章节的计算
  if (chapterHeight <= 0) {
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 计算视口顶部相对于章节内容的滚动偏移
  // contentRect.top - containerRect.top = 章节顶部相对于容器视口顶部的偏移（可为负）
  // 当章节向上滚动时，这个值变负，表示章节在视口上方露出多少
  const chapterTopToViewport = contentRect.top - containerRect.top
  
  // 已滚动距离 = 章节在视口上方露出的高度（负值取反）
  const scrolledInChapter = -chapterTopToViewport
  
  // 章节内已读比例（0-1）
  const innerRatio = Math.max(0, Math.min(1, scrolledInChapter / chapterHeight))

  // 使用 charOffsetProgress 的章节偏移数据
  const chapterInfo = charOffsetProgress.value.chapterOffsets[currentChapterIndex.value]
  if (!chapterInfo) {
    return (currentChapterIndex.value / bookChapters.value.length) * 100
  }

  // 当前总偏移 = 本章起始偏移 + 章节内偏移
  const innerChars = Math.floor(chapterInfo.textLength * innerRatio)
  const currentOffset = chapterInfo.startOffset + innerChars

  // 进度百分比
  const progress = (currentOffset / charOffsetProgress.value.totalChars) * 100
  return Math.min(100, Math.max(0, progress))
}

function updateCurrentCFI() {
  if (!contentRef.value || isRestoringPosition || !isProgressLoaded.value) return
  // 关键：.chapter-content 元素现在直接有 data-chapter-id，不需要额外选择器
  const cfi = getCurrentCFI(contentRef.value)
  if (cfi) {
    currentCFI = cfi
  }
}

function debouncedSaveProgress(delay = 500) {
  if (saveProgressTimer) clearTimeout(saveProgressTimer)
  saveProgressTimer = setTimeout(() => saveProgress(), delay)
}

async function saveProgress() {
  if (isGuest.value) {
    console.log('📖 游客模式：不保存阅读进度')
    return
  }
  if (!props.book || !isProgressLoaded.value) return

  try {
    const progressPercent = calculateProgress()
    displayProgress.value = progressPercent

    // 获取当前CFI
    if (contentRef.value) {
      // 关键：.chapter-content 元素现在直接有 data-chapter-id
      const cfi = getCurrentCFI(contentRef.value)
      if (cfi) currentCFI = cfi
    }

    const progressData = {
      currentPage: currentChapterIndex.value,
      scrollPosition: contentRef.value?.scrollTop || 0,
      progress: progressPercent,
      fontSize: fontSize.value,
      cfi: currentCFI
    }

    console.log('💾 保存阅读进度:', {
      书名: props.book.title,
      章节: currentChapterIndex.value + 1,
      CFI: currentCFI ? currentCFI.substring(0, 50) + '...' : '无',
      进度: progressPercent.toFixed(2) + '%',
      内存: getMemoryStatus()
    })

    await api.books.saveProgress(props.book.id, progressData)
  } catch (error) {
    console.error('❌ 保存进度失败:', error)
  }
}

// 获取内存状态
function getMemoryStatus() {
  const loadedChaptersList = Array.from(loadedChapters.value.keys()).map(id => {
    const chapter = bookChapters.value.find(ch => ch.id === id)
    return chapter ? bookChapters.value.indexOf(chapter) + 1 : '?'
  }).sort((a, b) => a - b)

  const loadedImagesList = Array.from(loadedImages.value).map(id => {
    const chapter = bookChapters.value.find(ch => ch.id === id)
    return chapter ? bookChapters.value.indexOf(chapter) + 1 : '?'
  }).sort((a, b) => a - b)

  return {
    当前章: currentChapterIndex.value + 1,
    已加载章节: loadedChaptersList.join(','),
    已加载图片: loadedImagesList.join(','),
    缓存章节数: loadedChapters.value.size,
    缓存图片数: loadedImages.value.size
  }
}

// 跳转章节
async function jumpToChapter(tocItem) {
  if (tocItem.chapterIndex === undefined) return

  showTocDrawer.value = false
  const targetIndex = tocItem.chapterIndex

  console.log(`📖 目录跳转: 第${targetIndex + 1}章`)

  // 关键：设置边界加载标志，防止跳转后立即触发边界检测
  isEdgeLoading.value = true
  edgeLoadingDirection.value = targetIndex > currentChapterIndex.value ? 'down' : 'up'
  lastEdgeLoadTime.value = Date.now()

  // 设置程序跳转标志，防止滚动事件干扰
  // 关键：程序跳转期间完全禁用章节切换检测，因为视口中心点检测在跳转后不可靠
  isProgrammaticScrolling = true

  // 检查章节是否在缓冲区内
  const inBuffer = targetIndex >= visibleRange.value.start && targetIndex < visibleRange.value.end

  if (!inBuffer) {
    console.log('📖 目标章节不在缓冲区，使用统一加载')
    
    // 清理缓存并重新加载目标章+相邻章
    loadedChapters.value.clear()
    loadedImages.value.clear()
    
    currentChapterIndex.value = targetIndex
    
    // 统一加载目标章+相邻章
    const loadResult = await loadChaptersUnified(targetIndex, {
      loadImages: true,
      loadAdjacent: true,
      showLoading: true
    })
    
    if (!loadResult.success) {
      showToast('加载失败', 'error')
      isEdgeLoading.value = false
      isProgrammaticScrolling = false
      return
    }

    // 滚动到目标章节
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 100))
    await scrollToChapterContent(targetIndex, { preserveTitle: true })
    
  } else {
    console.log('📖 目标章节在缓冲区，更新当前章节索引并滚动')
    // 在缓冲区内，更新当前章节索引
    currentChapterIndex.value = targetIndex
    // 确保 visibleRange 包含目标章节
    const newStart = Math.max(0, targetIndex - BUFFER_CHAPTERS)
    const newEnd = Math.min(totalChapterCount.value, targetIndex + BUFFER_CHAPTERS + 1)
    visibleRange.value = { start: newStart, end: newEnd }
    // 清理超出范围的章节
    cleanupBuffer(targetIndex)

    // 等待DOM更新后滚动
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 150))

    // 定位到章节内容区
    const success = await scrollToChapterContent(targetIndex, { preserveTitle: true })
    if (!success) {
      console.warn('⚠️ 未找到目标章节元素:', targetIndex)
    }
  }

  // 关键：延迟恢复标志，确保滚动完全稳定后再允许章节检测
  setTimeout(() => {
    isEdgeLoading.value = false
    edgeLoadingDirection.value = null
    isProgrammaticScrolling = false
    console.log('🔓 目录跳转完成，恢复滚动监听')
  }, 1000)

  debouncedSaveProgress(300)
}

// 处理内容点击
async function handleContentClick(e) {
  if (initialLoading.value) return

  const link = e.target.closest('a[href]')
  if (link) {
    const href = link.getAttribute('href')
    if (!href) return

      if (href.startsWith('#')) {
      e.preventDefault()
      const targetId = href.substring(1)
      console.log('📖 处理#开头的锚点跳转:', targetId)

      // 关键：程序跳转期间禁用章节切换检测
      isProgrammaticScrolling = true

      // 关键：在当前章节内查找锚点，避免ID冲突（不同章节可能有相同的注释ID）
      const currentChapterEl = contentRef.value?.querySelector(`[data-chapter-index="${currentChapterIndex.value}"]`)
      const targetElement = currentChapterEl?.querySelector(`#${CSS.escape(targetId)}, [name="${CSS.escape(targetId)}"]`)

      if (targetElement) {
        // 使用 block: 'center' 确保目标元素居中显示，避免顶部栏遮挡
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
        console.log('✅ 已跳转到锚点（居中显示）:', targetId)
      } else {
        console.warn('⚠️ 未找到锚点元素:', targetId)
      }

      // 关键：延迟恢复标志，确保滚动完全稳定
      setTimeout(() => {
        isProgrammaticScrolling = false
        console.log('🔓 锚点跳转完成，恢复滚动监听')
      }, 800)
      return
    }

    if (!href.startsWith('http') && !href.startsWith('data:') && !href.startsWith('javascript:')) {
      e.preventDefault()
      const [filePath, anchor] = href.split('#')

      // 如果只有锚点（当前章节内跳转），直接处理
      if (!filePath && anchor) {
        console.log('📖 当前章节内锚点跳转:', anchor)
        // 关键：程序跳转期间禁用章节切换检测
        isProgrammaticScrolling = true

        // 关键：在当前章节内查找锚点，避免ID冲突（不同章节可能有相同的注释ID）
        const currentChapterEl = contentRef.value?.querySelector(`[data-chapter-index="${currentChapterIndex.value}"]`)
        const targetElement = currentChapterEl?.querySelector(`#${CSS.escape(anchor)}, [name="${CSS.escape(anchor)}"]`)

        if (targetElement) {
          // 使用 block: 'center' 确保目标元素居中显示，避免顶部栏遮挡
          targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          console.log('✅ 已跳转到锚点（居中显示）:', anchor)
        } else {
          console.warn('⚠️ 未找到锚点元素:', anchor)
        }

        // 关键：延迟恢复标志，确保滚动完全稳定
        setTimeout(() => {
          isProgrammaticScrolling = false
          console.log('🔓 章内锚点跳转完成，恢复滚动监听')
        }, 800)
        return
      }

      let chapterIndex = -1
      const targetFileName = filePath.split('/').pop()?.toLowerCase()

      for (let i = 0; i < bookChapters.value.length; i++) {
        const ch = bookChapters.value[i]
        if (!ch.href) continue
        const chFileName = ch.href.split('/').pop()?.toLowerCase()
        if (chFileName === targetFileName) {
          chapterIndex = i
          break
        }
      }

      if (chapterIndex !== -1) {
        console.log('📖 章节链接跳转:', { 目标章: chapterIndex + 1, filePath, anchor })

        // 关键：设置边界加载标志，防止跳转后立即触发边界检测
        isEdgeLoading.value = true
        edgeLoadingDirection.value = chapterIndex > currentChapterIndex.value ? 'down' : 'up'
        lastEdgeLoadTime.value = Date.now()

        // 关键：程序跳转期间禁用章节切换检测
        isProgrammaticScrolling = true

        // 加载目标章+相邻章
        const targetChapter = bookChapters.value[chapterIndex]
        const hasContent = loadedChapters.value.has(targetChapter.id)
        
        // 如果目标章节不在内存，使用统一加载；否则只更新索引和范围
        if (!hasContent) {
          console.log(`📖 目标章节${chapterIndex + 1}未加载，使用统一加载`)
          const loadResult = await loadChaptersUnified(chapterIndex, {
            loadImages: true,
            loadAdjacent: true,
            showLoading: false
          })
          
          if (!loadResult.success) {
            showToast('加载失败', 'error')
            isEdgeLoading.value = false
            isProgrammaticScrolling = false
            return
          }
        } else {
          // 已在内存，只更新范围和清理缓存
          const newStart = Math.max(0, chapterIndex - BUFFER_CHAPTERS)
          const newEnd = Math.min(totalChapterCount.value, chapterIndex + BUFFER_CHAPTERS + 1)
          visibleRange.value = { start: newStart, end: newEnd }
          cleanupBuffer(chapterIndex)
        }

        // 更新当前章节
        currentChapterIndex.value = chapterIndex

        // 等待DOM更新后滚动
        await nextTick()
        await new Promise(resolve => setTimeout(resolve, 200))

        // 有锚点时直接滚动到锚点位置
        if (anchor) {
          const targetElement = contentRef.value?.querySelector(`#${CSS.escape(anchor)}`)
          if (targetElement) {
            // 统一使用居中显示，确保目标可见（避免顶部栏遮挡）
            targetElement.scrollIntoView({ behavior: 'auto', block: 'center' })
            console.log('✅ 已跳转到锚点（居中显示）:', anchor)
          } else {
            // 锚点未找到，回退到章节开头
            await scrollToChapterContent(chapterIndex, { preserveTitle: true })
            console.log('✅ 已滚动到目标章节开头（锚点未找到）:', chapterIndex + 1)
          }
        } else {
          // 没有锚点，滚动到章节开头
          await scrollToChapterContent(chapterIndex, { preserveTitle: true })
          console.log('✅ 已滚动到目标章节:', chapterIndex + 1)
        }

        // 关键：延迟恢复标志，确保滚动完全稳定后再允许章节检测
        setTimeout(() => {
          isEdgeLoading.value = false
          edgeLoadingDirection.value = null
          isProgrammaticScrolling = false
          console.log('🔓 链接跳转完成，恢复滚动监听')
        }, 1000)
        
        return
      } else {
        console.warn('⚠️ 未找到目标章节:', filePath)
      }
      return
    }

    if (href.startsWith('http')) {
      e.preventDefault()
      if (confirm('这是一个外部链接，是否在新窗口打开？\n' + href)) {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    }
    return
  }

  showMenu.value = !showMenu.value
}

// 字号调整
function increaseFontSize() {
  if (fontSize.value < 32) {
    fontSize.value += 2
    debouncedSaveProgress(500)
  }
}

function decreaseFontSize() {
  if (fontSize.value > 12) {
    fontSize.value -= 2
    debouncedSaveProgress(500)
  }
}

// 关闭阅读器
function handleClose() {
  // 只在非恢复状态下保存，避免保存错误位置
  if (!isRestoringPosition && isProgressLoaded.value) {
    console.log('📖 关闭阅读器，保存进度:', {
      章节: currentChapterIndex.value + 1,
      进度: displayProgress.value.toFixed(2) + '%'
    })
    saveProgress()
  } else {
    console.log('⏸️ 关闭阅读器时跳过保存（正在恢复位置或未加载完成）')
  }

  // 清理定时器
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer)
    scrollDebounceTimer = null
  }
  if (saveProgressTimer) {
    clearTimeout(saveProgressTimer)
    saveProgressTimer = null
  }

  // 停止滚动位置轮询
  stopScrollPolling()

  // 重置状态
  isProgressLoaded.value = false
  currentCFI = null
  isRestoringPosition = false
  isProgrammaticScrolling = false

  emit('update:visible', false)
  emit('close')
}

// 监听字体变化
watch(fontSize, async () => {
  const cfi = getCurrentCFI(contentRef.value)
  if (cfi) currentCFI = cfi

  await nextTick()
  setTimeout(() => {
    if (currentCFI && contentRef.value) {
      // 关键：.chapter-content 元素现在直接有 data-chapter-id
      scrollToCFI(contentRef.value, currentCFI, null, false)
    }
    debouncedSaveProgress(500)
  }, 100)
})
</script>

<style scoped>
.book-reader {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #f5f1e8;
  z-index: 9999;
  display: flex;
  flex-direction: column;
}

/* 初始加载遮罩 */
.initial-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #f5f1e8;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  z-index: 10001;
  color: #666;
  font-size: 14px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(0, 0, 0, 0.1);
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-spinner-small {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 边缘loading提示 */
.edge-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: #666;
  font-size: 14px;
  background: rgba(245, 241, 232, 0.9);
}

.top-loading {
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}

.bottom-loading {
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}

/* 章节loading遮罩 */
.chapter-loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(245, 241, 232, 0.95);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #666;
  font-size: 14px;
  z-index: 10;
}

.content-hidden {
  opacity: 0;
}

/* 顶部栏 */
.reader-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: rgba(245, 241, 232, 0.95);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  transition: transform 0.3s ease;
  z-index: 100;
  transform: translateY(-100%);
}

.reader-header.header-visible {
  transform: translateY(0);
}

.back-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
}

.book-title {
  flex: 1;
  text-align: center;
  font-size: 16px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 12px;
}

.placeholder {
  width: 40px;
}

/* 正文内容区 */
.reader-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 16px;
  scroll-behavior: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.reader-content::-webkit-scrollbar {
  display: none;
}

.chapter-block {
  margin-bottom: 32px;
  position: relative;
}

.chapter-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 20px;
  color: #333;
  text-align: center;
}

.chapter-content {
  text-align: justify;
  text-indent: 2em;
}

.chapter-content :deep(p) {
  margin-bottom: 1em;
}

.chapter-content :deep(img) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 16px auto;
}

.load-more {
  text-align: center;
  padding: 32px 16px;
  color: #999;
  font-size: 14px;
}

.book-end {
  color: #ccc;
}

/* 底部栏 */
.reader-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: rgba(245, 241, 232, 0.95);
  backdrop-filter: blur(10px);
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  transition: transform 0.3s ease;
  z-index: 100;
  transform: translateY(100%);
}

.reader-footer.footer-visible {
  transform: translateY(0);
}

.footer-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  cursor: pointer;
  padding: 8px 16px;
}

.progress-text {
  font-size: 14px;
  color: #333;
  font-weight: 500;
  min-width: 60px;
  text-align: center;
}

/* 目录列表 - 作为独立的滚动容器 */
.toc-list {
  max-height: calc(80vh - 60px - 57px); /* drawer-body高度减去header高度 */
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.toc-list::-webkit-scrollbar {
  display: none;
}

/* 原生抽屉样式 */
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 10000;
  animation: fade-in 0.2s ease;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.drawer-content {
  position: absolute;
  background: #fff;
  animation: slide-in 0.2s ease;
}

.drawer-left {
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  animation: slide-in-left 0.2s ease;
}

.drawer-bottom {
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 16px 16px 0 0;
  animation: slide-in-bottom 0.2s ease;
}

@keyframes slide-in-left {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

@keyframes slide-in-bottom {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #eee;
}

.drawer-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  color: #999;
  cursor: pointer;
  line-height: 1;
}

.drawer-body {
  padding: 0;
  /* 目录使用.toc-list作为滚动容器，.drawer-body不设置overflow */
}

.toc-item {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc-item.active {
  color: #0052d9;
  background: #f0f7ff;
}

/* 字体设置面板 */
.font-size-control {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
}

.size-btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid #ddd;
  background: #fff;
  font-size: 18px;
  cursor: pointer;
}

.size-value {
  font-size: 18px;
  min-width: 60px;
  text-align: center;
}

/* 原生提示样式 */
.toast {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 14px;
  color: #fff;
  z-index: 20001;
  animation: fade-in-out 2.5s ease;
}

.toast.success {
  background: rgba(0, 0, 0, 0.8);
}

.toast.error {
  background: rgba(227, 77, 89, 0.9);
}

@keyframes fade-in-out {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
  10% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  90% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
}

/* 过渡动画 */
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.3s ease;
}

.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}
</style>
