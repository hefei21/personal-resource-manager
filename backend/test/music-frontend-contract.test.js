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

test('music frontend API exposes the exact trash lifecycle routes', () => {
  assert.match(apiSource, /trash: \(\) => api\.get\('\/music\/trash'\)/u)
  assert.match(apiSource, /restoreTrash: \(id\) => api\.post\(`\/music\/trash\/\$\{id\}\/restore`\)/u)
  assert.match(apiSource, /permanentlyDeleteTrash: \(id\) => api\.delete\(`\/music\/trash\/\$\{id\}\/permanent`\)/u)
})

test('PC music UI presents reversible deletion and the full trash lifecycle', () => {
  assert.match(pcSource, /@click="openTrashDialog"/u)
  assert.match(pcSource, /移入回收站/u)
  assert.match(pcSource, /api\.music\.trash\(\)/u)
  assert.match(pcSource, /api\.music\.restoreTrash\(id\)/u)
  assert.match(pcSource, /api\.music\.permanentlyDeleteTrash\(id\)/u)
  assert.match(pcSource, /永久删除不可恢复/u)
  assert.match(pcSource, /MUSIC_TRASH_LEGACY_MIGRATION_REQUIRED/u)
})

test('mobile music UI presents reversible deletion and cleans the player queue without permanent deletion', () => {
  assert.match(mobileSource, /@click="openTrash"/u)
  assert.match(mobileSource, /默认保留 30 天，可在回收站恢复/u)
  assert.match(mobileSource, /api\.music\.trash\(\)/u)
  assert.match(mobileSource, /api\.music\.restoreTrash\(id\)/u)
  assert.doesNotMatch(mobileSource, /api\.music\.permanentlyDeleteTrash\(id\)/u)
  assert.doesNotMatch(mobileSource, /永久删除不可恢复/u)
  assert.match(mobileSource, /new CustomEvent\('remove-music'/u)
  assert.doesNotMatch(mobileSource, /彻底删除选中的/u)
  assert.doesNotMatch(mobileSource, /删除后无法恢复/u)
})
