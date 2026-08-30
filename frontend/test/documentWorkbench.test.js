import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectExpandableCategoryIds,
  documentFileIcon,
  flattenVisibleDocumentCategories
} from '../src/utils/documentWorkbench.js'

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
