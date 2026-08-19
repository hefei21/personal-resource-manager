import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(testDirectory, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

test('Git sync blocks dirty repositories without destructive commands', () => {
  const routeSource = read('backend/src/routes/code.js')

  assert.match(routeSource, /const REPOSITORY_DIRTY = 'REPOSITORY_DIRTY'/)
  assert.match(routeSource, /status[\s\S]*--porcelain=v1[\s\S]*--untracked-files=all/)
  assert.doesNotMatch(routeSource, /['"]reset['"]\s*,\s*['"]--hard['"]/) // no forced reset
  assert.doesNotMatch(routeSource, /['"]clean['"]\s*,\s*['"]-[a-z]*f[a-z]*['"]/) // no forced clean
  assert.doesNotMatch(routeSource, /['"]stash['"]/) // no hidden stash
})

test('safe reclone is available on desktop and mobile and keeps a backup entry', () => {
  const routeSource = read('backend/src/routes/code.js')
  const apiSource = read('frontend/src/api/index.js')
  const desktopSource = read('frontend/src/pc/pages/CodePC.vue')
  const mobileSource = read('frontend/src/mobile/pages/CodeMobile.vue')

  assert.match(routeSource, /router\.post\('\/:id\/reclone'/)
  assert.match(routeSource, /同步前本地备份/)
  assert.match(routeSource, /fs\.renameSync\(repositoryPath, backupPath\)/)
  assert.match(apiSource, /reclone: \(id\) => api\.post\(`\/code\/\$\{id\}\/reclone`\)/)
  assert.match(desktopSource, /data\.code === 'REPOSITORY_DIRTY'/)
  assert.match(mobileSource, /data\.code === 'REPOSITORY_DIRTY'/)
})
