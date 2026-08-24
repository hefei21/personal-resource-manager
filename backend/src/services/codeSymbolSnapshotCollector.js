import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { codeSymbolLanguage } from './codeSymbolExtractor.js'
import {
  createGitNasReadOnlyRunner,
  inspectGitNasSnapshot,
  inspectReadOnlyGitSnapshot,
  readGitNasFile
} from './gitNasRepositoryService.js'
import { resolveManagedRepositoryPath, resolveRepositoryEntry } from './repositorySecurity.js'
import { isSensitiveCodeFile, safeCodeText } from './searchSourceCollector.js'

const MAX_CODE_FILE_BYTES = 512 * 1024
const MAX_CODE_FILES = 5000

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Code symbol snapshot collection was cancelled.')
    error.code = 'CODE_SYMBOL_CANCELLED'
    throw error
  }
}

function safeErrorCode(error) {
  const code = String(error?.code ?? '')
  if (/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) return code
  return 'CODE_SYMBOL_SOURCE_FAILED'
}

function readManagedFile(codeBasePath, repositoryPath, relativePath) {
  const fullPath = resolveRepositoryEntry(codeBasePath, repositoryPath, relativePath)
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let descriptor
  try {
    const pathStat = fs.lstatSync(fullPath)
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_CODE_FILE_BYTES) return null
    descriptor = fs.openSync(fullPath, fs.constants.O_RDONLY | noFollow)
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size > MAX_CODE_FILE_BYTES) return null
    const buffer = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      const error = new Error('Repository file changed during snapshot collection.')
      error.code = 'CODE_SYMBOL_FILE_CHANGED'
      throw error
    }
    return safeCodeText(buffer)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
  }
}

async function inspectManagedSnapshot(repository, dependencies, signal) {
  const repositoryPath = resolveManagedRepositoryPath(dependencies.codeBasePath, repository.local_path, { mustExist: true })
  const rootPath = (fs.realpathSync.native ?? fs.realpathSync)(dependencies.codeBasePath)
  const snapshot = await dependencies.inspectReadOnlyGitSnapshot({
    repositoryPath,
    rootPath,
    signal,
    runGit: dependencies.runGit
  })
  return Object.freeze({
    repositoryId: Number(repository.id),
    sourceKind: 'managed_git',
    repositoryPath: snapshot.repositoryPath,
    branch: snapshot.branch,
    commit: snapshot.commit,
    files: snapshot.files
  })
}

async function inspectRepository(database, repository, dependencies, signal) {
  if (repository.type === 'git_nas') {
    return dependencies.inspectGitNasSnapshot(database, repository.id, { signal, runGit: dependencies.runGit })
  }
  return inspectManagedSnapshot(repository, dependencies, signal)
}

function readSnapshotFile(database, repository, snapshot, relativePath, dependencies) {
  if (repository.type === 'git_nas') {
    const file = dependencies.readGitNasFile(database, repository.id, relativePath, { maxBytes: MAX_CODE_FILE_BYTES })
    return safeCodeText(file.buffer)
  }
  return readManagedFile(dependencies.codeBasePath, snapshot.repositoryPath, relativePath)
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function createCodeSymbolSnapshotCollector({
  inspectGitNasSnapshotFn = inspectGitNasSnapshot,
  inspectReadOnlyGitSnapshotFn = inspectReadOnlyGitSnapshot,
  readGitNasFileFn = readGitNasFile,
  runGit = createGitNasReadOnlyRunner(),
  codeBasePath = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')
} = {}) {
  return async function collectCodeSymbolSnapshots({ database, signal, onProgress = async () => {} } = {}) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
    const repositories = database.prepare(`
      SELECT id, name, local_path, type
        FROM code_repositories
       ORDER BY id
    `).all()
    const dependencies = {
      inspectGitNasSnapshot: inspectGitNasSnapshotFn,
      inspectReadOnlyGitSnapshot: inspectReadOnlyGitSnapshotFn,
      readGitNasFile: readGitNasFileFn,
      runGit,
      codeBasePath
    }
    const snapshots = []
    const errors = []
    for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
      throwIfAborted(signal)
      const repository = repositories[repositoryIndex]
      try {
        const inspected = await inspectRepository(database, repository, dependencies, signal)
        const candidatePaths = inspected.files
          .filter((relativePath) => !isSensitiveCodeFile(relativePath) && codeSymbolLanguage(relativePath) !== null)
          .slice(0, MAX_CODE_FILES)
        const files = []
        const fileErrors = []
        for (const relativePath of candidatePaths) {
          throwIfAborted(signal)
          try {
            const content = readSnapshotFile(database, repository, inspected, relativePath, dependencies)
            if (content !== null) files.push(Object.freeze({ path: relativePath, content, contentHash: sha256(content) }))
          } catch (error) {
            fileErrors.push(Object.freeze({ code: safeErrorCode(error), path: relativePath }))
          }
        }
        const verified = await inspectRepository(database, repository, dependencies, signal)
        if (verified.commit !== inspected.commit || verified.branch !== inspected.branch || !sameFiles(verified.files, inspected.files)) {
          const error = new Error('Repository changed during symbol snapshot collection.')
          error.code = 'CODE_SYMBOL_COMMIT_CHANGED'
          throw error
        }
        snapshots.push(Object.freeze({
          repositoryId: Number(repository.id),
          sourceKind: repository.type === 'git_nas' ? 'git_nas' : 'managed_git',
          branch: inspected.branch,
          commit: inspected.commit,
          files: Object.freeze(files),
          errors: Object.freeze(fileErrors)
        }))
      } catch (error) {
        errors.push(Object.freeze({ repositoryId: Number(repository.id), code: safeErrorCode(error) }))
      }
      await onProgress(Math.round(((repositoryIndex + 1) / Math.max(1, repositories.length)) * 100))
    }
    if (repositories.length === 0) await onProgress(100)
    return Object.freeze({ snapshots: Object.freeze(snapshots), errors: Object.freeze(errors) })
  }
}

export const collectCodeSymbolSnapshots = createCodeSymbolSnapshotCollector()
export default collectCodeSymbolSnapshots
