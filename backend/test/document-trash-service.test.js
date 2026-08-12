import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { createDocumentStorageRuntime } from '../src/services/documentStorageRuntime.js'
import {
  listDeletedDocuments,
  permanentlyDeleteDocument,
  restoreDocumentFromTrash,
  softDeleteDocument
} from '../src/services/documentTrashService.js'

const require = createRequire(import.meta.url)
function bindingMissing(error) { return /^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? '')) }
let Database
let nativeAvailable = true
try { Database = require('better-sqlite3'); const probe = new Database(':memory:'); probe.close() } catch (error) {
  if (!bindingMissing(error)) throw error
  nativeAvailable = false
}
const nativeOptions = process.env.CI || nativeAvailable ? undefined : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-document-trash-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }
const now = () => new Date('2026-08-13T00:00:00.000Z')

async function setup(directory) {
  const database = new Database(path.join(directory, 'app.db'))
  database.pragma('foreign_keys = ON')
  database.exec(CREATE_RESOURCE_TRASH_SQL)
  database.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
    INSERT INTO categories VALUES (1, '技术'), (2, '技术/前端'), (3, '技术/前端/Vue');
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, subcategory TEXT, category_id INTEGER,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, original_name TEXT,
      version REAL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE document_versions (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, version INTEGER NOT NULL,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `)
  const legacy = path.join(directory, 'legacy'); fs.mkdirSync(legacy)
  const runtime = createDocumentStorageRuntime({ storageRoot: path.join(directory, 'storage'), legacyRoots: [legacy] })
  const staged = await runtime.storageService.stageFromStream(Readable.from(['shared']))
  const object = await runtime.storageService.commitStaged({ token: staged.token, kind: 'documents' })
  database.prepare(`
    INSERT INTO documents VALUES (7, 'Vue', '技术', '前端/Vue', 3, NULL, ?, ?, ?, 'vue.txt', 1, CURRENT_TIMESTAMP)
  `).run(object.storageKey, object.sha256, object.bytes)
  database.prepare(`INSERT INTO document_versions VALUES (11, 7, 1, NULL, ?, ?, ?)`)
    .run(object.storageKey, object.sha256, object.bytes)
  return { database, runtime, object, legacy }
}

test('soft deletes without moving content and restores to the nearest surviving category', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = await setup(directory); database = value.database
    const deleted = softDeleteDocument({ database, id: 7, now })
    assert.equal(deleted.purgeAfter, '2026-09-12T00:00:00.000Z')
    assert.equal(listDeletedDocuments(database).length, 1)
    assert.equal((await value.runtime.storageService.stat(value.object.storageKey)).bytes, 6)
    database.prepare('DELETE FROM categories WHERE id = 3').run()
    const restored = restoreDocumentFromTrash({ database, id: 7 })
    assert.equal(restored.categoryId, 2)
    assert.deepEqual(database.prepare('SELECT category, subcategory, category_id FROM documents WHERE id = 7').get(), {
      category: '技术', subcategory: '前端', category_id: 2
    })
    assert.equal(listDeletedDocuments(database).length, 0)
  } finally { database?.close(); cleanup(directory) }
})

test('permanently deletes metadata and an unshared managed object through verified trash', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = await setup(directory); database = value.database
    softDeleteDocument({ database, id: 7, now })
    const purged = await permanentlyDeleteDocument({ database, storageService: value.runtime.storageService, id: 7 })
    assert.equal(purged.purgedObjects, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resource_trash_entries').get().count, 0)
    await assert.rejects(value.runtime.storageService.stat(value.object.storageKey), { code: 'STORAGE_OBJECT_MISSING' })
  } finally { database?.close(); cleanup(directory) }
})

test('keeps shared objects and rejects permanent deletion of legacy-only content', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = await setup(directory); database = value.database
    database.prepare(`INSERT INTO documents VALUES (8, 'Shared', NULL, NULL, NULL, NULL, ?, ?, ?, 'shared.txt', 1, CURRENT_TIMESTAMP)`)
      .run(value.object.storageKey, value.object.sha256, value.object.bytes)
    softDeleteDocument({ database, id: 7, now })
    assert.equal((await permanentlyDeleteDocument({ database, storageService: value.runtime.storageService, id: 7 })).purgedObjects, 0)
    assert.equal((await value.runtime.storageService.stat(value.object.storageKey)).bytes, 6)

    const legacyFile = path.join(value.legacy, 'old.txt'); fs.writeFileSync(legacyFile, 'old')
    database.prepare(`INSERT INTO documents VALUES (9, 'Old', NULL, NULL, NULL, ?, NULL, NULL, NULL, 'old.txt', 1, CURRENT_TIMESTAMP)`)
      .run(legacyFile)
    softDeleteDocument({ database, id: 9, now })
    await assert.rejects(permanentlyDeleteDocument({ database, storageService: value.runtime.storageService, id: 9 }), {
      code: 'DOCUMENT_TRASH_LEGACY_MIGRATION_REQUIRED'
    })
    assert.equal(fs.existsSync(legacyFile), true)
  } finally { database?.close(); cleanup(directory) }
})
