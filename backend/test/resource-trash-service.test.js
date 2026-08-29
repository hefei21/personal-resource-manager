import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  listResourceTrash,
  normalizeResourceTrashSelection
} from '../src/services/resourceTrashService.js'

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

function fixture() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT, original_name TEXT, version INTEGER);
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, original_name TEXT);
    CREATE TABLE music (id INTEGER PRIMARY KEY, title TEXT, artist TEXT, original_name TEXT);
    CREATE TABLE resource_trash_entries (
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      original_parent_id INTEGER,
      original_path TEXT,
      deleted_at TEXT NOT NULL,
      purge_after TEXT,
      metadata_json TEXT,
      PRIMARY KEY (resource_type, resource_id)
    );
    INSERT INTO documents VALUES (1, 'NAS 运维手册', 'ops.pdf', 3);
    INSERT INTO books VALUES (2, '异世界记录', '示例作者', 'book.epub');
    INSERT INTO music VALUES (3, '夜航', '示例歌手', 'night.flac');
    INSERT INTO resource_trash_entries VALUES
      ('document', 1, 10, '技术/运维', '2026-08-29T10:00:00.000Z', '2026-09-28T10:00:00.000Z', '{"state":"deleted","tokens":[]}'),
      ('ebook', 2, 20, '小说', '2026-08-28T10:00:00.000Z', '2026-08-29T10:00:00.000Z', '{"state":"deleted","tokens":[]}'),
      ('music', 3, NULL, NULL, '2026-08-27T10:00:00.000Z', '2026-09-26T10:00:00.000Z', '{"state":"deleted","tokens":[]}'),
      ('music', 99, NULL, NULL, '2026-08-26T10:00:00.000Z', '2026-08-27T10:00:00.000Z', '{"state":"purging","tokens":[]}'),
      ('document_version', 100, 1, NULL, '2026-08-25T10:00:00.000Z', '2026-09-24T10:00:00.000Z', '{"state":"deleted","tokens":[]}');
  `)
  return database
}

test('unified trash lists only supported resource types with public lifecycle state', nativeTestOptions, () => {
  const database = fixture()
  try {
    const result = listResourceTrash({
      database,
      now: new Date('2026-08-30T00:00:00.000Z'),
      filters: { page: 1, pageSize: 20 }
    })
    assert.equal(result.summary.total, 4)
    assert.deepEqual(result.summary.byType, { document: 1, ebook: 1, music: 2 })
    assert.equal(result.summary.expired, 2)
    assert.equal(result.summary.restorable, 3)
    assert.equal(result.items.some((item) => item.resourceType === 'document_version'), false)
    const orphan = result.items.find((item) => item.resourceId === 99)
    assert.equal(orphan.state, 'purging')
    assert.equal(orphan.canRestore, false)
    assert.equal(orphan.canPermanentlyDelete, true)
  } finally {
    database.close()
  }
})

test('unified trash filters type, search, source, expiry and dates before pagination', nativeTestOptions, () => {
  const database = fixture()
  try {
    const result = listResourceTrash({
      database,
      now: new Date('2026-08-30T00:00:00.000Z'),
      filters: {
        type: 'document',
        q: '运维',
        source: '技术/运维',
        expiry: 'protected',
        deletedAfter: '2026-08-29',
        deletedBefore: '2026-08-29',
        page: 1,
        pageSize: 10
      }
    })
    assert.equal(result.pagination.total, 1)
    assert.equal(result.items[0].key, 'document:1')
    assert.deepEqual(result.summary.sources, ['技术/运维', '小说'])
  } finally {
    database.close()
  }
})

test('unified trash validates typed selections and rejects duplicates', () => {
  assert.deepEqual(normalizeResourceTrashSelection([
    { resourceType: 'document', resourceId: '7' },
    { resourceType: 'ebook', resourceId: 8 }
  ]).map(({ key }) => key), ['document:7', 'ebook:8'])
  assert.throws(() => normalizeResourceTrashSelection([
    { resourceType: 'music', resourceId: 9 },
    { resourceType: 'music', resourceId: 9 }
  ]), { code: 'RESOURCE_TRASH_SELECTION_DUPLICATE' })
  assert.throws(() => normalizeResourceTrashSelection([
    { resourceType: 'code', resourceId: 1 }
  ]), { code: 'RESOURCE_TRASH_TYPE_UNSUPPORTED' })
})
