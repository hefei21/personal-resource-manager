import { createHash } from 'node:crypto'
import path from 'node:path'

import { PRIVATE_DOCUMENT_MIGRATION_TABLE } from '../config/databaseMigrations.js'
import { documentOriginalName } from './documentStorageRuntime.js'
import { parseStorageKey } from './storageService.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const STATUS_VALUES = new Set(['migrated', 'skipped', 'failed'])
const SOURCE_ERROR_CODES = Object.freeze({
  LEGACY_STORAGE_PATH_INVALID: 'PRIVATE_MIGRATION_SOURCE_PATH_INVALID',
  LEGACY_STORAGE_OUTSIDE_ROOT: 'PRIVATE_MIGRATION_SOURCE_OUTSIDE_ROOT',
  LEGACY_STORAGE_SYMLINK_REJECTED: 'PRIVATE_MIGRATION_SOURCE_SYMLINK',
  LEGACY_STORAGE_FILE_MISSING: 'PRIVATE_MIGRATION_SOURCE_MISSING',
  LEGACY_STORAGE_FILE_INVALID: 'PRIVATE_MIGRATION_SOURCE_NOT_REGULAR_FILE',
  LEGACY_STORAGE_RANGE_INVALID: 'PRIVATE_MIGRATION_SOURCE_RANGE_INVALID'
})

const STORAGE_ERROR_CODES = Object.freeze({
  STORAGE_OBJECT_MISSING: 'PRIVATE_MIGRATION_TARGET_OBJECT_MISSING',
  STORAGE_OBJECT_INVALID: 'PRIVATE_MIGRATION_TARGET_OBJECT_INVALID',
  STORAGE_OBJECT_HASH_MISMATCH: 'PRIVATE_MIGRATION_TARGET_HASH_MISMATCH',
  STORAGE_OBJECT_COLLISION: 'PRIVATE_MIGRATION_TARGET_OBJECT_COLLISION',
  STORAGE_KEY_INVALID: 'PRIVATE_MIGRATION_TARGET_KEY_INVALID',
  STORAGE_DIRECTORY_INVALID: 'PRIVATE_MIGRATION_TARGET_DIRECTORY_INVALID'
})

export class PrivateSpaceMigrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'PrivateSpaceMigrationError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new PrivateSpaceMigrationError(code, message, cause ? { cause } : undefined)
}

function positiveId(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function nonNegativeBytes(value) {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null
}

function isSameOrWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function mapSourceError(error) {
  const code = SOURCE_ERROR_CODES[error?.code]
  if (code) return new PrivateSpaceMigrationError(code, 'Legacy source validation failed.', { cause: error })
  return error
}

function mapStorageError(error) {
  const code = STORAGE_ERROR_CODES[error?.code]
  if (code) return new PrivateSpaceMigrationError(code, 'Storage object validation failed.', { cause: error })
  return error
}

function normalizeFailure(error, fallback = 'PRIVATE_MIGRATION_UNEXPECTED_FAILURE') {
  if (error instanceof PrivateSpaceMigrationError) return error
  const source = mapSourceError(error)
  if (source !== error) return source
  const storage = mapStorageError(error)
  if (storage !== error) return storage
  if (String(error?.code ?? '').startsWith('SQLITE_')) {
    return new PrivateSpaceMigrationError(
      'PRIVATE_MIGRATION_DATABASE_WRITE_FAILED',
      'Private migration database write failed.',
      { cause: error }
    )
  }
  if (String(error?.code ?? '').startsWith('STORAGE_')) {
    return new PrivateSpaceMigrationError(
      'PRIVATE_MIGRATION_STORAGE_FAILED',
      'Private migration storage operation failed.',
      { cause: error }
    )
  }
  return new PrivateSpaceMigrationError(fallback, 'Private migration operation failed.', { cause: error })
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== 'function' ||
    typeof database.transaction !== 'function'
  ) {
    fail('PRIVATE_MIGRATION_DATABASE_INVALID', 'Private migration database is invalid.')
  }
}

function assertRuntime(runtime) {
  if (
    !runtime?.storageService ||
    typeof runtime.storageService.stageFromStream !== 'function' ||
    typeof runtime.storageService.commitStaged !== 'function' ||
    typeof runtime.storageService.stat !== 'function' ||
    !runtime?.legacyStorageAdapter ||
    typeof runtime.legacyStorageAdapter.stat !== 'function' ||
    typeof runtime.legacyStorageAdapter.createReadStream !== 'function'
  ) {
    fail('PRIVATE_MIGRATION_RUNTIME_INVALID', 'Private migration storage runtime is invalid.')
  }
}

function assertTable(database, tableName, code) {
  let row
  try {
    row = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName)
  } catch (error) {
    fail(code, 'Private migration schema could not be inspected.', error)
  }
  if (!row) fail(code, 'Private migration schema is incomplete.')
}

function assertDependencies(database, runtime) {
  assertDatabase(database)
  assertRuntime(runtime)
  assertTable(database, 'private_documents', 'PRIVATE_MIGRATION_SOURCE_TABLE_MISSING')
  assertTable(database, 'documents', 'PRIVATE_MIGRATION_TARGET_TABLE_MISSING')
  assertTable(database, 'document_versions', 'PRIVATE_MIGRATION_TARGET_VERSION_TABLE_MISSING')
  assertTable(database, PRIVATE_DOCUMENT_MIGRATION_TABLE, 'PRIVATE_MIGRATION_MAPPING_TABLE_MISSING')

  const storageRoot = runtime.storageService.rootPath
  const legacyRoots = runtime.legacyStorageAdapter.roots
  if (typeof storageRoot === 'string' && Array.isArray(legacyRoots)) {
    for (const legacyRoot of legacyRoots) {
      if (typeof legacyRoot === 'string' && (
        isSameOrWithin(storageRoot, legacyRoot) || isSameOrWithin(legacyRoot, storageRoot)
      )) {
        fail('PRIVATE_MIGRATION_STORAGE_ROOT_OVERLAP', 'Private migration storage root overlaps a legacy root.')
      }
    }
  }
}

function readLegacyRows(database) {
  try {
    return database.prepare(`
      SELECT id, title, file_path, size, created_at, updated_at
      FROM private_documents
      ORDER BY id
    `).all()
  } catch (error) {
    fail('PRIVATE_MIGRATION_SOURCE_READ_FAILED', 'Legacy private records could not be read.', error)
  }
}

function readMappings(database) {
  try {
    return database.prepare(`
      SELECT legacy_private_document_id, document_id, version_id, status,
             source_sha256, source_bytes, storage_key, content_sha256, content_bytes,
             issue_code, created_at, updated_at
      FROM ${PRIVATE_DOCUMENT_MIGRATION_TABLE}
      ORDER BY legacy_private_document_id
    `).all()
  } catch (error) {
    fail('PRIVATE_MIGRATION_MAPPING_READ_FAILED', 'Private migration mappings could not be read.', error)
  }
}

function normalizeLegacyRow(row) {
  const id = positiveId(row?.id)
  if (id === null || typeof row?.title !== 'string') {
    fail('PRIVATE_MIGRATION_LEGACY_ROW_INVALID', 'Legacy private record is invalid.')
  }
  const size = nonNegativeBytes(row.size)
  if (size === null) fail('PRIVATE_MIGRATION_LEGACY_SIZE_INVALID', 'Legacy private record size is invalid.')
  return Object.freeze({
    id,
    title: row.title,
    filePath: row.file_path,
    size,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  })
}

function normalizeMapping(mapping) {
  if (!mapping) return null
  const id = positiveId(mapping.legacy_private_document_id)
  if (id === null) fail('PRIVATE_MIGRATION_MAPPING_INVALID', 'Private migration mapping ID is invalid.')
  if (!STATUS_VALUES.has(mapping.status)) {
    fail('PRIVATE_MIGRATION_MAPPING_STATUS_INVALID', 'Private migration mapping status is invalid.')
  }
  return mapping
}

function objectId(value) {
  if (typeof value !== 'string') return null
  try {
    parseStorageKey(value)
    return value
  } catch {
    return null
  }
}

function validateHash(value, code) {
  if (!HASH_PATTERN.test(value ?? '')) fail(code, 'Private migration content hash is invalid.')
  return value
}

async function hashReadable(readable) {
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of readable) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buffer)
      bytes += buffer.length
    }
  } catch (error) {
    throw new PrivateSpaceMigrationError(
      'PRIVATE_MIGRATION_SOURCE_READ_FAILED',
      'Legacy private file could not be read.',
      { cause: error }
    )
  }
  return Object.freeze({ sha256: hash.digest('hex'), bytes })
}

function legacyStat(adapter, filePath) {
  try {
    return adapter.stat(filePath)
  } catch (error) {
    throw mapSourceError(error)
  }
}

async function hashLegacyFile(adapter, filePath) {
  let stream
  try {
    stream = adapter.createReadStream(filePath)
  } catch (error) {
    throw mapSourceError(error)
  }
  return hashReadable(stream)
}

async function inspectSource(context, row, expectedSha256 = null) {
  const stat = legacyStat(context.legacyStorageAdapter, row.filePath)
  if (stat.bytes !== row.size) {
    fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Legacy private file size does not match its record.')
  }
  if (expectedSha256 !== null) validateHash(expectedSha256, 'PRIVATE_MIGRATION_MAPPING_METADATA_INVALID')

  const actual = await hashLegacyFile(context.legacyStorageAdapter, row.filePath)
  if (actual.bytes !== row.size || actual.bytes !== stat.bytes) {
    fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Legacy private file size changed during verification.')
  }
  if (expectedSha256 !== null && actual.sha256 !== expectedSha256) {
    fail('PRIVATE_MIGRATION_SOURCE_HASH_MISMATCH', 'Legacy private file hash does not match its mapping.')
  }
  const finalStat = legacyStat(context.legacyStorageAdapter, row.filePath)
  if (finalStat.bytes !== actual.bytes) {
    fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Legacy private file size changed during verification.')
  }
  return Object.freeze({ sha256: actual.sha256, bytes: actual.bytes })
}

async function stageSource(context, row) {
  const initialStat = legacyStat(context.legacyStorageAdapter, row.filePath)
  if (initialStat.bytes !== row.size) {
    fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Legacy private file size does not match its record.')
  }

  let staged
  try {
    let stream
    try {
      stream = context.legacyStorageAdapter.createReadStream(row.filePath)
    } catch (error) {
      throw mapSourceError(error)
    }
    staged = await context.storageService.stageFromStream(stream)
    if (
      !staged ||
      typeof staged.token !== 'string' ||
      !HASH_PATTERN.test(staged.sha256 ?? '') ||
      !Number.isSafeInteger(staged.bytes) ||
      staged.bytes < 0
    ) {
      fail('PRIVATE_MIGRATION_STORAGE_METADATA_INVALID', 'Staged private content metadata is invalid.')
    }
    if (staged.bytes !== row.size) {
      fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Staged private content size does not match its record.')
    }
    const source = await inspectSource(context, row, staged.sha256)
    if (source.bytes !== staged.bytes || source.sha256 !== staged.sha256) {
      fail('PRIVATE_MIGRATION_SOURCE_HASH_MISMATCH', 'Legacy private file changed during staging.')
    }
    return Object.freeze({ staged, source })
  } catch (error) {
    if (staged?.token) {
      try { context.storageService.discardStaged(staged.token) } catch {}
    }
    throw error
  }
}

async function commitSource(context, staged, source) {
  let committed
  try {
    committed = await context.storageService.commitStaged({
      token: staged.token,
      kind: 'documents',
      expectedSha256: source.sha256,
      expectedBytes: source.bytes
    })
  } catch (error) {
    try { context.storageService.discardStaged(staged.token) } catch {}
    throw mapStorageError(error)
  }
  if (!committed || typeof committed.storageKey !== 'string') {
    fail('PRIVATE_MIGRATION_STORAGE_METADATA_INVALID', 'Committed private content metadata is invalid.')
  }
  const canonicalObjectId = objectId(committed.storageKey)
  if (!canonicalObjectId || committed.sha256 !== source.sha256 || committed.bytes !== source.bytes) {
    fail('PRIVATE_MIGRATION_STORAGE_METADATA_INVALID', 'Committed private content metadata is inconsistent.')
  }
  let metadata
  try {
    metadata = await context.storageService.stat(committed.storageKey)
  } catch (error) {
    throw mapStorageError(error)
  }
  if (metadata.sha256 !== source.sha256 || metadata.bytes !== source.bytes) {
    fail('PRIVATE_MIGRATION_TARGET_HASH_MISMATCH', 'Committed private content does not match its source.')
  }
  return Object.freeze({
    storageKey: committed.storageKey,
    objectId: canonicalObjectId,
    sha256: source.sha256,
    bytes: source.bytes,
    reused: committed.reused === true
  })
}

function runTransaction(database, callback) {
  try {
    return database.transaction(callback)()
  } catch (error) {
    throw new PrivateSpaceMigrationError(
      'PRIVATE_MIGRATION_DATABASE_WRITE_FAILED',
      'Private migration database write failed.',
      { cause: error }
    )
  }
}

function upsertMapping(database, payload) {
  database.prepare(`
    INSERT INTO ${PRIVATE_DOCUMENT_MIGRATION_TABLE}
      (legacy_private_document_id, document_id, version_id, status,
       source_sha256, source_bytes, storage_key, content_sha256, content_bytes, issue_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(legacy_private_document_id) DO UPDATE SET
      document_id = excluded.document_id,
      version_id = excluded.version_id,
      status = excluded.status,
      source_sha256 = excluded.source_sha256,
      source_bytes = excluded.source_bytes,
      storage_key = excluded.storage_key,
      content_sha256 = excluded.content_sha256,
      content_bytes = excluded.content_bytes,
      issue_code = excluded.issue_code,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    payload.legacyDocumentId,
    payload.documentId ?? null,
    payload.versionId ?? null,
    payload.status,
    payload.sourceSha256 ?? null,
    payload.sourceBytes ?? null,
    payload.storageKey ?? null,
    payload.contentSha256 ?? null,
    payload.contentBytes ?? null,
    payload.issueCode ?? null
  )
}

function writeSuccessfulMapping(context, row, source, object) {
  let result
  runTransaction(context.database, () => {
    const insertedDocument = context.database.prepare(`
      INSERT INTO documents
        (title, category, subcategory, category_id, tags, file_path, storage_key,
         content_sha256, content_bytes, original_name, version, created_at, updated_at)
      VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      row.title,
      object.storageKey,
      source.sha256,
      source.bytes,
      documentOriginalName(row.filePath),
      row.createdAt,
      row.updatedAt
    )
    const documentId = Number(insertedDocument.lastInsertRowid)
    const insertedVersion = context.database.prepare(`
      INSERT INTO document_versions
        (document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at)
      VALUES (?, 1, NULL, ?, ?, ?, NULL, ?)
    `).run(documentId, object.storageKey, source.sha256, source.bytes, row.createdAt)
    const versionId = Number(insertedVersion.lastInsertRowid)
    upsertMapping(context.database, {
      legacyDocumentId: row.id,
      documentId,
      versionId,
      status: 'migrated',
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      storageKey: object.storageKey,
      contentSha256: source.sha256,
      contentBytes: source.bytes,
      issueCode: null
    })
    result = Object.freeze({ documentId, versionId })
  })
  return result
}

function writeFailureMapping(context, row, mapping, issueCode) {
  try {
    runTransaction(context.database, () => {
      upsertMapping(context.database, {
        legacyDocumentId: row.id,
        documentId: positiveId(mapping?.document_id),
        versionId: positiveId(mapping?.version_id),
        status: 'failed',
        sourceSha256: HASH_PATTERN.test(mapping?.source_sha256 ?? '') ? mapping.source_sha256 : null,
        sourceBytes: nonNegativeBytes(mapping?.source_bytes),
        storageKey: objectId(mapping?.storage_key),
        contentSha256: HASH_PATTERN.test(mapping?.content_sha256 ?? '') ? mapping.content_sha256 : null,
        contentBytes: nonNegativeBytes(mapping?.content_bytes),
        issueCode
      })
    })
    return null
  } catch (error) {
    return normalizeFailure(error, 'PRIVATE_MIGRATION_STATUS_WRITE_FAILED')
  }
}

function updateVerifiedMapping(context, mapping) {
  if (mapping.status === 'migrated' && mapping.issue_code === null) return null
  try {
    runTransaction(context.database, () => {
      context.database.prepare(`
        UPDATE ${PRIVATE_DOCUMENT_MIGRATION_TABLE}
        SET status = 'migrated', issue_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE legacy_private_document_id = ?
      `).run(mapping.legacy_private_document_id)
    })
    return null
  } catch (error) {
    return normalizeFailure(error, 'PRIVATE_MIGRATION_STATUS_WRITE_FAILED')
  }
}

function getTargetRows(database, mapping) {
  const documentId = positiveId(mapping.document_id)
  const versionId = positiveId(mapping.version_id)
  if (documentId === null || versionId === null) {
    fail('PRIVATE_MIGRATION_MAPPING_INCOMPLETE', 'Private migration mapping does not identify a document and version.')
  }
  let document
  let version
  try {
    document = database.prepare(`
      SELECT id, title, category, subcategory, category_id, tags, file_path, storage_key,
             content_sha256, content_bytes, original_name, version, created_at, updated_at
      FROM documents
      WHERE id = ?
    `).get(documentId)
    version = database.prepare(`
      SELECT id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at
      FROM document_versions
      WHERE id = ? AND document_id = ?
    `).get(versionId, documentId)
  } catch (error) {
    fail('PRIVATE_MIGRATION_TARGET_READ_FAILED', 'Migrated document records could not be read.', error)
  }
  if (!document) fail('PRIVATE_MIGRATION_TARGET_DOCUMENT_MISSING', 'Migrated document does not exist.')
  if (!version) fail('PRIVATE_MIGRATION_TARGET_VERSION_MISSING', 'Migrated document version does not exist.')
  return { document, version, documentId, versionId }
}

async function inspectMappedTarget(context, row, mapping, source) {
  normalizeMapping(mapping)
  if (mapping.source_bytes !== row.size || mapping.source_bytes !== source.bytes) {
    fail('PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH', 'Private migration source size metadata is inconsistent.')
  }
  validateHash(mapping.source_sha256, 'PRIVATE_MIGRATION_MAPPING_METADATA_INVALID')
  validateHash(mapping.content_sha256, 'PRIVATE_MIGRATION_MAPPING_METADATA_INVALID')
  if (
    mapping.source_sha256 !== source.sha256 ||
    mapping.content_sha256 !== source.sha256 ||
    mapping.content_bytes !== source.bytes
  ) {
    fail('PRIVATE_MIGRATION_SOURCE_HASH_MISMATCH', 'Private migration source hash metadata is inconsistent.')
  }

  const storageKey = objectId(mapping.storage_key)
  if (!storageKey) fail('PRIVATE_MIGRATION_MAPPING_METADATA_INVALID', 'Private migration storage metadata is invalid.')
  let parsed
  try { parsed = parseStorageKey(storageKey) } catch (error) {
    fail('PRIVATE_MIGRATION_MAPPING_METADATA_INVALID', 'Private migration storage key is invalid.', error)
  }
  if (parsed.kind !== 'documents' || parsed.sha256 !== source.sha256) {
    fail('PRIVATE_MIGRATION_TARGET_METADATA_MISMATCH', 'Private migration storage key does not match its content.')
  }

  let targetObject
  try {
    targetObject = await context.storageService.stat(storageKey)
  } catch (error) {
    throw mapStorageError(error)
  }
  if (targetObject.sha256 !== source.sha256 || targetObject.bytes !== source.bytes) {
    fail('PRIVATE_MIGRATION_TARGET_HASH_MISMATCH', 'Private migration target object metadata is inconsistent.')
  }

  const target = getTargetRows(context.database, mapping)
  const expectedName = documentOriginalName(row.filePath)
  const documentMatches = (
    target.document.id === target.documentId &&
    target.document.title === row.title &&
    target.document.category === null &&
    target.document.subcategory === null &&
    target.document.category_id === null &&
    target.document.tags === null &&
    target.document.file_path === null &&
    target.document.storage_key === storageKey &&
    target.document.content_sha256 === source.sha256 &&
    target.document.content_bytes === source.bytes &&
    target.document.original_name === expectedName &&
    Number(target.document.version) === 1 &&
    target.document.created_at === row.createdAt &&
    target.document.updated_at === row.updatedAt
  )
  const versionMatches = (
    target.version.id === target.versionId &&
    target.version.document_id === target.documentId &&
    Number(target.version.version) === 1 &&
    target.version.file_path === null &&
    target.version.storage_key === storageKey &&
    target.version.content_sha256 === source.sha256 &&
    target.version.content_bytes === source.bytes &&
    target.version.created_at === row.createdAt
  )
  if (!documentMatches || !versionMatches) {
    fail('PRIVATE_MIGRATION_TARGET_METADATA_MISMATCH', 'Migrated document metadata is inconsistent.')
  }
  return Object.freeze({
    documentId: target.documentId,
    versionId: target.versionId,
    storageKey,
    objectId: storageKey,
    sha256: source.sha256,
    bytes: source.bytes
  })
}

function reportRecord({ row, status, disposition, issueCode = null, documentId = null, versionId = null, objectIdValue = null }) {
  const record = {
    legacyDocumentId: row.id,
    status,
    disposition
  }
  if (documentId !== null) record.documentId = documentId
  if (versionId !== null) record.versionId = versionId
  if (objectIdValue !== null) record.objectId = objectIdValue
  if (issueCode !== null) record.issueCode = issueCode
  return Object.freeze(record)
}

function reportIssue(legacyDocumentId, code, objectIdValue = null) {
  const issue = {
    legacyDocumentId,
    code,
    severity: 'error',
    disposition: 'blocked'
  }
  if (objectIdValue !== null) issue.objectId = objectIdValue
  return Object.freeze(issue)
}

function issueKey(issue) {
  return `${issue.legacyDocumentId ?? ''}:${issue.code}:${issue.objectId ?? ''}`
}

function uniqueIssues(issues) {
  const seen = new Set()
  return issues.filter((issue) => {
    const key = issueKey(issue)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function countStatuses(records) {
  return records.reduce((counts, record) => {
    counts[`${record.status}Count`] += 1
    return counts
  }, { migratedCount: 0, skippedCount: 0, failedCount: 0 })
}

function issueCodes(issues) {
  return new Set(issues.map(({ code }) => code))
}

async function buildVerificationReport(context, rows = readLegacyRows(context.database)) {
  const mappings = readMappings(context.database)
  const mappingsById = new Map()
  for (const rawMapping of mappings) {
    const mapping = normalizeMapping(rawMapping)
    mappingsById.set(mapping.legacy_private_document_id, mapping)
  }

  const records = []
  const issues = []
  const sourceGroups = new Map()
  const targetObjects = new Map()
  let sourceBytes = 0
  let targetBytes = 0
  let mappedCount = 0
  let sourceFileChecks = 0
  let targetChecks = 0

  for (const rawRow of rows) {
    let row
    try {
      row = normalizeLegacyRow(rawRow)
    } catch (error) {
      const failure = normalizeFailure(error, 'PRIVATE_MIGRATION_LEGACY_ROW_INVALID')
      const fallbackRow = { id: positiveId(rawRow?.id) }
      records.push(reportRecord({ row: fallbackRow, status: 'failed', disposition: 'blocked', issueCode: failure.code }))
      issues.push(reportIssue(fallbackRow.id, failure.code))
      continue
    }

    const mapping = mappingsById.get(row.id)
    let source
    try {
      source = await inspectSource(context, row, mapping?.source_sha256 ?? null)
      sourceBytes += source.bytes
      sourceFileChecks += 1
      const group = sourceGroups.get(source.sha256) ?? { count: 0, objectId: null }
      group.count += 1
      sourceGroups.set(source.sha256, group)
    } catch (error) {
      const failure = normalizeFailure(error, 'PRIVATE_MIGRATION_SOURCE_READ_FAILED')
      records.push(reportRecord({
        row,
        status: 'failed',
        disposition: 'blocked',
        issueCode: failure.code,
        objectIdValue: objectId(mapping?.storage_key)
      }))
      issues.push(reportIssue(row.id, failure.code, objectId(mapping?.storage_key)))
      continue
    }

    if (!mapping) {
      const code = 'PRIVATE_MIGRATION_MAPPING_MISSING'
      records.push(reportRecord({ row, status: 'failed', disposition: 'blocked', issueCode: code }))
      issues.push(reportIssue(row.id, code))
      continue
    }

    mappedCount += 1
    try {
      const target = await inspectMappedTarget(context, row, mapping, source)
      targetChecks += 1
      sourceGroups.get(source.sha256).objectId ??= target.objectId
      const existingObject = targetObjects.get(target.objectId)
      if (existingObject && existingObject.sha256 !== source.sha256) {
        fail('PRIVATE_MIGRATION_DUPLICATE_MAPPING_MISMATCH', 'Duplicate content mappings disagree.')
      }
      targetObjects.set(target.objectId, { sha256: source.sha256, bytes: target.bytes })
      targetBytes += target.bytes
      records.push(reportRecord({
        row,
        status: 'migrated',
        disposition: 'verified',
        documentId: target.documentId,
        versionId: target.versionId,
        objectIdValue: target.objectId
      }))
    } catch (error) {
      const failure = normalizeFailure(error, 'PRIVATE_MIGRATION_TARGET_READ_FAILED')
      records.push(reportRecord({
        row,
        status: 'failed',
        disposition: 'blocked',
        issueCode: failure.code,
        documentId: positiveId(mapping.document_id),
        versionId: positiveId(mapping.version_id),
        objectIdValue: objectId(mapping.storage_key)
      }))
      issues.push(reportIssue(row.id, failure.code, objectId(mapping.storage_key)))
    }
  }

  for (const mapping of mappings) {
    if (!rows.some((row) => positiveId(row?.id) === mapping.legacy_private_document_id)) {
      const code = 'PRIVATE_MIGRATION_ORPHAN_MAPPING'
      issues.push(reportIssue(mapping.legacy_private_document_id, code, objectId(mapping.storage_key)))
    }
  }

  const duplicateContentGroups = [...sourceGroups.values()].filter(({ count }) => count > 1).length
  const duplicateContentCount = [...sourceGroups.values()]
    .reduce((sum, { count }) => sum + Math.max(0, count - 1), 0)
  const counts = countStatuses(records)
  const codes = issueCodes(issues)
  const checks = Object.freeze({
    oldRecordCount: records.length === rows.length,
    mappingCount: mappings.length === rows.length && mappedCount === rows.length,
    sourceTotalBytes: counts.failedCount === 0 && sourceBytes === targetBytes,
    fileExistence: sourceFileChecks === rows.length,
    sourceHashes: counts.failedCount === 0 && sourceFileChecks === rows.length,
    targetStorage: targetChecks === rows.length,
    duplicateContent: !codes.has('PRIVATE_MIGRATION_DUPLICATE_MAPPING_MISMATCH'),
    bounds: !codes.has('PRIVATE_MIGRATION_SOURCE_OUTSIDE_ROOT')
  })
  const verified = Object.values(checks).every(Boolean) && counts.failedCount === 0 && issues.length === 0

  return Object.freeze({
    operation: 'verify',
    verified,
    checks,
    stats: Object.freeze({
      recordCount: rows.length,
      mappingCount: mappings.length,
      mappedCount,
      sourceBytes,
      targetBytes,
      uniqueContentCount: sourceGroups.size,
      duplicateContentGroups,
      duplicateContentCount,
      uniqueObjectCount: targetObjects.size,
      uniqueObjectBytes: [...targetObjects.values()].reduce((sum, object) => sum + object.bytes, 0),
      ...counts,
      outsideRootCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_OUTSIDE_ROOT').length,
      missingSourceCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_MISSING').length,
      symlinkCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_SYMLINK').length,
      nonRegularFileCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_NOT_REGULAR_FILE').length,
      sizeMismatchCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH').length,
      hashMismatchCount: issues.filter(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_HASH_MISMATCH').length
    }),
    records: Object.freeze(records),
    issues: Object.freeze(uniqueIssues(issues))
  })
}

async function processExpandRow(context, row, mapping) {
  const hasMappingEvidence = Boolean(mapping && (
    mapping.status !== 'failed' ||
    mapping.document_id !== null ||
    mapping.version_id !== null ||
    mapping.storage_key !== null
  ))
  if (hasMappingEvidence) {
    const source = await inspectSource(context, row, mapping.source_sha256 ?? null)
    const target = await inspectMappedTarget(context, row, mapping, source)
    const statusError = updateVerifiedMapping(context, mapping)
    if (statusError) throw statusError
    return Object.freeze({
      record: reportRecord({
        row,
        status: 'skipped',
        disposition: 'verified-existing',
        documentId: target.documentId,
        versionId: target.versionId,
        objectIdValue: target.objectId
      }),
      reused: false
    })
  }

  const { staged, source } = await stageSource(context, row)
  const object = await commitSource(context, staged, source)
  const created = writeSuccessfulMapping(context, row, source, object)
  return Object.freeze({
    record: reportRecord({
      row,
      status: 'migrated',
      disposition: object.reused ? 'migrated-reused-object' : 'migrated',
      documentId: created.documentId,
      versionId: created.versionId,
      objectIdValue: object.objectId
    }),
    reused: object.reused
  })
}

export class PrivateSpaceMigrationService {
  constructor({ database, runtime } = {}) {
    assertDependencies(database, runtime)
    this.database = database
    this.runtime = runtime
  }

  async expand() {
    const context = { database: this.database, ...this.runtime }
    const rows = readLegacyRows(this.database)
    const mappings = readMappings(this.database)
    const mappingsById = new Map(mappings.map((mapping) => [mapping.legacy_private_document_id, normalizeMapping(mapping)]))
    const processedRecords = []
    const processingIssues = []
    let reusedObjectCount = 0

    for (const rawRow of rows) {
      let row
      try {
        row = normalizeLegacyRow(rawRow)
        const result = await processExpandRow(context, row, mappingsById.get(row.id) ?? null)
        processedRecords.push(result.record)
        if (result.reused) reusedObjectCount += 1
      } catch (error) {
        const failure = normalizeFailure(error)
        const fallbackRow = row ?? { id: positiveId(rawRow?.id) }
        const mapping = fallbackRow.id === null ? null : mappingsById.get(fallbackRow.id) ?? null
        const statusError = fallbackRow.id === null
          ? null
          : writeFailureMapping(context, fallbackRow, mapping, failure.code)
        processedRecords.push(reportRecord({
          row: fallbackRow,
          status: 'failed',
          disposition: 'blocked',
          issueCode: failure.code,
          documentId: positiveId(mapping?.document_id),
          versionId: positiveId(mapping?.version_id),
          objectIdValue: objectId(mapping?.storage_key)
        }))
        processingIssues.push(reportIssue(fallbackRow.id, failure.code, objectId(mapping?.storage_key)))
        if (statusError) {
          processingIssues.push(reportIssue(fallbackRow.id, statusError.code))
        }
      }
    }

    const verification = await buildVerificationReport(context, rows)
    const verificationById = new Map(verification.records.map((record) => [record.legacyDocumentId, record]))
    const records = processedRecords.map((record) => {
      const verified = verificationById.get(record.legacyDocumentId)
      if (verified?.status === 'failed') return verified
      return record
    })
    const counts = countStatuses(records)
    const issues = uniqueIssues([
      ...processingIssues,
      ...verification.issues
    ])
    const stats = Object.freeze({
      ...verification.stats,
      ...counts,
      reusedObjectCount
    })
    return Object.freeze({
      operation: 'expand',
      verified: verification.verified && issues.length === 0,
      checks: verification.checks,
      stats,
      records: Object.freeze(records),
      issues: Object.freeze(issues)
    })
  }

  async verify() {
    const context = { database: this.database, ...this.runtime }
    return buildVerificationReport(context)
  }
}

export function createPrivateSpaceMigrationService(options) {
  return new PrivateSpaceMigrationService(options)
}

export async function expandPrivateSpace(options) {
  return createPrivateSpaceMigrationService(options).expand()
}

export async function verifyPrivateSpace(options) {
  return createPrivateSpaceMigrationService(options).verify()
}

export const migratePrivateSpace = expandPrivateSpace
export const verifyPrivateSpaceMigration = verifyPrivateSpace
