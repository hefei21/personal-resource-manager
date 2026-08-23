import fs from 'node:fs'
import path from 'node:path'
import ignorePackage from 'ignore'
import {
  DEFAULT_CREDENTIAL_GLOBS,
  DEFAULT_EXCLUDED_GLOBS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  normalizeNasScanRules
} from '../config/nasScan.js'

const createIgnore = typeof ignorePackage === 'function'
  ? ignorePackage
  : ignorePackage.default
const MAX_GITIGNORE_BYTES = 1024 * 1024

export const NAS_SCAN_ERROR_CODES = Object.freeze({
  ROOT_INVALID: 'NAS_SCAN_ROOT_INVALID',
  ROOT_NOT_ABSOLUTE: 'NAS_SCAN_ROOT_NOT_ABSOLUTE',
  ROOT_MISSING: 'NAS_SCAN_ROOT_MISSING',
  ROOT_ACCESS_DENIED: 'NAS_SCAN_ROOT_ACCESS_DENIED',
  ROOT_NOT_DIRECTORY: 'NAS_SCAN_ROOT_NOT_DIRECTORY',
  ROOT_SYMLINK: 'NAS_SCAN_ROOT_SYMLINK',
  ROOT_REALPATH_FAILED: 'NAS_SCAN_ROOT_REALPATH_FAILED',
  ENTRY_STAT_FAILED: 'NAS_SCAN_ENTRY_STAT_FAILED',
  ENTRY_MISSING: 'NAS_SCAN_ENTRY_MISSING',
  ENTRY_ACCESS_DENIED: 'NAS_SCAN_ENTRY_ACCESS_DENIED',
  SYMLINK_FORBIDDEN: 'NAS_SCAN_SYMLINK_FORBIDDEN',
  REALPATH_ESCAPE: 'NAS_SCAN_REALPATH_ESCAPE',
  DIRECTORY_READ_FAILED: 'NAS_SCAN_DIRECTORY_READ_FAILED',
  GITIGNORE_STAT_FAILED: 'NAS_SCAN_GITIGNORE_STAT_FAILED',
  GITIGNORE_ACCESS_DENIED: 'NAS_SCAN_GITIGNORE_ACCESS_DENIED',
  GITIGNORE_INVALID: 'NAS_SCAN_GITIGNORE_INVALID'
})

export const NAS_SCAN_EXCLUSION_CODES = Object.freeze({
  DEFAULT: 'DEFAULT_EXCLUDED',
  CREDENTIAL: 'CREDENTIAL_PATH',
  GITIGNORE: 'GITIGNORE',
  CUSTOM_GLOB: 'EXCLUDED_GLOB',
  EXTENSION: 'EXTENSION_NOT_ALLOWED',
  SIZE: 'FILE_TOO_LARGE',
  SPECIAL: 'SPECIAL_FILE',
  DEPTH: 'MAX_DEPTH'
})

export class NasScanSecurityError extends Error {
  constructor(code, message = 'NAS scan security validation failed.') {
    super(message)
    this.name = 'NasScanSecurityError'
    this.code = code
  }
}

function fail(code, message) {
  throw new NasScanSecurityError(code, message)
}

function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM'
}

function realpathNative(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value)
}

function isInside(rootPath, candidatePath, allowRoot = false) {
  const relative = path.relative(rootPath, candidatePath)
  if (relative === '') return allowRoot
  return relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function safeRelativePath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  if (!isInside(rootPath, candidatePath)) {
    fail(NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE, 'NAS scan entry is outside its configured root.')
  }
  const normalized = relative.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    fail(NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE, 'NAS scan entry has an invalid relative path.')
  }
  return normalized
}

function rootFailure(error) {
  if (error instanceof NasScanSecurityError) throw error
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    fail(NAS_SCAN_ERROR_CODES.ROOT_MISSING, 'NAS scan root could not be found.')
  }
  if (isPermissionError(error)) {
    fail(NAS_SCAN_ERROR_CODES.ROOT_ACCESS_DENIED, 'NAS scan root could not be accessed.')
  }
  if (error?.code === 'ELOOP') {
    fail(NAS_SCAN_ERROR_CODES.ROOT_SYMLINK, 'NAS scan root may not be a symbolic link.')
  }
  fail(NAS_SCAN_ERROR_CODES.ROOT_REALPATH_FAILED, 'NAS scan root could not be resolved.')
}

/**
 * Validate and resolve a user-selected NAS scan root.
 *
 * This function never creates directories.  `lstat` is intentionally used
 * before `realpath` so a configured symlink root is rejected rather than
 * silently accepted as an alias for a different directory.
 */
export function canonicalizeNasScanRoot(input) {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    fail(NAS_SCAN_ERROR_CODES.ROOT_INVALID, 'NAS scan root must be a non-empty path.')
  }
  if (!path.isAbsolute(input)) {
    fail(NAS_SCAN_ERROR_CODES.ROOT_NOT_ABSOLUTE, 'NAS scan root must be absolute.')
  }

  const requested = path.normalize(input)
  let stat
  try {
    stat = fs.lstatSync(requested)
  } catch (error) {
    rootFailure(error)
  }
  if (stat.isSymbolicLink()) {
    fail(NAS_SCAN_ERROR_CODES.ROOT_SYMLINK, 'NAS scan root may not be a symbolic link.')
  }
  if (!stat.isDirectory()) {
    fail(NAS_SCAN_ERROR_CODES.ROOT_NOT_DIRECTORY, 'NAS scan root must be a directory.')
  }

  let realRoot
  try {
    realRoot = realpathNative(requested)
    const realStat = fs.lstatSync(realRoot)
    if (realStat.isSymbolicLink() || !realStat.isDirectory()) {
      fail(NAS_SCAN_ERROR_CODES.ROOT_REALPATH_FAILED, 'NAS scan root could not be resolved.')
    }
  } catch (error) {
    rootFailure(error)
  }
  return realRoot
}

function normalizeGitignoreText(content) {
  // BOM and CRLF are common in files authored on Windows. Backslashes remain
  // untouched because Git treats them as pattern escape characters.
  return content
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
}

function createMatcher(patterns, code) {
  if (!patterns.length) return null
  try {
    return createIgnore().add(patterns)
  } catch {
    fail(code, 'NAS scan ignore rules are invalid.')
  }
}

function gitignoreFailure(error) {
  if (error instanceof NasScanSecurityError) throw error
  if (isPermissionError(error)) {
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_ACCESS_DENIED, 'NAS scan ignore rules could not be accessed.')
  }
  if (error?.code === 'ENOENT') return null
  fail(NAS_SCAN_ERROR_CODES.GITIGNORE_STAT_FAILED, 'NAS scan ignore rules could not be inspected.')
}

function relativeFromBase(baseRelative, candidateRelative) {
  if (!baseRelative) return candidateRelative
  const relative = path.posix.relative(baseRelative, candidateRelative)
  if (!relative || relative === '..' || relative.startsWith('../')) return null
  return relative
}

function readGitignore(directoryPath, rootPath, directoryRelative) {
  const gitignorePath = path.join(directoryPath, '.gitignore')
  let stat
  try {
    stat = fs.lstatSync(gitignorePath)
  } catch (error) {
    return gitignoreFailure(error)
  }
  if (stat.isSymbolicLink()) {
    fail(NAS_SCAN_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS scan ignore rules may not be symbolic links.')
  }
  if (!stat.isFile()) {
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_STAT_FAILED, 'NAS scan ignore rules must be regular files.')
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_GITIGNORE_BYTES) {
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID, 'NAS scan ignore rules exceed the safe size limit.')
  }
  let realPath
  try {
    realPath = realpathNative(gitignorePath)
  } catch (error) {
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.GITIGNORE_ACCESS_DENIED, 'NAS scan ignore rules could not be accessed.')
    }
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_STAT_FAILED, 'NAS scan ignore rules could not be resolved.')
  }
  if (!isInside(rootPath, realPath)) {
    fail(NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE, 'NAS scan ignore rules are outside their configured root.')
  }
  let content
  try {
    // `.gitignore` is scanner control metadata.  No other file contents are
    // read by this service.
    content = fs.readFileSync(realPath, 'utf8')
  } catch (error) {
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.GITIGNORE_ACCESS_DENIED, 'NAS scan ignore rules could not be accessed.')
    }
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_STAT_FAILED, 'NAS scan ignore rules could not be read.')
  }
  try {
    return {
      baseRelative: directoryRelative,
      matcher: createIgnore().add(normalizeGitignoreText(content))
    }
  } catch {
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID, 'NAS scan ignore rules are invalid.')
  }
}

function entryFailure(error) {
  if (error instanceof NasScanSecurityError) throw error
  if (error?.code === 'ENOENT') {
    fail(NAS_SCAN_ERROR_CODES.ENTRY_MISSING, 'NAS scan entry disappeared during traversal.')
  }
  if (isPermissionError(error)) {
    fail(NAS_SCAN_ERROR_CODES.ENTRY_ACCESS_DENIED, 'NAS scan entry could not be accessed.')
  }
  fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'NAS scan entry could not be inspected.')
}

function inspectEntry(rootPath, candidatePath) {
  let stat
  try {
    stat = fs.lstatSync(candidatePath, { bigint: true })
  } catch (error) {
    entryFailure(error)
  }
  if (stat.isSymbolicLink()) {
    fail(NAS_SCAN_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS scan symbolic links are not followed.')
  }

  let realPath
  try {
    realPath = realpathNative(candidatePath)
  } catch (error) {
    entryFailure(error)
  }
  if (!isInside(rootPath, realPath)) {
    fail(NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE, 'NAS scan entry is outside its configured root.')
  }
  return { stat, relativePath: safeRelativePath(rootPath, realPath) }
}

function statSize(stat) {
  return typeof stat.size === 'bigint' ? stat.size.toString() : String(stat.size)
}

function statMtimeNs(stat) {
  if (typeof stat.mtimeNs === 'bigint') return stat.mtimeNs.toString()
  if (Number.isFinite(stat.mtimeMs)) {
    return (BigInt(Math.trunc(stat.mtimeMs)) * 1000000n).toString()
  }
  return '0'
}

function fileIdentifier(stat, kind) {
  if (kind !== 'file' || stat.dev === undefined || stat.ino === undefined) return null
  const identifier = `${String(stat.dev)}:${String(stat.ino)}`
  return identifier === '0:0' ? null : identifier
}

function isSafeEnvExample(relativePath) {
  const base = path.posix.basename(relativePath).toLowerCase()
  return base === '.env.example' || /^\.env\.[^.]+(?:\.[^.]+)*\.example$/u.test(base)
}

function matcherIgnores(matcher, relativePath) {
  if (!matcher) return false
  try {
    return matcher.ignores(relativePath)
  } catch {
    // The path is generated from readdir and already validated; a matcher
    // failure therefore denotes a broken rule/structure, not an exclusion.
    fail(NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID, 'NAS scan ignore rules could not evaluate an entry.')
  }
}

function safetyMatcherIgnores(matcher, relativePath) {
  return matcherIgnores(matcher, relativePath) ||
    matcherIgnores(matcher, relativePath.toLowerCase())
}

function gitignored(contexts, relativePath) {
  let ignored = false
  for (const context of contexts) {
    const candidate = relativeFromBase(context.baseRelative, relativePath)
    if (!candidate) continue
    let result
    try {
      result = context.matcher.test(candidate)
    } catch {
      fail(NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID, 'NAS scan ignore rules could not evaluate an entry.')
    }
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

function makeRecord(relativePath, kind, stat, decision, exclusionCode = null) {
  return {
    relativePath,
    kind,
    size: statSize(stat),
    mtimeNs: statMtimeNs(stat),
    fileIdentifier: fileIdentifier(stat, kind),
    decision,
    exclusionCode
  }
}

function classifyEntry({ relativePath, kind, stat }, rules, matchers, contexts, depth) {
  // Safety matchers run first and have no negation path.  This keeps the
  // credential and generated-output denylist stronger than user or Git rules.
  const envExample = isSafeEnvExample(relativePath)
  const credential = !envExample && safetyMatcherIgnores(matchers.credential, relativePath)
  if (credential) return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.CREDENTIAL)
  if (safetyMatcherIgnores(matchers.defaultExcluded, relativePath)) {
    return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.DEFAULT)
  }
  if (matcherIgnores(matchers.customExcluded, relativePath)) {
    return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.CUSTOM_GLOB)
  }
  if (rules.useGitignore && gitignored(contexts, relativePath)) {
    return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
  }
  if (kind === 'special') {
    return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.SPECIAL)
  }
  if (depth > rules.maxDepth) {
    return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.DEPTH)
  }
  if (kind === 'file') {
    const size = typeof stat.size === 'bigint' ? stat.size : BigInt(Math.max(0, Math.trunc(stat.size)))
    if (size > BigInt(rules.maxFileBytes)) {
      return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.SIZE)
    }
    if (rules.allowedExtensions && !rules.allowedExtensions.includes(path.posix.extname(relativePath).toLowerCase())) {
      return makeRecord(relativePath, kind, stat, 'excluded', NAS_SCAN_EXCLUSION_CODES.EXTENSION)
    }
  }
  return makeRecord(relativePath, kind, stat, 'included')
}

function makeMatchers(rules) {
  const defaultExcluded = createMatcher(DEFAULT_EXCLUDED_GLOBS, NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID)
  const credential = createMatcher(
    [...DEFAULT_CREDENTIAL_GLOBS, ...rules.credentialGlobs],
    NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID
  )
  const customExcluded = createMatcher(rules.excludedGlobs, NAS_SCAN_ERROR_CODES.GITIGNORE_INVALID)
  return { defaultExcluded, credential, customExcluded }
}

function readDirectory(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  } catch (error) {
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.DIRECTORY_READ_FAILED, 'NAS scan directory could not be accessed.')
    }
    fail(NAS_SCAN_ERROR_CODES.DIRECTORY_READ_FAILED, 'NAS scan directory could not be read.')
  }
}

async function* walkDirectory(rootPath, directoryPath, directoryRelative, depth, contexts, rules, matchers) {
  const ownContext = rules.useGitignore
    ? readGitignore(directoryPath, rootPath, directoryRelative)
    : null
  const activeContexts = ownContext ? [...contexts, ownContext] : contexts
  const names = readDirectory(directoryPath)

  for (const name of names) {
    // Names returned by readdir cannot contain a path separator, but retain a
    // structural check so this remains true if the filesystem adapter changes.
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'NAS scan directory returned an invalid entry name.')
    }
    const candidatePath = path.join(directoryPath, name)
    const { stat, relativePath } = inspectEntry(rootPath, candidatePath)
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special'
    const entryDepth = directoryRelative ? directoryRelative.split('/').length + 1 : 1
    const record = classifyEntry({ relativePath, kind, stat }, rules, matchers, activeContexts, entryDepth)
    yield record

    if (kind === 'directory' && record.decision === 'included') {
      yield* walkDirectory(rootPath, candidatePath, relativePath, entryDepth, activeContexts, rules, matchers)
    }
  }
}

/**
 * Read-only, symlink-free NAS traversal.  The generator yields metadata only;
 * it never opens or hashes ordinary files.
 */
export async function* walkNasScanRoot(rootInput, inputRules = {}) {
  let rootPath = rootInput
  if (rootInput && typeof rootInput === 'object' && !Array.isArray(rootInput)) {
    rootPath = rootInput.rootPath ?? rootInput.root ?? rootInput.path
    inputRules = rootInput.rules ?? {}
  }
  const realRoot = canonicalizeNasScanRoot(rootPath)
  const rulesInput = inputRules && Object.hasOwn(inputRules, 'rules')
    ? inputRules.rules
    : inputRules
  const rules = normalizeNasScanRules(rulesInput)
  const matchers = makeMatchers(rules)
  yield* walkDirectory(realRoot, realRoot, '', 0, [], rules, matchers)
}

export function getDefaultNasScanRules() {
  return {
    version: 1,
    useGitignore: true,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    allowedExtensions: null,
    excludedGlobs: [],
    credentialGlobs: [],
    maxDepth: DEFAULT_MAX_DEPTH
  }
}
