import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONTENT_OBJECT_TABLE,
  NAS_SCAN_ENTRY_TABLE,
  NAS_SCAN_ROOT_TABLE,
  RESOURCE_CONFLICT_CANDIDATE_TABLE,
  RESOURCE_SOURCE_TABLE,
  RESOURCE_TABLE,
  RESOURCE_VERSION_TABLE,
  RESOURCE_MODEL_MIGRATIONS
} from '../src/config/resourceModelSchema.js'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  classifyNasResourceType,
  collectNasResourceObservations,
  hashNasFile,
  NAS_RESOURCE_ERROR_CODES,
  NAS_RESOURCE_EXCLUSION_CODES,
  scanNasResourceRoot
} from '../src/services/nasResourceScanner.js'
import { commitNasResourceScan } from '../src/services/nasResourceCommitService.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Cannot find module|Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run SQLite cases' }

const resourceRegistry = createMigrationRegistry(
  applicationMigrationRegistry.migrations.filter(({ id }) => id >= '0063_')
)

function makeRoot(prefix = 'pr-nas-resource-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function collect(root, rules = { useGitignore: false }) {
  return collectNasResourceObservations({ rootPath: root, rules })
}

function openDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry: resourceRegistry,
    plan: createMigrationPlan(resourceRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-21T00:00:00.000Z'
  })
  return database
}

function createScanRoot(database, rootPath, name = '测试根') {
  return Number(database.prepare(`
    INSERT INTO ${NAS_SCAN_ROOT_TABLE} (name, root_path, rules_json)
    VALUES (?, ?, ?)
  `).run(name, rootPath, JSON.stringify({ version: 1, useGitignore: false })).lastInsertRowid)
}

function fileObservation(relativePath, content, fileIdentifier = null) {
  return {
    relativePath,
    kind: 'file',
    status: 'discovered',
    fileIdentifier,
    size: content.length,
    mtimeNs: 1,
    contentSha256: sha256(content),
    title: path.posix.basename(relativePath),
    resourceType: classifyNasResourceType(relativePath)
  }
}

test('classifies NAS resources by stable extension and never needs external metadata', () => {
  assert.equal(classifyNasResourceType('book.epub'), 'ebook')
  assert.equal(classifyNasResourceType('track.FLAC'), 'audio')
  assert.equal(classifyNasResourceType('src/main.ts'), 'code')
  assert.equal(classifyNasResourceType('notes.unknown'), 'document')
})

test('streams ordinary files and keeps returned observations relative and content-safe', async () => {
  const root = makeRoot()
  try {
    fs.mkdirSync(path.join(root, 'docs'))
    fs.writeFileSync(path.join(root, 'docs', 'note.txt'), 'hello')
    const result = await collect(root)
    assert.deepEqual(result.observations.map(({ relativePath }) => relativePath), ['docs/note.txt'])
    assert.equal(result.observations[0].contentSha256, sha256('hello'))
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    removeRoot(root)
  }
})

test('writes excluded file observations without reading or returning credential content', async () => {
  const root = makeRoot()
  try {
    fs.writeFileSync(path.join(root, '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    fs.writeFileSync(path.join(root, 'private.txt'), '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----')
    fs.writeFileSync(path.join(root, 'safe.txt'), 'ordinary')
    const result = await collect(root)
    const byPath = new Map(result.observations.map((entry) => [entry.relativePath, entry]))
    assert.equal(byPath.get('.env').exclusionCode, NAS_RESOURCE_EXCLUSION_CODES.CREDENTIAL)
    assert.equal(byPath.get('private.txt').exclusionCode, NAS_RESOURCE_EXCLUSION_CODES.CREDENTIAL_CONTENT)
    assert.equal(byPath.get('private.txt').contentSha256, null)
    assert.doesNotMatch(JSON.stringify(byPath.get('private.txt')), /PRIVATE KEY|secret/u)
    assert.equal(byPath.get('safe.txt').contentSha256, sha256('ordinary'))
  } finally {
    removeRoot(root)
  }
})

test('returns FILE_CHANGED when bytes change during streaming hash and does not expose the digest', async () => {
  const root = makeRoot()
  try {
    const file = path.join(root, 'large.bin')
    fs.writeFileSync(file, Buffer.alloc(512 * 1024, 'a'))
    let changed = false
    const result = await hashNasFile({
      rootPath: root,
      relativePath: 'large.bin',
      onProgress: ({ phase }) => {
        if (phase === 'hashing' && !changed) {
          changed = true
          fs.appendFileSync(file, 'changed')
        }
      }
    })
    assert.equal(result.status, 'error')
    assert.equal(result.errorCode, NAS_RESOURCE_ERROR_CODES.FILE_CHANGED)
    assert.equal(result.contentSha256, null)
  } finally {
    removeRoot(root)
  }
})

test('cancellation stops streaming with a stable code and no absolute path', async () => {
  const root = makeRoot()
  try {
    const file = path.join(root, 'large.bin')
    fs.writeFileSync(file, Buffer.alloc(512 * 1024, 'a'))
    const controller = new AbortController()
    await assert.rejects(
      hashNasFile({
        rootPath: root,
        relativePath: 'large.bin',
        signal: controller.signal,
        onProgress: ({ phase }) => { if (phase === 'hashing') controller.abort() }
      }),
      (error) => {
        assert.equal(error.code, NAS_RESOURCE_ERROR_CODES.CANCELLED)
        assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
        return true
      }
    )
  } finally {
    removeRoot(root)
  }
})

test('commits add, unchanged, modify and idempotent retry with a generation fence', nativeTestOptions, async () => {
  const root = makeRoot()
  const database = openDatabase()
  try {
    const rootId = createScanRoot(database, root)
    const first = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 1,
      observations: [fileObservation('book.epub', 'one', 'dev:1')]
    })
    assert.equal(first.counts.added, 1)
    assert.equal(database.prepare(`SELECT last_successful_generation FROM ${NAS_SCAN_ROOT_TABLE}`).get().last_successful_generation, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_TABLE}`).get().count, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_VERSION_TABLE}`).get().count, 1)

    fs.writeFileSync(path.join(root, 'book.epub'), 'one')
    const same = await scanNasResourceRoot({
      database,
      scanRootId: rootId
    })
    assert.equal(same.counts.unchanged, 1)
    assert.equal(same.generation, 2)

    const second = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 3,
      observations: [fileObservation('book.epub', 'two', 'dev:1')]
    })
    assert.equal(second.counts.modified, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_VERSION_TABLE}`).get().count, 2)

    const retry = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 3,
      observations: [fileObservation('book.epub', 'two', 'dev:1')]
    })
    assert.equal(retry.idempotent, true)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_VERSION_TABLE}`).get().count, 2)
  } finally {
    database.close()
    removeRoot(root)
  }
})

test('moves a unique file identifier, creates candidates for unreliable identifiers, and marks missing sources', nativeTestOptions, () => {
  const root = makeRoot()
  const database = openDatabase()
  try {
    const rootId = createScanRoot(database, root)
    commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 1,
      observations: [fileObservation('old.txt', 'same', 'dev:9')]
    })
    const moved = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 2,
      observations: [fileObservation('new.txt', 'same', 'dev:9')]
    })
    assert.equal(moved.counts.moved, 1)
    const source = database.prepare(`SELECT resource_id, relative_path, state FROM ${RESOURCE_SOURCE_TABLE}`).get()
    assert.deepEqual(source, { resource_id: 1, relative_path: 'new.txt', state: 'active' })

    const candidate = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 3,
      observations: [
        fileObservation('other.txt', 'same', null),
        fileObservation('folder/new.txt', 'different', null),
        fileObservation('missing.txt', 'gone', 'dev:77')
      ]
    })
    assert.equal(candidate.counts.added, 3)
    assert.ok(candidate.counts.conflicts >= 2)
    const missing = database.prepare(`SELECT relative_path, state FROM ${RESOURCE_SOURCE_TABLE} WHERE relative_path = 'new.txt'`).get()
    assert.equal(missing.state, 'missing')
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_CONFLICT_CANDIDATE_TABLE}`).get().count >= 2, true)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${NAS_SCAN_ENTRY_TABLE}`).get().count, 4)
  } finally {
    database.close()
    removeRoot(root)
  }
})

test('full scan commit is independent of PC worker and Redis availability', nativeTestOptions, async () => {
  const root = makeRoot()
  const database = openDatabase()
  try {
    fs.writeFileSync(path.join(root, 'note.md'), 'offline-safe')
    const rootId = createScanRoot(database, root)
    const result = await scanNasResourceRoot({
      database,
      scanRootId: rootId
    })
    assert.equal(result.generation, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${CONTENT_OBJECT_TABLE}`).get().count, 1)
  } finally {
    database.close()
    removeRoot(root)
  }
})

test('database mode uses the persisted root and freezes generation before filesystem work', nativeTestOptions, async () => {
  const root = makeRoot()
  const untrusted = makeRoot('pr-nas-untrusted-')
  const database = openDatabase()
  try {
    fs.writeFileSync(path.join(root, 'trusted.txt'), 'trusted')
    fs.writeFileSync(path.join(untrusted, 'untrusted.txt'), 'untrusted')
    const rootId = createScanRoot(database, root)
    const first = await scanNasResourceRoot({
      database,
      scanRootId: rootId,
      rootPath: untrusted,
      rules: { useGitignore: true, excludedGlobs: ['trusted.txt'] }
    })
    assert.equal(first.counts.added, 1)
    assert.equal(database.prepare(`SELECT title FROM ${RESOURCE_TABLE}`).get().title, 'trusted.txt')

    const stale = commitNasResourceScan({
      database,
      scanRootId: rootId,
      generation: 1,
      observations: [fileObservation('untrusted.txt', 'untrusted', 'dev:stale')]
    })
    assert.equal(stale.idempotent, true)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RESOURCE_TABLE}`).get().count, 1)
  } finally {
    database.close()
    removeRoot(root)
    removeRoot(untrusted)
  }
})
