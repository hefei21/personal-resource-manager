import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import test from 'node:test'

import { MUSIC_STORAGE_TARGET_DDL } from '../src/config/musicStorageSchema.js'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ENSURE_STORAGE_COMMIT_OPERATIONS_SQL } from '../src/config/storageCommitSchema.js'
import { commitMusicUpload } from '../src/services/musicStorageService.js'
import { StorageService } from '../src/services/storageService.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-music-storage-'))
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    ${MUSIC_STORAGE_TARGET_DDL};
    ${ENSURE_STORAGE_COMMIT_OPERATIONS_SQL};
  `)
  for (const migration of applicationMigrationRegistry.migrations.filter(({ id }) => /^00(?:59|60|61|62)_/u.test(id))) {
    database.exec(migration.source)
  }
  return {
    root,
    database,
    storageService: new StorageService({ rootPath: path.join(root, 'storage') }),
    cleanup() {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

async function stage(storageService, content = 'managed-audio') {
  return storageService.stageFromStream(Readable.from([content]))
}

test('commits a staged music object and upload metadata with a null legacy path', nativeTestOptions, async () => {
  const value = setup()
  try {
    const staged = await stage(value.storageService)
    const result = await commitMusicUpload({
      database: value.database,
      storageService: value.storageService,
      staged,
      idempotencyKey: 'music-upload:test-success',
      music: {
        title: '测试歌曲',
        artist: '歌手',
        album: '专辑',
        duration: 245,
        originalName: 'track.mp3',
        fileType: 'mp3',
        coverImage: 'data:image/jpeg;base64,cover',
        metadataStatus: 'failed',
        metadataErrorCode: 'MUSIC_METADATA_PARSE_FAILED',
        metadataParserVersion: 'music-parser-v1'
      }
    })
    const song = value.database.prepare(`
      SELECT title, artist, album, duration, file_path, storage_key, content_sha256,
             content_bytes, original_name, file_size, file_type, cover_image,
             metadata_status, metadata_error_code, metadata_parser_version,
             metadata_updated_at IS NOT NULL AS has_metadata_updated_at
      FROM music WHERE id = ?
    `).get(result.id)
    assert.deepEqual(song, {
      title: '测试歌曲',
      artist: '歌手',
      album: '专辑',
      duration: 245,
      file_path: null,
      storage_key: result.storageKey,
      content_sha256: result.sha256,
      content_bytes: staged.bytes,
      original_name: 'track.mp3',
      file_size: staged.bytes,
      file_type: 'mp3',
      cover_image: 'data:image/jpeg;base64,cover',
      metadata_status: 'failed',
      metadata_error_code: 'MUSIC_METADATA_PARSE_FAILED',
      metadata_parser_version: 'music-parser-v1',
      has_metadata_updated_at: 1
    })
    assert.equal((await value.storageService.stat(result.storageKey)).bytes, staged.bytes)
    assert.equal(value.database.prepare("SELECT state FROM storage_commit_operations WHERE idempotency_key = ?").get('music-upload:test-success').state, 'database_committed')
  } finally {
    value.cleanup()
  }
})

test('records an orphan after database failure and retries without recommitting the music object', nativeTestOptions, async () => {
  const value = setup()
  try {
    const staged = await stage(value.storageService, 'retry-audio')
    const request = {
      database: value.database,
      storageService: value.storageService,
      staged,
      idempotencyKey: 'music-upload:test-retry',
      music: { title: '重试歌曲', originalName: 'retry.flac', fileType: 'flac' }
    }
    value.database.exec('DROP TABLE music')
    await assert.rejects(commitMusicUpload(request), { code: 'STORAGE_COMMIT_DATABASE_FAILED' })
    assert.equal(value.database.prepare("SELECT state FROM storage_commit_operations WHERE idempotency_key = ?").get(request.idempotencyKey).state, 'orphaned')
    assert.equal((await value.storageService.stat(`music/${staged.sha256.slice(0, 2)}/${staged.sha256}`)).bytes, staged.bytes)
    value.database.exec(MUSIC_STORAGE_TARGET_DDL)
    for (const migration of applicationMigrationRegistry.migrations.filter(({ id }) => /^00(?:59|60|61|62)_/u.test(id))) {
      value.database.exec(migration.source)
    }
    const result = await commitMusicUpload(request)
    assert.equal(result.title, '重试歌曲')
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM music').get().count, 1)
    assert.equal(value.database.prepare("SELECT file_path FROM music WHERE id = ?").get(result.id).file_path, null)
    assert.equal(value.database.prepare("SELECT state FROM storage_commit_operations WHERE idempotency_key = ?").get(request.idempotencyKey).state, 'database_committed')
  } finally {
    value.cleanup()
  }
})
