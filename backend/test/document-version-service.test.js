import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { CREATE_STORAGE_COMMIT_OPERATIONS_SQL } from '../src/services/storageCommitCoordinator.js'
import { createDocumentStorageRuntime } from '../src/services/documentStorageRuntime.js'
import {
  appendDocumentVersion,
  assertMatchingDocumentVersionFileType,
  restoreDocumentVersion,
  updateDocumentContent
} from '../src/services/documentVersionService.js'

test('new versions keep the current file type while accepting equivalent extensions', () => {
  assert.equal(assertMatchingDocumentVersionFileType('note.markdown', 'replacement.md'), '.md')
  assert.equal(assertMatchingDocumentVersionFileType('photo.jpeg', 'replacement.jpg'), '.jpg')
  assert.throws(
    () => assertMatchingDocumentVersionFileType('manual.docx', 'manual.pdf'),
    { code: 'DOCUMENT_VERSION_FILE_TYPE_MISMATCH' }
  )
  assert.throws(
    () => assertMatchingDocumentVersionFileType('manual', 'manual.pdf'),
    { code: 'DOCUMENT_VERSION_FILE_TYPE_MISMATCH' }
  )
})

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
    ${CREATE_RESOURCE_TRASH_SQL};
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, subcategory TEXT,
      category_id INTEGER, tags TEXT, file_path TEXT, storage_key TEXT,
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
    const second = await updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'second' })
    assert.equal(first.version, 2)
    assert.equal(second.version, 3)
    const rows = database.prepare('SELECT version, storage_key, note FROM document_versions ORDER BY version').all()
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0].storage_key, rows[1].storage_key)
    assert.deepEqual(rows.map(({ version }) => version), [2, 3])
    assert.equal(database.prepare('SELECT version, storage_key, file_path FROM documents WHERE id = 7').get().file_path, null)
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'old', version: 4 }), {
      code: 'DOCUMENT_VERSION_MANAGED'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'second' }), {
      code: 'DOCUMENT_CONTENT_IDENTICAL'
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
    database.prepare('UPDATE documents SET version = 2 WHERE id = 7').run()
    const restored = await restoreDocumentVersion({
      database, runtime: value.runtime, id: 7, versionId: Number(legacyVersion.lastInsertRowid)
    })
    assert.equal(restored.version, 3)
    assert.equal(database.prepare('SELECT storage_key FROM documents WHERE id = 7').get().storage_key, restored.storageKey)
    assert.equal(database.prepare('SELECT file_path FROM document_versions WHERE id = ?').get(restored.versionId).file_path, null)
  } finally { database?.close(); cleanup(directory) }
})

test('rejects restoring the current version and invalid content/version inputs', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = setup(directory); database = value.database
    const currentVersion = database.prepare(`
      INSERT INTO document_versions (document_id, version, file_path) VALUES (7, 1, ?)
    `).run(path.join(value.legacy, 'current.txt'))
    await assert.rejects(restoreDocumentVersion({
      database, runtime: value.runtime, id: 7, versionId: Number(currentVersion.lastInsertRowid)
    }), {
      code: 'DOCUMENT_VERSION_IS_CURRENT'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 99, content: 'x' }), {
      code: 'DOCUMENT_NOT_FOUND'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: '' }), {
      code: 'DOCUMENT_CONTENT_INVALID'
    })
    await assert.rejects(updateDocumentContent({ database, runtime: value.runtime, id: 7, content: 'x', newVersion: 2 }), {
      code: 'DOCUMENT_VERSION_MANAGED'
    })
    await assert.rejects(restoreDocumentVersion({ database, runtime: value.runtime, id: 7, versionId: 99 }), {
      code: 'DOCUMENT_VERSION_NOT_FOUND'
    })
  } finally { database?.close(); cleanup(directory) }
})

test('appends a staged upload without changing document metadata', nativeOptions, async () => {
  const directory = root(); let database
  try {
    const value = setup(directory); database = value.database
    database.prepare(`
      UPDATE documents
      SET category = 'Notes', subcategory = 'Daily', tags = 'keep', original_name = 'original.txt'
      WHERE id = 7
    `).run()
    const staged = await value.runtime.storageService.stageFromStream(Readable.from([Buffer.from('uploaded')]))
    const result = await appendDocumentVersion({
      database,
      runtime: value.runtime,
      id: 7,
      staged,
      versionNote: 'upload'
    })
    assert.equal(result.version, 2)
    assert.deepEqual(
      database.prepare('SELECT title, category, subcategory, tags, original_name, version FROM documents WHERE id = 7').get(),
      { title: 'Note', category: 'Notes', subcategory: 'Daily', tags: 'keep', original_name: 'original.txt', version: 2 }
    )
  } finally { database?.close(); cleanup(directory) }
})
