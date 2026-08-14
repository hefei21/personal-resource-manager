import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { parseStorageKey, StorageServiceError } from './storageService.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const TOKEN_PATTERN = /^[a-f0-9]{32}$/

export const CONSISTENCY_DISPOSITIONS = Object.freeze({
  REPORT_ONLY: 'report_only',
  SAFE_REPAIR_CANDIDATE: 'safe_repair_candidate',
  MANUAL_CONFIRMATION: 'manual_confirmation'
})

export class StorageConsistencyError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'StorageConsistencyError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new StorageConsistencyError(code, message, cause ? { cause } : undefined)
}

function redactedIdentifier(value) {
  return `object:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`
}

function issue(code, severity, disposition, resourceType, identity, evidence = {}) {
  return Object.freeze({
    code,
    severity,
    disposition,
    resourceType,
    objectId: redactedIdentifier(identity),
    evidence: Object.freeze(evidence)
  })
}

function assertRealDirectory(directory, root = directory) {
  let stat
  try { stat = fs.lstatSync(directory) } catch (error) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Managed storage directory is unavailable.', error)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Managed storage path must be a real directory.')
  }
  let real
  let realRoot
  try {
    real = fs.realpathSync.native(directory)
    realRoot = fs.realpathSync.native(root)
  } catch (error) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Managed storage path could not be resolved.', error)
  }
  const relative = path.relative(realRoot, real)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Managed storage path escaped its root.')
  }
  return real
}

async function inspectRegularFile(filePath, rootPath) {
  let stat
  try { stat = fs.lstatSync(filePath) } catch (error) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Storage entry could not be inspected.', error)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Storage entry must be a regular file.')
  }
  let real
  try { real = fs.realpathSync.native(filePath) } catch (error) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Storage entry could not be resolved.', error)
  }
  const relative = path.relative(rootPath, real)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Storage entry escaped its managed root.')
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of fs.createReadStream(real)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes, modifiedMs: stat.mtimeMs }
}

function readReferences(database) {
  if (!database || typeof database.prepare !== 'function') {
    fail('CONSISTENCY_DATABASE_INVALID', 'A readable database connection is required.')
  }
  try {
    const documents = database.prepare(`
      SELECT id, storage_key, content_sha256, content_bytes
      FROM documents
    `).all().map(row => ({ ...row, source: 'document', documentId: row.id }))
    const versions = database.prepare(`
      SELECT id, document_id, storage_key, content_sha256, content_bytes
      FROM document_versions
    `).all().map(row => ({ ...row, source: 'document_version', documentId: row.document_id }))
    const operations = database.prepare(`
      SELECT staging_token, state
      FROM storage_commit_operations
      WHERE state IN ('staged', 'object_committed')
    `).all()
    return { references: [...documents, ...versions], resumableTokens: new Set(operations.map(row => row.staging_token)) }
  } catch (error) {
    fail('CONSISTENCY_DATABASE_READ_FAILED', 'Consistency references could not be read.', error)
  }
}

function enumerateObjectEntries(objectsPath) {
  const root = assertRealDirectory(objectsPath)
  const entries = []
  for (const kindEntry of fs.readdirSync(root, { withFileTypes: true })) {
    const kindPath = path.join(root, kindEntry.name)
    if (kindEntry.isSymbolicLink()) {
      fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Object storage contains a symbolic link.')
    }
    if (!kindEntry.isDirectory()) {
      entries.push({ invalidIdentity: kindEntry.name })
      continue
    }
    assertRealDirectory(kindPath, root)
    for (const prefixEntry of fs.readdirSync(kindPath, { withFileTypes: true })) {
      const prefixPath = path.join(kindPath, prefixEntry.name)
      if (prefixEntry.isSymbolicLink()) {
        fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Object storage contains a symbolic link.')
      }
      if (!prefixEntry.isDirectory()) {
        entries.push({ invalidIdentity: `${kindEntry.name}/${prefixEntry.name}` })
        continue
      }
      assertRealDirectory(prefixPath, root)
      for (const objectEntry of fs.readdirSync(prefixPath, { withFileTypes: true })) {
        const relative = `${kindEntry.name}/${prefixEntry.name}/${objectEntry.name}`
        if (!objectEntry.isFile() || objectEntry.isSymbolicLink()) {
          fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Object storage contains a non-regular entry.')
        }
        entries.push({ storageKey: relative, filePath: path.join(prefixPath, objectEntry.name) })
      }
    }
  }
  return { root, entries }
}

function validateOptions({ storageService, now, stagingMaxAgeMs }) {
  if (!storageService?.objectsPath || !storageService?.stagingPath) {
    fail('CONSISTENCY_STORAGE_INVALID', 'A prepared StorageService is required.')
  }
  const currentTime = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(currentTime.getTime())) fail('CONSISTENCY_TIME_INVALID', 'Current time is invalid.')
  if (!Number.isSafeInteger(stagingMaxAgeMs) || stagingMaxAgeMs < 0) {
    fail('CONSISTENCY_STAGING_THRESHOLD_INVALID', 'Staging threshold must be a non-negative integer.')
  }
  return currentTime
}

export class StorageConsistencyService {
  constructor({ database, storageService, now = new Date(), stagingMaxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    this.database = database
    this.storageService = storageService
    this.now = now
    this.stagingMaxAgeMs = stagingMaxAgeMs
  }

  async inspect() {
    const currentTime = validateOptions(this)
    const { references, resumableTokens } = readReferences(this.database)
    const issues = []
    const referencesByKey = new Map()

    for (const reference of references) {
      if (reference.storage_key == null || reference.storage_key === '') {
        // Legacy-only rows remain valid until their explicit migration node.
        continue
      }
      let parsed
      try { parsed = parseStorageKey(reference.storage_key) } catch (error) {
        if (!(error instanceof StorageServiceError)) throw error
        issues.push(issue('INVALID_STORAGE_KEY', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          reference.source, `${reference.source}:${reference.id}`, { referenceId: reference.id }))
        continue
      }
      if (!HASH_PATTERN.test(reference.content_sha256 ?? '') ||
          !Number.isSafeInteger(reference.content_bytes) || reference.content_bytes < 0 ||
          parsed.sha256 !== reference.content_sha256) {
        issues.push(issue('STORAGE_METADATA_MISMATCH', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          parsed.kind, reference.storage_key, { referenceId: reference.id, source: reference.source }))
      }
      const group = referencesByKey.get(reference.storage_key) ?? []
      group.push(reference)
      referencesByKey.set(reference.storage_key, group)
    }

    const { root: objectsRoot, entries } = enumerateObjectEntries(this.storageService.objectsPath)
    const objects = new Map()
    for (const entry of entries) {
      if (entry.invalidIdentity) {
        issues.push(issue('INVALID_STORAGE_KEY', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          'unknown', entry.invalidIdentity))
        continue
      }
      let parsed
      try { parsed = parseStorageKey(entry.storageKey) } catch (error) {
        if (!(error instanceof StorageServiceError)) throw error
        issues.push(issue('INVALID_STORAGE_KEY', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          'unknown', entry.storageKey))
        continue
      }
      const metadata = await inspectRegularFile(entry.filePath, objectsRoot)
      objects.set(entry.storageKey, { parsed, metadata })
      if (metadata.sha256 !== parsed.sha256) {
        issues.push(issue('OBJECT_HASH_MISMATCH', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          parsed.kind, entry.storageKey, { actualBytes: metadata.bytes }))
      }
      if (!referencesByKey.has(entry.storageKey)) {
        issues.push(issue('ORPHAN_OBJECT', 'warning', CONSISTENCY_DISPOSITIONS.SAFE_REPAIR_CANDIDATE,
          parsed.kind, entry.storageKey, { actualBytes: metadata.bytes }))
      }
    }

    for (const [storageKey, group] of referencesByKey) {
      const parsed = parseStorageKey(storageKey)
      const object = objects.get(storageKey)
      if (!object) {
        issues.push(issue('MISSING_OBJECT', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          parsed.kind, storageKey, { referenceCount: group.length }))
        continue
      }
      if (group.some(reference => reference.content_sha256 !== object.metadata.sha256 ||
        reference.content_bytes !== object.metadata.bytes)) {
        issues.push(issue('OBJECT_METADATA_MISMATCH', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          parsed.kind, storageKey, { referenceCount: group.length, actualBytes: object.metadata.bytes }))
      }
      const currentDocuments = group.filter(reference => reference.source === 'document')
      if (currentDocuments.length > 1) {
        issues.push(issue('DUPLICATE_BUSINESS_REFERENCE', 'warning', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          parsed.kind, storageKey, { referenceCount: group.length, currentDocumentCount: currentDocuments.length }))
      }
    }

    const stagingRoot = assertRealDirectory(this.storageService.stagingPath)
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail('CONSISTENCY_STORAGE_LAYOUT_INVALID', 'Staging contains a non-regular entry.')
      }
      const filePath = path.join(stagingRoot, entry.name)
      const metadata = await inspectRegularFile(filePath, stagingRoot)
      if (!TOKEN_PATTERN.test(entry.name)) {
        issues.push(issue('INVALID_STAGING_ENTRY', 'error', CONSISTENCY_DISPOSITIONS.MANUAL_CONFIRMATION,
          'staging', entry.name))
      } else if (!resumableTokens.has(entry.name) && currentTime.getTime() - metadata.modifiedMs > this.stagingMaxAgeMs) {
        issues.push(issue('EXPIRED_STAGING', 'warning', CONSISTENCY_DISPOSITIONS.SAFE_REPAIR_CANDIDATE,
          'staging', entry.name, { ageMs: currentTime.getTime() - metadata.modifiedMs, bytes: metadata.bytes }))
      }
    }

    issues.sort((left, right) => left.code.localeCompare(right.code) || left.objectId.localeCompare(right.objectId))
    return Object.freeze({
      inspectedAt: currentTime.toISOString(),
      issueCount: issues.length,
      issues: Object.freeze(issues),
      summary: Object.freeze(issues.reduce((result, current) => {
        result[current.code] = (result[current.code] ?? 0) + 1
        return result
      }, {}))
    })
  }
}
