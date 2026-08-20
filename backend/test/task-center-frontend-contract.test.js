import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendSource = path.resolve(testDirectory, '..', '..', 'frontend', 'src')

function readFrontend(relativePath) {
  return fs.readFileSync(path.join(frontendSource, relativePath), 'utf8')
}

test('Stage 3.4 frontend task center keeps the frozen API and shared-state boundaries', () => {
  const apiSource = readFrontend('api/index.js')
  const storeSource = readFrontend('stores/tasks.js')
  const viewSource = readFrontend('views/Tasks.vue')
  const routerSource = readFrontend('router/index.js')
  const pcLayoutSource = readFrontend('pc/layout/Layout.vue')
  const mobileLayoutSource = readFrontend('mobile/layout/Layout.vue')

  assert.match(apiSource, /tasks:\s*\{/u)
  assert.match(apiSource, /list:\s*\(params\)\s*=>\s*api\.get\('\/tasks',\s*\{\s*params\s*\}\)/u)
  assert.match(apiSource, /get:\s*\(id\)\s*=>\s*api\.get\(`\/tasks\/\$\{id\}`\)/u)
  assert.match(apiSource, /cancel:\s*\(id\)\s*=>\s*api\.post\(`\/tasks\/\$\{id\}\/cancel`\)/u)
  assert.match(apiSource, /retry:\s*\(id\)\s*=>\s*api\.post\(`\/tasks\/\$\{id\}\/retry`\)/u)

  assert.match(storeSource, /defineStore\('tasks'/u)
  for (const field of ['tasks', 'pagination', 'loading', 'error', 'filter', 'fetch', 'refresh', 'setFilters', 'retry', 'cancel']) {
    assert.match(storeSource, new RegExp(`\\b${field}\\b`, 'u'), field)
  }
  assert.match(storeSource, /requestSequence/u)
  assert.match(storeSource, /activeRequest\?\.key === key/u)
  assert.match(storeSource, /requestId !== requestSequence/u)
  assert.match(storeSource, /TASK_ERROR_CODE_WHITELIST/u)

  assert.match(viewSource, /POLL_INTERVAL_MS\s*=\s*2000/u)
  assert.match(viewSource, /visibilitychange/u)
  assert.match(viewSource, /clearInterval\(pollTimer\)/u)
  assert.match(viewSource, /onBeforeUnmount/u)
  assert.match(viewSource, /store\.hasActiveTasks/u)
  assert.match(viewSource, /ACTIVE_STATUS_SET/u)
  assert.match(viewSource, /pending[\s\S]*?leased[\s\S]*?running/u)
  assert.match(viewSource, /SAFE_TASK_ERROR_CODE_PATTERN/u)
  assert.match(viewSource, /任务失败（代码：\$\{safeCode\}）/u)
  assert.match(viewSource, /subjectLabel/u)
  assert.match(viewSource, /代码仓库/u)
  assert.match(viewSource, /Steam游戏库/u)

  const taskTypeSource = [storeSource, viewSource].join('\n')
  for (const taskType of [
    'code.repository.clone',
    'code.repository.sync',
    'code.repository.reclone',
    'music.lyrics.batch',
    'games.steam.sync',
    'anime.bangumi.refresh',
    'ebook.cover.generate'
  ]) {
    assert.match(taskTypeSource, new RegExp(taskType.replaceAll('.', '\\.'), 'u'), taskType)
  }

  assert.match(routerSource, /path:\s*'tasks',[\s\S]*?name:\s*'Tasks',[\s\S]*?Tasks\.vue/u)
  assert.match(pcLayoutSource, /value:\s*'tasks',[\s\S]*?任务中心/u)
  assert.match(mobileLayoutSource, /value:\s*'tasks',[\s\S]*?任务中心/u)
  assert.doesNotMatch(readFrontend('views/DemoWorkspace.vue'), /任务中心|\/tasks/u)

  for (const source of [storeSource, viewSource]) {
    assert.doesNotMatch(source, /errorSummary|leaseToken|leaseOwner|leaseExpiresAt/u)
    assert.doesNotMatch(source, /response\??\.data\??\.message|error\.response\??\.data\??\.message/u)
  }
})
