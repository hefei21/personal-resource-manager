import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import { DOCUMENTS_STORAGE_TARGET_DDL, DOCUMENT_VERSIONS_STORAGE_TARGET_DDL } from '../src/config/documentStorageSchema.js'
import { BOOKS_STORAGE_TARGET_DDL } from '../src/config/ebookStorageSchema.js'
import { MUSIC_STORAGE_TARGET_DDL } from '../src/config/musicStorageSchema.js'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { RESOURCE_MODEL_MIGRATIONS } from '../src/config/resourceModelSchema.js'
import { createDocumentStorageRuntime } from '../src/services/documentStorageRuntime.js'
import { createResourceStorageRuntime } from '../src/services/resourceStorageRuntime.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'resource-domain-adapter-test-data')

const {
  createResourceDomainAdapter,
  reconcileMissingDomainRecords,
  RESOURCE_DOMAIN_IMPORT_ERROR_CODES
} = await import('../src/services/resourceDomainAdapter.js')

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
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function tempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function openDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, path TEXT, level INTEGER);
    CREATE TABLE book_categories (id INTEGER PRIMARY KEY, name TEXT);
    ${DOCUMENTS_STORAGE_TARGET_DDL};
    ${DOCUMENT_VERSIONS_STORAGE_TARGET_DDL};
    ${BOOKS_STORAGE_TARGET_DDL};
    ${MUSIC_STORAGE_TARGET_DDL};
    ${CREATE_RESOURCE_TRASH_SQL};
  `)
  for (const migration of RESOURCE_MODEL_MIGRATIONS) database.exec(migration.source)
  return database
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

test('projects document, ebook, and music authority rows without merging identity and remains idempotent', nativeTestOptions, async () => {
  const root = tempDirectory('resource-domain-adapter-')
  const documentRoot = path.join(root, 'documents')
  const ebookRoot = path.join(root, 'ebooks')
  const musicRoot = path.join(root, 'music')
  fs.mkdirSync(documentRoot)
  fs.mkdirSync(ebookRoot)
  fs.mkdirSync(musicRoot)
  const documentPath = path.join(documentRoot, 'readme.md')
  const ebookPath = path.join(ebookRoot, 'book.epub')
  const musicPath = path.join(musicRoot, 'song.mp3')
  fs.writeFileSync(documentPath, '# document')
  fs.writeFileSync(ebookPath, 'epub bytes')
  fs.writeFileSync(musicPath, 'music bytes')

  const database = openDatabase()
  try {
    database.prepare(`
      INSERT INTO documents (id, title, file_path, original_name, version)
      VALUES (1, '文档', ?, 'readme.md', 1.0)
    `).run(documentPath)
    database.prepare(`
      INSERT INTO document_versions (document_id, version, file_path)
      VALUES (1, 1, ?)
    `).run(documentPath)
    database.prepare(`
      INSERT INTO documents (id, title, file_path, original_name, version)
      VALUES (2, '缺失文档', ?, 'missing.md', 1.0)
    `).run(path.join(documentRoot, 'missing.md'))
    database.prepare(`
      INSERT INTO books (id, title, file_path, original_name, file_type, file_size)
      VALUES (1, '书', ?, 'book.epub', 'epub', 10)
    `).run(ebookPath)
    database.prepare(`
      INSERT INTO music (id, title, file_path, original_name, file_size)
      VALUES (1, '歌', ?, 'song.mp3', 11)
    `).run(musicPath)
    database.prepare(`
      INSERT INTO resource_trash_entries
        (resource_type, resource_id, deleted_at, metadata_json)
      VALUES ('ebook', 1, '2026-08-22T00:00:00.000Z', '{}')
    `).run()

    const documentRuntime = createDocumentStorageRuntime({
      storageRoot: path.join(root, 'document-storage'),
      legacyRoots: [documentRoot]
    })
    const resourceRuntime = createResourceStorageRuntime({
      storageRoot: path.join(root, 'resource-storage'),
      ebooksLegacyRoot: ebookRoot,
      musicLegacyRoot: musicRoot
    })
    const progress = []
    const adapter = createResourceDomainAdapter({
      database,
      documentContentService: documentRuntime.contentService,
      resourceRuntime
    })

    const first = await adapter.adapt({ scope: 'all', batchSize: 10 }, {
      onProgress: (event) => progress.push(event)
    })
    assert.equal(first.processed, 4)
    assert.equal(first.resourcesCreated, 4)
    assert.equal(first.sourcesCreated, 4)
    assert.equal(first.versionsCreated, 3, `unexpected domain import counts: ${JSON.stringify(first)}`)
    assert.equal(first.contentObjectsCreated, 3)
    assert.ok(first.missingContent >= 2)
    assert.ok(first.errors >= 2)
    assert.ok(progress.length >= 2)

    const resources = database.prepare(`
      SELECT r.id, r.resource_type, r.title, r.lifecycle_status, l.domain_type, l.domain_id
        FROM resources r JOIN resource_domain_links l ON l.resource_id = r.id
       ORDER BY l.domain_type, l.domain_id
    `).all()
    assert.deepEqual(resources.map(({ resource_type, title, lifecycle_status, domain_type, domain_id }) => ({
      resource_type, title, lifecycle_status, domain_type, domain_id
    })), [
      { resource_type: 'document', title: '文档', lifecycle_status: 'active', domain_type: 'document', domain_id: 1 },
      { resource_type: 'document', title: '缺失文档', lifecycle_status: 'active', domain_type: 'document', domain_id: 2 },
      { resource_type: 'ebook', title: '书', lifecycle_status: 'trashed', domain_type: 'ebook', domain_id: 1 },
      { resource_type: 'audio', title: '歌', lifecycle_status: 'active', domain_type: 'music', domain_id: 1 }
    ])
    const sources = database.prepare(`
      SELECT source_kind, external_id, state FROM resource_sources ORDER BY id
    `).all()
    assert.equal(sources.every((source) => source.source_kind === 'domain_record'), true)
    assert.equal(sources.some((source) => source.state === 'missing'), true)
    assert.equal(sources.every((source) => !source.external_id.includes('/') && !source.external_id.includes('readme.md')), true)
    assert.doesNotMatch(JSON.stringify(first), /readme\.md|missing\.md|book\.epub|song\.mp3|document bytes/u)

    const second = await adapter.adapt({ scope: 'all', batchSize: 10 })
    assert.equal(second.processed, 4)
    assert.equal(second.resourcesCreated, 0)
    assert.equal(second.resourcesReused, 4)
    assert.equal(second.sourcesCreated, 0)
    assert.equal(second.versionsCreated, 0)
    assert.equal(second.versionsReused, 3)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 4)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resource_sources').get().count, 4)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resource_versions').get().count, 3)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_objects').get().count, 3)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resource_versions WHERE is_current = 1').get().count, 3)
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
        FROM resource_versions v
        JOIN resource_domain_links l ON l.resource_id = v.resource_id
       WHERE l.domain_type = 'document' AND l.domain_id = 1 AND v.is_current = 1
    `).get().count, 1)

    database.prepare('DELETE FROM music WHERE id = 1').run()
    assert.deepEqual(reconcileMissingDomainRecords(database, 'music'), { missingRecords: 1 })
    const removedMusic = database.prepare(`
      SELECT r.lifecycle_status, s.state
        FROM resource_domain_links l
        JOIN resources r ON r.id = l.resource_id
        JOIN resource_sources s ON s.resource_id = r.id AND s.source_kind = 'domain_record'
       WHERE l.domain_type = 'music' AND l.domain_id = 1
    `).get()
    assert.deepEqual(removedMusic, { lifecycle_status: 'trashed', state: 'missing' })
  } finally {
    database.close()
    cleanup(root)
  }
})

test('rejects unsafe import input and keeps cancellation before projection', nativeTestOptions, async () => {
  const root = tempDirectory('resource-domain-adapter-input-')
  const database = openDatabase()
  try {
    const adapter = createResourceDomainAdapter({ database })
    await assert.rejects(adapter.adapt({ scope: 'documents', rootPath: '/not-allowed' }), {
      code: RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID
    })
    await assert.rejects(adapter.adapt({ scope: 'documents' }, { signal: AbortSignal.abort() }), {
      code: RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED
    })
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 0)
  } finally {
    database.close()
    cleanup(root)
  }
})
