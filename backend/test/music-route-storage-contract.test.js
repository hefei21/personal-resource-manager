import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const routeSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'routes', 'music.js'), 'utf8')

test('music upload and content routes use the managed storage contracts', () => {
  assert.match(routeSource, /commitMusicUpload\(/u)
  assert.match(routeSource, /getStorageCommitOperation\(/u)
  assert.match(routeSource, /stageFromStream\(/u)
  assert.match(routeSource, /contentServiceFor\('music'\)/u)
  assert.match(routeSource, /contentService\.stat\(music\)/u)
  assert.match(routeSource, /contentService\.createReadStream\(music/u)
  assert.match(routeSource, /resolveVerifiedFilePath\(/u)

  const mergeRoute = routeSource.slice(
    routeSource.indexOf("router.post('/merge-chunks'"),
    routeSource.indexOf("// 取消上传")
  )
  assert.doesNotMatch(mergeRoute, /INSERT INTO music/u)
  const completedRetry = mergeRoute.slice(
    mergeRoute.indexOf("operation?.state === 'database_committed'"),
    mergeRoute.indexOf('// A cancelled upload')
  )
  assert.match(completedRetry, /clearMusicUploadInputs\(fileId, totalChunks, mergedPath\)/u)
  assert.match(completedRetry, /cancelledUploads\.delete\(fileId\)/u)

  const playRoute = routeSource.slice(
    routeSource.indexOf("router.get('/play/:id'"),
    routeSource.indexOf('// 歌单管理')
  )
  assert.doesNotMatch(playRoute, /music\.file_path/u)
  assert.doesNotMatch(playRoute, /fs\.createReadStream/u)
  assert.match(playRoute, /Content-Range/u)
  assert.match(playRoute, /bytes \*\//u)

  const reparseRoute = routeSource.slice(
    routeSource.indexOf("router.post('/:id/reparse'"),
    routeSource.indexOf('// 更新音乐信息')
  )
  assert.match(reparseRoute, /resolveVerifiedFilePath/u)
  assert.doesNotMatch(reparseRoute, /music\.file_path/u)
})

test('duplicate responses do not include legacy paths', () => {
  const duplicateRoute = routeSource.slice(
    routeSource.indexOf("router.get('/duplicates'"),
    routeSource.indexOf('// 删除重复音乐')
  )
  assert.doesNotMatch(duplicateRoute, /m1\.file_path/u)
  assert.doesNotMatch(duplicateRoute, /, file_path/u)
})
