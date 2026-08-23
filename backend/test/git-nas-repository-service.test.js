import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeNasScanRules } from '../src/config/nasScan.js'
import { RESOURCE_MODEL_MIGRATIONS } from '../src/config/resourceModelSchema.js'
import { createNasScanRootService } from '../src/services/nasScanRootService.js'

let Database = null
try {
  const module = await import('better-sqlite3')
  const probe = new module.default(':memory:')
  probe.close()
  Database = module.default
} catch {
  // Native SQLite is supplied by the Linux CI acceptance environment.
}

const databaseOptions = Database ? {} : {
  skip: 'better-sqlite3 native bindings are unavailable locally; Linux CI must run SQLite cases'
}

const {
  GIT_NAS_ERROR_CODES,
  createGitNasReadOnlyRunner,
  discoverGitNasRepositories,
  getGitNasRepository,
  inspectReadOnlyGitSnapshot,
  importGitNasCandidate,
  listGitNasCandidates,
  listGitNasTree,
  readGitNasFile
} = await import('../src/services/gitNasRepositoryService.js')

function createDatabase() {
  const database = new Database(':memory:')
  for (const migration of RESOURCE_MODEL_MIGRATIONS) database.exec(migration.source)
  database.exec(`
    CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git_nas',
      last_sync TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    )
  `)
  return database
}

function createRoot(database, rootPath) {
  const rules = normalizeNasScanRules({ useGitignore: false })
  database.prepare(`
    INSERT INTO nas_scan_roots
      (name, root_path, enabled, rules_json, rules_version, last_successful_generation)
    VALUES ('Fixture', ?, 1, ?, 1, 0)
  `).run(rootPath, JSON.stringify(rules))
}

function fakeGitRunner(rootPath) {
  return async (repositoryPath, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true\n' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${repositoryPath}\n` }
    if (args[0] === 'ls-files') return { stdout: '' }
    if (args[0] === 'log') return { stdout: '0123456789abcdef|Owner|2026-08-22 00:00:00|Initial commit\n' }
    if (args[0] === 'show') return { stdout: '' }
    throw new Error(`unexpected fake command ${args.join(' ')}`)
  }
}

test('discovers safe Git roots, stops at repository boundaries, and commits redacted candidates', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-service-'))
  try {
    const repositoryPath = path.join(rootPath, 'sample')
    fs.mkdirSync(path.join(repositoryPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(repositoryPath, 'README.md'), '# sample\n')
    createRoot(database, rootPath)

    const result = await discoverGitNasRepositories({
      database,
      scanRootId: 1,
      rulesVersion: 1,
      generation: 1,
      runGit: fakeGitRunner(rootPath)
    })
    assert.equal(result.candidates, 1)
    assert.equal(result.created, 1)
    assert.deepEqual(listGitNasCandidates(database), [{ candidateId: 1, name: 'sample', state: 'active' }])
    assert.doesNotMatch(JSON.stringify(listGitNasCandidates(database)), new RegExp(rootPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

    const imported = await importGitNasCandidate({
      database,
      candidateId: 1,
      runGit: fakeGitRunner(rootPath)
    })
    assert.deepEqual(imported, { repositoryId: 1, resourceId: 1, status: 'imported' })
    assert.equal(database.prepare('SELECT type, local_path, url FROM code_repositories WHERE id = 1').get().type, 'git_nas')
    assert.equal(database.prepare('SELECT local_path FROM code_repositories WHERE id = 1').get().local_path, '')
    assert.equal(database.prepare('SELECT url FROM code_repositories WHERE id = 1').get().url, 'git-nas:candidate-1')
    assert.deepEqual(await importGitNasCandidate({ database, candidateId: 1, runGit: fakeGitRunner(rootPath) }), {
      repositoryId: 1,
      resourceId: 1,
      status: 'already-imported'
    })

    assert.equal(getGitNasRepository(database, 1).relativePath, 'sample')
    assert.equal(listGitNasTree(database, 1).some((entry) => entry.name === '.git'), false)
    const file = readGitNasFile(database, 1, 'README.md')
    assert.equal(file.buffer.toString(), '# sample\n')
    assert.throws(() => readGitNasFile(database, 1, '.git/config'), (error) => error.code === GIT_NAS_ERROR_CODES.PATH_INVALID)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('scan configuration changes fence Git imports and reads until rediscovery', databaseOptions, async () => {
  const database = createDatabase()
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-config-first-'))
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-config-second-'))
  try {
    for (const [rootPath, contents] of [[firstRoot, '# first\n'], [secondRoot, '# second\n']]) {
      const repositoryPath = path.join(rootPath, 'sample')
      fs.mkdirSync(path.join(repositoryPath, '.git'), { recursive: true })
      fs.writeFileSync(path.join(repositoryPath, 'README.md'), contents)
    }
    createRoot(database, firstRoot)
    await discoverGitNasRepositories({
      database,
      scanRootId: 1,
      rulesVersion: 1,
      generation: 1,
      runGit: fakeGitRunner(firstRoot)
    })
    await importGitNasCandidate({ database, candidateId: 1, runGit: fakeGitRunner(firstRoot) })
    assert.equal(readGitNasFile(database, 1, 'README.md').buffer.toString(), '# first\n')

    const rootService = createNasScanRootService()
    const updated = rootService.update(database, 1, { rootPath: secondRoot })
    assert.equal(updated.rulesVersion, 2)
    assert.deepEqual(listGitNasCandidates(database), [{ candidateId: 1, name: 'sample', state: 'missing' }])
    await assert.rejects(
      () => importGitNasCandidate({ database, candidateId: 1, runGit: fakeGitRunner(secondRoot) }),
      (error) => error.code === GIT_NAS_ERROR_CODES.CANDIDATE_STATE_INVALID
    )
    assert.throws(
      () => readGitNasFile(database, 1, 'README.md'),
      (error) => error.code === GIT_NAS_ERROR_CODES.CANDIDATE_STATE_INVALID
    )

    await discoverGitNasRepositories({
      database,
      scanRootId: 1,
      rulesVersion: 2,
      generation: 2,
      runGit: fakeGitRunner(secondRoot)
    })
    assert.deepEqual(listGitNasCandidates(database), [{ candidateId: 1, name: 'sample', state: 'imported' }])
    assert.equal(readGitNasFile(database, 1, 'README.md').buffer.toString(), '# second\n')
  } finally {
    database.close()
    fs.rmSync(firstRoot, { recursive: true, force: true })
    fs.rmSync(secondRoot, { recursive: true, force: true })
  }
})

test('rejects linked worktrees, submodules, and external alternates', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-invalid-'))
  try {
    const linked = path.join(rootPath, 'linked')
    fs.mkdirSync(path.join(linked, '.git'), { recursive: true })
    fs.writeFileSync(path.join(linked, '.git', 'commondir'), '../outside')
    const submodule = path.join(rootPath, 'submodule')
    fs.mkdirSync(path.join(submodule, '.git'), { recursive: true })
    fs.writeFileSync(path.join(submodule, '.gitmodules'), '[submodule "x"]\n')
    const nested = path.join(rootPath, 'nested')
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true })
    fs.mkdirSync(path.join(nested, 'child', '.git'), { recursive: true })
    createRoot(database, rootPath)
    const result = await discoverGitNasRepositories({
      database,
      scanRootId: 1,
      rulesVersion: 1,
      generation: 1,
      runGit: fakeGitRunner(rootPath)
    })
    assert.equal(result.candidates, 0)
    assert.equal(result.rejected, 3)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('imports a repository located at the scan root without constructing an absolute child path', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-root-repository-'))
  try {
    fs.mkdirSync(path.join(rootPath, '.git'))
    fs.writeFileSync(path.join(rootPath, 'README.md'), '# root repository\n')
    createRoot(database, rootPath)
    const result = await discoverGitNasRepositories({
      database,
      scanRootId: 1,
      rulesVersion: 1,
      generation: 1,
      runGit: fakeGitRunner(rootPath)
    })
    assert.equal(result.candidates, 1)
    await importGitNasCandidate({ database, candidateId: 1, runGit: fakeGitRunner(rootPath) })
    assert.equal(readGitNasFile(database, 1, 'README.md').buffer.toString(), '# root repository\n')
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('discovery never converts a same-path NAS file source into a Git source', databaseOptions, async () => {
  const database = createDatabase()
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-nas-source-conflict-'))
  try {
    const repositoryPath = path.join(rootPath, 'sample')
    fs.mkdirSync(path.join(repositoryPath, '.git'), { recursive: true })
    createRoot(database, rootPath)
    const resource = database.prepare(`
      INSERT INTO resources (resource_type, title, lifecycle_status)
      VALUES ('document', 'previous file', 'active')
    `).run()
    database.prepare(`
      INSERT INTO resource_sources
        (resource_id, source_kind, scan_root_id, relative_path, state, last_seen_generation)
      VALUES (?, 'nas_path', 1, 'sample', 'active', 1)
    `).run(resource.lastInsertRowid)
    await assert.rejects(
      () => discoverGitNasRepositories({
        database,
        scanRootId: 1,
        rulesVersion: 1,
        generation: 1,
        runGit: fakeGitRunner(rootPath)
      }),
      (error) => error.code === GIT_NAS_ERROR_CODES.WRITE_FAILED
    )
    assert.equal(database.prepare('SELECT source_kind FROM resource_sources').get().source_kind, 'nas_path')
    assert.equal(database.prepare('SELECT resource_type FROM resources WHERE id = ?').get(resource.lastInsertRowid).resource_type, 'document')
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('read-only Git runner validates complete argv and strips inherited Git controls', async () => {
  const calls = []
  const runner = createGitNasReadOnlyRunner(async (...args) => {
    calls.push(args)
    return { stdout: 'true\n' }
  })
  process.env.GIT_TEST_INJECTION = 'must-not-survive'
  try {
    await runner('C:\\fixture', ['rev-parse', '--is-inside-work-tree'])
    assert.equal(calls.length, 1)
    const options = calls[0][2]
    assert.equal(options.shell, false)
    assert.equal(options.env.GIT_TEST_INJECTION, undefined)
    await assert.rejects(
      () => runner('C:\\fixture', ['config', 'core.hooksPath', 'malicious']),
      (error) => error.code === GIT_NAS_ERROR_CODES.COMMAND_FAILED
    )
    assert.equal(calls.length, 1)
  } finally {
    delete process.env.GIT_TEST_INJECTION
  }
})

test('inspects a clean full-commit snapshot with tracked files and detached-head semantics', async () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-snapshot-'))
  const repositoryPath = path.join(rootPath, 'repository')
  fs.mkdirSync(path.join(repositoryPath, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repositoryPath, 'index.js'), 'export function index() {}\n')
  const calls = []
  const runGit = async (currentPath, args) => {
    calls.push(args)
    assert.equal(currentPath, repositoryPath)
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true\n' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${repositoryPath}\n` }
    if (args[0] === 'ls-files') return { stdout: `100644 ${'a'.repeat(40)} 0\tindex.js\0` }
    if (args[0] === 'status') return { stdout: '' }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${'b'.repeat(40)}\n` }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'HEAD\n' }
    throw new Error(`unexpected fake command ${args.join(' ')}`)
  }
  try {
    const snapshot = await inspectReadOnlyGitSnapshot({ repositoryPath, rootPath, runGit })
    assert.equal(snapshot.commit, 'b'.repeat(40))
    assert.equal(snapshot.branch, null)
    assert.deepEqual(snapshot.files, ['index.js'])
    assert.ok(calls.some((args) => args[0] === 'status'))
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('rejects dirty tracked worktrees before exposing a commit snapshot', async () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-snapshot-dirty-'))
  const repositoryPath = path.join(rootPath, 'repository')
  fs.mkdirSync(path.join(repositoryPath, '.git'), { recursive: true })
  const runGit = async (_currentPath, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true\n' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${repositoryPath}\n` }
    if (args[0] === 'ls-files') return { stdout: '' }
    if (args[0] === 'status') return { stdout: ' M index.js\0' }
    throw new Error(`unexpected fake command ${args.join(' ')}`)
  }
  try {
    await assert.rejects(
      () => inspectReadOnlyGitSnapshot({ repositoryPath, rootPath, runGit }),
      (error) => error.code === GIT_NAS_ERROR_CODES.WORKTREE_DIRTY
    )
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})
