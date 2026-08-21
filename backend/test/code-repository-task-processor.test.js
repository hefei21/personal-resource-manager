import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { enqueueExclusiveRun } from '../src/services/taskStore.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'code-repository-task-test-data')

let NativeDatabase = null
try {
  const databaseModule = await import('better-sqlite3')
  const probe = new databaseModule.default(':memory:')
  probe.close()
  NativeDatabase = databaseModule.default
} catch {
  // better-sqlite3 is built in the Linux CI acceptance environment.
}

let processorModule = null
try {
  processorModule = await import('../src/services/codeRepositoryTaskProcessor.js')
} catch (error) {
  // The primary task adds taskProcessorError.js in the same integration step.
  if (!String(error?.message).includes('taskProcessorError.js')) throw error
}

const PROCESSOR_TEST_OPTIONS = processorModule ? {} : {
  skip: 'TaskProcessorError is not present in the current checkout'
}
const DATABASE_TEST_OPTIONS = NativeDatabase ? {} : {
  skip: 'better-sqlite3 native bindings are unavailable in the local checkout'
}

const TASK_TYPES = [
  'code.repository.clone',
  'code.repository.sync',
  'code.repository.reclone'
]

function createDatabase() {
  const database = new NativeDatabase(':memory:')
  database.exec(CREATE_TASK_SCHEMA_SQL)
  database.exec(`
    CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'git',
      last_sync TEXT,
      languages TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
  return database
}

function createFixture() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-repository-task-'))
  const repositoriesRoot = path.join(storageRoot, 'repositories')
  const repositoryPath = path.join(repositoriesRoot, 'sample-repository')
  fs.mkdirSync(repositoriesRoot, { recursive: true })
  return { storageRoot, repositoryPath }
}

function insertRepository(database, repositoryPath, id = 1) {
  database.prepare(`
    INSERT INTO code_repositories (id, name, url, description, local_path, type, last_sync)
    VALUES (?, ?, ?, ?, ?, 'git', ?)
  `).run(
    id,
    'sample',
    'https://github.com/acme/sample.git',
    null,
    repositoryPath,
    '2026-08-20 00:00:00'
  )
}

function createFakeGitRunner() {
  const calls = []
  const runGit = async (args, options = {}) => {
    calls.push({ args: [...args], options })
    if (options.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      error.code = 'ABORT_ERR'
      throw error
    }
    const pathIndex = args.indexOf('-C')
    const repositoryPath = pathIndex === -1 ? null : args[pathIndex + 1]
    if (args.includes('rev-parse')) {
      return {
        stdout: repositoryPath && fs.existsSync(path.join(repositoryPath, '.git'))
          ? 'true\n'
          : 'false\n'
      }
    }
    if (args.includes('status')) {
      return {
        stdout: repositoryPath && fs.existsSync(path.join(repositoryPath, 'working.txt'))
          ? ' M working.txt\0'
          : ''
      }
    }
    return { stdout: '' }
  }
  return { calls, runGit }
}

function createFakeSpawn({ hold = false, calls, failureStderr = null }) {
  return (command, args, options) => {
    const process = new EventEmitter()
    process.stderr = new EventEmitter()
    process.killed = false
    process.kill = () => {
      process.killed = true
    }
    calls.push({ command, args: [...args], options, process })
    options.signal?.addEventListener('abort', () => {
      process.kill()
      const error = new Error('aborted')
      error.name = 'AbortError'
      error.code = 'ABORT_ERR'
      process.emit('error', error)
      process.emit('close', null)
    }, { once: true })
    if (!hold) {
      queueMicrotask(() => {
        const targetPath = args.at(-1)
        fs.mkdirSync(path.join(targetPath, '.git'), { recursive: true })
        if (failureStderr) process.stderr.emit('data', failureStderr)
        process.emit('close', failureStderr ? 128 : 0)
      })
    }
    return process
  }
}

function createProcessor(database, storageRoot, runGit, spawnProcess) {
  return processorModule.createCodeRepositoryTaskProcessor({
    database,
    codeBasePath: storageRoot,
    runGit,
    spawnProcess,
    fetchLanguages: async () => {}
  })
}

function task(taskType, id = 1, repositoryId = 1) {
  return {
    id,
    taskType,
    input: { repoId: String(repositoryId) }
  }
}

test('repository operations enqueue persistent tasks with one atomic mutex domain', DATABASE_TEST_OPTIONS, () => {
  const database = createDatabase()
  try {
    const first = enqueueExclusiveRun(database, {
      taskType: TASK_TYPES[0],
      processorVersion: 'v1',
      subjectType: 'code-repository',
      subjectId: '1',
      subjectVersionId: 'create-1',
      executionClass: 'network',
      input: { repoId: '1' }
    }, { taskTypes: TASK_TYPES })
    const conflict = enqueueExclusiveRun(database, {
      taskType: TASK_TYPES[1],
      processorVersion: 'v1',
      subjectType: 'code-repository',
      subjectId: '1',
      subjectVersionId: 'sync-1',
      executionClass: 'network',
      input: { repoId: '1' }
    }, { taskTypes: TASK_TYPES })

    assert.equal(first.created, true)
    assert.equal(conflict.activeConflict, true)
    assert.equal(conflict.task.id, first.task.id)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
    assert.equal(first.task.input.url, undefined)
    assert.equal(first.task.input.local_path, undefined)
  } finally {
    database.close()
  }
})

test('sync rejects dirty workspaces without reset, clean, or stash', { ...DATABASE_TEST_OPTIONS, ...PROCESSOR_TEST_OPTIONS }, async () => {
  const database = createDatabase()
  const fixture = createFixture()
  try {
    fs.mkdirSync(path.join(fixture.repositoryPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(fixture.repositoryPath, 'working.txt'), 'local change')
    insertRepository(database, fixture.repositoryPath)
    const fakeGit = createFakeGitRunner()
    const processor = createProcessor(database, fixture.storageRoot, fakeGit.runGit, createFakeSpawn({ calls: [] }))

    await assert.rejects(
      () => processor({ task: task(TASK_TYPES[1]), signal: new AbortController().signal }),
      (error) => error.code === 'REPOSITORY_DIRTY' && error.retryable === false
    )
    assert.equal(fakeGit.calls.some(({ args }) => args.some((arg) => ['reset', 'clean', 'stash'].includes(arg))), false)
  } finally {
    database.close()
    fs.rmSync(fixture.storageRoot, { recursive: true, force: true })
  }
})

test('Git porcelain summary counts categories without retaining file names', PROCESSOR_TEST_OPTIONS, () => {
  const summary = processorModule.summarizeGitPorcelain([
    ' M secret-name.txt',
    'D  deleted/private.txt',
    '?? token.txt',
    ' T link.txt',
    'R  renamed.txt',
    'old-name.txt'
  ].join('\0') + '\0')
  assert.deepEqual(summary, {
    modified: 1,
    deleted: 1,
    untracked: 1,
    typeChanged: 1,
    other: 1,
    total: 5
  })
  assert.doesNotMatch(JSON.stringify(summary), /secret|private|token|renamed|old-name/u)
})

test('clone maps Clash DNS failure and removes only its safe partial target', { ...DATABASE_TEST_OPTIONS, ...PROCESSOR_TEST_OPTIONS }, async () => {
  const database = createDatabase()
  const fixture = createFixture()
  try {
    insertRepository(database, fixture.repositoryPath)
    const fakeGit = createFakeGitRunner()
    const spawnCalls = []
    const processor = createProcessor(
      database,
      fixture.storageRoot,
      fakeGit.runGit,
      createFakeSpawn({
        calls: spawnCalls,
        failureStderr: "fatal: unable to access 'https://user:secret@github.com/acme/sample.git/': Could not resolve proxy: clash"
      })
    )
    await assert.rejects(
      () => processor({ task: task(TASK_TYPES[0], 22), signal: new AbortController().signal }),
      (error) => {
        assert.equal(error.code, 'PROXY_DNS_FAILED')
        assert.equal(error.causeCategory, 'PROXY_DNS')
        assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /user|secret|github\.com/iu)
        return true
      }
    )
    assert.equal(fs.existsSync(fixture.repositoryPath), false)
  } finally {
    database.close()
    fs.rmSync(fixture.storageRoot, { recursive: true, force: true })
  }
})

test('clone passes AbortSignal to git and aborts the child process', { ...DATABASE_TEST_OPTIONS, ...PROCESSOR_TEST_OPTIONS }, async () => {
  const database = createDatabase()
  const fixture = createFixture()
  try {
    insertRepository(database, fixture.repositoryPath)
    const fakeGit = createFakeGitRunner()
    const spawnCalls = []
    const processor = createProcessor(
      database,
      fixture.storageRoot,
      fakeGit.runGit,
      createFakeSpawn({ hold: true, calls: spawnCalls })
    )
    const controller = new AbortController()
    const pending = processor({ task: task(TASK_TYPES[0], 11), signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await assert.rejects(pending, (error) => error.code === 'TASK_CANCELLED')
    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].options.signal, controller.signal)
    assert.equal(spawnCalls[0].process.killed, true)
  } finally {
    database.close()
    fs.rmSync(fixture.storageRoot, { recursive: true, force: true })
  }
})

test('reclone switches to a clean clone, preserves one stable backup, and is retry-safe', { ...DATABASE_TEST_OPTIONS, ...PROCESSOR_TEST_OPTIONS }, async () => {
  const database = createDatabase()
  const fixture = createFixture()
  try {
    fs.mkdirSync(path.join(fixture.repositoryPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(fixture.repositoryPath, 'working.txt'), 'local change')
    insertRepository(database, fixture.repositoryPath)
    const fakeGit = createFakeGitRunner()
    const spawnCalls = []
    const processor = createProcessor(
      database,
      fixture.storageRoot,
      fakeGit.runGit,
      createFakeSpawn({ calls: spawnCalls })
    )

    const first = await processor({ task: task(TASK_TYPES[2], 42), signal: new AbortController().signal })
    const backupPath = path.join(
      path.dirname(fixture.repositoryPath),
      `${path.basename(fixture.repositoryPath)}.local-backup-42`
    )
    assert.equal(first.backupRepositoryId > 1, true)
    assert.equal(fs.existsSync(fixture.repositoryPath), true)
    assert.equal(fs.existsSync(backupPath), true)
    assert.equal(fs.existsSync(path.join(backupPath, 'working.txt')), true)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_repositories').get().count, 2)

    const second = await processor({ task: task(TASK_TYPES[2], 42), signal: new AbortController().signal })
    assert.equal(second.backupRepositoryId, first.backupRepositoryId)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_repositories').get().count, 2)
    assert.equal(spawnCalls.length, 1)
  } finally {
    database.close()
    fs.rmSync(fixture.storageRoot, { recursive: true, force: true })
  }
})
