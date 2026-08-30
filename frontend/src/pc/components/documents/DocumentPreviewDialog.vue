<template>
  <NativeDialog
    v-model="visible"
    :title="dialogTitle"
    width="min(1560px, calc(100vw - 48px))"
    min-width="min(720px, calc(100vw - 40px))"
    min-height="min(380px, calc(100vh - 40px))"
    max-height="92vh"
    class="document-preview-dialog"
    :style="{ height: dialogHeight }"
    :show-footer="false"
    resizable
    @close="savePreviewPosition"
    @closed="handleClosed"
  >
    <div v-if="loading" class="loading-container"><NativeLoading text="加载中..." /></div>
    <div v-else class="preview-container">
      <div class="preview-toolbar">
        <div class="preview-file-meta">
          <span class="document-type-icon" :class="`document-type-icon--${documentFileTone(fileName)}`">
            <NativeIcon :name="documentFileIcon(fileName)" size="18" />
          </span>
          <div><strong>{{ fileName }}</strong><span>{{ formatFileSize(fileSize) }}</span></div>
        </div>
        <NativeButton variant="outline" @click="emit('download', currentDocument)">
          <template #icon><NativeIcon name="download" /></template>
          下载原件
        </NativeButton>
      </div>

      <div v-if="previewError" class="preview-error-state">
        <span><NativeIcon name="warning-circle" size="30" /></span>
        <strong>暂时无法显示预览</strong>
        <p>{{ previewError }}</p>
        <NativeButton theme="primary" @click="retry">重新加载</NativeButton>
      </div>

      <div v-else-if="previewType === 'pdf'" class="pdf-preview">
        <div ref="pdfCanvasStage" class="pdf-canvas-stage"><canvas ref="pdfCanvas"></canvas></div>
        <div class="pdf-controls" aria-label="PDF 页面导航">
          <NativeButton class="pdf-page-button" size="small" variant="outline" @click="previousPage" :disabled="currentPage <= 1">
            <NativeIcon name="chevron-left" size="15" />
            上一页
          </NativeButton>
          <div class="pdf-page-status">
            <span>第</span>
            <NativeInput v-model="jumpPage" :min="1" :max="totalPages" size="small" class="pdf-page-input" type="number" />
            <span>/ {{ totalPages }} 页</span>
            <NativeButton class="pdf-page-jump" size="small" theme="primary" @click="jumpToPage">跳转</NativeButton>
          </div>
          <NativeButton class="pdf-page-button" size="small" variant="outline" @click="nextPage" :disabled="currentPage >= totalPages">
            下一页
            <NativeIcon name="chevron-right" size="15" />
          </NativeButton>
        </div>
      </div>

      <MdPreview
        v-else-if="previewType === 'markdown'"
        ref="previewScrollSurface"
        :model-value="previewContent"
        :sanitize="sanitizeRichHtml"
        theme="light"
        preview-theme="default"
        code-theme="atom"
        class="markdown-preview"
      />
      <div v-else-if="previewType === 'code'" ref="previewScrollSurface" class="code-preview">
        <pre><code v-html="highlightedCode" :class="`language-${previewLanguage}`"></code></pre>
      </div>
      <div v-else-if="previewType === 'text'" ref="previewScrollSurface" class="text-preview"><pre>{{ previewContent }}</pre></div>
      <div v-else-if="previewType === 'image'" ref="previewScrollSurface" class="image-preview">
        <img :src="`data:image/${imageMimeType};base64,${previewContent}`" :alt="fileName" />
      </div>
      <div v-else-if="previewType === 'word-html'" ref="previewScrollSurface" class="word-html-preview">
        <div class="word-content" v-html="sanitizedPreviewContent"></div>
      </div>
      <div v-else-if="previewType === 'office'" ref="previewScrollSurface" class="office-preview">
        <NativeIcon :name="officeIconName" size="64" />
        <h3>{{ officeTypeLabel }}文档</h3>
        <p>此文件格式暂不支持在线预览，可使用右上角“下载原件”后通过 Microsoft Office 或 WPS 打开。</p>
      </div>
      <div v-else ref="previewScrollSurface" class="unsupported-preview">
        <NativeIcon name="info" size="48" />
        <p>此文件格式暂不支持在线预览，可使用右上角“下载原件”查看。</p>
      </div>
    </div>
  </NativeDialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import hljs from 'highlight.js'
import 'highlight.js/styles/atom-one-dark.css'
import mammoth from 'mammoth'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

import api from '@/api'
import { NativeButton, NativeDialog, NativeIcon, NativeInput, NativeLoading } from '@/components/native'
import { authenticatedAssetUrl } from '@/utils/authentication'
import {
  documentDisplayFileName,
  documentFileIcon,
  documentFileTone,
  pruneDocumentPreviewPositions,
  updateDocumentPreviewPosition
} from '@/utils/documentWorkbench'
import { openPdfDocument } from '@/utils/pdfPreview'
import { sanitizeHighlightHtml, sanitizeRichHtml } from '@/utils/sanitizeHtml'

const emit = defineEmits(['download'])
const visible = ref(false)
const loading = ref(false)
const previewContent = ref('')
const previewType = ref('text')
const previewLanguage = ref('plaintext')
const fileName = ref('')
const fileSize = ref(0)
const currentDocument = ref(null)
const previewError = ref('')
const dialogHeight = ref('min(76vh, 820px)')
const previewScrollSurface = ref(null)
const pdfCanvas = ref(null)
const pdfCanvasStage = ref(null)
const currentPage = ref(1)
const totalPages = ref(0)
const jumpPage = ref(1)
const pdfDocument = shallowRef(null)
let pdfRenderTask = null
let pdfRenderSequence = 0
let pdfResizeObserver = null
let pdfResizeTimer = null
let pdfLastStageWidth = 0

const STORAGE_KEY = 'pr-manager:document-preview-position:v1'
const dialogTitle = computed(() => `预览 - ${String(currentDocument.value?.title || fileName.value || '文档')}`)
const sanitizedPreviewContent = computed(() => sanitizeRichHtml(previewContent.value))
const highlightedCode = computed(() => {
  if (!previewContent.value || previewType.value !== 'code') return ''
  const language = hljs.getLanguage(previewLanguage.value) ? previewLanguage.value : 'plaintext'
  return sanitizeHighlightHtml(hljs.highlight(previewContent.value, { language }).value)
})
const imageMimeType = computed(() => ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp' })[
  fileName.value.split('.').pop()?.toLowerCase()
] || 'png')
const officeIconName = computed(() => ({ word: 'file-word', ppt: 'file-powerpoint', excel: 'file-excel' })[previewLanguage.value] || 'file')
const officeTypeLabel = computed(() => ({ word: 'Word', ppt: 'PowerPoint', excel: 'Excel' })[previewLanguage.value] || 'Office')

function previewInfo(extension) {
  const ext = String(extension || '').toLowerCase()
  if (ext === 'pdf') return { type: 'pdf', language: 'pdf' }
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return { type: 'markdown', language: 'markdown' }
  const code = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript', py: 'python', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
    swift: 'swift', kt: 'kotlin', scala: 'scala', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini', cfg: 'ini'
  }
  if (code[ext]) return { type: 'code', language: code[ext] }
  if (['txt', 'log', 'csv', 'tsv'].includes(ext)) return { type: 'text', language: 'plaintext' }
  if (['doc', 'docx'].includes(ext)) return { type: 'office', language: 'word' }
  if (['ppt', 'pptx'].includes(ext)) return { type: 'office', language: 'ppt' }
  if (['xls', 'xlsx'].includes(ext)) return { type: 'office', language: 'excel' }
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return { type: 'image', language: 'image' }
  return { type: 'unsupported', language: 'plaintext' }
}

function extensionOf(value) {
  const name = String(value || '')
  return name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : ''
}

function positionKey() {
  const row = currentDocument.value
  return row?.id ? `${row.id}:${row.version || 1}` : ''
}

function readPositionStore() {
  try { return pruneDocumentPreviewPositions(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')) } catch { return {} }
}

function currentScrollElement() {
  if (previewType.value === 'pdf') return pdfCanvasStage.value
  const root = previewScrollSurface.value?.$el || previewScrollSurface.value
  if (previewType.value === 'markdown') {
    return root?.querySelector?.('.md-editor-preview-wrapper') || root
  }
  return root || null
}

function savePreviewPosition() {
  const key = positionKey()
  if (!key || loading.value) return
  const surface = currentScrollElement()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updateDocumentPreviewPosition(readPositionStore(), key, {
      type: previewType.value,
      page: currentPage.value,
      scrollTop: surface?.scrollTop || 0,
      scrollLeft: surface?.scrollLeft || 0
    })))
  } catch {
    // Reading progress is a local enhancement and never blocks document access.
  }
}

function savedPosition() {
  const key = positionKey()
  return key ? readPositionStore()[key] || null : null
}

async function restorePosition(position = savedPosition()) {
  if (!position) return
  await nextTick()
  const surface = currentScrollElement()
  surface?.scrollTo?.({
    top: Math.max(0, Number(position.scrollTop) || 0),
    left: Math.max(0, Number(position.scrollLeft) || 0),
    behavior: 'auto'
  })
}

function animationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

async function adjustDialogHeight() {
  if (previewType.value === 'pdf') {
    dialogHeight.value = 'min(92vh, 980px)'
    return
  }
  if (['image', 'office', 'unsupported'].includes(previewType.value)) {
    dialogHeight.value = previewType.value === 'image' ? 'min(78vh, 820px)' : 'min(520px, calc(100vh - 40px))'
    return
  }
  await nextTick()
  await animationFrame()
  const surface = currentScrollElement()
  const root = previewScrollSurface.value?.$el || previewScrollSurface.value
  const contentNode = previewType.value === 'word-html'
    ? root?.querySelector?.('.word-content')
    : previewType.value === 'markdown'
      ? root?.querySelector?.('.md-editor-preview')
      : root?.querySelector?.('pre')
  const contentHeight = contentNode?.scrollHeight || surface?.scrollHeight || 0
  const maximum = Math.min(Math.round(window.innerHeight * 0.86), 920)
  const target = Math.min(maximum, Math.max(440, Math.round(contentHeight + 176)))
  dialogHeight.value = `${target}px`
}

async function open(row) {
  if (!row?.id) return
  if (visible.value) savePreviewPosition()
  currentDocument.value = { ...row }
  const initial = previewInfo(extensionOf(row.filePath))
  previewType.value = initial.type
  previewLanguage.value = initial.language
  fileName.value = documentDisplayFileName(row.title, row.filePath)
  fileSize.value = row.size ?? null
  dialogHeight.value = initial.type === 'pdf' ? 'min(92vh, 980px)' : 'min(76vh, 820px)'
  visible.value = true
  await load(row)
}

async function load(row) {
  loading.value = true
  previewContent.value = ''
  previewError.value = ''
  currentPage.value = 1
  jumpPage.value = 1
  totalPages.value = 0
  teardownPdfResizeObserver()
  await destroyPdfDocument()

  try {
    const listedExtension = extensionOf(row.filePath)
    const initial = previewInfo(listedExtension)
    previewType.value = initial.type
    previewLanguage.value = initial.language
    const position = savedPosition()

    if (initial.type === 'pdf') {
      await loadPdf(authenticatedAssetUrl(`/api/documents/preview/${row.id}`))
      loading.value = false
      await nextTick()
      currentPage.value = Math.min(totalPages.value, Math.max(1, Number(position?.page) || 1))
      jumpPage.value = currentPage.value
      await renderPage(currentPage.value)
      setupPdfResizeObserver()
      await restorePosition(position)
      return
    }

    if (initial.language === 'excel') {
      loading.value = false
      await adjustDialogHeight()
      return
    }

    const response = await api.documents.getContent(row.id)
    const data = response.data || {}
    const sourceName = data.fileName || row.filePath
    const logicalTitle = data.title || row.title
    fileName.value = documentDisplayFileName(logicalTitle, sourceName)
    fileSize.value = data.fileSize ?? row.size ?? null
    if (data.title) currentDocument.value = { ...currentDocument.value, title: data.title }
    const info = previewInfo(extensionOf(sourceName))
    previewType.value = info.type
    previewLanguage.value = info.language

    if (data.isBase64) {
      if (info.type === 'image') previewContent.value = data.content || ''
      else if (info.type === 'office') await loadOffice(data.content || '', extensionOf(sourceName))
      else previewType.value = 'unsupported'
    } else {
      previewContent.value = data.content || ''
    }
    loading.value = false
    await adjustDialogHeight()
    await restorePosition(position)
  } catch (error) {
    console.error('加载预览内容失败:', error)
    previewError.value = previewType.value === 'pdf'
      ? 'PDF 预览组件加载失败。你可以重新加载；若仍失败，原件仍可正常下载。'
      : '预览内容加载失败。你可以重新加载或下载原件。'
    loading.value = false
    await adjustDialogHeight()
  }
}

async function loadOffice(base64, extension) {
  if (extension !== 'docx') return
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer })
    previewContent.value = result.value
    previewType.value = 'word-html'
  } catch (error) {
    console.error('加载 Word 文档失败:', error)
    previewType.value = 'office'
  }
}

async function loadPdf(source) {
  pdfDocument.value = await openPdfDocument(source)
  totalPages.value = pdfDocument.value.numPages
}

async function renderPage(pageNumber) {
  const sequence = ++pdfRenderSequence
  if (!pdfDocument.value || !pdfCanvas.value) return
  try {
    const page = await pdfDocument.value.getPage(pageNumber)
    if (sequence !== pdfRenderSequence) return
    const canvas = pdfCanvas.value
    const stage = pdfCanvasStage.value
    const context = canvas.getContext('2d', { alpha: false })
    const baseViewport = page.getViewport({ scale: 1 })
    const availableWidth = Math.max((stage?.clientWidth || baseViewport.width) - 48, 320)
    const cssScale = Math.min(2, Math.max(0.72, availableWidth / baseViewport.width))
    const viewport = page.getViewport({ scale: cssScale })
    const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2.25)
    if (pdfRenderTask) pdfRenderTask.cancel()
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    pdfRenderTask = page.render({
      canvasContext: context,
      viewport,
      background: '#ffffff',
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
    })
    await pdfRenderTask.promise
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') console.error('渲染 PDF 页面失败:', error)
  } finally {
    if (sequence === pdfRenderSequence) pdfRenderTask = null
  }
}

function teardownPdfResizeObserver() {
  pdfResizeObserver?.disconnect()
  pdfResizeObserver = null
  if (pdfResizeTimer) clearTimeout(pdfResizeTimer)
  pdfResizeTimer = null
  pdfLastStageWidth = 0
}

function setupPdfResizeObserver() {
  teardownPdfResizeObserver()
  if (!pdfCanvasStage.value || typeof ResizeObserver === 'undefined') return
  pdfLastStageWidth = Math.round(pdfCanvasStage.value.clientWidth)
  pdfResizeObserver = new ResizeObserver(entries => {
    const width = Math.round(entries[0]?.contentRect?.width || 0)
    if (!width || Math.abs(width - pdfLastStageWidth) < 8) return
    pdfLastStageWidth = width
    if (pdfResizeTimer) clearTimeout(pdfResizeTimer)
    pdfResizeTimer = setTimeout(() => void renderPage(currentPage.value), 140)
  })
  pdfResizeObserver.observe(pdfCanvasStage.value)
}

async function destroyPdfDocument() {
  pdfRenderSequence += 1
  if (pdfRenderTask) pdfRenderTask.cancel()
  pdfRenderTask = null
  const document = pdfDocument.value
  pdfDocument.value = null
  if (document) {
    try { await document.destroy() } catch { /* Closing can race with a cancelled render. */ }
  }
}

async function handleClosed() {
  teardownPdfResizeObserver()
  await destroyPdfDocument()
}

async function previousPage() {
  if (currentPage.value <= 1) return
  currentPage.value -= 1
  jumpPage.value = currentPage.value
  await renderPage(currentPage.value)
  pdfCanvasStage.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
}

async function nextPage() {
  if (currentPage.value >= totalPages.value) return
  currentPage.value += 1
  jumpPage.value = currentPage.value
  await renderPage(currentPage.value)
  pdfCanvasStage.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
}

async function jumpToPage() {
  const value = Number.parseInt(jumpPage.value)
  if (value < 1 || value > totalPages.value) return
  currentPage.value = value
  await renderPage(value)
  pdfCanvasStage.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
}

function retry() {
  if (currentDocument.value) void load(currentDocument.value)
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '大小未知'
  const numericBytes = Number(bytes)
  if (!Number.isFinite(numericBytes) || numericBytes < 0) return '大小未知'
  if (numericBytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(numericBytes) / Math.log(1024)))
  return `${Math.round(numericBytes / (1024 ** index) * 100) / 100} ${units[index]}`
}

defineExpose({ open })
onBeforeUnmount(() => {
  savePreviewPosition()
  teardownPdfResizeObserver()
  void destroyPdfDocument()
})
</script>

<style scoped>
:global(.document-preview-dialog.native-dialog) { overflow: hidden; }
:global(.document-preview-dialog .native-dialog__body) { padding: 0; display: flex; overflow: hidden; }
.loading-container { min-height: 360px; display: flex; align-items: center; justify-content: center; }
.preview-container { width: 100%; height: 100%; min-height: 0; display: flex; flex: 1 1 auto; flex-direction: column; overflow: hidden; background: var(--color-surface-page); }
.preview-toolbar { min-height: 62px; padding: 10px 16px; display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--color-border-subtle); background: var(--color-surface-raised); }
.preview-file-meta { min-width: 0; display: flex; align-items: center; gap: 10px; }
.preview-file-meta > div { min-width: 0; display: grid; gap: 2px; }
.preview-file-meta strong { max-width: min(760px, 60vw); overflow: hidden; color: var(--color-text-primary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.preview-file-meta span { color: var(--color-text-muted); font-size: 12px; }
.document-type-icon { width: 34px; height: 34px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); color: var(--color-primary); background: var(--color-primary-surface); }
.document-type-icon--pdf { color: var(--color-danger-text); background: var(--color-danger-surface); }
.document-type-icon--word { color: #3564b8; background: #edf4ff; }
.document-type-icon--sheet { color: var(--color-success-text); background: var(--color-success-surface); }
.document-type-icon--slides { color: var(--color-warning-text); background: var(--color-warning-surface); }
.document-type-icon--markdown { color: #6a4fb0; background: #f2efff; }
.document-type-icon--image { color: #087c8f; background: #e9f7f8; }
.document-type-icon--code { color: #4f6078; background: #edf0f5; }
.pdf-preview { position: relative; height: 100%; min-height: 0; padding-bottom: 72px; display: flex; flex: 1 1 auto; overflow: hidden; }
.pdf-canvas-stage { height: 100%; min-height: 0; padding: 24px; display: flex; flex: 1 1 auto; justify-content: center; overflow: auto; background: var(--color-surface-subtle); }
.pdf-preview canvas { align-self: flex-start; max-width: none; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: white; box-shadow: var(--shadow-md); }
.pdf-controls { position: absolute; right: 0; bottom: 0; left: 0; z-index: 1; min-height: 72px; padding: 11px 18px; display: flex; align-items: center; justify-content: center; gap: 10px; border-top: 1px solid var(--color-border-subtle); background: color-mix(in srgb, var(--color-surface-page) 72%, var(--color-surface-raised)); box-shadow: 0 -8px 24px rgba(23, 32, 51, .06); }
.pdf-page-status { min-height: 42px; padding: 4px 5px 4px 12px; display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-md); color: var(--color-text-secondary); background: var(--color-surface-raised); box-shadow: var(--shadow-sm); font-size: 13px; white-space: nowrap; }
.pdf-page-input { width: 72px; }
.pdf-page-input :deep(.native-input) { text-align: center; font-variant-numeric: tabular-nums; }
.pdf-page-jump { border-radius: var(--radius-sm); }
.pdf-page-button :deep(.native-icon) { width: 15px; height: 15px; flex: 0 0 15px; }
.pdf-page-button { min-width: 92px; background: var(--color-surface-raised); }
.markdown-preview, .text-preview, .code-preview, .image-preview, .word-html-preview, .office-preview, .unsupported-preview, .preview-error-state { min-height: 0; margin: 20px; flex: 1 1 auto; overflow: auto; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-lg); background: var(--color-surface-raised); }
.code-preview { padding: 20px; background: #282c34; }
.code-preview pre, .text-preview pre { min-width: max-content; margin: 0; padding: 16px; font: 14px/1.65 Consolas, Monaco, monospace; }
.text-preview pre { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--color-surface-raised); }
.image-preview { display: flex; align-items: center; justify-content: center; padding: 20px; }
.image-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.word-content { padding: 22px 28px; overflow-x: auto; background: var(--color-surface-raised); }
.word-content :deep(p) { margin: 12px 0; line-height: 1.8; }
.word-content :deep(h1), .word-content :deep(h2), .word-content :deep(h3) { margin: 20px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-subtle); }
.word-content :deep(table) { width: 100%; margin: 12px 0; border-collapse: collapse; }
.word-content :deep(td), .word-content :deep(th) { padding: 8px 12px; border: 1px solid var(--color-border-default); }
.office-preview, .unsupported-preview, .preview-error-state { padding: 42px 24px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--color-text-secondary); text-align: center; }
.preview-error-state > span { width: 52px; height: 52px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-lg); color: var(--color-danger); background: var(--color-danger-surface); }
.preview-error-state p, .office-preview p, .unsupported-preview p { max-width: 620px; margin: 0; }
.pdf-canvas-stage, .code-preview, .text-preview, .word-html-preview, .markdown-preview :deep(.md-editor-preview-wrapper) { scrollbar-color: var(--color-border-strong) transparent; scrollbar-width: thin; }
.pdf-canvas-stage::-webkit-scrollbar, .code-preview::-webkit-scrollbar, .text-preview::-webkit-scrollbar, .word-html-preview::-webkit-scrollbar, .markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar { width: 8px; height: 8px; }
.pdf-canvas-stage::-webkit-scrollbar-thumb, .code-preview::-webkit-scrollbar-thumb, .text-preview::-webkit-scrollbar-thumb, .word-html-preview::-webkit-scrollbar-thumb, .markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: var(--radius-pill); background: var(--color-border-strong); background-clip: padding-box; }
.pdf-canvas-stage::-webkit-scrollbar-thumb:hover, .code-preview::-webkit-scrollbar-thumb:hover, .text-preview::-webkit-scrollbar-thumb:hover, .word-html-preview::-webkit-scrollbar-thumb:hover, .markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb:hover { background-color: var(--color-primary); }
.pdf-canvas-stage::-webkit-scrollbar-thumb:active, .code-preview::-webkit-scrollbar-thumb:active, .text-preview::-webkit-scrollbar-thumb:active, .word-html-preview::-webkit-scrollbar-thumb:active, .markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb:active { background-color: var(--color-primary-active); }
</style>
