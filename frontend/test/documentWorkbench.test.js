import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  collectExpandableCategoryIds,
  documentFileIcon,
  flattenVisibleDocumentCategories
} from '../src/utils/documentWorkbench.js'

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
  assert.equal(documentFileIcon('notes.md'), 'file-text')
  assert.equal(documentFileIcon('cover.png'), 'image')
  assert.equal(documentFileIcon('archive.unknown'), 'file')
  assert.equal(documentFileIcon(''), 'file')
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

  assert.match(documents, /版本与回收/u)
  assert.match(documents, /版本记录[\s\S]*已删除版本/u)
  assert.match(documents, /versionHistoryView === 'trash'/u)
  assert.doesNotMatch(documents, /versionTrashDialogVisible/u)
  assert.match(documents, /class="preview-error-state"/u)
})
