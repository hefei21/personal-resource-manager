import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CREATE_STORAGE_COMMIT_OPERATIONS_SQL } from '../src/services/storageCommitCoordinator.js'
import { createDocumentStorageRuntime } from '../src/services/documentStorageRuntime.js'
import { restoreDocumentVersion, updateDocumentContent } from '../src/services/documentVersionService.js'

const require = createRequire(import.meta.url)
function bindingMissing(error) { return /^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? '')) }
let Database
let nativeAvailable = true
try { Database = require('better-sqlite3'); const probe = new Database(':memory:'); probe.close() } catch (error) {
  if (!bindingMissing(error)) throw error
  nativeAvailable = false
}
const nativeOptions = process.env.CI || nativeAvailable ? undefined : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-document-version-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }

function setup(directory) {
  const database = new Database(path.join(directory, 'app.db'))
  database.exec(CREATE_STORAGE_COMMIT_OPERATIONS_SQL)
  database.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, file_path TEXT, storage_key TEXT,
      content_sha256 TEXT, content_bytes INTEGER, original_name TEXT, version REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, version INTEGER NOT NULL,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO documents (id, title, original_name, version) VALUES (7, 'Note', 'note.txt', 1);
  `)
  const legacy = path.join(directory, 'legacy')
  fs.mkdirSync(legacy)
  const runtime = createDocumentStorageRuntime({ storageRoot: path.join(directory, 'storage'), legacyRoots: [legacy] })
  return { database, runtime, legacy }
}

test('creates immutable content versions and advances the current reference atomically', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = setup(directory); database = value.database
    const first = await updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'first', versionNote: 'first edit' })
    const second = await updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'second', version: 5 })
    assert.equal(first.version, 2)
    assert.equal(second.version, 5)
    const rows = database.prepare('SELECT version, storage_key, note FROM document_versions ORDER BY version').all()
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0].storage_key, rows[1].storage_key)
    assert.deepEqual(rows.map(({ version }) => version), [2, 5])
    assert.equal(database.prepare('SELECT version, storage_key, file_path FROM documents WHERE id = 7').get().file_path, null)
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'old', version: 4 }), {
      code: 'STORAGE_COMMIT_DATABASE_FAILED'
    })
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count, 2)
  } finally { database?.close(); cleanup(directory) }
})

test('restores storage and legacy versions as a new immutable current version', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = setup(directory); database = value.database
    const legacyFile = path.join(value.legacy, 'legacy.txt')
    fs.writeFileSync(legacyFile, 'legacy')
    const legacyVersion = database.prepare(`
      INSERT INTO document_versions (document_id, version, file_path, note) VALUES (7, 1, ?, 'legacy')
    `).run(legacyFile)
    const restored = await restoreDocumentVersion({
      database, runtime: value.runtime, id: 7, versionId: Number(legacyVersion.lastInsertRowid)
    })
    assert.equal(restored.version, 2)
    assert.equal(database.prepare('SELECT storage_key FROM documents WHERE id = 7').get().storage_key, restored.storageKey)
    assert.equal(database.prepare('SELECT file_path FROM document_versions WHERE id = ?').get(restored.versionId).file_path, null)
  } finally { database?.close(); cleanup(directory) }
})

test('rejects missing documents, foreign versions, invalid versions and empty content', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = setup(directory); database = value.database
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 99, content: 'x' }), {
      code: 'STORAGE_COMMIT_DATABASE_FAILED'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: '', version: 2 }), {
      code: 'DOCUMENT_CONTENT_INVALID'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'x', version: '1.2' }), {
      code: 'DOCUMENT_VERSION_INVALID'
    })
    await assert.rejects(restoreDocumentVersion({ database, runtime: value.runtime, id: 7, versionId: 99 }), {
      code: 'DOCUMENT_VERSION_NOT_FOUND'
    })
  } finally { database?.close(); cleanup(directory) }
})
