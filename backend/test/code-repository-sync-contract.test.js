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
  const processorSource = read('backend/src/services/codeRepositoryTaskProcessor.js')

  assert.match(processorSource, /status[\s\S]*--porcelain[\s\S]*-z[\s\S]*--untracked-files=all/)
  assert.match(processorSource, /taskError\('REPOSITORY_DIRTY'/)
  assert.doesNotMatch(processorSource, /['"]reset['"]\s*,\s*['"]--hard['"]/) // no forced reset
  assert.doesNotMatch(processorSource, /['"]clean['"]\s*,\s*['"]-[a-z]*f[a-z]*['"]/) // no forced clean
  assert.doesNotMatch(processorSource, /['"]stash['"]/) // no hidden stash
})

test('safe reclone is available on desktop and mobile and keeps a backup entry', () => {
  const routeSource = read('backend/src/routes/code.js')
  const processorSource = read('backend/src/services/codeRepositoryTaskProcessor.js')
  const apiSource = read('frontend/src/api/index.js')
  const desktopSource = read('frontend/src/pc/pages/CodePC.vue')
  const mobileSource = read('frontend/src/mobile/pages/CodeMobile.vue')

  assert.match(routeSource, /router\.post\('\/:id\/reclone'/)
  assert.match(processorSource, /同步前本地备份/)
  assert.match(processorSource, /fs\.renameSync\(repo\.repositoryPath, backupPath\)/)
  assert.match(processorSource, /local-backup-\$\{taskId\}/)
  assert.match(apiSource, /reclone: \(id\) => api\.post\(`\/code\/\$\{id\}\/reclone`\)/)
  assert.match(desktopSource, /data\.code === 'REPOSITORY_DIRTY'/)
  assert.match(mobileSource, /data\.code === 'REPOSITORY_DIRTY'/)
})

test('code repository routes enqueue persistent exclusive tasks and no longer keep process-local maps', () => {
  const routeSource = read('backend/src/routes/code.js')

  assert.match(routeSource, /enqueueExclusiveRun/)
  assert.match(routeSource, /CODE_REPOSITORY_TASK_TYPES/)
  assert.match(routeSource, /input: \{ repoId: String\(repositoryId\) \}/)
  assert.match(routeSource, /requireWritePermission/)
  assert.match(routeSource, /ORDER BY id DESC[\s\S]*LIMIT 1/)
  assert.match(routeSource, /DELETE FROM code_repositories WHERE id = \?/)
  assert.match(routeSource, /findIdempotentRepositoryTask/)
  assert.doesNotMatch(routeSource, /new Map\(/)
  assert.doesNotMatch(routeSource, /setTimeout\(/)
  assert.doesNotMatch(routeSource, /cloneRepository|updateRepository|safelyRecloneRepository/)
})

test('processor registration and task inputs do not start runtime or persist repository paths', () => {
  const processorSource = read('backend/src/services/codeRepositoryTaskProcessor.js')

  assert.match(processorSource, /registerTaskProcessor\('code\.repository\.clone', 'v1', 'network'/)
  assert.match(processorSource, /registerTaskProcessor\('code\.repository\.sync', 'v1', 'network'/)
  assert.match(processorSource, /registerTaskProcessor\('code\.repository\.reclone', 'v1', 'network'/)
  assert.match(processorSource, /keys\.length !== 1 \|\| keys\[0\] !== 'repoId'/u)
  assert.match(processorSource, /changeSummary\.total === 0[\s\S]*updateLastSync\(database, repo\.id\)/u)
  assert.doesNotMatch(processorSource, /startTaskRuntime|initDatabase/u)
})
