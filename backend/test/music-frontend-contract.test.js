import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(testDirectory, '..', '..')
const readFrontend = (...segments) => fs.readFileSync(path.join(projectRoot, 'frontend', 'src', ...segments), 'utf8')

const apiSource = readFrontend('api', 'index.js')
const pcSource = readFrontend('pc', 'pages', 'MusicPC.vue')
const mobileSource = readFrontend('mobile', 'pages', 'MusicMobile.vue')
const trashSource = readFrontend('views', 'Trash.vue')

test('music frontend API exposes the exact trash lifecycle routes', () => {
  assert.match(apiSource, /trash: \(\) => api\.get\('\/music\/trash'\)/u)
  assert.match(apiSource, /restoreTrash: \(id\) => api\.post\(`\/music\/trash\/\$\{id\}\/restore`\)/u)
  assert.match(apiSource, /permanentlyDeleteTrash: \(id\) => api\.delete\(`\/music\/trash\/\$\{id\}\/permanent`\)/u)
})

test('PC music UI presents reversible deletion and delegates the trash lifecycle to the unified page', () => {
  assert.match(pcSource, /@click="openTrashDialog"/u)
  assert.match(pcSource, /移入回收站/u)
  assert.match(pcSource, /name: 'Trash', query: \{ type: 'music' \}/u)
  assert.doesNotMatch(pcSource, /api\.music\.(?:trash|restoreTrash|permanentlyDeleteTrash)/u)
  assert.match(trashSource, /api\.trash\.restore\(item\.resourceType, item\.resourceId\)/u)
  assert.match(trashSource, /api\.trash\.permanentlyDelete\(item\.resourceType, item\.resourceId\)/u)
  assert.match(trashSource, /永久删除资源/u)
})

test('mobile music UI links to unified restore and cleans the player queue without permanent deletion', () => {
  assert.match(mobileSource, /@click="openTrash"/u)
  assert.match(mobileSource, /默认保留 30 天，可在回收站恢复/u)
  assert.match(mobileSource, /name: 'Trash', query: \{ type: 'music' \}/u)
  assert.doesNotMatch(mobileSource, /api\.music\.(?:trash|restoreTrash|permanentlyDeleteTrash)/u)
  assert.match(trashSource, /v-if="!isMobile"[\s\S]*?永久删除/u)
  assert.doesNotMatch(mobileSource, /永久删除不可恢复/u)
  assert.match(mobileSource, /new CustomEvent\('remove-music'/u)
  assert.doesNotMatch(mobileSource, /彻底删除选中的/u)
  assert.doesNotMatch(mobileSource, /删除后无法恢复/u)
})
