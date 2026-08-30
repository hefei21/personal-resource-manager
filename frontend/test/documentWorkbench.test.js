import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  collectExpandableCategoryIds,
  documentDisplayFileName,
  documentFileIcon,
  documentFileTone,
  flattenVisibleDocumentCategories,
  pruneDocumentPreviewPositions,
  updateDocumentPreviewPosition
} from '../src/utils/documentWorkbench.js'
import {
  parseDocumentListRouteState,
  serializeDocumentListRouteState
} from '../src/utils/documentListRouteState.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(testDirectory, '..')
const read = relativePath => fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8')

const categories = [
  {
    id: 1,
    name: '笔记',
    subcategories: [
      {
        id: 2,
        name: 'Linux',
        subcategories: [
          { id: 3, name: '测试', subcategories: [] }
        ]
      }
    ]
  },
  { id: 4, name: '图片', subcategories: [] }
]

test('document workbench maps file names to stable semantic icons', () => {
  assert.equal(documentFileIcon('guide.PDF'), 'file-pdf')
  assert.equal(documentFileIcon('notes.md'), 'file-md')
  assert.equal(documentFileIcon('notes.txt'), 'file-txt')
  assert.equal(documentFileIcon('report.docx'), 'file-word')
  assert.equal(documentFileIcon('cover.png'), 'file-image')
  assert.equal(documentFileIcon('archive.unknown'), 'file')
  assert.equal(documentFileIcon(''), 'file')
  assert.equal(documentFileTone('guide.pdf'), 'pdf')
  assert.equal(documentFileTone('report.docx'), 'word')
  assert.equal(documentFileTone('sheet.xlsx'), 'sheet')
  assert.equal(documentFileTone('deck.pptx'), 'slides')
  assert.equal(documentFileTone('notes.md'), 'markdown')
  assert.equal(documentFileTone('cover.png'), 'image')
  assert.equal(documentFileTone('worker.py'), 'code')
  assert.equal(documentFileTone('plain.txt'), 'text')
  assert.equal(documentDisplayFileName('北辰灯塔-v2.4', 'garbled.docx'), '北辰灯塔-v2.4.docx')
  assert.equal(documentDisplayFileName('report.pdf', 'legacy.pdf'), 'report.pdf')
})

test('document list route state round-trips stable filters and drops defaults', () => {
  const parsed = parseDocumentListRouteState({
    categoryId: '23', q: ' 灯塔 ', tags: '运维,安全', from: '2026-08-01', to: '2026-08-31',
    sort: 'title', order: 'asc', page: '3', pageSize: '50'
  })
  assert.deepEqual(parsed, {
    categoryId: 23,
    keyword: '灯塔',
    tags: ['运维', '安全'],
    dateRange: ['2026-08-01', '2026-08-31'],
    sortBy: 'title',
    sortOrder: 'asc',
    page: 3,
    pageSize: 50
  })
  assert.deepEqual(serializeDocumentListRouteState(parsed, { documentId: '8', page: '1' }), {
    documentId: '8', categoryId: '23', q: '灯塔', tags: '运维,安全', from: '2026-08-01',
    to: '2026-08-31', sort: 'title', order: 'asc', page: '3', pageSize: '50'
  })
  assert.deepEqual(serializeDocumentListRouteState({ page: 1, pageSize: 30 }, {}), {})
})

test('document preview position memory expires stale entries and keeps the newest 100', () => {
  const now = Date.UTC(2026, 7, 30)
  const stale = now - 91 * 24 * 60 * 60 * 1000
  const initial = {
    stale: { savedAt: stale, page: 2 },
    recent: { savedAt: now - 1000, page: 3 }
  }
  const updated = updateDocumentPreviewPosition(initial, '23:4', {
    type: 'pdf',
    page: 7,
    scrollTop: 280,
    scrollLeft: 12
  }, now)

  assert.equal(updated.stale, undefined)
  assert.deepEqual(updated['23:4'], {
    type: 'pdf',
    page: 7,
    scrollTop: 280,
    scrollLeft: 12,
    savedAt: now
  })

  const oversized = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
    `entry-${index}`,
    { savedAt: now - index, page: 1 }
  ]))
  const pruned = pruneDocumentPreviewPositions(oversized, now)
  assert.equal(Object.keys(pruned).length, 100)
  assert.ok(pruned['entry-0'])
  assert.equal(pruned['entry-119'], undefined)
})

test('document category tree only flattens descendants of expanded folders', () => {
  assert.deepEqual([...collectExpandableCategoryIds(categories)], [1, 2])
  assert.deepEqual(
    flattenVisibleDocumentCategories(categories, new Set()).map(item => [item.id, item.depth]),
    [[1, 0], [4, 0]]
  )
  assert.deepEqual(
    flattenVisibleDocumentCategories(categories, new Set([1])).map(item => [item.id, item.depth]),
    [[1, 0], [2, 1], [4, 0]]
  )
  assert.deepEqual(
    flattenVisibleDocumentCategories(categories, new Set([1, 2])).map(item => [item.id, item.depth]),
    [[1, 0], [2, 1], [3, 2], [4, 0]]
  )
})

test('document UI keeps filters and portaled menus bounded and opaque', () => {
  const datePicker = read('src/components/native/NativeDateRangePicker.vue')
  const select = read('src/components/native/NativeSelect.vue')

  assert.match(datePicker, /Math\.min\(372, viewportWidth/u)
  assert.doesNotMatch(datePicker, /width: `\$\{rect\.width\}px`/u)
  assert.match(select, /:global\(\.native-select__dropdown\)[\s\S]*background: var\(--color-surface-raised/u)
  assert.match(select, /opacity: 1/u)
})

test('document versions expose active and deleted records in one contextual dialog', () => {
  const documents = read('src/pc/pages/DocumentsPC.vue')
  const detail = read('src/pc/components/documents/DocumentDetailDrawer.vue')

  assert.match(detail, /版本与回收/u)
  assert.match(documents, /版本记录[\s\S]*已删除版本/u)
  assert.match(documents, /versionHistoryView === 'trash'/u)
  assert.doesNotMatch(documents, /versionTrashDialogVisible/u)
})

test('document PC refinement keeps categories collapsed and preview controls usable', () => {
  const documents = read('src/pc/pages/DocumentsPC.vue')
  const preview = read('src/pc/components/documents/DocumentPreviewDialog.vue')
  const metadata = read('src/pc/components/documents/DocumentMetadataDialog.vue')
  const detail = read('src/pc/components/documents/DocumentDetailDrawer.vue')
  const treeSelect = read('src/components/native/NativeTreeSelect.vue')
  const dialog = read('src/components/native/NativeDialog.vue')
  const drawer = read('src/components/native/NativeDrawer.vue')

  assert.match(documents, /expandedCategoryIds\.value = new Set\(\)/u)
  assert.match(documents, /class="sort-direction-button"/u)
  assert.match(preview, /class="pdf-canvas-stage"[\s\S]*class="pdf-controls"/u)
  assert.match(preview, /window\.devicePixelRatio/u)
  assert.match(preview, /transform: outputScale/u)
  assert.match(preview, /resizable[\s\S]*@closed="handleClosed"/u)
  assert.match(preview, /@close="savePreviewPosition"/u)
  assert.match(preview, /document-preview-position:v1/u)
  assert.match(preview, /md-editor-preview-wrapper/u)
  assert.match(preview, /\/api\/documents\/preview\/\$\{row\.id\}/u)
  assert.match(preview, /adjustDialogHeight/u)
  assert.match(documents, /\.batch-actions-bar[\s\S]*position: absolute/u)
  assert.match(preview, /\.pdf-controls[\s\S]*position: absolute/u)
  assert.equal((preview.match(/emit\('download'/gu) || []).length, 1)
  assert.match(documents, /documentFileTone/u)
  assert.match(documents, /value: cat\.id/u)
  assert.match(metadata, /update:categoryId/u)
  assert.match(treeSelect, /class="native-tree-select"[\s\S]*v-click-outside="close"/u)
  assert.doesNotMatch(treeSelect, /native-tree-select__dropdown" v-click-outside/u)
  assert.match(treeSelect, /<Teleport to="body">/u)
  assert.match(treeSelect, /zIndex: 12000/u)
  assert.match(treeSelect, /pointer-events: auto/u)
  assert.match(treeSelect, /@pointerdown\.stop/u)
  assert.match(documents, /activeDocumentFilterCount/u)
  assert.match(documents, /document-row-action--preview/u)
  assert.match(preview, /pdf-page-status/u)
  assert.match(preview, /chevron-left" size="15"[\s\S]*chevron-right" size="15"/u)
  assert.match(detail, /:show-title="false"/u)
  assert.match(detail, /:top-offset="72"/u)
  assert.match(drawer, /style\.height = 'auto'/u)
  assert.match(documents, /class="workbench-sort-group"/u)
  assert.match(documents, /align: 'left', headerAlign: 'left'/u)
  assert.match(documents, /\.document-row-actions[\s\S]*justify-content: flex-start/u)
  assert.match(detail, /<NativeIcon name="file-text" size="22"/u)
  assert.match(detail, /\.document-detail-hero \{ padding: 16px 48px 16px 0;/u)
  assert.doesNotMatch(detail, /documentFileIcon|documentFileTone/u)
  assert.match(read('src/components/native/NativeIcon.vue'), /'archive': 'Archive'/u)
  assert.match(read('src/components/native/NativeIcon.vue'), /'file-md': 'FileMd'/u)
  assert.match(read('src/components/native/NativeIcon.vue'), /'file-word': 'FileDoc'/u)
  assert.match(dialog, /native-dialog--resizable/u)
  assert.match(dialog, /resize: both/u)
  assert.match(dialog, /native-tree-select__dropdown/u)
})

test('document mobile refinement uses touch-native navigation and shared preview continuity', () => {
  const mobile = read('src/mobile/pages/DocumentsMobile.vue')

  assert.match(mobile, /class="mobile-category-filter"/u)
  assert.match(mobile, /class="native-action-sheet category-picker-sheet"/u)
  assert.match(mobile, /categoryPickerRows/u)
  assert.match(mobile, /--category-depth/u)
  assert.match(mobile, /aria-label="打开文档回收站"/u)
  assert.match(mobile, /class="document-open-target"/u)
  assert.match(mobile, /params\.categoryId = currentCategoryId\.value/u)
  assert.match(mobile, /function syncMobileListRoute\(\)/u)
  assert.match(mobile, /findCategoryTrail\(categories\.value, requestedCategoryId\)/u)
  assert.match(mobile, /formData\.append\('categoryId'/u)
  assert.match(mobile, /batchEditForm\.value\.categoryId/u)
  assert.match(mobile, /documentFileIcon\(doc\.filePath\)/u)
  assert.match(mobile, /documentFileTone\(doc\.filePath\)/u)
  assert.match(mobile, /pr-manager:document-preview-position:v1/u)
  assert.match(mobile, /updateDocumentPreviewPosition/u)
  assert.match(mobile, /\/api\/documents\/preview\/\$\{doc\.id\}/u)
  assert.match(mobile, /window\.devicePixelRatio/u)
  assert.match(mobile, /class="pdf-canvas-stage"[\s\S]*class="pdf-controls"/u)
  assert.match(mobile, /class="mobile-list-pagination"/u)
  assert.match(mobile, /每次加载 \$\{pageSize\} 项/u)
  assert.match(mobile, /class="mobile-version-summary"/u)
  assert.match(mobile, /ver\.contentBytes/u)
  assert.match(mobile, /height: 100dvh/u)
  assert.match(mobile, /role="dialog" aria-modal="true" aria-label="文档操作"/u)
  assert.match(mobile, /移入回收站/u)
  assert.match(mobile, /prefers-reduced-motion/u)
  assert.doesNotMatch(mobile, /preview-fullscreen-dialog/u)
  assert.doesNotMatch(mobile, /watch\(viewMode/u)
})
