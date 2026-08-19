import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  documentUploadConflict,
  findDocumentUploadConflicts,
  normalizeDocumentConflictResolution,
  selectDocumentConflictTarget
} from '../src/services/documentConflictService.js'

const require = createRequire(import.meta.url)
function bindingMissing(error) { return /^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? '')) }
let Database
let nativeAvailable = true
try { Database = require('better-sqlite3'); const probe = new Database(':memory:'); probe.close() } catch (error) {
  if (!bindingMissing(error)) throw error
  nativeAvailable = false
}
const nativeOptions = process.env.CI || nativeAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function setup() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT, subcategory TEXT,
      category_id INTEGER, version REAL, updated_at TEXT, content_bytes INTEGER,
      content_sha256 TEXT, original_name TEXT, storage_key TEXT, file_path TEXT
    );
    INSERT INTO categories (id, name, path) VALUES
      (1, 'Notes', 'Notes'), (2, 'Archive', 'Archive');
    INSERT INTO documents
      (id, title, category, category_id, version, updated_at, content_bytes, content_sha256, storage_key, file_path)
    VALUES
      (7, 'Report', 'Notes', 1, 3, '2026-08-19 01:02:03', 12, '${'a'.repeat(64)}', 'documents/aa/${'a'.repeat(64)}', '/synthetic/secret.txt'),
      (8, 'Report', 'Archive', 2, 1, '2026-08-18 01:02:03', 8, '${'b'.repeat(64)}', 'documents/bb/${'b'.repeat(64)}', '/synthetic/other.txt'),
      (9, 'Report (1)', 'Notes', 1, 1, '2026-08-17 01:02:03', 4, '${'c'.repeat(64)}', 'documents/cc/${'c'.repeat(64)}', '/synthetic/suffix.txt');
  `)
  return database
}

test('returns safe same-category candidates and a collision-free suggested title', nativeOptions, () => {
  const database = setup()
  try {
    const candidates = findDocumentUploadConflicts(database, {
      title: ' Report ',
      category: { id: 1, path: 'Notes' },
      contentSha256: 'A'.repeat(64)
    })
    assert.equal(candidates.length, 1)
    assert.deepEqual(candidates[0], {
      id: 7,
      title: 'Report',
      categoryId: 1,
      categoryPath: 'Notes',
      currentVersion: 3,
      updatedAt: '2026-08-19 01:02:03',
      contentBytes: 12,
      hashMatches: true
    })
    assert.equal('storageKey' in candidates[0], false)
    assert.equal('filePath' in candidates[0], false)

    const conflict = documentUploadConflict({
      database,
      title: 'Report',
      category: { id: 1, path: 'Notes' },
      contentSha256: 'd'.repeat(64)
    })
    assert.equal(conflict.code, 'DOCUMENT_UPLOAD_CONFLICT')
    assert.equal(conflict.details.suggestedTitle, 'Report (2)')
    assert.deepEqual(conflict.details.candidates.map(({ id }) => id), [7])

    assert.deepEqual(
      findDocumentUploadConflicts(database, { title: 'Report', category: { id: 2, path: 'Archive' } })
        .map(({ id }) => id),
      [8]
    )
  } finally {
    database.close()
  }
})

test('accepts only explicit create/new_version resolutions and only current candidates as targets', nativeOptions, () => {
  const database = setup()
  try {
    assert.equal(normalizeDocumentConflictResolution(undefined), null)
    assert.equal(normalizeDocumentConflictResolution('create'), 'create')
    assert.equal(normalizeDocumentConflictResolution('new_version'), 'new_version')
    assert.throws(() => normalizeDocumentConflictResolution('cancel'), { code: 'DOCUMENT_CONFLICT_RESOLUTION_INVALID' })

    const candidates = findDocumentUploadConflicts(database, {
      title: 'Report',
      category: { id: 1, path: 'Notes' }
    })
    assert.equal(selectDocumentConflictTarget(candidates, '7').id, 7)
    assert.throws(() => selectDocumentConflictTarget(candidates, 8), { code: 'DOCUMENT_CONFLICT_TARGET_INVALID' })
    assert.throws(() => selectDocumentConflictTarget(candidates, undefined), { code: 'DOCUMENT_CONFLICT_TARGET_INVALID' })
  } finally {
    database.close()
  }
})

test('legacy rows with no category id do not create cross-category conflicts', nativeOptions, () => {
  const database = setup()
  try {
    database.prepare(`
      INSERT INTO documents
        (id, title, category, subcategory, category_id, version, updated_at, content_bytes, content_sha256)
      VALUES (?, 'Legacy report', ?, NULL, NULL, 1, CURRENT_TIMESTAMP, 1, ?)
    `).run(10, 'Notes', 'd'.repeat(64))
    database.prepare(`
      INSERT INTO documents
        (id, title, category, subcategory, category_id, version, updated_at, content_bytes, content_sha256)
      VALUES (?, 'Legacy report', ?, NULL, NULL, 1, CURRENT_TIMESTAMP, 1, ?)
    `).run(11, 'Archive', 'e'.repeat(64))

    assert.deepEqual(
      findDocumentUploadConflicts(database, {
        title: 'Legacy report',
        category: { id: 1, path: 'Notes' }
      }).map(({ id }) => id),
      [10]
    )
    assert.deepEqual(
      findDocumentUploadConflicts(database, {
        title: 'Legacy report',
        category: { id: 2, path: 'Archive' }
      }).map(({ id }) => id),
      [11]
    )
    assert.deepEqual(
      findDocumentUploadConflicts(database, { title: 'Legacy report', category: null }),
      []
    )
  } finally {
    database.close()
  }
})

test('route source exposes the frozen upload and version contracts', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(directory, '..', 'src', 'routes', 'documents.js'), 'utf8')
  const versionService = fs.readFileSync(
    path.join(directory, '..', 'src', 'services', 'documentVersionService.js'),
    'utf8'
  )
  const upload = source.slice(source.indexOf("router.post('/upload'"), source.indexOf("router.get('/:id/content'"))
  assert.match(source, /DOCUMENT_UPLOAD_CONFLICT/u)
  assert.match(upload, /resolution === 'new_version'/u)
  assert.match(upload, /targetDocumentId/u)
  assert.doesNotMatch(upload, /finalTitle|suffix\s*=|自动添加后缀/u)
  assert.match(source, /listDocumentVersions\(getDatabase\(\), req\.params\.id\)/u)
  assert.match(versionService, /isCurrent:/u)
  assert.match(source, /DOCUMENT_VERSION_MANAGED/u)
  assert.match(source, /DOCUMENT_VERSION_IS_CURRENT/u)
})
