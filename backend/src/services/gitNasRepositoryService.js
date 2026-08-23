import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  DEFAULT_CREDENTIAL_GLOBS,
  DEFAULT_EXCLUDED_GLOBS,
  normalizeNasScanRules
} from '../config/nasScan.js'
import { canonicalizeNasScanRoot } from './nasScanSecurity.js'

const execFileAsync = promisify(execFile)

export const GIT_NAS_DISCOVER_TASK_TYPE = 'code.repository.git_nas.discover'
export const GIT_NAS_IMPORT_TASK_TYPE = 'code.repository.git_nas.import'
export const GIT_NAS_TASK_TYPES = Object.freeze([
  GIT_NAS_DISCOVER_TASK_TYPE,
  GIT_NAS_IMPORT_TASK_TYPE
])
export const GIT_NAS_PROCESSOR_VERSION = 'v1'
export const GIT_NAS_EXECUTION_CLASS = 'disk'
export const GIT_NAS_ROOT_SUBJECT_TYPE = 'nas-scan-root'
export const GIT_NAS_CANDIDATE_SUBJECT_TYPE = 'git-nas-candidate'
export const GIT_NAS_ROOT_MUTEX_TASK_TYPES = Object.freeze([
  'nas.resource.scan',
  'nas.resource.repair',
  GIT_NAS_DISCOVER_TASK_TYPE
])

const POSITIVE_ID = /^[1-9]\d*$/u
const COMMIT_HASH = /^[0-9a-f]{7,64}$/iu
const SAFE_TITLE_LENGTH = 160
const MAX_TREE_ENTRIES = 5000
const MAX_COMMIT_LIMIT = 100
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 5 * 1024 * 1024
const SAFE_REV_PARSE_ARGUMENTS = new Set(['--is-inside-work-tree', '--show-toplevel'])

const SAFE_GIT_CONFIG = Object.freeze([
  '--no-pager',
  '--no-optional-locks',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
  '-c', 'core.pager=cat',
  '-c', 'pager.log=false',
  '-c', 'pager.show=false'
])

const SENSITIVE_BASENAME = Object.freeze([
  '.git',
  '.gitmodules',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials.json',
  'secrets.json',
  'kubeconfig',
  'id_rsa',
  'id_ed25519'
])

const SENSITIVE_SUFFIX = Object.freeze([
  '.pem',
  '.key',
  '.p12',
  '.pfx'
])

const SENSITIVE_WORDS = Object.freeze(['token', 'secret', 'credential'])
const PROTECTED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'cache', '.cache', 'derived',
  'derived-cache', 'generated', '__pycache__', '.pytest_cache', '.next',
  '.nuxt', 'target', 'artifacts', '.hg', '.svn', '.ssh'
])
const ROOT_RELATIVE_PATH = '.'

export const GIT_NAS_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'GIT_NAS_INPUT_INVALID',
  ROOT_NOT_FOUND: 'GIT_NAS_ROOT_NOT_FOUND',
  ROOT_DISABLED: 'GIT_NAS_ROOT_DISABLED',
  CONFIG_CONFLICT: 'GIT_NAS_CONFIG_CONFLICT',
  CANDIDATE_NOT_FOUND: 'GIT_NAS_CANDIDATE_NOT_FOUND',
  CANDIDATE_STATE_INVALID: 'GIT_NAS_CANDIDATE_STATE_INVALID',
  PATH_INVALID: 'GIT_NAS_PATH_INVALID',
  SYMLINK_FORBIDDEN: 'GIT_NAS_SYMLINK_FORBIDDEN',
  REALPATH_ESCAPE: 'GIT_NAS_REALPATH_ESCAPE',
  GIT_NOT_FOUND: 'GIT_NAS_GIT_NOT_FOUND',
  GIT_METADATA_INVALID: 'GIT_NAS_METADATA_INVALID',
  SUBMODULE_FORBIDDEN: 'GIT_NAS_SUBMODULE_FORBIDDEN',
  LINKED_WORKTREE_FORBIDDEN: 'GIT_NAS_LINKED_WORKTREE_FORBIDDEN',
  EXTERNAL_ALTERNATES_FORBIDDEN: 'GIT_NAS_EXTERNAL_ALTERNATES_FORBIDDEN',
  COMMAND_FAILED: 'GIT_NAS_COMMAND_FAILED',
  READ_ONLY: 'GIT_NAS_READ_ONLY',
  DATABASE_BUSY: 'GIT_NAS_DATABASE_BUSY',
  WRITE_FAILED: 'GIT_NAS_WRITE_FAILED',
  CANCELLED: 'GIT_NAS_CANCELLED'
})

export class GitNasRepositoryError extends Error {
  constructor(code, message = 'NAS Git repository operation failed.', cause = undefined) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GitNasRepositoryError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new GitNasRepositoryError(code, message, cause)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizePositiveId(value, code = GIT_NAS_ERROR_CODES.INPUT_INVALID) {
  if (typeof value === 'string' && POSITIVE_ID.test(value.trim())) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) fail(code, 'The NAS Git identifier is invalid.')
  return value
}

function normalizeCommitLimit(value) {
  const number = value === undefined ? 20 : Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_COMMIT_LIMIT) {
    fail(GIT_NAS_ERROR_CODES.INPUT_INVALID, 'The commit limit is invalid.')
  }
  return number
}

function normalizeCommitHash(value) {
  if (typeof value !== 'string' || !COMMIT_HASH.test(value)) {
    fail(GIT_NAS_ERROR_CODES.INPUT_INVALID, 'The commit identifier is invalid.')
  }
  return value
}

function normalizeRelativePath(value, { allowRoot = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowRoot) return ''
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository path is invalid.')
  }
  if (typeof value !== 'string' || value.includes('\0')) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository path is invalid.')
  }
  const normalized = value.replaceAll('\\', '/')
  if (allowRoot && normalized === ROOT_RELATIVE_PATH) return ''
  if (normalized.startsWith('/') || /^[a-z]:\//iu.test(normalized)) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository path is invalid.')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository path is invalid.')
  }
  return parts.join('/')
}

function realpathNative(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value)
}

function isInside(rootPath, candidatePath, allowRoot = false) {
  const relative = path.relative(rootPath, candidatePath)
  if (relative === '') return allowRoot
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function asSafeTitle(value) {
  const title = String(value ?? '').normalize('NFKC').trim()
  if (!title || title.length > SAFE_TITLE_LENGTH || /[\u0000-\u001f\u007f]/u.test(title)) {
    return 'NAS Git repository'
  }
  return title
}

function isSensitivePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath, { allowRoot: true })
  if (!normalized) return false
  const parts = normalized.split('/')
  const basename = parts.at(-1).toLowerCase()
  if (parts.some((part) => part === '.git')) return true
  if (parts.some((part) => PROTECTED_DIRECTORY_NAMES.has(part.toLowerCase()))) return true
  if (SENSITIVE_BASENAME.includes(basename)) return true
  if (SENSITIVE_SUFFIX.some((suffix) => basename.endsWith(suffix))) return true
  if (basename === '.env' || basename.startsWith('.env.')) return true
  return SENSITIVE_WORDS.some((word) => basename.includes(word))
}

function pathFromRoot(rootPath, relativePath, { allowRoot = false } = {}) {
  const safeRelativePath = normalizeRelativePath(relativePath, { allowRoot })
  const candidatePath = safeRelativePath
    ? path.join(rootPath, ...safeRelativePath.split('/'))
    : rootPath
  const relative = path.relative(rootPath, candidatePath)
  if ((!allowRoot && !relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The repository path is outside the NAS root.')
  }
  return { candidatePath, relativePath: safeRelativePath }
}

function inspectPath(rootPath, candidatePath, { allowRoot = false, requireDirectory = false } = {}) {
  let stat
  try {
    stat = fs.lstatSync(candidatePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail(GIT_NAS_ERROR_CODES.CANDIDATE_NOT_FOUND, 'The NAS Git repository was not found.', error)
    }
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS Git path could not be inspected.', error)
  }
  if (stat.isSymbolicLink()) fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
  if (requireDirectory && !stat.isDirectory()) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS Git repository is not a directory.')
  }
  let realPath
  try {
    realPath = realpathNative(candidatePath)
  } catch (error) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS Git path could not be resolved.', error)
  }
  if (!isInside(rootPath, realPath, allowRoot)) {
    fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The NAS Git path is outside the NAS root.')
  }
  return Object.freeze({ stat, realPath })
}

function readRoot(database, rawScanRootId) {
  const scanRootId = normalizePositiveId(rawScanRootId)
  const row = database.prepare(`
    SELECT id, root_path, enabled, rules_json, rules_version, last_successful_generation
      FROM nas_scan_roots
     WHERE id = ?
  `).get(scanRootId)
  if (!row) fail(GIT_NAS_ERROR_CODES.ROOT_NOT_FOUND, 'The NAS scan root was not found.')
  if (Number(row.enabled) !== 1) fail(GIT_NAS_ERROR_CODES.ROOT_DISABLED, 'The NAS scan root is disabled.')
  let rules
  try {
    rules = normalizeNasScanRules(JSON.parse(row.rules_json))
  } catch (error) {
    fail(GIT_NAS_ERROR_CODES.CONFIG_CONFLICT, 'The NAS scan root configuration is invalid.', error)
  }
  let rootPath
  try {
    rootPath = canonicalizeNasScanRoot(row.root_path)
  } catch (error) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS scan root could not be accessed safely.', error)
  }
  return Object.freeze({
    id: Number(row.id),
    rootPath,
    enabled: true,
    rules,
    rulesVersion: Number(row.rules_version),
    lastSuccessfulGeneration: Number(row.last_successful_generation)
  })
}

function assertGeneration(root, { rulesVersion, generation } = {}) {
  if (rulesVersion !== undefined && Number(rulesVersion) !== root.rulesVersion) {
    fail(GIT_NAS_ERROR_CODES.CONFIG_CONFLICT, 'The NAS scan root configuration changed.')
  }
  if (generation !== undefined && Number(generation) !== root.lastSuccessfulGeneration + 1) {
    fail(GIT_NAS_ERROR_CODES.CONFIG_CONFLICT, 'The NAS scan root generation changed.')
  }
}

function safeError(error, fallbackCode = GIT_NAS_ERROR_CODES.COMMAND_FAILED) {
  if (error instanceof GitNasRepositoryError) return error
  if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
    return new GitNasRepositoryError(GIT_NAS_ERROR_CODES.DATABASE_BUSY, 'NAS Git storage is temporarily busy.', error)
  }
  return new GitNasRepositoryError(fallbackCode, 'The NAS Git operation failed.', error)
}

function assertReadOnlyCommand(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    fail(GIT_NAS_ERROR_CODES.COMMAND_FAILED, 'The Git command is not allowed.')
  }
  const allowed =
    (args.length === 2 && args[0] === 'rev-parse' && SAFE_REV_PARSE_ARGUMENTS.has(args[1])) ||
    (args.length === 3 && args[0] === 'ls-files' && args[1] === '--stage' && args[2] === '-z') ||
    (args.length === 5 && args[0] === 'log' && args[1] === '--pretty=format:%H|%an|%ad|%s' &&
      args[2] === '--date=format:%Y-%m-%d %H:%M:%S' && args[3] === '-n' && /^\d{1,3}$/u.test(args[4])) ||
    (args.length === 7 && args[0] === 'show' && args[1] === '--no-ext-diff' &&
      args[2] === '--no-textconv' && args[3] === '--stat' &&
      args[4] === '--pretty=format:%H|%an|%ad|%s' && COMMIT_HASH.test(args[5]) && args[6] === '--')
  if (!allowed) fail(GIT_NAS_ERROR_CODES.COMMAND_FAILED, 'The Git command is not allowed.')
}

function safeGitEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  )
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_PAGER: 'cat'
  }
}

function createDefaultReadOnlyGitRunner(execFileFunction = execFileAsync) {
  return async function runReadOnlyGit(repositoryPath, args, options = {}) {
    assertReadOnlyCommand(args)
    const timeout = options.timeout ?? GIT_TIMEOUT_MS
    try {
      return await execFileFunction('git', [
        ...SAFE_GIT_CONFIG,
        '-C', repositoryPath,
        ...args
      ], {
        timeout,
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        windowsHide: true,
        shell: false,
        ...(options.signal ? { signal: options.signal } : {}),
        env: safeGitEnvironment()
      })
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        fail(GIT_NAS_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.', error)
      }
      throw safeError(error)
    }
  }
}

export function createGitNasReadOnlyRunner(execFileFunction = execFileAsync) {
  if (typeof execFileFunction !== 'function') throw new TypeError('execFileFunction must be a function')
  return createDefaultReadOnlyGitRunner(execFileFunction)
}

async function runAllowedGit(runGit, repositoryPath, args, options = {}) {
  assertReadOnlyCommand(args)
  try {
    return await runGit(repositoryPath, args, options)
  } catch (error) {
    throw safeError(error)
  }
}

function assertGitDirectoryMetadata(repositoryPath, rootPath) {
  const gitPath = path.join(repositoryPath, '.git')
  let gitStat
  try {
    gitStat = fs.lstatSync(gitPath)
  } catch (error) {
    if (error?.code === 'ENOENT') fail(GIT_NAS_ERROR_CODES.GIT_NOT_FOUND, 'The Git repository metadata is missing.')
    fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git repository metadata is invalid.', error)
  }
  if (gitStat.isSymbolicLink()) fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
  if (!gitStat.isDirectory()) {
    fail(GIT_NAS_ERROR_CODES.LINKED_WORKTREE_FORBIDDEN, 'Linked Git worktrees are not supported.')
  }
  const git = inspectPath(repositoryPath, gitPath, { requireDirectory: true })
  if (!isInside(rootPath, git.realPath)) {
    fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The Git metadata is outside the NAS root.')
  }

  const commondirPath = path.join(git.realPath, 'commondir')
  try {
    const commondirStat = fs.lstatSync(commondirPath)
    if (commondirStat.isSymbolicLink() || !commondirStat.isFile()) {
      fail(GIT_NAS_ERROR_CODES.LINKED_WORKTREE_FORBIDDEN, 'Linked Git worktrees are not supported.')
    }
    fail(GIT_NAS_ERROR_CODES.LINKED_WORKTREE_FORBIDDEN, 'Linked Git worktrees are not supported.')
  } catch (error) {
    if (error instanceof GitNasRepositoryError) throw error
    if (error?.code !== 'ENOENT') fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git metadata is invalid.', error)
  }

  const alternatesPath = path.join(git.realPath, 'objects', 'info', 'alternates')
  try {
    const alternatesStat = fs.lstatSync(alternatesPath)
    if (alternatesStat.isSymbolicLink() || !alternatesStat.isFile()) {
      fail(GIT_NAS_ERROR_CODES.EXTERNAL_ALTERNATES_FORBIDDEN, 'External Git object alternates are not supported.')
    }
    const objectRoot = realpathNative(path.join(git.realPath, 'objects'))
    const text = fs.readFileSync(alternatesPath, 'utf8')
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (!line) continue
      const alternatePath = path.isAbsolute(line)
        ? path.normalize(line)
        : path.resolve(path.dirname(alternatesPath), line)
      let realAlternate
      try { realAlternate = realpathNative(alternatePath) } catch (error) {
        fail(GIT_NAS_ERROR_CODES.EXTERNAL_ALTERNATES_FORBIDDEN, 'External Git object alternates are not supported.', error)
      }
      if (!isInside(objectRoot, realAlternate, true)) {
        fail(GIT_NAS_ERROR_CODES.EXTERNAL_ALTERNATES_FORBIDDEN, 'External Git object alternates are not supported.')
      }
    }
  } catch (error) {
    if (error instanceof GitNasRepositoryError) throw error
    if (error?.code !== 'ENOENT') fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git metadata is invalid.', error)
  }

  const modulesPath = path.join(repositoryPath, '.gitmodules')
  try {
    const modulesStat = fs.lstatSync(modulesPath)
    if (modulesStat.isSymbolicLink() || !modulesStat.isFile()) {
      fail(GIT_NAS_ERROR_CODES.SUBMODULE_FORBIDDEN, 'Git submodules are not supported.')
    }
    fail(GIT_NAS_ERROR_CODES.SUBMODULE_FORBIDDEN, 'Git submodules are not supported.')
  } catch (error) {
    if (error instanceof GitNasRepositoryError) throw error
    if (error?.code !== 'ENOENT') fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git metadata is invalid.', error)
  }
  return Object.freeze({ repositoryPath, gitPath: git.realPath })
}

function assertNoNestedRepositoryOrSymlink(repositoryPath) {
  let visited = 0
  function visit(directoryPath, depth, insideGitMetadata = false) {
    if (depth > 128 || visited > 1_000_000) {
      fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git worktree is too deep or too large to validate safely.')
    }
    let entries
    try { entries = fs.readdirSync(directoryPath, { withFileTypes: true }) } catch (error) {
      fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git worktree could not be validated safely.', error)
    }
    for (const entry of entries) {
      visited += 1
      const entryPath = path.join(directoryPath, entry.name)
      let stat
      try { stat = fs.lstatSync(entryPath) } catch (error) {
        fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git worktree could not be validated safely.', error)
      }
      if (stat.isSymbolicLink()) {
        fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
      }
      if (depth === 0 && entry.name === '.git') {
        if (!stat.isDirectory()) {
          fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git metadata is invalid.')
        }
        visit(entryPath, depth + 1, true)
        continue
      }
      if (!insideGitMetadata && entry.name === '.git') {
        fail(GIT_NAS_ERROR_CODES.SUBMODULE_FORBIDDEN, 'Nested Git repositories are not supported.')
      }
      if (!insideGitMetadata && PROTECTED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue
      if (stat.isDirectory()) visit(entryPath, depth + 1, insideGitMetadata)
    }
  }
  visit(repositoryPath, 0)
}

async function inspectGitRepository(repositoryPath, rootPath, runGit, signal) {
  const repository = inspectPath(rootPath, repositoryPath, { allowRoot: true, requireDirectory: true })
  const checkedPath = repository.realPath
  assertGitDirectoryMetadata(checkedPath, rootPath)
  assertNoNestedRepositoryOrSymlink(checkedPath)
  const inside = await runAllowedGit(runGit, checkedPath, ['rev-parse', '--is-inside-work-tree'], { signal })
  if (String(inside?.stdout ?? '').trim() !== 'true') {
    fail(GIT_NAS_ERROR_CODES.GIT_NOT_FOUND, 'The path is not a Git worktree.')
  }
  const topLevel = await runAllowedGit(runGit, checkedPath, ['rev-parse', '--show-toplevel'], { signal })
  let reportedTop
  try { reportedTop = realpathNative(String(topLevel?.stdout ?? '').trim()) } catch (error) {
    fail(GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID, 'The Git worktree metadata is invalid.', error)
  }
  if (path.resolve(reportedTop) !== path.resolve(checkedPath)) {
    fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The Git worktree is outside its configured root.')
  }
  const staged = await runAllowedGit(runGit, checkedPath, ['ls-files', '--stage', '-z'], { signal })
  if (String(staged?.stdout ?? '').split('\0').some((entry) => /^160000\s/u.test(entry))) {
    fail(GIT_NAS_ERROR_CODES.SUBMODULE_FORBIDDEN, 'Git submodules are not supported.')
  }
  return Object.freeze({ rootPath, repositoryPath: checkedPath })
}

function readRelativeRootPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath).replaceAll('\\', '/')
  return relative ? normalizeRelativePath(relative) : ROOT_RELATIVE_PATH
}

function readDirectoryNames(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS Git directory could not be read.', error)
  }
}

function readStableDirectoryNames(repositoryPath, directoryPath) {
  let before
  let beforeRealPath
  try {
    before = fs.lstatSync(directoryPath)
    if (before.isSymbolicLink() || !before.isDirectory()) {
      fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
    }
    beforeRealPath = realpathNative(directoryPath)
    if (!isInside(repositoryPath, beforeRealPath, true)) {
      fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The requested repository path is outside the repository.')
    }
    const names = readDirectoryNames(directoryPath)
    const after = fs.lstatSync(directoryPath)
    const afterRealPath = realpathNative(directoryPath)
    if (after.isSymbolicLink() || !after.isDirectory() ||
      before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      beforeRealPath !== afterRealPath) {
      fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository directory changed while reading.')
    }
    return names
  } catch (error) {
    if (error instanceof GitNasRepositoryError) throw error
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The repository directory could not be read safely.', error)
  }
}

function entryIsExcluded(relativePath, rules) {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some((segment) => PROTECTED_DIRECTORY_NAMES.has(segment))) return true
  const patterns = [
    ...(rules.excludedGlobs ?? []),
    ...(DEFAULT_EXCLUDED_GLOBS ?? []),
    ...(rules.credentialGlobs ?? []),
    ...(DEFAULT_CREDENTIAL_GLOBS ?? [])
  ]
  return patterns.some((glob) => {
    const plain = glob.toLowerCase().replaceAll('**/', '').replaceAll('/**', '').replaceAll('*', '')
    return plain && (normalized === plain || segments.includes(plain))
  })
}

async function discoverDirectories(root, { runGit, signal, onProgress } = {}) {
  const found = []
  let visited = 0
  let rejected = 0

  async function visit(directoryPath, relativePath, depth) {
    if (signal?.aborted) fail(GIT_NAS_ERROR_CODES.CANCELLED, 'The NAS Git discovery was cancelled.')
    if (depth > root.rules.maxDepth) return
    const names = readDirectoryNames(directoryPath)
    const gitNamePresent = names.includes('.git')
    if (gitNamePresent) {
      const gitPath = path.join(directoryPath, '.git')
      let gitStat
      try { gitStat = fs.lstatSync(gitPath) } catch (error) {
        fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS Git metadata could not be inspected.', error)
      }
      if (gitStat.isSymbolicLink()) fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
      if (!gitStat.isDirectory()) {
        rejected += 1
        return
      }
      try {
        const relative = relativePath || readRelativeRootPath(root.rootPath, directoryPath)
        const checked = await inspectGitRepository(directoryPath, root.rootPath, runGit, signal)
        found.push(Object.freeze({ relativePath: relative, title: asSafeTitle(path.basename(checked.repositoryPath)) }))
      } catch (error) {
        if (error instanceof GitNasRepositoryError && [
          GIT_NAS_ERROR_CODES.SUBMODULE_FORBIDDEN,
          GIT_NAS_ERROR_CODES.LINKED_WORKTREE_FORBIDDEN,
          GIT_NAS_ERROR_CODES.EXTERNAL_ALTERNATES_FORBIDDEN,
          GIT_NAS_ERROR_CODES.GIT_NOT_FOUND,
          GIT_NAS_ERROR_CODES.GIT_METADATA_INVALID
        ].includes(error.code)) {
          rejected += 1
          return
        }
        throw error
      }
      await onProgress?.({ visitedEntries: visited, candidates: found.length })
      // A valid repository is an atomic candidate.  Never inspect its files
      // or descend into possible nested repositories.
      return
    }

    for (const name of names) {
      if (name === '.gitmodules' || entryIsExcluded(relativePath ? `${relativePath}/${name}` : name, root.rules)) continue
      const candidatePath = path.join(directoryPath, name)
      let entry
      try { entry = inspectPath(root.rootPath, candidatePath) } catch (error) {
        throw error
      }
      visited += 1
      if (entry.stat.isDirectory()) {
        const childRelative = readRelativeRootPath(root.rootPath, entry.realPath)
        await visit(entry.realPath, childRelative, depth + 1)
      }
      await onProgress?.({ visitedEntries: visited, candidates: found.length })
    }
  }

  await visit(root.rootPath, '', 0)
  return Object.freeze({ found, visitedEntries: visited, rejected })
}

function commitDiscoveredCandidates(database, root, candidates, generation) {
  try {
    return database.transaction(() => {
      let created = 0
      let existing = 0
      for (const candidate of candidates) {
        const source = database.prepare(`
          SELECT id, resource_id, state
            FROM resource_sources
           WHERE source_kind = 'git_nas' AND scan_root_id = ? AND relative_path = ?
        `).get(root.id, candidate.relativePath)
        let resourceId
        if (source) {
          resourceId = Number(source.resource_id)
          existing += 1
          database.prepare(`
            UPDATE resource_sources
               SET source_kind = 'git_nas', state = 'active', last_seen_generation = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
          `).run(generation, source.id)
        } else {
          const resource = database.prepare(`
            INSERT INTO resources (resource_type, title, lifecycle_status)
            VALUES ('code_repository', ?, 'active')
          `).run(candidate.title)
          resourceId = Number(resource.lastInsertRowid)
          database.prepare(`
            INSERT INTO resource_sources
              (resource_id, source_kind, scan_root_id, relative_path, state, last_seen_generation)
            VALUES (?, 'git_nas', ?, ?, 'active', ?)
          `).run(resourceId, root.id, candidate.relativePath, generation)
          created += 1
        }
        // A source is the candidate identity.  A previously imported display
        // name is intentionally preserved; discovery never overwrites it.
        void resourceId
      }
      const missing = database.prepare(`
        UPDATE resource_sources
           SET state = 'missing', updated_at = CURRENT_TIMESTAMP
         WHERE scan_root_id = ? AND source_kind = 'git_nas'
           AND (last_seen_generation IS NULL OR last_seen_generation < ?)
      `).run(root.id, generation).changes
      const fence = database.prepare(`
        UPDATE nas_scan_roots
           SET last_successful_generation = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND rules_version = ? AND last_successful_generation = ?
      `).run(generation, root.id, root.rulesVersion, generation - 1).changes
      if (fence !== 1) fail(GIT_NAS_ERROR_CODES.CONFIG_CONFLICT, 'The NAS scan root generation changed.')
      return { created, existing, missing }
    })()
  } catch (error) {
    throw safeError(error, GIT_NAS_ERROR_CODES.WRITE_FAILED)
  }
}

export async function discoverGitNasRepositories({
  database,
  scanRootId,
  rulesVersion,
  generation,
  signal,
  onProgress,
  runGit = createDefaultReadOnlyGitRunner()
} = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(GIT_NAS_ERROR_CODES.WRITE_FAILED, 'NAS Git storage is unavailable.')
  }
  const root = readRoot(database, scanRootId)
  assertGeneration(root, { rulesVersion: Number(rulesVersion), generation: Number(generation) })
  const discovered = await discoverDirectories(root, { runGit, signal, onProgress })
  const committed = commitDiscoveredCandidates(database, root, discovered.found, Number(generation))
  return Object.freeze({
    generation: Number(generation),
    rulesVersion: root.rulesVersion,
    visitedEntries: Number(discovered.visitedEntries),
    candidates: Number(discovered.found.length),
    rejected: Number(discovered.rejected),
    created: Number(committed.created),
    existing: Number(committed.existing),
    missing: Number(committed.missing)
  })
}

function readCandidate(database, rawCandidateId) {
  const candidateId = normalizePositiveId(rawCandidateId, GIT_NAS_ERROR_CODES.INPUT_INVALID)
  const row = database.prepare(`
    SELECT r.id AS resource_id, r.title, r.lifecycle_status,
           s.id AS source_id, s.scan_root_id, s.relative_path, s.state,
           n.root_path, n.enabled, n.rules_json, n.rules_version
      FROM resources r
      JOIN resource_sources s ON s.resource_id = r.id
      JOIN nas_scan_roots n ON n.id = s.scan_root_id
     WHERE r.id = ? AND r.resource_type = 'code_repository' AND s.source_kind = 'git_nas'
     LIMIT 1
  `).get(candidateId)
  if (!row) fail(GIT_NAS_ERROR_CODES.CANDIDATE_NOT_FOUND, 'The NAS Git candidate was not found.')
  return Object.freeze({
    candidateId,
    resourceId: Number(row.resource_id),
    title: asSafeTitle(row.title),
    lifecycleStatus: row.lifecycle_status,
    sourceId: Number(row.source_id),
    scanRootId: Number(row.scan_root_id),
    relativePath: normalizeRelativePath(row.relative_path, { allowRoot: true }),
    state: row.state,
    rootPath: row.root_path,
    enabled: Number(row.enabled) === 1,
    rulesVersion: Number(row.rules_version),
    rules: JSON.parse(row.rules_json)
  })
}

function candidateProjection(row, database) {
  const imported = database.prepare(`
    SELECT domain_id FROM resource_domain_links
     WHERE resource_id = ? AND domain_type = 'code_repository'
  `).get(row.resourceId)
  return Object.freeze({
    candidateId: row.candidateId,
    name: row.title,
    state: row.state === 'active' && imported ? 'imported' : row.state
  })
}

export function listGitNasCandidates(database, { scanRootId } = {}) {
  if (!database || typeof database.prepare !== 'function') fail(GIT_NAS_ERROR_CODES.WRITE_FAILED, 'NAS Git storage is unavailable.')
  const params = []
  let where = `r.resource_type = 'code_repository' AND s.source_kind = 'git_nas'`
  if (scanRootId !== undefined) {
    params.push(normalizePositiveId(scanRootId))
    where += ' AND s.scan_root_id = ?'
  }
  const rows = database.prepare(`
    SELECT r.id AS resource_id, r.title, r.lifecycle_status,
           s.id AS source_id, s.scan_root_id, s.relative_path, s.state,
           n.root_path, n.enabled, n.rules_json, n.rules_version
      FROM resources r
      JOIN resource_sources s ON s.resource_id = r.id
      JOIN nas_scan_roots n ON n.id = s.scan_root_id
     WHERE ${where}
     ORDER BY r.id ASC
  `).all(...params)
  return Object.freeze(rows.map((row) => candidateProjection(readCandidate(database, row.resource_id), database)))
}

function ensureCandidatePath(candidate) {
  if (candidate.state !== 'active') fail(GIT_NAS_ERROR_CODES.CANDIDATE_STATE_INVALID, 'The NAS Git candidate is not active.')
  if (!candidate.enabled) fail(GIT_NAS_ERROR_CODES.ROOT_DISABLED, 'The NAS scan root is disabled.')
  let rootPath
  try { rootPath = canonicalizeNasScanRoot(candidate.rootPath) } catch (error) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS scan root could not be accessed safely.', error)
  }
  const { candidatePath } = pathFromRoot(rootPath, candidate.relativePath, { allowRoot: true })
  return { rootPath, candidatePath }
}

export async function importGitNasCandidate({
  database,
  candidateId,
  signal,
  runGit = createDefaultReadOnlyGitRunner()
} = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(GIT_NAS_ERROR_CODES.WRITE_FAILED, 'NAS Git storage is unavailable.')
  }
  if (signal?.aborted) fail(GIT_NAS_ERROR_CODES.CANCELLED, 'The NAS Git import was cancelled.')
  const candidate = readCandidate(database, candidateId)
  const { rootPath, candidatePath } = ensureCandidatePath(candidate)
  await inspectGitRepository(candidatePath, rootPath, runGit, signal)
  if (signal?.aborted) fail(GIT_NAS_ERROR_CODES.CANCELLED, 'The NAS Git import was cancelled.')
  try {
    return database.transaction(() => {
      const existing = database.prepare(`
        SELECT domain_id FROM resource_domain_links
         WHERE resource_id = ? AND domain_type = 'code_repository'
      `).get(candidate.resourceId)
      if (existing) {
        return Object.freeze({
          repositoryId: Number(existing.domain_id),
          resourceId: candidate.resourceId,
          status: 'already-imported'
        })
      }
      const conflict = database.prepare(`
        SELECT resource_id FROM resource_domain_links WHERE resource_id = ?
      `).get(candidate.resourceId)
      if (conflict) fail(GIT_NAS_ERROR_CODES.WRITE_FAILED, 'The NAS Git candidate is already linked.')
      const opaqueUrl = `git-nas:candidate-${candidate.candidateId}`
      const result = database.prepare(`
        INSERT INTO code_repositories
          (name, url, description, local_path, type, languages)
        VALUES (?, ?, NULL, '', 'git_nas', '{}')
      `).run(candidate.title, opaqueUrl)
      const repositoryId = Number(result.lastInsertRowid)
      database.prepare(`
        INSERT INTO resource_domain_links (resource_id, domain_type, domain_id)
        VALUES (?, 'code_repository', ?)
      `).run(candidate.resourceId, repositoryId)
      return Object.freeze({ repositoryId, resourceId: candidate.resourceId, status: 'imported' })
    })()
  } catch (error) {
    throw safeError(error, GIT_NAS_ERROR_CODES.WRITE_FAILED)
  }
}

export function getGitNasRepository(database, rawRepositoryId) {
  const repositoryId = normalizePositiveId(rawRepositoryId, GIT_NAS_ERROR_CODES.INPUT_INVALID)
  const row = database.prepare(`
    SELECT c.id AS repository_id, c.name, c.description,
           r.id AS resource_id, s.scan_root_id, s.relative_path, s.state,
           n.root_path, n.enabled, n.rules_json, n.rules_version
      FROM code_repositories c
      JOIN resource_domain_links d ON d.domain_type = 'code_repository' AND d.domain_id = c.id
      JOIN resources r ON r.id = d.resource_id AND r.resource_type = 'code_repository'
      JOIN resource_sources s ON s.resource_id = r.id AND s.source_kind = 'git_nas'
      JOIN nas_scan_roots n ON n.id = s.scan_root_id
     WHERE c.id = ? AND c.type = 'git_nas'
     LIMIT 1
  `).get(repositoryId)
  if (!row) fail(GIT_NAS_ERROR_CODES.CANDIDATE_NOT_FOUND, 'The NAS Git repository was not found.')
  return Object.freeze({
    repositoryId,
    name: asSafeTitle(row.name),
    description: row.description ?? null,
    resourceId: Number(row.resource_id),
    scanRootId: Number(row.scan_root_id),
    relativePath: normalizeRelativePath(row.relative_path, { allowRoot: true }),
    state: row.state,
    rootPath: row.root_path,
    enabled: Number(row.enabled) === 1,
    rulesVersion: Number(row.rules_version),
    rules: JSON.parse(row.rules_json)
  })
}

function resolveGitNasEntry(database, rawRepositoryId, relativePath, options = {}) {
  const repository = getGitNasRepository(database, rawRepositoryId)
  if (repository.state !== 'active') fail(GIT_NAS_ERROR_CODES.CANDIDATE_STATE_INVALID, 'The NAS Git repository is not active.')
  if (!repository.enabled) fail(GIT_NAS_ERROR_CODES.ROOT_DISABLED, 'The NAS scan root is disabled.')
  if (isSensitivePath(relativePath)) fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository metadata is not available.')
  let rootPath
  try { rootPath = canonicalizeNasScanRoot(repository.rootPath) } catch (error) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The NAS scan root could not be accessed safely.', error)
  }
  const combinedRelativePath = [repository.relativePath, relativePath]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('/')
  const { candidatePath, relativePath: safePath } = pathFromRoot(rootPath, combinedRelativePath, options)
  const repoPathInfo = inspectPath(rootPath, path.join(rootPath, ...repository.relativePath.split('/')), {
    allowRoot: true,
    requireDirectory: true
  })
  const entry = inspectPath(rootPath, candidatePath, { allowRoot: options.allowRoot === true })
  if (!isInside(repoPathInfo.realPath, entry.realPath, options.allowRoot === true)) {
    fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The requested repository path is outside the repository.')
  }
  const repositoryPrefix = repository.relativePath ? `${repository.relativePath}/` : ''
  return Object.freeze({
    repository,
    rootPath,
    repositoryPath: repoPathInfo.realPath,
    candidatePath: entry.realPath,
    relativePath: repositoryPrefix ? safePath.slice(repositoryPrefix.length) : safePath
  })
}

function contentTypeFor(relativePath) {
  const ext = path.extname(relativePath).toLowerCase()
  const mimeTypes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'text/plain', '.js': 'text/plain',
    '.css': 'text/plain', '.html': 'text/plain'
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

const CREDENTIAL_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u
])

function containsCredentialContent(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  return CREDENTIAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text))
}

export function listGitNasTree(database, rawRepositoryId, relativePath = '') {
  const resolved = resolveGitNasEntry(database, rawRepositoryId, relativePath, { allowRoot: true })
  const stat = fs.lstatSync(resolved.candidatePath)
  if (stat.isSymbolicLink()) fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
  if (!stat.isDirectory()) fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository path is not a directory.')
  const entries = readStableDirectoryNames(resolved.repositoryPath, resolved.candidatePath)
    .filter((name) => !isSensitivePath(name))
    .slice(0, MAX_TREE_ENTRIES)
    .map((name) => {
      const entry = resolveGitNasEntry(database, rawRepositoryId, relativePath ? `${relativePath}/${name}` : name)
      const entryStat = fs.lstatSync(entry.candidatePath)
      if (entryStat.isSymbolicLink()) fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
      return {
        name,
        type: entryStat.isDirectory() ? 'directory' : 'file',
        path: entry.relativePath,
        size: entryStat.isFile() ? entryStat.size : undefined
      }
    })
    .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1)
  return entries
}

export function readGitNasFile(database, rawRepositoryId, relativePath, { maxBytes = 1024 * 1024 } = {}) {
  const resolved = resolveGitNasEntry(database, rawRepositoryId, relativePath)
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let descriptor
  let stat
  let buffer
  try {
    descriptor = fs.openSync(resolved.candidatePath, fs.constants.O_RDONLY | noFollow)
    stat = fs.fstatSync(descriptor)
    const pathStat = fs.lstatSync(resolved.candidatePath)
    if (pathStat.isSymbolicLink() || !stat.isFile() ||
      pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.')
    }
    const currentRealPath = realpathNative(resolved.candidatePath)
    if (!isInside(resolved.repositoryPath, currentRealPath)) {
      fail(GIT_NAS_ERROR_CODES.REALPATH_ESCAPE, 'The requested repository path is outside the repository.')
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository file is too large.')
    }
    buffer = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository file changed while reading.')
    }
  } catch (error) {
    if (error instanceof GitNasRepositoryError) throw error
    if (error?.code === 'ELOOP') fail(GIT_NAS_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS Git symbolic links are not allowed.', error)
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository file could not be read safely.', error)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
  }
  if (containsCredentialContent(buffer)) {
    fail(GIT_NAS_ERROR_CODES.PATH_INVALID, 'The requested repository file is excluded by the credential policy.')
  }
  return Object.freeze({
    name: path.basename(resolved.relativePath),
    relativePath: resolved.relativePath,
    size: stat.size,
    contentType: contentTypeFor(resolved.relativePath),
    buffer
  })
}

export function readGitNasReadme(database, rawRepositoryId) {
  const names = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README.txt', 'readme.txt']
  for (const name of names) {
    try {
      const file = readGitNasFile(database, rawRepositoryId, name)
      return Object.freeze({ name: file.name, content: file.buffer.toString('utf8') })
    } catch (error) {
      if (error instanceof GitNasRepositoryError && error.code === GIT_NAS_ERROR_CODES.CANDIDATE_NOT_FOUND) continue
      if (error instanceof GitNasRepositoryError && error.code === GIT_NAS_ERROR_CODES.PATH_INVALID) continue
      throw error
    }
  }
  return null
}

function parseGitLog(stdout) {
  return String(stdout ?? '').split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, ...messageParts] = line.split('|')
    return {
      hash: String(hash ?? '').slice(0, 7),
      fullHash: String(hash ?? ''),
      author: String(author ?? '').slice(0, 256),
      date: String(date ?? '').slice(0, 64),
      message: containsCredentialContent(messageParts.join('|'))
        ? '[redacted]'
        : messageParts.join('|').slice(0, 2048)
    }
  })
}

export async function listGitNasCommits(database, rawRepositoryId, limit, { runGit = createDefaultReadOnlyGitRunner() } = {}) {
  const repository = getGitNasRepository(database, rawRepositoryId)
  const rootPath = canonicalizeNasScanRoot(repository.rootPath)
  const repositoryPath = pathFromRoot(rootPath, repository.relativePath, { allowRoot: true }).candidatePath
  await inspectGitRepository(repositoryPath, rootPath, runGit)
  const result = await runAllowedGit(runGit, repositoryPath, [
    'log', '--pretty=format:%H|%an|%ad|%s', '--date=format:%Y-%m-%d %H:%M:%S', '-n', String(normalizeCommitLimit(limit))
  ])
  return parseGitLog(result.stdout)
}

function parseChangedFiles(output) {
  const files = []
  for (const line of String(output ?? '').split('\n')) {
    const match = line.match(/^\s+(.+?)\s*\|\s*(\d+)/u)
    if (!match) continue
    const file = match[1].trim().replaceAll('\\', '/')
    if (isSensitivePath(file)) continue
    files.push({ file, changes: Number(match[2]) })
  }
  return files
}

export async function getGitNasCommitDetail(database, rawRepositoryId, rawHash, { runGit = createDefaultReadOnlyGitRunner() } = {}) {
  const hash = normalizeCommitHash(rawHash)
  const repository = getGitNasRepository(database, rawRepositoryId)
  const rootPath = canonicalizeNasScanRoot(repository.rootPath)
  const repositoryPath = pathFromRoot(rootPath, repository.relativePath, { allowRoot: true }).candidatePath
  await inspectGitRepository(repositoryPath, rootPath, runGit)
  const statResult = await runAllowedGit(runGit, repositoryPath, [
    'show', '--no-ext-diff', '--no-textconv', '--stat', '--pretty=format:%H|%an|%ad|%s', hash, '--'
  ])
  // NAS Git history may contain credentials that are absent from the current
  // worktree. Return bounded metadata only; never expose raw historical diffs.
  return {
    hash,
    diff: '',
    files: parseChangedFiles(statResult?.stdout)
  }
}

export function getGitNasRepositorySize(database, rawRepositoryId) {
  const repository = getGitNasRepository(database, rawRepositoryId)
  const rootPath = canonicalizeNasScanRoot(repository.rootPath)
  const repositoryPath = pathFromRoot(rootPath, repository.relativePath, { allowRoot: true }).candidatePath
  let total = 0
  function visit(directoryPath, relativePath) {
    for (const name of readStableDirectoryNames(repositoryPath, directoryPath)) {
      const childRelative = relativePath ? `${relativePath}/${name}` : name
      if (isSensitivePath(childRelative)) continue
      const childPath = path.join(directoryPath, name)
      const child = inspectPath(repositoryPath, childPath)
      if (child.stat.isDirectory()) visit(child.realPath, childRelative)
      else if (child.stat.isFile()) total += child.stat.size
    }
  }
  visit(repositoryPath, '')
  return total
}

export default Object.freeze({
  discoverGitNasRepositories,
  importGitNasCandidate,
  listGitNasCandidates,
  getGitNasRepository,
  listGitNasTree,
  readGitNasFile,
  readGitNasReadme,
  listGitNasCommits,
  getGitNasCommitDetail,
  getGitNasRepositorySize
})
