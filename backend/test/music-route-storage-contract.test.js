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
  assert.match(routeSource, /currentMusicTempDir\(\)/u)
  assert.match(routeSource, /contentServiceFor\('music'\)\.stat\(reference\)/u)
  assert.doesNotMatch(routeSource, /\btempDir\b/u)

  const mergeRoute = routeSource.slice(
    routeSource.indexOf("router.post('/merge-chunks'"),
    routeSource.indexOf("// 取消上传")
  )
  assert.doesNotMatch(mergeRoute, /INSERT INTO music/u)
  assert.match(mergeRoute, /verifyMusicUploadContent\(runtime/u)
  const completedRetry = mergeRoute.slice(
    mergeRoute.indexOf("operation?.state === 'database_committed'"),
    mergeRoute.indexOf('// A cancelled upload')
  )
  const retryVerifyIndex = completedRetry.indexOf('await verifyMusicUploadContent(runtime, existing.reference)')
  const retryCleanupIndex = completedRetry.indexOf('clearMusicUploadInputs(fileId, totalChunks, mergedPath)')
  const retryResponseIndex = completedRetry.indexOf('return res.json(existing.response)')
  assert.ok(retryVerifyIndex >= 0 && retryVerifyIndex < retryCleanupIndex && retryVerifyIndex < retryResponseIndex)
  assert.match(completedRetry, /clearMusicUploadInputs\(fileId, totalChunks, mergedPath\)/u)
  assert.match(completedRetry, /cancelledUploads\.delete\(fileId\)/u)

  const committedVerifyIndex = mergeRoute.indexOf('await verifyMusicUploadContent(runtime, {')
  const committedCleanupIndex = mergeRoute.indexOf('clearMusicUploadInputs(fileId, totalChunks, mergedPath)', committedVerifyIndex)
  const committedResponseIndex = mergeRoute.indexOf('return res.json(response)', committedVerifyIndex)
  assert.ok(committedVerifyIndex >= 0 && committedVerifyIndex < committedCleanupIndex && committedVerifyIndex < committedResponseIndex)

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

test('music trash routes and destructive flows use the generic lifecycle without physical or playlist unlinking', () => {
  assert.match(routeSource, /softDeleteMusic\(/u)
  assert.match(routeSource, /softDeleteMusics\(/u)
  assert.match(routeSource, /listDeletedMusic\(/u)
  assert.match(routeSource, /restoreMusicFromTrash\(/u)
  assert.match(routeSource, /permanentlyDeleteMusic\(/u)
  assert.match(routeSource, /router\.get\('\/trash', authenticateToken/u)
  assert.match(routeSource, /router\.post\('\/trash\/:id\/restore', authenticateToken, requireWritePermission/u)
  assert.match(routeSource, /router\.delete\('\/trash\/:id\/permanent', authenticateToken, requireWritePermission/u)
  assert.match(routeSource, /router\.post\('\/remove-duplicates', authenticateToken, requireWritePermission/u)

  const singleDeleteRoute = routeSource.slice(
    routeSource.indexOf("router.delete('/:id'"),
    routeSource.indexOf('// 批量删除音乐')
  )
  assert.doesNotMatch(singleDeleteRoute, /unlinkSync|DELETE FROM playlist_songs|DELETE FROM music/u)

  const duplicateDeleteRoute = routeSource.slice(
    routeSource.indexOf("router.post('/remove-duplicates'"),
    routeSource.indexOf('// 播放音乐')
  )
  assert.doesNotMatch(duplicateDeleteRoute, /unlinkSync|DELETE FROM playlist_songs|DELETE FROM music|file_path/u)
  assert.match(duplicateDeleteRoute, /softDeleteMusics\(/u)
})

test('music visibility queries exclude generic trash entries', () => {
  const queryRoutes = [
    routeSource.slice(routeSource.indexOf("router.get('/all-ids'"), routeSource.indexOf('// 获取音乐列表')),
    routeSource.slice(routeSource.indexOf("router.get('/',"), routeSource.indexOf('// 获取所有艺术家列表')),
    routeSource.slice(routeSource.indexOf("router.get('/artists'"), routeSource.indexOf('// 获取所有专辑列表')),
    routeSource.slice(routeSource.indexOf("router.get('/albums'"), routeSource.indexOf('// 重新解析音乐元数据')),
    routeSource.slice(routeSource.indexOf("router.get('/playlists'"), routeSource.indexOf('// 创建歌单')),
    routeSource.slice(routeSource.indexOf("router.get('/playlists/:id/songs'"), routeSource.indexOf('// 获取歌单内所有歌曲ID')),
    routeSource.slice(routeSource.indexOf("router.get('/playlists/:id/all-ids'"), routeSource.indexOf('// 向歌单添加歌曲'))
  ]
  for (const route of queryRoutes) assert.match(route, /resource_trash_entries/u)
})
