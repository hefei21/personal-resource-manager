<template>
  <Teleport to="body">
    <Transition name="ebook-reader-fade">
      <section v-if="modelValue" ref="readerRoot" class="ebook-reader" :class="`ebook-reader--${readerTheme}`" role="dialog" aria-modal="true" tabindex="-1" :aria-label="book?.title || '电子书阅读器'" @keydown.esc.stop="handleEscape">
        <header class="ebook-reader__header">
          <div class="ebook-reader__topbar">
          <NativeButton variant="text" class="ebook-reader__icon-button" aria-label="关闭阅读器" @click="closeReader">
            <NativeIcon name="arrow-left" size="22" />
          </NativeButton>
          <NativeButton variant="text" class="ebook-reader__tool ebook-reader__toc-trigger" aria-label="打开或关闭目录" :aria-expanded="tocOpen" @click="settingsOpen = false; tocOpen = !tocOpen">
            <NativeIcon name="list-dashes" size="20" /><span>目录</span>
          </NativeButton>
          <div class="ebook-reader__identity">
            <strong>{{ book?.title || '电子书阅读器' }}</strong>
            <span>{{ positionLabel }}</span>
          </div>
          <div class="ebook-reader__header-actions">
            <NativeButton variant="text" class="ebook-reader__tool" aria-label="阅读设置" :aria-expanded="settingsOpen" @click="tocOpen = false; settingsOpen = !settingsOpen">
              <NativeIcon name="gear" size="20" /><span>排版</span>
            </NativeButton>
            <NativeButton variant="text" class="ebook-reader__icon-button" aria-label="下载原件" @click="downloadOriginal">
              <NativeIcon name="download" size="20" />
            </NativeButton>
          </div>
          </div>
        </header>

        <div v-if="syncStatus === 'offline'" class="ebook-reader__notice">
          <NativeIcon name="cloud-arrow-up" />
          <span>当前离线，阅读位置已保存在本机，联网后自动同步。</span>
        </div>
        <div v-else-if="progressConflict" class="ebook-reader__notice ebook-reader__notice--warning">
          <NativeIcon name="warning-circle" />
          <span>其他设备已更新阅读位置，请选择要保留的位置。</span>
          <NativeButton size="small" variant="outline" @click="resolveConflict('remote')">前往其他设备位置</NativeButton>
          <NativeButton size="small" theme="primary" @click="resolveConflict('local')">保留本机位置</NativeButton>
        </div>

        <button v-if="tocOpen || settingsOpen" class="ebook-reader__scrim" aria-label="关闭阅读面板" @click="tocOpen = false; settingsOpen = false" />
        <Transition name="reader-panel-left">
        <aside v-if="tocOpen" class="ebook-reader__toc ebook-reader__toc--open">
          <div class="ebook-reader__panel-heading">
            <div><strong>目录</strong><span>{{ chapterCountLabel }}</span></div>
            <NativeButton variant="text" class="ebook-reader__icon-button" aria-label="关闭目录" @click="tocOpen = false">
              <NativeIcon name="x" />
            </NativeButton>
          </div>
          <nav ref="tocList" class="ebook-reader__toc-list" aria-label="书籍目录">
            <button
              v-for="(chapter, index) in effectiveToc"
              :key="`${chapter.href || chapter.id || index}-${index}`"
              type="button"
              :class="{ active: currentPageIndex === chapter.chapterIndex }"
              :aria-current="currentPageIndex === chapter.chapterIndex ? 'location' : undefined"
              @click="goToChapter(chapter.chapterIndex, chapter.href?.split('#')[1])"
            >
              <span>{{ chapter.title || `章节 ${index + 1}` }}</span>
              <small>{{ chapter.chapterIndex + 1 }}</small>
            </button>
          </nav>
        </aside>
        </Transition>

        <Transition name="reader-panel-right">
        <aside v-if="settingsOpen" class="ebook-reader__settings ebook-reader__settings--open">
          <div class="ebook-reader__panel-heading">
            <div><strong>阅读设置</strong><span>仅保存在当前设备</span></div>
            <NativeButton variant="text" class="ebook-reader__icon-button" aria-label="关闭阅读设置" @click="settingsOpen = false">
              <NativeIcon name="x" />
            </NativeButton>
          </div>
          <div class="ebook-reader__setting-group">
            <label>字号</label>
            <div class="ebook-reader__stepper">
              <NativeButton variant="outline" :disabled="fontSize <= 14" @click="fontSize -= 1">A−</NativeButton>
              <span>{{ fontSize }} px</span>
              <NativeButton variant="outline" :disabled="fontSize >= 28" @click="fontSize += 1">A＋</NativeButton>
            </div>
          </div>
          <div class="ebook-reader__setting-group">
            <label>字体</label>
            <div class="ebook-reader__segmented">
              <button v-for="option in fontOptions" :key="option.value" type="button" :class="{ active: fontFamily === option.value }" @click="fontFamily = option.value">
                {{ option.label }}
              </button>
            </div>
          </div>
          <div class="ebook-reader__setting-group">
            <label>页面</label>
            <div class="ebook-reader__segmented">
              <button v-for="option in themeOptions" :key="option.value" type="button" :class="{ active: readerTheme === option.value }" @click="readerTheme = option.value">
                {{ option.label }}
              </button>
            </div>
          </div>
          <div v-if="isPdf" class="ebook-reader__setting-group">
            <label>缩放</label>
            <div class="ebook-reader__stepper">
              <NativeButton variant="outline" :disabled="pdfScale <= 0.7" @click="pdfScale = Math.max(0.7, pdfScale - 0.1)">−</NativeButton>
              <span>{{ Math.round(pdfScale * 100) }}%</span>
              <NativeButton variant="outline" :disabled="pdfScale >= 2" @click="pdfScale = Math.min(2, pdfScale + 0.1)">＋</NativeButton>
            </div>
          </div>
        </aside>
        </Transition>

        <main ref="readingSurface" class="ebook-reader__surface" :class="`ebook-reader__surface--${readerTheme}`" @click="handleContentClick" @scroll.passive="handleScroll">
          <div v-if="loading" class="ebook-reader__state" role="status">
            <NativeIcon name="book-open" size="38" />
            <strong>正在准备阅读内容</strong>
            <span>{{ loadingMessage }}</span>
          </div>
          <div v-else-if="loadError" class="ebook-reader__state ebook-reader__state--error" role="alert">
            <NativeIcon name="warning-circle" size="38" />
            <strong>暂时无法打开这本书</strong>
            <span>{{ loadError }}</span>
            <div>
              <NativeButton theme="primary" @click="openBook">重试</NativeButton>
              <NativeButton variant="outline" @click="downloadOriginal">下载原件</NativeButton>
            </div>
          </div>

          <article
            v-else-if="isFlowDocument"
            ref="flowArticle"
            class="ebook-reader__paper ebook-reader__flow book-text"
            :style="flowStyle"
            :data-chapter-id="currentChapter?.id"
            v-html="safeChapterContent"
          />

          <div v-else-if="isPdf" ref="pdfStage" class="ebook-reader__pdf-stage">
            <canvas ref="pdfCanvas" class="ebook-reader__pdf-canvas" aria-label="PDF 当前页面" />
          </div>
        </main>

        <footer v-if="!loading && !loadError" class="ebook-reader__footer" :aria-busy="navigating">
          <NativeButton variant="outline" class="ebook-reader__nav-button" :disabled="!canGoPrevious" @click="goPrevious">
            <NativeIcon name="chevron-left" />
            {{ isPdf ? '上一页' : '上一章' }}
          </NativeButton>
          <button class="ebook-reader__progress" type="button" @click="tocOpen = true">
            <span><i :style="{ width: `${readingPercent}%` }" /></span>
            <strong>{{ footerPositionLabel }}</strong>
            <small>{{ readingPercent.toFixed(0) }}%</small>
          </button>
          <NativeButton variant="outline" class="ebook-reader__nav-button" :disabled="!canGoNext && !canMarkFinished" @click="goNextOrFinish">
            {{ canGoNext ? (isPdf ? '下一页' : '下一章') : canMarkFinished ? '标为读完' : (isPdf ? '下一页' : '下一章') }}
            <NativeIcon :name="canMarkFinished ? 'check' : 'chevron-right'" />
          </NativeButton>
        </footer>
      </section>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { NativeButton, NativeIcon } from '@/components/native'
import { findEbookChapterIndex, resolveEbookLink } from '@/domain/ebookReaderNavigation'
import { createEbookReadingProgressSync, deriveEbookChapterFraction, EbookProgressConflictError, isEbookCfiForChapter } from '@/domain/ebookReadingProgress'
import { getCurrentCFI, scrollToCFI } from '@/utils/epub-cfi'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { disposePdfDocument, openAuthenticatedPdfDocument, openMobilePdfDocument } from '@/utils/pdfPreview'
import { sanitizeRichHtml } from '@/utils/sanitizeHtml'
import { useViewport } from '@/composables/useViewport'
import { acquireBodyScrollLock, useModalFocus } from '@/composables/useModalFocus'

const props = defineProps({
  modelValue: Boolean,
  book: { type: Object, default: null },
  isGuest: Boolean
})
const emit = defineEmits(['update:modelValue', 'closed'])
const { isMobile } = useViewport()
const readerRoot = ref(null)
useModalFocus(readerRoot, () => props.modelValue)
let releaseScrollLock = null
let navigationSequence = 0
let renderSequence = 0
let resizeObserver = null
let resizeTimer = null
const navigating = ref(false)

const DEVICE_PREF_KEY = 'pr-manager:ebook-reader-preferences:v1'
const fontOptions = [
  { value: 'serif', label: '衬线' },
  { value: 'sans', label: '无衬线' },
  { value: 'kai', label: '楷体' }
]
const themeOptions = [
  { value: 'paper', label: '纸张' },
  { value: 'warm', label: '暖色' },
  { value: 'dark', label: '深色' }
]

const readingSurface = ref(null)
const flowArticle = ref(null)
const tocList = ref(null)
const pdfStage = ref(null)
const pdfCanvas = ref(null)
const loading = ref(false)
const loadingMessage = ref('正在载入书籍信息…')
const loadError = ref('')
const chapters = ref([])
const toc = ref([])
const chapterIndex = ref(0)
const currentChapter = ref(null)
const totalPdfPages = ref(0)
const pdfPageIndex = ref(0)
const pdfScale = ref(1)
const fontSize = ref(18)
const fontFamily = ref('serif')
const readerTheme = ref('paper')
const tocOpen = ref(false)
const settingsOpen = ref(false)
const readingPercent = ref(0)
const syncStatus = ref('synced')
const progressConflict = ref(null)
let progressSync = null
let pdfDocument = null
let pdfRenderTask = null
let saveTimer = null
let openSequence = 0
let pendingRestoreCFI = null
let pendingRestoreFraction = 0
let restoringPosition = false
let progressDirty = false

const fileType = computed(() => String(props.book?.fileType || props.book?.file_type || '').toLowerCase())
const isPdf = computed(() => fileType.value === 'pdf')
const isFlowDocument = computed(() => fileType.value === 'epub' || fileType.value === 'txt' || fileType.value === 'html' || fileType.value === 'htm')
const currentPageIndex = computed(() => isPdf.value ? pdfPageIndex.value : chapterIndex.value)
const effectiveToc = computed(() => {
  if (isPdf.value) {
    return Array.from({ length: totalPdfPages.value }, (_, index) => ({ title: `第 ${index + 1} 页`, chapterIndex: index, id: `page-${index}` }))
  }
  if (toc.value.length > 0) return toc.value.map((entry, index) => ({ ...entry, chapterIndex: Number.isSafeInteger(entry.chapterIndex) ? entry.chapterIndex : index }))
  return chapters.value.map((chapter, index) => ({ ...chapter, title: chapter.title || `章节 ${index + 1}`, chapterIndex: index }))
})
const safeChapterContent = computed(() => {
  const template = document.createElement('template')
  template.innerHTML = sanitizeRichHtml(currentChapter.value?.content || '')
  // Mark references without wrapping/reordering nodes: existing CFI paths remain stable.
  for (const link of template.content.querySelectorAll('a[href]')) {
    const label = link.textContent.trim()
    const superscript = link.closest('sup') || link.querySelector('sup')
    if (link.getAttribute('role') === 'doc-noteref' || (link.getAttribute('href').includes('#') && (superscript || /^[\[(（【]?\d{1,4}[\])）】]?$/.test(label)))) {
      link.dataset.readerNote = superscript ? 'sup' : 'inline'
    }
  }
  return template.innerHTML
})
const flowStyle = computed(() => ({
  fontSize: `${fontSize.value}px`,
  fontFamily: fontFamily.value === 'sans'
    ? '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    : fontFamily.value === 'kai'
      ? 'KaiTi, "STKaiti", serif'
      : '"Source Han Serif SC", "Noto Serif SC", SimSun, serif'
}))
const chapterCountLabel = computed(() => isPdf.value ? `${totalPdfPages.value} 页` : `${chapters.value.length} 章`)
const positionLabel = computed(() => loading.value ? loadingMessage.value : footerPositionLabel.value)
const footerPositionLabel = computed(() => isPdf.value
  ? `第 ${pdfPageIndex.value + 1} / ${totalPdfPages.value || 1} 页`
  : `第 ${chapterIndex.value + 1} / ${chapters.value.length || 1} 章`)
const canGoPrevious = computed(() => currentPageIndex.value > 0)
const canGoNext = computed(() => currentPageIndex.value < (isPdf.value ? totalPdfPages.value : chapters.value.length) - 1)
const canMarkFinished = computed(() => isFlowDocument.value && !canGoNext.value && readingPercent.value < 99.5)

function readDevicePreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(DEVICE_PREF_KEY) || '{}')
    if (Number.isFinite(value.fontSize)) fontSize.value = Math.min(28, Math.max(14, value.fontSize))
    if (fontOptions.some(option => option.value === value.fontFamily)) fontFamily.value = value.fontFamily
    if (themeOptions.some(option => option.value === value.readerTheme)) readerTheme.value = value.readerTheme
    if (Number.isFinite(value.pdfScale)) pdfScale.value = Math.min(2, Math.max(0.7, value.pdfScale))
  } catch { /* Invalid local preferences fall back to safe defaults. */ }
}

function persistDevicePreferences() {
  try {
  localStorage.setItem(DEVICE_PREF_KEY, JSON.stringify({
    fontSize: fontSize.value,
    fontFamily: fontFamily.value,
    readerTheme: readerTheme.value,
    pdfScale: pdfScale.value
  }))
  } catch { /* Reading remains available when device storage is unavailable. */ }
}

function createProgressSync() {
  if (props.isGuest) return null
  progressSync?.dispose()
  const sync = createEbookReadingProgressSync({
    bookId: props.book.id,
    api: api.books,
    onStatus(status) {
      if (progressSync !== sync) return
      syncStatus.value = status.name
      progressConflict.value = status.name === 'conflict' ? { local: status.local, remote: status.remote } : null
    }
  })
  progressSync = sync
  return progressSync
}

async function openBook() {
  const sequence = ++openSequence
  navigationSequence += 1
  clearTimeout(saveTimer)
  navigating.value = false
  restoringPosition = false
  progressDirty = false
  loading.value = true
  loadError.value = ''
  chapters.value = []
  toc.value = []
  currentChapter.value = null
  totalPdfPages.value = 0
  readingPercent.value = 0
  pendingRestoreCFI = null
  pendingRestoreFraction = 0
  readDevicePreferences()
  await disposePdf()
  if (sequence !== openSequence || !props.modelValue) return
  if (sequence !== openSequence || !props.modelValue) return

  try {
    const sync = createProgressSync()
    const progressPromise = sync ? sync.load() : Promise.resolve({ currentPage: 0, progress: 0, cfi: null })
    if (isPdf.value) {
      loadingMessage.value = '正在建立 PDF 流式阅读会话…'
      const [progress, document] = await Promise.all([
        progressPromise,
        (isMobile.value ? openMobilePdfDocument : openAuthenticatedPdfDocument)(authenticatedAssetUrl(`/api/ebooks/${props.book.id}/preview`))
      ])
      if (sequence !== openSequence) { await disposePdfDocument(document); return }
      pdfDocument = document
      totalPdfPages.value = document.numPages
      const requestedPage = Number.isSafeInteger(props.book?.searchChapterIndex) ? props.book.searchChapterIndex : progress.currentPage
      pdfPageIndex.value = Math.min(Math.max(0, requestedPage || 0), Math.max(0, document.numPages - 1))
      loading.value = false
      await nextTick()
      await renderPdfPage()
      readingPercent.value = document.numPages > 0 ? ((pdfPageIndex.value + 1) / document.numPages) * 100 : 0
    } else if (fileType.value === 'epub') {
      loadingMessage.value = '正在读取目录并恢复阅读位置…'
      const [progress, response] = await Promise.all([progressPromise, api.books.getManifest(props.book.id)])
      if (sequence !== openSequence) return
      chapters.value = response.data?.chapters || []
      toc.value = response.data?.toc || []
      if (chapters.value.length === 0) throw new Error('这本 EPUB 没有可阅读章节')
      const requestedChapter = Number.isSafeInteger(props.book?.searchChapterIndex) ? props.book.searchChapterIndex : progress.currentPage
      chapterIndex.value = Math.min(Math.max(0, requestedChapter || 0), chapters.value.length - 1)
      const explicitSearchPosition = Number.isSafeInteger(props.book?.searchChapterIndex)
      readingPercent.value = explicitSearchPosition ? (chapterIndex.value / chapters.value.length) * 100 : Number(progress.progress || 0)
      pendingRestoreCFI = explicitSearchPosition ? null : (progress.cfi || null)
      pendingRestoreFraction = explicitSearchPosition ? 0 : (progress.chapterFraction ?? deriveEbookChapterFraction(progress.progress, chapterIndex.value, chapters.value.length))
      loading.value = false
      await loadEpubChapter(chapterIndex.value)
    } else if (fileType.value === 'txt' || fileType.value === 'html' || fileType.value === 'htm') {
      loadingMessage.value = '正在载入正文并恢复阅读位置…'
      const [progress, response] = await Promise.all([progressPromise, api.books.getContent(props.book.id)])
      if (sequence !== openSequence) return
      chapters.value = [{ id: 'content', title: '正文', href: '', content: plainTextHtml(response.data?.content || '') }]
      currentChapter.value = chapters.value[0]
      chapterIndex.value = 0
      pendingRestoreCFI = progress.cfi || null
      readingPercent.value = Number(progress.progress || 0)
      pendingRestoreFraction = progress.chapterFraction ?? deriveEbookChapterFraction(progress.progress, 0, 1)
      loading.value = false
      await restoreFlowPosition()
    } else {
      throw new Error('当前格式暂不支持在线阅读，请下载原件后查看')
    }
    if (sequence === openSequence) loading.value = false
  } catch (error) {
    if (sequence !== openSequence) return
    console.error('打开电子书失败:', error)
    loadError.value = error?.response?.data?.message || error?.message || '内容加载失败，请稍后重试'
    loading.value = false
  }
}

async function loadEpubChapter(index) {
  const sequence = ++navigationSequence
  const session = openSequence
  navigating.value = true
  loadingMessage.value = `正在载入第 ${index + 1} 章…`
  try {
  const response = await api.books.getChapters(props.book.id, index, 1)
  if (sequence !== navigationSequence || session !== openSequence) return false
  const loaded = response.data?.chapters?.[0]
  if (typeof loaded?.content !== 'string') throw new Error('章节内容加载失败')
  currentChapter.value = { ...chapters.value[index], ...loaded }
  chapterIndex.value = index
  await restoreFlowPosition(sequence)
  return sequence === navigationSequence && session === openSequence
  } finally { if (sequence === navigationSequence) navigating.value = false }
}

async function restoreFlowPosition(sequence = navigationSequence) {
  restoringPosition = true
  await waitForFlowLayout()
  if (sequence !== navigationSequence || !props.modelValue) return
  const surface = readingSurface.value
  if (!surface) {
    restoringPosition = false
    return
  }
  surface.scrollTop = 0
  let restored = false
  if (isEbookCfiForChapter(pendingRestoreCFI, currentChapter.value?.id)) {
    restored = scrollToCFI(surface, pendingRestoreCFI, null, false, { strict: true })
  }
  if (!restored && pendingRestoreFraction > 0) {
    const scrollable = Math.max(0, surface.scrollHeight - surface.clientHeight)
    surface.scrollTop = Math.round(scrollable * Math.min(1, Math.max(0, pendingRestoreFraction)))
  }
  pendingRestoreCFI = null
  pendingRestoreFraction = 0
  updateFlowProgress()
  await nextAnimationFrame()
  if (sequence === navigationSequence) restoringPosition = false
}

async function waitForFlowLayout() {
  await nextTick()
  await nextAnimationFrame()
  if (document.fonts?.ready) {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 250))])
  }
  await nextAnimationFrame()
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

async function renderPdfPage() {
  if (!pdfDocument || !pdfCanvas.value) return
  const sequence = ++renderSequence
  const activeDocument = pdfDocument
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel() } catch { /* A superseded render can be cancelled safely. */ }
    try { await pdfRenderTask.promise } catch { /* Wait before reusing the canvas. */ }
  }
  const page = await activeDocument.getPage(pdfPageIndex.value + 1)
  if (sequence !== renderSequence || activeDocument !== pdfDocument || !pdfCanvas.value) return
  const stage = pdfStage.value
  const stageStyle = stage ? getComputedStyle(stage) : null
  const horizontalPadding = stageStyle ? parseFloat(stageStyle.paddingLeft) + parseFloat(stageStyle.paddingRight) : 0
  const stageWidth = Math.max(160, (stage?.clientWidth || 900) - horizontalPadding - 2)
  const natural = page.getViewport({ scale: 1 })
  const fitScale = Math.min(1.7, stageWidth / natural.width)
  const viewport = page.getViewport({ scale: fitScale * pdfScale.value })
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2)
  const canvas = pdfCanvas.value
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  const context = canvas.getContext('2d', { alpha: false })
  const task = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] })
  pdfRenderTask = task
  try { await task.promise } catch (error) {
    if (error?.name !== 'RenderingCancelledException') throw error
  } finally { if (pdfRenderTask === task) pdfRenderTask = null }
}

function updateFlowProgress() {
  const surface = readingSurface.value
  if (!surface) return
  const scrollable = Math.max(0, surface.scrollHeight - surface.clientHeight)
  const total = Math.max(1, chapters.value.length)
  const alreadyFinished = readingPercent.value >= 99.5 && chapterIndex.value === total - 1
  const chapterFraction = scrollable > 0
    ? Math.min(1, Math.max(0, surface.scrollTop / scrollable))
    : alreadyFinished ? 1 : 0
  readingPercent.value = ((chapterIndex.value + chapterFraction) / total) * 100
}

function handleScroll() {
  if (!isFlowDocument.value || loading.value || restoringPosition || navigating.value) return
  updateFlowProgress()
  progressDirty = true
  scheduleProgressSave()
}

function scheduleProgressSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void saveProgress() }, 700)
}

async function saveProgress() {
  if (!progressSync || !progressDirty || loading.value || loadError.value || navigating.value || restoringPosition) return
  let cfi = null
  if (isFlowDocument.value && readingSurface.value) {
    const candidate = getCurrentCFI(readingSurface.value)
    cfi = isEbookCfiForChapter(candidate, currentChapter.value?.id) ? candidate : null
  }
  try {
    progressDirty = false
    await progressSync.queue({
      currentPage: currentPageIndex.value,
      progress: Math.min(100, Math.max(0, readingPercent.value)),
      chapterFraction: currentChapterFraction(),
      cfi
    })
  } catch (error) {
    if (!(error instanceof EbookProgressConflictError)) console.error('同步阅读位置失败:', error)
  }
}

function plainTextHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r?\n/gu, '<br>')
}

async function resolveConflict(choice) {
  if (!progressSync) return
  try {
    const progress = await progressSync.resolveConflict(choice)
    progressConflict.value = null
    if (choice === 'remote') await moveToProgress(progress)
  } catch (error) {
    console.error('处理阅读进度冲突失败:', error)
  }
}

async function moveToProgress(progress) {
  if (isPdf.value) {
    pdfPageIndex.value = Math.min(Math.max(0, progress.currentPage || 0), Math.max(0, totalPdfPages.value - 1))
    await renderPdfPage()
    readingPercent.value = totalPdfPages.value > 0 ? ((pdfPageIndex.value + 1) / totalPdfPages.value) * 100 : 0
  } else {
    pendingRestoreCFI = progress.cfi || null
    const target = Math.min(Math.max(0, progress.currentPage || 0), Math.max(0, chapters.value.length - 1))
    readingPercent.value = Number(progress.progress || 0)
    pendingRestoreFraction = progress.chapterFraction ?? deriveEbookChapterFraction(progress.progress, target, chapters.value.length)
    if (fileType.value === 'epub') await loadEpubChapter(target)
    else await restoreFlowPosition()
  }
}

async function goToChapter(index, fragment = '') {
  const total = isPdf.value ? totalPdfPages.value : chapters.value.length
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) return
  clearTimeout(saveTimer)
  tocOpen.value = false
  try {
  if (isPdf.value) {
    const sequence = ++navigationSequence
    pdfPageIndex.value = index
    await renderPdfPage()
    if (sequence !== navigationSequence || !props.modelValue) return
    readingPercent.value = ((index + 1) / totalPdfPages.value) * 100
  } else if (fileType.value === 'epub') {
    pendingRestoreCFI = null
    pendingRestoreFraction = 0
    if (!await loadEpubChapter(index)) return
    if (fragment) scrollToFlowFragment(decodeURIComponent(fragment))
    updateFlowProgress()
  }
  progressDirty = true
  await saveProgress()
  } catch (error) {
    loadError.value = error?.response?.data?.message || error?.message || '章节加载失败，请重试'
  }
}

function goPrevious() { if (canGoPrevious.value) void goToChapter(currentPageIndex.value - 1) }

function currentChapterFraction() {
  if (isPdf.value) return null
  const surface = readingSurface.value
  if (!surface) return 0
  const scrollable = Math.max(0, surface.scrollHeight - surface.clientHeight)
  if (scrollable <= 0) return readingPercent.value >= 99.5 && !canGoNext.value ? 1 : 0
  return Math.min(1, Math.max(0, surface.scrollTop / scrollable))
}

async function handleContentClick(event) {
  if (!isFlowDocument.value) return
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!anchor || !flowArticle.value?.contains(anchor)) return
  const target = resolveEbookLink(anchor.getAttribute('href'), currentChapter.value?.href)
  if (!target) return
  event.preventDefault()

  if (target.external) {
    window.open(target.url, '_blank', 'noopener,noreferrer')
    return
  }

  const targetChapterIndex = findEbookChapterIndex(chapters.value, target.path)
  if (targetChapterIndex >= 0 && targetChapterIndex !== chapterIndex.value) {
    await goToChapter(targetChapterIndex, target.fragment)
    return
  }
  if (targetChapterIndex < 0 && target.path !== String(currentChapter.value?.href || '').replace(/^\/+/, '')) return
  await nextTick()
  if (target.fragment) scrollToFlowFragment(target.fragment)
  else readingSurface.value?.scrollTo({ top: 0, behavior: 'auto' })
  updateFlowProgress()
  progressDirty = true
  await saveProgress()
}

function scrollToFlowFragment(fragment) {
  const article = flowArticle.value
  const surface = readingSurface.value
  if (!article || !surface) return false
  const decoded = String(fragment || '')
  const target = [...article.querySelectorAll('[id], a[name]')]
    .find(element => element.id === decoded || element.getAttribute('name') === decoded)
  if (!target) return false
  const surfaceRect = surface.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  surface.scrollTo({ top: Math.max(0, surface.scrollTop + targetRect.top - surfaceRect.top - 24), behavior: 'auto' })
  return true
}
async function goNextOrFinish() {
  if (canGoNext.value) {
    await goToChapter(currentPageIndex.value + 1)
    return
  }
  if (!canMarkFinished.value) return
  if (readingSurface.value) readingSurface.value.scrollTop = readingSurface.value.scrollHeight
  readingPercent.value = 100
  progressDirty = true
  await saveProgress()
}
function downloadOriginal() { window.open(authenticatedAssetUrl(`/api/ebooks/download/${props.book.id}`), '_blank') }

async function disposePdf() {
  renderSequence += 1
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel() } catch {}
    pdfRenderTask = null
  }
  const previousDocument = pdfDocument
  pdfDocument = null
  if (previousDocument) {
    try { await disposePdfDocument(previousDocument) } catch {}
  }
}

async function closeReader() {
  clearTimeout(saveTimer)
  persistDevicePreferences()
  const closingSync = progressSync
  const saveRequest = saveProgress()
  progressSync = null
  emit('update:modelValue', false)
  void Promise.resolve(saveRequest)
    .then(() => closingSync?.flush())
    .catch(() => {})
    .finally(() => { closingSync?.dispose(); emit('closed') })
  await disposePdf()
}

function handleEscape() {
  if (tocOpen.value || settingsOpen.value) { tocOpen.value = false; settingsOpen.value = false }
  else void closeReader()
}

watch(() => [props.modelValue, props.book?.id], ([visible]) => {
  if (visible && props.book?.id) void openBook()
  if (visible && !releaseScrollLock) releaseScrollLock = acquireBodyScrollLock()
  if (!visible) {
    openSequence += 1
    navigationSequence += 1
    tocOpen.value = false
    settingsOpen.value = false
    releaseScrollLock?.()
    releaseScrollLock = null
    void disposePdf()
  }
}, { immediate: true })
watch([fontSize, fontFamily, readerTheme], async () => {
  persistDevicePreferences()
  if (props.modelValue && isFlowDocument.value && !loading.value && !navigating.value) {
    const surface = readingSurface.value
    const scrollable = surface ? Math.max(0, surface.scrollHeight - surface.clientHeight) : 0
    const candidate = surface ? getCurrentCFI(surface) : null
    pendingRestoreCFI = isEbookCfiForChapter(candidate, currentChapter.value?.id) ? candidate : null
    pendingRestoreFraction = scrollable > 0 ? surface.scrollTop / scrollable : 0
    await restoreFlowPosition()
  }
})
watch(tocOpen, async (open) => {
  if (open) await scrollCurrentTocItemIntoView()
})
watch(currentPageIndex, async () => {
  if (tocOpen.value) await scrollCurrentTocItemIntoView()
})
watch(pdfScale, async () => {
  persistDevicePreferences()
  requestPdfResize()
})

function requestPdfResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (props.modelValue && isPdf.value && !loading.value) {
      void renderPdfPage().catch(error => { loadError.value = error?.message || '页面绘制失败' })
    }
  }, 120)
}
watch(readingSurface, (surface) => {
  resizeObserver?.disconnect()
  if (surface && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(requestPdfResize)
    resizeObserver.observe(surface)
  }
})
function persistOnHide() { if (document.visibilityState === 'hidden') void saveProgress() }
function resumeSync() { void progressSync?.flush().catch(() => {}) }
onMounted(() => {
  document.addEventListener('visibilitychange', persistOnHide)
  window.addEventListener('pagehide', saveProgress)
  window.addEventListener('online', resumeSync)
})

async function scrollCurrentTocItemIntoView() {
  await nextTick()
  tocList.value?.querySelector('button.active')?.scrollIntoView({ block: 'center', behavior: 'auto' })
}

onBeforeUnmount(() => {
  clearTimeout(saveTimer)
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  document.removeEventListener('visibilitychange', persistOnHide)
  window.removeEventListener('pagehide', saveProgress)
  window.removeEventListener('online', resumeSync)
  releaseScrollLock?.()
  const closingSync = progressSync
  void saveProgress().finally(() => closingSync?.dispose())
  openSequence += 1
  navigationSequence += 1
  void disposePdf()
})
</script>

<style scoped>
.ebook-reader{position:fixed;inset:0;z-index:12000;display:grid;grid-template-rows:64px auto minmax(0,1fr) 72px;background:#edf0f4;color:#1f2937}.ebook-reader__header{display:flex;align-items:center;gap:14px;padding:0 22px;border-bottom:1px solid #dce2ea;background:#fffdfb}.ebook-reader__identity{min-width:0;display:flex;flex:1;flex-direction:column}.ebook-reader__identity strong{overflow:hidden;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.ebook-reader__identity span,.ebook-reader__panel-heading span{font-size:12px;color:#8390a3}.ebook-reader__header-actions{display:flex;gap:4px}.ebook-reader__icon-button{width:40px;height:40px;padding:0}.ebook-reader__notice{display:flex;align-items:center;justify-content:center;gap:10px;min-height:44px;padding:6px 20px;background:#eef2ff;color:#4655a6}.ebook-reader__notice--warning{background:#fff7e8;color:#8a5b19}.ebook-reader__surface{min-height:0;overflow:auto;padding:36px 56px;scrollbar-gutter:stable}.ebook-reader__surface--paper{background:#edf0f4}.ebook-reader__surface--warm{background:#e8dfd0}.ebook-reader__surface--dark{background:#171a21}.ebook-reader__paper{width:min(780px,100%);min-height:calc(100vh - 250px);box-sizing:border-box;margin:0 auto;padding:68px 78px;border:1px solid rgba(76,90,116,.12);border-radius:8px;background:#fffdf9;box-shadow:0 12px 36px rgba(40,48,65,.08);line-height:1.85;color:#273244}.ebook-reader__surface--warm .ebook-reader__paper{background:#fbf3e4;color:#3c3328}.ebook-reader__surface--dark .ebook-reader__paper{border-color:#333a47;background:#232832;color:#e4e8ef}.ebook-reader__pdf-stage{display:flex;justify-content:center;min-height:100%;padding:0 0 40px}.ebook-reader__pdf-canvas{align-self:flex-start;max-width:none;border:1px solid #d6dce5;background:#fff;box-shadow:0 12px 38px rgba(32,42,60,.16)}.ebook-reader__state{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#68758a}.ebook-reader__state strong{font-size:16px;color:#2b3445}.ebook-reader__state--error>div{display:flex;gap:10px;margin-top:8px}.ebook-reader__toc,.ebook-reader__settings{position:fixed;top:64px;bottom:0;z-index:12002;width:min(360px,90vw);display:flex;flex-direction:column;background:#fffdfb;box-shadow:0 16px 48px rgba(30,37,50,.18);transition:transform .22s ease}.ebook-reader__toc{left:0;transform:translateX(-105%)}.ebook-reader__settings{right:0;transform:translateX(105%)}.ebook-reader__toc--open,.ebook-reader__settings--open{transform:translateX(0)}.ebook-reader__panel-heading{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e5e9ef}.ebook-reader__panel-heading>div{display:flex;flex-direction:column;gap:2px}.ebook-reader__toc-list{overflow:auto;padding:10px}.ebook-reader__toc-list button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:0;border-radius:8px;background:transparent;color:#445066;text-align:left;cursor:pointer}.ebook-reader__toc-list button:hover{background:#f2f4f8}.ebook-reader__toc-list button.active{background:#eef0ff;color:#4f5ed6}.ebook-reader__toc-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ebook-reader__toc-list small{color:#98a3b5}.ebook-reader__setting-group{display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-bottom:1px solid #edf0f4}.ebook-reader__setting-group label{font-size:13px;color:#6b778a}.ebook-reader__stepper{display:grid;grid-template-columns:1fr 80px 1fr;align-items:center;gap:8px;text-align:center}.ebook-reader__segmented{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.ebook-reader__segmented button{min-height:38px;border:1px solid #dce2ea;border-radius:8px;background:#fff;color:#526076;cursor:pointer}.ebook-reader__segmented button.active{border-color:#6674e8;background:#eef0ff;color:#4c5bd1}.ebook-reader__footer{position:relative;z-index:12001;display:grid;grid-template-columns:132px minmax(220px,460px) 132px;align-items:center;justify-content:center;gap:22px;padding:12px 24px;border-top:1px solid #dce2ea;background:#fffdfb;box-shadow:0 -8px 24px rgba(40,48,65,.05)}.ebook-reader__nav-button{height:44px}.ebook-reader__progress{display:grid;grid-template-columns:minmax(120px,1fr) auto auto;align-items:center;gap:12px;padding:8px 12px;border:0;background:transparent;color:#526076;cursor:pointer}.ebook-reader__progress>span{height:4px;overflow:hidden;border-radius:99px;background:#dfe4ec}.ebook-reader__progress i{display:block;height:100%;border-radius:inherit;background:#5967dd}.ebook-reader__progress strong{font-size:13px}.ebook-reader__progress small{font-size:12px;color:#8995a8}.ebook-reader-fade-enter-active,.ebook-reader-fade-leave-active{transition:opacity .18s ease}.ebook-reader-fade-enter-from,.ebook-reader-fade-leave-to{opacity:0}@media(max-width:900px){.ebook-reader__surface{padding:24px 20px}.ebook-reader__paper{padding:44px 38px}.ebook-reader__footer{grid-template-columns:48px minmax(160px,1fr) 48px;gap:10px}.ebook-reader__nav-button{font-size:0}.ebook-reader__nav-button :deep(svg){font-size:16px}.ebook-reader__progress{grid-template-columns:1fr auto}.ebook-reader__progress small{display:none}}
/* Optional sync notices must not change the reading viewport's grid placement. */
.ebook-reader{display:flex;flex-direction:column;height:100dvh;outline:none}
.ebook-reader__header{min-height:64px;flex-shrink:0}
.ebook-reader__notice{flex-shrink:0;flex-wrap:wrap;font-size:13px}
.ebook-reader__surface{flex:1;overscroll-behavior:contain}
.ebook-reader__footer{flex-shrink:0;min-height:64px;box-sizing:border-box;box-shadow:none}
.ebook-reader__paper{border-radius:3px;box-shadow:0 3px 18px #28304108}
.ebook-reader__flow :deep(img){max-width:100%;height:auto}
.ebook-reader__flow :deep(table){max-width:100%;overflow-wrap:anywhere}
.ebook-reader__flow :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere}
.ebook-reader__flow :deep(a){color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px}
.ebook-reader__flow :deep(a[data-reader-note]),.ebook-reader__flow :deep(a[data-reader-note] *){text-decoration:none;border-bottom:0;box-shadow:none}
.ebook-reader__flow :deep(a[data-reader-note]){color:#626fa5;cursor:pointer}
.ebook-reader__flow :deep(a[data-reader-note="inline"]){font-size:.75em;vertical-align:super;line-height:0}
.ebook-reader__flow :deep(a[data-reader-note]:hover){color:#4356a3;background:#6371ac14;border-radius:2px}
.ebook-reader__flow :deep(a:focus-visible){outline:1px solid currentColor;outline-offset:3px}
.ebook-reader--dark .ebook-reader__flow :deep(a[data-reader-note]){color:#a9b7ec}
.ebook-reader__topbar{display:flex;align-items:center;gap:14px;width:100%;max-width:980px;margin-inline:auto}
.ebook-reader__tool{height:40px;padding:0 10px;gap:7px;flex-shrink:0;font-size:13px}
.ebook-reader__toc-trigger{margin-right:8px;border-right:1px solid var(--color-border-subtle);border-radius:0;padding-right:18px}
.ebook-reader__scrim{position:absolute;inset:64px 0 0;z-index:12001;border:0;background:#18202d30;cursor:default}
.ebook-reader__toc,.ebook-reader__settings{overscroll-behavior:contain}
.ebook-reader__settings{overflow:auto}
.ebook-reader__toc-list button{min-height:44px}
.ebook-reader__toc-list button.active{box-shadow:inset 2px 0 #5967dd;border-radius:0 6px 6px 0}
.ebook-reader--dark .ebook-reader__header,.ebook-reader--dark .ebook-reader__footer,.ebook-reader--dark .ebook-reader__toc,.ebook-reader--dark .ebook-reader__settings{background:#232832;color:#e4e8ef;border-color:#39414e}
.ebook-reader--dark .ebook-reader__progress,.ebook-reader--dark .ebook-reader__toc-list button{color:#c5cddb}
.ebook-reader--dark .ebook-reader__toc-list button.active{background:#343b52}
.ebook-reader--dark .ebook-reader__panel-heading,.ebook-reader--dark .ebook-reader__setting-group{border-color:#39414e}
.reader-panel-left-enter-active,.reader-panel-left-leave-active,.reader-panel-right-enter-active,.reader-panel-right-leave-active{transition:transform 200ms cubic-bezier(.2,.7,.2,1)}
.reader-panel-left-enter-from,.reader-panel-left-leave-to{transform:translateX(-100%)}
.reader-panel-right-enter-from,.reader-panel-right-leave-to{transform:translateX(100%)}
@media(max-width:768px){
  .ebook-reader{-webkit-tap-highlight-color:transparent}
  .ebook-reader__header{min-height:56px;padding:env(safe-area-inset-top) 8px 0;gap:4px}
  .ebook-reader__identity strong{font-size:14px;font-weight:600}
  .ebook-reader__identity span{font-size:11px;margin-top:2px}
  .ebook-reader__icon-button{width:44px;height:44px;flex-shrink:0}
  .ebook-reader__header-actions{gap:0}
  .ebook-reader__topbar{gap:4px}
  .ebook-reader__tool{width:44px;height:44px;padding:0}
  .ebook-reader__tool>span{display:none}
  .ebook-reader__toc-trigger{margin:0;border:0;order:2}
  .ebook-reader__header-actions{order:3}
  .ebook-reader__header-actions .ebook-reader__icon-button:last-child{display:none}
  .ebook-reader__surface{padding:0;scrollbar-gutter:auto}
  .ebook-reader__paper{width:100%;min-height:100%;padding:28px 22px 48px;border:0;border-radius:0;box-shadow:none;line-height:1.85;overflow-wrap:anywhere}
  .ebook-reader__pdf-stage{padding:12px 8px 24px;box-sizing:border-box;justify-content:flex-start;width:100%}
  .ebook-reader__pdf-canvas{margin:0 auto;box-shadow:0 2px 12px #202a3c0d}
  .ebook-reader__footer{grid-template-columns:44px minmax(0,1fr) 44px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));gap:8px;min-height:60px}
  .ebook-reader__nav-button{width:44px;height:44px;padding:0;font-size:0;border:0}
  .ebook-reader__nav-button :deep(.native-icon){width:20px;height:20px;font-size:20px}
  .ebook-reader__progress{grid-template-columns:1fr auto;gap:8px;padding:10px 8px}
  .ebook-reader__progress strong{font-size:12px;font-weight:500;white-space:nowrap}
  .ebook-reader__progress>span{min-width:24px;height:3px}
  .ebook-reader__toc,.ebook-reader__settings{top:calc(56px + env(safe-area-inset-top));width:min(340px,90vw);padding-bottom:env(safe-area-inset-bottom)}
  .ebook-reader__scrim{top:calc(56px + env(safe-area-inset-top))}
  .ebook-reader__notice{padding:8px 12px;gap:8px;font-size:12px}
  .ebook-reader__state{padding:24px;text-align:center;box-sizing:border-box;font-size:13px}
  .ebook-reader :deep(button:focus:not(:focus-visible)){outline:none;box-shadow:none}
}
@media(prefers-reduced-motion:reduce){.ebook-reader-fade-enter-active,.ebook-reader-fade-leave-active,.reader-panel-left-enter-active,.reader-panel-left-leave-active,.reader-panel-right-enter-active,.reader-panel-right-leave-active,.ebook-reader__toc,.ebook-reader__settings{transition:none}}
</style>
