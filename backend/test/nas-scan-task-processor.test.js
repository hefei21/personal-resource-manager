import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import { normalizeNasScanRules } from '../src/config/nasScan.js'
import { RESOURCE_MODEL_MIGRATIONS } from '../src/config/resourceModelSchema.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'nas-scan-task-processor-test-data')

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

const databaseOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run SQLite cases' }

const { createNasScanTaskProcessor, NAS_SCAN_TASK_ERROR_CODES } =
  await import('../src/services/nasScanTaskProcessor.js')

function createDatabase() {
  const database = new Database(':memory:')
  for (const migration of RESOURCE_MODEL_MIGRATIONS) database.exec(migration.source)
  return database
}

function createRoot(database, rootPath, overrides = {}) {
  const rules = normalizeNasScanRules(overrides.rules ?? {})
  database.prepare(`
    INSERT INTO nas_scan_roots
      (name, root_path, enabled, rules_json, rules_version, last_successful_generation)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'Fixture',
    rootPath,
    overrides.enabled === false ? 0 : 1,
    JSON.stringify(rules),
    overrides.rulesVersion ?? 1,
    overrides.generation ?? 0
  )
}

function task(taskType, input = {}) {
  return {
    id: 1,
    taskType,
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType: 'nas-scan-root',
    subjectId: '1',
    input
  }
}

test('NAS scan task processor commits safe numeric result and advances generation', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-processor-'))
  try {
    fs.writeFileSync(path.join(rootPath, 'readme.md'), '# fixture\n')
    createRoot(database, rootPath)
    const progress = []
    const processor = createNasScanTaskProcessor({ database })
    const result = await processor({
      task: task('nas.resource.scan', { scanRootId: 1, rulesVersion: 1, generation: 1 }),
      signal: new AbortController().signal,
      progress: async (value) => progress.push(value)
    })

    assert.equal(result.generation, 1)
    assert.equal(result.rulesVersion, 1)
    assert.equal(result.files, 1)
    assert.equal(result.counts.added, 1)
    assert.ok(progress.length >= 1)
    assert.ok(progress.every((value) => value >= 1 && value <= 95))
    assert.doesNotMatch(JSON.stringify(result), /readme|nas-scan-processor|sha256|hash|relative|path/u)
    assert.equal(database.prepare('SELECT last_successful_generation FROM nas_scan_roots WHERE id = 1').get().last_successful_generation, 1)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('processor does not perform a fallible progress write after the scan commit', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-post-commit-'))
  try {
    createRoot(database, rootPath)
    let progressCalls = 0
    const processor = createNasScanTaskProcessor({
      database,
      scan: async ({ database: connection }) => {
        connection.prepare(`
          UPDATE nas_scan_roots
          SET last_successful_generation = 1
          WHERE id = 1
        `).run()
        return { visitedEntries: 0, files: 0, excluded: 0, counts: {} }
      }
    })
    const result = await processor({
      task: task('nas.resource.scan', { scanRootId: 1, rulesVersion: 1, generation: 1 }),
      progress: async () => {
        progressCalls += 1
        if (progressCalls > 1) throw new Error('post-commit progress failed')
      }
    })
    assert.equal(result.generation, 1)
    assert.equal(progressCalls, 1)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('scan and repair task types share validation and root mutex contract', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-repair-'))
  try {
    createRoot(database, rootPath)
    let called = 0
    const processor = createNasScanTaskProcessor({
      database,
      scan: async () => {
        called += 1
        return { visitedEntries: 0, files: 0, excluded: 0, counts: {} }
      }
    })
    const result = await processor({
      task: task('nas.resource.repair', { scanRootId: 1, rulesVersion: 1, generation: 1 }),
      signal: new AbortController().signal
    })
    assert.equal(called, 1)
    assert.equal(result.generation, 1)
    assert.equal(result.counts.added, 0)
    assert.equal(database.prepare('SELECT last_successful_generation FROM nas_scan_roots WHERE id = 1').get().last_successful_generation, 0)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('processor rejects disabled and stale roots without advancing generation', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-validation-'))
  try {
    createRoot(database, rootPath, { enabled: false })
    const processor = createNasScanTaskProcessor({ database })
    await assert.rejects(
      () => processor({ task: task('nas.resource.scan', { scanRootId: 1, rulesVersion: 1, generation: 1 }) }),
      (error) => error.code === NAS_SCAN_TASK_ERROR_CODES.ROOT_DISABLED && error.retryable === false
    )
    database.prepare('UPDATE nas_scan_roots SET enabled = 1').run()
    await assert.rejects(
      () => processor({ task: task('nas.resource.scan', { scanRootId: 1, rulesVersion: 2, generation: 1 }) }),
      (error) => error.code === NAS_SCAN_TASK_ERROR_CODES.CONFIG_CONFLICT && error.retryable === false
    )
    assert.equal(database.prepare('SELECT last_successful_generation FROM nas_scan_roots WHERE id = 1').get().last_successful_generation, 0)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('processor rejects task payloads that contain paths or hashes', databaseOptions, async () => {
  const database = createDatabase()
  try {
    const processor = createNasScanTaskProcessor({ database })
    await assert.rejects(
      () => processor({
        task: task('nas.resource.scan', {
          scanRootId: 1,
          rulesVersion: 1,
          generation: 1,
          root_path: 'C:\\private',
          hash: 'secret'
        })
      }),
      (error) => error.code === NAS_SCAN_TASK_ERROR_CODES.INPUT_INVALID && error.retryable === false
    )
  } finally {
    database.close()
  }
})
