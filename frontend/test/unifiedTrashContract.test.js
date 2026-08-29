import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(testDirectory, '..')
const read = (relativePath) => fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8')

const trashView = read('src/views/Trash.vue')
const routerSource = read('src/router/index.js')
const apiSource = read('src/api/index.js')
const moduleSources = [
  ['src/pc/pages/DocumentsPC.vue', 'document'],
  ['src/mobile/pages/DocumentsMobile.vue', 'document'],
  ['src/pc/pages/BooksPC.vue', 'ebook'],
  ['src/mobile/pages/BooksMobile.vue', 'ebook'],
  ['src/pc/pages/MusicPC.vue', 'music'],
  ['src/mobile/pages/MusicMobile.vue', 'music']
]

test('unified trash has one route and one typed API surface', () => {
  assert.match(routerSource, /path: 'trash'[\s\S]*?name: 'Trash'[\s\S]*?views\/Trash\.vue/u)
  assert.match(apiSource, /trash:\s*\{[\s\S]*?list:[\s\S]*?batchRestore:[\s\S]*?permanentlyDelete:/u)
  assert.match(trashView, /文档、电子书和音频/u)
  assert.match(trashView, /批量恢复/u)
  assert.match(trashView, /v-if="!isMobile"[\s\S]*?永久删除/u)
  assert.match(trashView, /function localDateBoundary[\s\S]*?date\.toISOString\(\)/u)
})

test('module trash shortcuts route to the unified page with a type filter', () => {
  for (const [relativePath, type] of moduleSources) {
    const source = read(relativePath)
    assert.match(source, new RegExp(`name: 'Trash', query: \\{ type: '${type}' \\}`, 'u'), relativePath)
    assert.doesNotMatch(source, new RegExp(`api\\.(documents|books|music)\\.(trash|restoreTrash|permanentlyDeleteTrash)`, 'u'), relativePath)
  }
})

test('mobile unified trash keeps restore but hides destructive and batch actions', () => {
  assert.match(trashView, /NativeButton[\s\S]*?>\s*恢复\s*<\/NativeButton>/u)
  assert.match(trashView, /v-if="!isMobile"[\s\S]*?永久删除/u)
  assert.match(trashView, /v-if="!isMobile && items\.length"[\s\S]*?批量恢复/u)
})
