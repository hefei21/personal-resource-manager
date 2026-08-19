import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { MUSIC_STORAGE_TARGET_DDL } from '../src/config/musicStorageSchema.js'
import { createResourceStorageRuntime } from '../src/services/resourceStorageRuntime.js'
import {
  listDeletedMusic,
  permanentlyDeleteMusic,
  restoreMusicFromTrash,
  softDeleteMusic,
  softDeleteMusics
} from '../src/services/musicTrashService.js'

const require = createRequire(import.meta.url)
let Database
let nativeAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeAvailable = false
}

const nativeOptions = process.env.CI || nativeAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-music-trash-'))
}

function setup(directory) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    ${MUSIC_STORAGE_TARGET_DDL};
    ${CREATE_RESOURCE_TRASH_SQL};
    CREATE TABLE playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(playlist_id, music_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (music_id) REFERENCES music(id) ON DELETE CASCADE
    );
  `)
  const musicLegacyRoot = path.join(directory, 'legacy-music')
  const ebooksLegacyRoot = path.join(directory, 'legacy-ebooks')
  fs.mkdirSync(musicLegacyRoot)
  fs.mkdirSync(ebooksLegacyRoot)
  const runtime = createResourceStorageRuntime({
    storageRoot: path.join(directory, 'storage'),
    musicLegacyRoot,
    ebooksLegacyRoot
  })
  database.prepare('INSERT INTO playlists (id, name) VALUES (1, ?)').run('收藏')
  return { database, runtime }
}

async function insertManaged(value, { id, title = `歌曲-${id}`, storageKey, object } = {}) {
  let committed = object
  if (!committed) {
    const staged = await value.runtime.storageService.stageFromStream(Readable.from([`audio-${id}`]))
    committed = await value.runtime.storageService.commitStaged({
      token: staged.token,
      kind: 'music',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes
    })
  }
  value.database.prepare(`
    INSERT INTO music
      (id, title, artist, album, duration, file_path, storage_key, content_sha256,
       content_bytes, original_name, file_size, file_type)
    VALUES (?, ?, '歌手', '专辑', 120, NULL, ?, ?, ?, ?, ?, 'mp3')
  `).run(
    id,
    title,
    storageKey ?? committed.storageKey,
    committed.sha256,
    committed.bytes,
    `${title}.mp3`,
    committed.bytes
  )
  return committed
}

function close(value, directory) {
  value?.database?.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

test('soft delete hides music without deleting content or playlist relationships, and restore reverses only the marker', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    const object = await insertManaged(value, { id: 1 })
    value.database.prepare('INSERT INTO playlist_songs (playlist_id, music_id, sort_order) VALUES (1, 1, 2)').run()

    const deleted = softDeleteMusic({
      database: value.database,
      id: 1,
      now: () => new Date('2026-08-17T00:00:00.000Z')
    })
    assert.equal(deleted.purgeAfter, '2026-09-16T00:00:00.000Z')
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM music').get().count, 1)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 1)
    assert.equal((await value.runtime.storageService.stat(object.storageKey)).bytes, object.bytes)
    const listed = listDeletedMusic(value.database)
    assert.equal(listed.length, 1)
    assert.equal('file_path' in listed[0], false)
    assert.equal('storage_key' in listed[0], false)
    assert.equal('content_sha256' in listed[0], false)
    assert.equal('trashToken' in listed[0], false)

    assert.deepEqual(restoreMusicFromTrash({ database: value.database, id: 1 }), { id: 1 })
    assert.equal(listDeletedMusic(value.database).length, 0)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 1)
  } finally {
    close(value, directory)
  }
})

test('batch soft delete is atomic and never deletes music rows or playlist relationships', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    await insertManaged(value, { id: 1 })
    await insertManaged(value, { id: 2 })
    value.database.prepare('INSERT INTO playlist_songs (playlist_id, music_id) VALUES (1, 1)').run()
    value.database.prepare('INSERT INTO playlist_songs (playlist_id, music_id) VALUES (1, 2)').run()

    assert.throws(() => softDeleteMusics({ database: value.database, ids: [1, 99] }), { code: 'MUSIC_NOT_FOUND' })
    assert.equal(listDeletedMusic(value.database).length, 0)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM music').get().count, 2)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 2)
    assert.equal(softDeleteMusics({ database: value.database, ids: [1, 2] }).length, 2)
    assert.equal(listDeletedMusic(value.database).length, 2)
  } finally {
    close(value, directory)
  }
})

test('permanent delete removes managed music and playlist rows only after verified storage trash', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    const object = await insertManaged(value, { id: 1 })
    value.database.prepare('INSERT INTO playlist_songs (playlist_id, music_id) VALUES (1, 1)').run()
    softDeleteMusic({ database: value.database, id: 1 })

    const result = await permanentlyDeleteMusic({
      database: value.database,
      storageService: value.runtime.storageService,
      id: 1
    })
    assert.deepEqual(result, { id: 1, purgedObjects: 1 })
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM music').get().count, 0)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 0)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM resource_trash_entries').get().count, 0)
    await assert.rejects(value.runtime.storageService.stat(object.storageKey), { code: 'STORAGE_OBJECT_MISSING' })
  } finally {
    close(value, directory)
  }
})

test('permanent delete fails closed for legacy-only music and preserves its file', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    const legacyFile = path.join(directory, 'legacy-music', 'old.mp3')
    fs.writeFileSync(legacyFile, 'legacy-audio')
    value.database.prepare(`
      INSERT INTO music (id, title, file_path, file_type) VALUES (1, '旧歌', ?, 'mp3')
    `).run(legacyFile)
    softDeleteMusic({ database: value.database, id: 1 })
    let called = false
    await assert.rejects(permanentlyDeleteMusic({
      database: value.database,
      storageService: {
        async trashObject() { called = true },
        async restoreTrashed() {},
        async purgeTrashed() { called = true }
      },
      id: 1
    }), { code: 'MUSIC_TRASH_LEGACY_MIGRATION_REQUIRED' })
    assert.equal(called, false)
    assert.equal(fs.existsSync(legacyFile), true)
    assert.ok(value.database.prepare('SELECT 1 FROM music WHERE id = 1').get())
  } finally {
    close(value, directory)
  }
})

test('shared managed objects survive the first permanent delete and purge on the final reference', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    const object = await insertManaged(value, { id: 1 })
    await insertManaged(value, { id: 2, object, storageKey: object.storageKey })
    softDeleteMusics({ database: value.database, ids: [1, 2] })
    const calls = []
    const storageService = {
      async trashObject(input) {
        calls.push(['trash', input])
        return { trashToken: 'a'.repeat(32) }
      },
      async restoreTrashed(token) { calls.push(['restore', token]) },
      async purgeTrashed(token) { calls.push(['purge', token]) }
    }

    assert.deepEqual(await permanentlyDeleteMusic({ database: value.database, storageService, id: 1 }), {
      id: 1,
      purgedObjects: 0
    })
    assert.ok(value.database.prepare('SELECT 1 FROM music WHERE id = 2').get())
    assert.deepEqual(await permanentlyDeleteMusic({ database: value.database, storageService, id: 2 }), {
      id: 2,
      purgedObjects: 1
    })
    assert.deepEqual(calls, [
      ['trash', { storageKey: object.storageKey, activeReferenceCount: 0 }],
      ['purge', 'a'.repeat(32)]
    ])
  } finally {
    close(value, directory)
  }
})

test('database deletion failure restores the moved object and rolls back music, playlist, and trash state', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = setup(directory)
    const object = await insertManaged(value, { id: 1 })
    value.database.prepare('INSERT INTO playlist_songs (playlist_id, music_id) VALUES (1, 1)').run()
    softDeleteMusic({ database: value.database, id: 1 })
    value.database.exec(`
      CREATE TRIGGER reject_music_delete
      BEFORE DELETE ON music
      BEGIN
        SELECT RAISE(ABORT, 'injected delete failure');
      END;
    `)
    const calls = []
    const storageService = {
      async trashObject(input) {
        calls.push(['trash', input])
        return { trashToken: 'b'.repeat(32) }
      },
      async restoreTrashed(token) { calls.push(['restore', token]) },
      async purgeTrashed(token) { calls.push(['purge', token]) }
    }

    await assert.rejects(permanentlyDeleteMusic({
      database: value.database,
      storageService,
      id: 1
    }), /injected delete failure/u)
    assert.deepEqual(calls, [
      ['trash', { storageKey: object.storageKey, activeReferenceCount: 0 }],
      ['restore', 'b'.repeat(32)]
    ])
    assert.ok(value.database.prepare('SELECT 1 FROM music WHERE id = 1').get())
    assert.ok(value.database.prepare('SELECT 1 FROM playlist_songs WHERE music_id = 1').get())
    const trash = value.database.prepare(`
      SELECT metadata_json FROM resource_trash_entries
      WHERE resource_type = 'music' AND resource_id = 1
    `).get()
    assert.deepEqual(JSON.parse(trash.metadata_json), { state: 'deleted', tokens: [] })
  } finally {
    close(value, directory)
  }
})
