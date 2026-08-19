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
  assertDocumentVersionNotTrashed,
  listDocumentVersions,
  restoreDocumentVersion
} from '../src/services/documentVersionService.js'
import {
  listDeletedDocumentVersions,
  restoreDocumentVersionFromTrash,
  softDeleteDocumentVersion
} from '../src/services/documentVersionTrashService.js'

const require = createRequire(import.meta.url)
function bindingMissing(error) { return /^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? '')) }
let Database
let nativeAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!bindingMissing(error)) throw error
  nativeAvailable = false
}
const nativeOptions = process.env.CI || nativeAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-document-version-trash-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }

async function managedObject(runtime, content) {
  const staged = await runtime.storageService.stageFromStream(
    Readable.from([Buffer.from(content, 'utf8')])
  )
  return runtime.storageService.commitStaged({
    token: staged.token,
    kind: 'documents',
    expectedSha256: staged.sha256,
    expectedBytes: staged.bytes
  })
}

async function setup(directory) {
  const database = new Database(path.join(directory, 'app.db'))
  database.pragma('foreign_keys = ON')
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
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, version INTEGER NOT NULL,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `)

  const legacy = path.join(directory, 'legacy')
  fs.mkdirSync(legacy)
  const runtime = createDocumentStorageRuntime({
    storageRoot: path.join(directory, 'storage'),
    legacyRoots: [legacy]
  })
  const historyObject = await managedObject(runtime, 'history')
  const currentObject = await managedObject(runtime, 'current')
  database.prepare(`
    INSERT INTO documents
      (id, title, original_name, version, storage_key, content_sha256, content_bytes)
    VALUES (7, 'Note', 'note.txt', 2, ?, ?, ?)
  `).run(currentObject.storageKey, currentObject.sha256, currentObject.bytes)
  database.prepare(`
    INSERT INTO document_versions
      (id, document_id, version, storage_key, content_sha256, content_bytes, note)
    VALUES (101, 7, 1, ?, ?, ?, 'history')
  `).run(historyObject.storageKey, historyObject.sha256, historyObject.bytes)
  database.prepare(`
    INSERT INTO document_versions
      (id, document_id, version, storage_key, content_sha256, content_bytes, note)
    VALUES (102, 7, 2, ?, ?, ?, 'current')
  `).run(currentObject.storageKey, currentObject.sha256, currentObject.bytes)
  database.prepare(`
    INSERT INTO documents
      (id, title, original_name, version, storage_key, content_sha256, content_bytes)
    VALUES (8, 'Shared note', 'shared.txt', 1, ?, ?, ?)
  `).run(historyObject.storageKey, historyObject.sha256, historyObject.bytes)
  database.prepare(`
    INSERT INTO document_versions
      (id, document_id, version, storage_key, content_sha256, content_bytes, note)
    VALUES (103, 8, 1, ?, ?, ?, 'shared')
  `).run(historyObject.storageKey, historyObject.sha256, historyObject.bytes)

  return { database, runtime, historyObject, currentObject }
}

function close(value, directory) {
  value?.database?.close()
  cleanup(directory)
}

test('rejects deleting the current version and does not create a trash marker', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = await setup(directory)
    await assert.rejects(restoreDocumentVersionFromTrash({
      database: value.database,
      runtime: value.runtime,
      id: 7,
      versionId: 101
    }), { code: 'DOCUMENT_VERSION_NOT_TRASHED' })
    assert.throws(() => softDeleteDocumentVersion({ database: value.database, id: 7, versionId: 102 }), {
      code: 'DOCUMENT_VERSION_IS_CURRENT'
    })
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM resource_trash_entries').get().count, 0)
  } finally {
    close(value, directory)
  }
})

test('soft deletes history, hides it from ordinary access, and keeps shared storage objects in place', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = await setup(directory)
    const deleted = softDeleteDocumentVersion({
      database: value.database,
      id: 7,
      versionId: 101,
      now: () => new Date('2026-08-19T00:00:00.000Z')
    })

    assert.deepEqual(deleted, {
      documentId: 7,
      versionId: 101,
      version: 1,
      deletedAt: '2026-08-19T00:00:00.000Z',
      purgeAfter: '2026-09-18T00:00:00.000Z'
    })
    assert.deepEqual(listDocumentVersions(value.database, 7).map(({ version }) => version), [2])
    assert.deepEqual(listDeletedDocumentVersions(value.database, 7).map(({ id, version }) => ({ id, version })), [
      { id: 101, version: 1 }
    ])
    assert.equal((await value.runtime.storageService.stat(value.historyObject.storageKey)).bytes, 7)
    assert.deepEqual(fs.readdirSync(value.runtime.storageService.trashPath), [])

    await assert.rejects(restoreDocumentVersion({
      database: value.database,
      runtime: value.runtime,
      id: 7,
      versionId: 101
    }), { code: 'DOCUMENT_VERSION_TRASHED' })
    assert.throws(() => assertDocumentVersionNotTrashed(value.database, 101), {
      code: 'DOCUMENT_VERSION_TRASHED'
    })
  } finally {
    close(value, directory)
  }
})

test('restores a trashed history version as a new integer current version and removes only its marker', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = await setup(directory)
    softDeleteDocumentVersion({ database: value.database, id: 7, versionId: 101 })

    const restored = await restoreDocumentVersionFromTrash({
      database: value.database,
      runtime: value.runtime,
      id: 7,
      versionId: 101
    })

    assert.equal(restored.documentId, 7)
    assert.equal(restored.version, 3)
    assert.equal(Number.isInteger(restored.version), true)
    assert.deepEqual(value.database.prepare(`
      SELECT version, storage_key, content_sha256, content_bytes
      FROM documents WHERE id = 7
    `).get(), {
      version: 3,
      storage_key: value.historyObject.storageKey,
      content_sha256: value.historyObject.sha256,
      content_bytes: value.historyObject.bytes
    })
    assert.ok(value.database.prepare('SELECT 1 FROM document_versions WHERE id = 101').get())
    assert.equal(value.database.prepare(`
      SELECT COUNT(*) AS count FROM resource_trash_entries
      WHERE resource_type = 'document_version' AND resource_id = 101
    `).get().count, 0)
    assert.equal(listDeletedDocumentVersions(value.database, 7).length, 0)
    assert.deepEqual(listDocumentVersions(value.database, 7).map(({ version }) => version), [3, 2, 1])
    assert.equal((await value.runtime.storageService.stat(value.historyObject.storageKey)).bytes, 7)
    assert.deepEqual(fs.readdirSync(value.runtime.storageService.trashPath), [])
  } finally {
    close(value, directory)
  }
})

test('database failure rolls back the new current version and keeps the history trash marker', nativeOptions, async () => {
  const directory = root()
  let value
  try {
    value = await setup(directory)
    softDeleteDocumentVersion({ database: value.database, id: 7, versionId: 101 })
    const beforeDocument = value.database.prepare(`
      SELECT version, storage_key, content_sha256, content_bytes FROM documents WHERE id = 7
    `).get()
    const beforeVersionCount = value.database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count
    value.database.exec(`
      CREATE TRIGGER reject_document_version_trash_restore
      BEFORE DELETE ON resource_trash_entries
      WHEN OLD.resource_type = 'document_version'
      BEGIN
        SELECT RAISE(ABORT, 'injected history marker delete failure');
      END;
    `)

    await assert.rejects(restoreDocumentVersionFromTrash({
      database: value.database,
      runtime: value.runtime,
      id: 7,
      versionId: 101
    }), (error) => {
      assert.equal(error?.code, 'STORAGE_COMMIT_DATABASE_FAILED')
      assert.match(String(error?.cause?.message ?? error?.message), /injected history marker delete failure/u)
      return true
    })
    assert.deepEqual(value.database.prepare(`
      SELECT version, storage_key, content_sha256, content_bytes FROM documents WHERE id = 7
    `).get(), beforeDocument)
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count, beforeVersionCount)
    assert.ok(value.database.prepare(`
      SELECT 1 FROM resource_trash_entries
      WHERE resource_type = 'document_version' AND resource_id = 101
    `).get())
    assert.equal((await value.runtime.storageService.stat(value.historyObject.storageKey)).bytes, 7)
  } finally {
    close(value, directory)
  }
})
