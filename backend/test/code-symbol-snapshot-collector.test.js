import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodeSymbolSnapshotCollector } from '../src/services/codeSymbolSnapshotCollector.js'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

function databaseWith(repositories) {
  return {
    prepare(sql) {
      assert.match(sql, /FROM code_repositories/u)
      return { all: () => repositories }
    }
  }
}

test('collects only safe supported tracked files and verifies the commit after reads', async () => {
  const inspections = []
  const reads = []
  const collector = createCodeSymbolSnapshotCollector({
    inspectGitNasSnapshotFn: async () => {
      inspections.push(true)
      return {
        repositoryId: 1,
        sourceKind: 'git_nas',
        branch: 'main',
        commit: COMMIT_A,
        files: ['.env', 'dist/generated.js', 'src/search.ts', 'src/worker.py', 'README.md']
      }
    },
    readGitNasFileFn: (_database, _repositoryId, relativePath) => {
      reads.push(relativePath)
      return { buffer: Buffer.from(relativePath.endsWith('.py') ? 'def run():\n    return True\n' : 'export function search() {}\n') }
    },
    runGit: async () => { throw new Error('unused') }
  })
  const progress = []
  const result = await collector({
    database: databaseWith([{ id: 1, name: 'fixture', local_path: '', type: 'git_nas' }]),
    onProgress: async (value) => progress.push(value)
  })
  assert.equal(inspections.length, 2)
  assert.deepEqual(reads, ['src/search.ts', 'src/worker.py'])
  assert.deepEqual(result.errors, [])
  assert.equal(result.snapshots[0].files.length, 2)
  assert.deepEqual(result.snapshots[0].files.map(({ path }) => path), ['src/search.ts', 'src/worker.py'])
  assert.match(result.snapshots[0].files[0].contentHash, /^[0-9a-f]{64}$/u)
  assert.deepEqual(progress, [100])
})

test('records safe repository errors when HEAD changes without exposing paths or stderr', async () => {
  let inspection = 0
  const collector = createCodeSymbolSnapshotCollector({
    inspectGitNasSnapshotFn: async () => ({
      repositoryId: 1,
      sourceKind: 'git_nas',
      branch: 'main',
      commit: inspection++ === 0 ? COMMIT_A : COMMIT_B,
      files: ['src/search.js']
    }),
    readGitNasFileFn: () => ({ buffer: Buffer.from('export function search() {}\n') }),
    runGit: async () => { throw new Error('unused') }
  })
  const result = await collector({
    database: databaseWith([{ id: 1, name: 'fixture', local_path: 'E:\\private', type: 'git_nas' }])
  })
  assert.deepEqual(result.snapshots, [])
  assert.deepEqual(result.errors, [{ repositoryId: 1, code: 'CODE_SYMBOL_COMMIT_CHANGED' }])
  assert.equal(JSON.stringify(result).includes('E:\\private'), false)
})

test('omits credential-like content and keeps other files in a partial snapshot', async () => {
  const collector = createCodeSymbolSnapshotCollector({
    inspectGitNasSnapshotFn: async () => ({
      repositoryId: 1,
      sourceKind: 'git_nas',
      branch: null,
      commit: COMMIT_A,
      files: ['src/credential.js', 'src/fails.js', 'src/safe.js']
    }),
    readGitNasFileFn: (_database, _repositoryId, relativePath) => {
      if (relativePath === 'src/fails.js') {
        const error = new Error('E:\\private\\fails.js')
        error.code = 'GIT_NAS_PATH_INVALID'
        throw error
      }
      const content = relativePath === 'src/credential.js'
        ? 'const api_key = "secret-value-123"\n'
        : 'export const SAFE = true\n'
      return { buffer: Buffer.from(content) }
    },
    runGit: async () => { throw new Error('unused') }
  })
  const result = await collector({
    database: databaseWith([{ id: 1, name: 'fixture', local_path: '', type: 'git_nas' }])
  })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.snapshots[0].files.map(({ path }) => path), ['src/safe.js'])
  assert.deepEqual(result.snapshots[0].errors, [{ code: 'GIT_NAS_PATH_INVALID', path: 'src/fails.js' }])
  assert.equal(JSON.stringify(result).includes('private'), false)
})
