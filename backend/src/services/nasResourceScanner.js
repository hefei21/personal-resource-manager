import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { normalizeNasScanRules } from '../config/nasScan.js'
import {
  canonicalizeNasScanRoot,
  NAS_SCAN_ERROR_CODES,
  NAS_SCAN_EXCLUSION_CODES,
  walkNasScanRoot
} from './nasScanSecurity.js'
import {
  classifyNasResourceType,
  commitNasResourceScan,
  NAS_RESOURCE_ERROR_CODES
} from './nasResourceCommitService.js'

export { classifyNasResourceType, NAS_RESOURCE_ERROR_CODES }
export { NAS_SCAN_ERROR_CODES, NAS_SCAN_EXCLUSION_CODES }

export const NAS_RESOURCE_EXCLUSION_CODES = Object.freeze({
  ...NAS_SCAN_EXCLUSION_CODES,
  CREDENTIAL_CONTENT: 'CREDENTIAL_CONTENT'
})

export class NasResourceScanError extends Error {
  constructor(code, message = 'NAS resource scan failed.', relativePath = null) {
    super(message)
    this.name = 'NasResourceScanError'
    this.code = code
    if (relativePath) this.relativePath = relativePath
  }
}

function fail(code, message, relativePath = null) {
  throw new NasResourceScanError(code, message, relativePath)
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean'
}

function assertNotAborted(signal, relativePath = null) {
  if (signal?.aborted) fail(NAS_RESOURCE_ERROR_CODES.CANCELLED, 'The NAS scan was cancelled.', relativePath)
}

function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM'
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(NAS_RESOURCE_ERROR_CODES.PATH_INVALID, 'The scan path is invalid.')
  }
  const relativePath = value.replaceAll('\\', '/')
  if (
    relativePath.startsWith('/') ||
    /^[a-z]:\//iu.test(relativePath) ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(NAS_RESOURCE_ERROR_CODES.PATH_INVALID, 'The scan path is invalid.')
  }
  return relativePath
}

function fileIdentifier(stat) {
  if (!stat || stat.dev === undefined || stat.ino === undefined) return null
  const identifier = `${String(stat.dev)}:${String(stat.ino)}`
  return identifier === '0:0' ? null : identifier
}

function statSize(stat) {
  return typeof stat.size === 'bigint' ? stat.size.toString() : String(stat.size)
}

function statMtimeNs(stat) {
  if (typeof stat.mtimeNs === 'bigint') return stat.mtimeNs.toString()
  if (Number.isFinite(stat.mtimeMs)) return (BigInt(Math.trunc(stat.mtimeMs)) * 1000000n).toString()
  return '0'
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function realpathNative(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value)
}

function absolutePathFor(rootPath, relativePath) {
  const safePath = safeRelativePath(relativePath)
  const candidatePath = path.join(rootPath, ...safePath.split('/'))
  const relative = path.relative(rootPath, candidatePath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(NAS_RESOURCE_ERROR_CODES.PATH_INVALID, 'The scan path is invalid.', safePath)
  }
  return { candidatePath, relativePath: safePath }
}

function inspectHashFile(rootPath, relativePath) {
  const { candidatePath, relativePath: safePath } = absolutePathFor(rootPath, relativePath)
  let stat
  try {
    stat = fs.lstatSync(candidatePath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail(NAS_RESOURCE_ERROR_CODES.FILE_MISSING, 'The file disappeared during scanning.', safePath)
    }
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.ENTRY_ACCESS_DENIED, 'The file could not be accessed.', safePath)
    }
    fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'The file could not be inspected.', safePath)
  }
  if (stat.isSymbolicLink()) {
    fail(NAS_SCAN_ERROR_CODES.SYMLINK_FORBIDDEN, 'NAS scan symbolic links are not followed.', safePath)
  }
  if (!stat.isFile()) {
    fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'The scanned entry is no longer a regular file.', safePath)
  }
  let realPath
  try {
    realPath = realpathNative(candidatePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail(NAS_RESOURCE_ERROR_CODES.FILE_MISSING, 'The file disappeared during scanning.', safePath)
    }
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.ENTRY_ACCESS_DENIED, 'The file could not be accessed.', safePath)
    }
    fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'The file could not be resolved.', safePath)
  }
  if (!isInside(rootPath, realPath)) {
    fail(NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE, 'NAS scan entry is outside its configured root.', safePath)
  }
  return {
    candidatePath,
    relativePath: safePath,
    stat,
    realPath,
    fileIdentifier: fileIdentifier(stat),
    size: statSize(stat),
    mtimeNs: statMtimeNs(stat)
  }
}

function sameSnapshot(before, after) {
  return before.fileIdentifier === after.fileIdentifier &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.realPath === after.realPath
}

// Only fixed, high-confidence formats are detected.  This deliberately does
// not attempt generic secret heuristics, which would create noisy exclusions.
const CONTENT_CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u
])

function hasContentCredential(bufferText) {
  return CONTENT_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(bufferText))
}

function fileErrorObservation(relativePath, errorCode, metadata = {}) {
  return {
    relativePath,
    kind: 'file',
    status: 'error',
    errorCode,
    fileIdentifier: metadata.fileIdentifier ?? null,
    size: metadata.size ?? null,
    mtimeNs: metadata.mtimeNs ?? null,
    contentSha256: null,
    title: path.posix.basename(relativePath),
    resourceType: classifyNasResourceType(relativePath)
  }
}

async function reportProgress(callback, value) {
  if (typeof callback === 'function') await callback(Object.freeze({ ...value }))
}

function normalizeHashOptions(first, second) {
  if (typeof first === 'string') {
    if (typeof second === 'string') return { filePath: first, relativePath: second }
    return { filePath: first, ...(second ?? {}) }
  }
  return first ?? {}
}

/**
 * Hash one file outside any SQLite transaction.  The file is lstat/realpath
 * checked both before and after streaming; a changed file yields a stable
 * error observation without returning its digest.
 */
export async function hashNasFile(first, second) {
  const options = normalizeHashOptions(first, second)
  const signal = isAbortSignal(options.signal) ? options.signal : null
  const rootPath = options.rootPath ?? options.root ?? null
  const relativePath = safeRelativePath(options.relativePath ?? options.path)
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    fail(NAS_RESOURCE_ERROR_CODES.INPUT_INVALID, 'A scan root is required.', relativePath)
  }
  assertNotAborted(signal, relativePath)
  const canonicalRoot = canonicalizeNasScanRoot(rootPath)
  let before
  try {
    before = inspectHashFile(canonicalRoot, relativePath)
  } catch (error) {
    if (error?.code === NAS_RESOURCE_ERROR_CODES.FILE_MISSING) {
      return fileErrorObservation(relativePath, NAS_RESOURCE_ERROR_CODES.FILE_MISSING, options.metadata)
    }
    throw error
  }
  let digest
  let bytesRead = 0
  let credentialDetected = false
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(before.candidatePath)
  let tail = ''
  const abort = () => stream.destroy(Object.assign(new Error('scan cancelled'), { code: 'ABORT_ERR' }))
  if (signal) signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) {
      assertNotAborted(signal, relativePath)
      hash.update(chunk)
      bytesRead += chunk.length
      const text = tail + chunk.toString('utf8')
      if (!credentialDetected && hasContentCredential(text)) credentialDetected = true
      tail = text.slice(-256)
      await reportProgress(options.onProgress, {
        phase: 'hashing',
        relativePath,
        bytesRead
      })
    }
    assertNotAborted(signal, relativePath)
    digest = hash.digest('hex')
  } catch (error) {
    if (signal?.aborted || error?.code === 'ABORT_ERR') {
      fail(NAS_RESOURCE_ERROR_CODES.CANCELLED, 'The NAS scan was cancelled.', relativePath)
    }
    if (error instanceof NasResourceScanError) throw error
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return fileErrorObservation(relativePath, NAS_RESOURCE_ERROR_CODES.FILE_MISSING, before)
    }
    if (isPermissionError(error)) {
      fail(NAS_SCAN_ERROR_CODES.ENTRY_ACCESS_DENIED, 'The file could not be read.', relativePath)
    }
    fail(NAS_SCAN_ERROR_CODES.ENTRY_STAT_FAILED, 'The file could not be read.', relativePath)
  } finally {
    if (signal) signal.removeEventListener('abort', abort)
  }

  let after
  try {
    after = inspectHashFile(canonicalRoot, relativePath)
  } catch (error) {
    if (error?.code === NAS_RESOURCE_ERROR_CODES.FILE_MISSING) {
      return fileErrorObservation(relativePath, NAS_RESOURCE_ERROR_CODES.FILE_MISSING, before)
    }
    throw error
  }
  if (!sameSnapshot(before, after) || Number(after.size) !== bytesRead) {
    return {
      relativePath,
      kind: 'file',
      status: 'error',
      errorCode: NAS_RESOURCE_ERROR_CODES.FILE_CHANGED,
      fileIdentifier: after.fileIdentifier,
      size: after.size,
      mtimeNs: after.mtimeNs,
      contentSha256: null,
      title: path.posix.basename(relativePath),
      resourceType: classifyNasResourceType(relativePath)
    }
  }
  if (credentialDetected) {
    return {
      relativePath,
      kind: 'file',
      status: 'excluded',
      exclusionCode: NAS_RESOURCE_EXCLUSION_CODES.CREDENTIAL_CONTENT,
      errorCode: NAS_RESOURCE_EXCLUSION_CODES.CREDENTIAL_CONTENT,
      fileIdentifier: after.fileIdentifier,
      size: after.size,
      mtimeNs: after.mtimeNs,
      contentSha256: null,
      title: path.posix.basename(relativePath),
      resourceType: classifyNasResourceType(relativePath)
    }
  }
  return {
    relativePath,
    kind: 'file',
    status: 'discovered',
    fileIdentifier: after.fileIdentifier,
    size: after.size,
    mtimeNs: after.mtimeNs,
    contentSha256: digest,
    title: path.posix.basename(relativePath),
    resourceType: classifyNasResourceType(relativePath)
  }
}

export const hashNasScanFile = hashNasFile
export const hashScannedNasFile = hashNasFile
export const streamHashNasFile = hashNasFile

function parseRules(value) {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { fail(NAS_RESOURCE_ERROR_CODES.INPUT_INVALID, 'The scan rules are invalid.') }
  }
  return value
}

function normalizeScanOptions(first, second) {
  if (typeof first === 'string') return { ...(second ?? {}), rootPath: first }
  const options = first ?? {}
  const scanRoot = options.scanRoot ?? options.rootRecord ?? (
    options.root && typeof options.root === 'object' ? options.root : null
  )
  const rootPath = options.rootPath ?? (typeof options.root === 'string' ? options.root : null) ??
    scanRoot?.rootPath ?? scanRoot?.root_path ?? scanRoot?.path
  const scanRootId = options.scanRootId ?? options.rootId ?? scanRoot?.id
  const rules = options.rules ?? parseRules(scanRoot?.rules ?? scanRoot?.rules_json)
  return { ...options, rootPath, scanRootId, rules }
}

/**
 * Traverse and hash a complete root.  Only included regular files are hashed;
 * directories produce progress callbacks, while excluded entries become
 * safe observations for the commit service.
 */
export async function collectNasResourceObservations(first, second) {
  const options = normalizeScanOptions(first, second)
  const signal = isAbortSignal(options.signal) ? options.signal : null
  assertNotAborted(signal)
  if (typeof options.rootPath !== 'string' || options.rootPath.length === 0) {
    fail(NAS_RESOURCE_ERROR_CODES.INPUT_INVALID, 'A scan root is required.')
  }
  const rootPath = canonicalizeNasScanRoot(options.rootPath)
  const rules = normalizeNasScanRules(options.rules ?? {})
  const observations = []
  let visitedEntries = 0
  let files = 0
  let excluded = 0
  for await (const record of walkNasScanRoot(rootPath, rules)) {
    assertNotAborted(signal, record.relativePath)
    visitedEntries += 1
    if (record.kind === 'directory') {
      await reportProgress(options.onProgress, {
        phase: 'directory',
        relativePath: record.relativePath,
        visitedEntries
      })
      continue
    }
    if (record.decision === 'excluded') {
      excluded += 1
      observations.push({
        relativePath: record.relativePath,
        kind: record.kind,
        status: 'excluded',
        exclusionCode: record.exclusionCode,
        errorCode: record.exclusionCode,
        fileIdentifier: record.fileIdentifier,
        size: record.size,
        mtimeNs: record.mtimeNs,
        contentSha256: null,
        title: path.posix.basename(record.relativePath),
        resourceType: classifyNasResourceType(record.relativePath)
      })
      await reportProgress(options.onProgress, {
        phase: 'excluded',
        relativePath: record.relativePath,
        visitedEntries,
        excluded
      })
      continue
    }
    if (record.kind !== 'file') continue
    files += 1
    await reportProgress(options.onProgress, {
      phase: 'discovered',
      relativePath: record.relativePath,
      visitedEntries,
      files
    })
    const observation = await hashNasFile({
      rootPath,
      relativePath: record.relativePath,
      metadata: record,
      signal,
      onProgress: options.onProgress
    })
    observations.push(observation)
  }
  return {
    observations,
    visitedEntries,
    files,
    excluded,
    rulesVersion: rules.version
  }
}

export const scanNasResourceFiles = collectNasResourceObservations
export const discoverNasResourceFiles = collectNasResourceObservations

/**
 * End-to-end scan.  Supplying `database` and `scanRootId` performs the
 * generation-fenced commit after all filesystem work succeeds; omitting them
 * returns safe observations for a caller that wants to stage its own commit.
 */
export async function scanNasResourceRoot(first, second) {
  let options = normalizeScanOptions(first, second)
  if (options.database) {
    if (options.scanRootId === undefined || options.scanRootId === null) {
      fail(NAS_RESOURCE_ERROR_CODES.ROOT_ID_REQUIRED, 'A scan root id is required for a database commit.')
    }
    const root = options.database.prepare(`
      SELECT root_path, rules_json, enabled, last_successful_generation
      FROM nas_scan_roots
      WHERE id = ?
    `).get(options.scanRootId)
    if (!root) fail(NAS_RESOURCE_ERROR_CODES.ROOT_NOT_FOUND, 'The scan root was not found.')
    if (Number(root.enabled) !== 1) fail(NAS_RESOURCE_ERROR_CODES.ROOT_DISABLED, 'The scan root is disabled.')
    options = {
      ...options,
      rootPath: root.root_path,
      rules: parseRules(root.rules_json),
      generation: options.generation ?? Number(root.last_successful_generation) + 1
    }
  }
  const collected = await collectNasResourceObservations(options)
  if (!options.database) return collected
  const committed = commitNasResourceScan({
    database: options.database,
    scanRootId: options.scanRootId,
    generation: options.generation,
    observations: collected.observations
  })
  return { ...collected, ...committed }
}

export const scanNasScanRoot = scanNasResourceRoot
export const runNasResourceScan = scanNasResourceRoot
export const scanNasRoot = scanNasResourceRoot
