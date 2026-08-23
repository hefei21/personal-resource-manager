import path from 'node:path'

import {
  CONTENT_OBJECT_TABLE,
  NAS_SCAN_ENTRY_TABLE,
  NAS_SCAN_ROOT_TABLE,
  RESOURCE_CONFLICT_CANDIDATE_TABLE,
  RESOURCE_SOURCE_TABLE,
  RESOURCE_TABLE,
  RESOURCE_VERSION_TABLE
} from '../config/resourceModelSchema.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const POSITIVE_ID = /^[1-9]\d*$/u

/**
 * Stable error codes exposed by the NAS discovery/commit boundary.  Human
 * messages are deliberately generic: callers should branch on `code` and
 * never need to parse a filesystem or database error string.
 */
export const NAS_RESOURCE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'NAS_RESOURCE_INPUT_INVALID',
  DATABASE_REQUIRED: 'NAS_RESOURCE_DATABASE_REQUIRED',
  ROOT_ID_REQUIRED: 'NAS_RESOURCE_ROOT_ID_REQUIRED',
  ROOT_NOT_FOUND: 'NAS_RESOURCE_ROOT_NOT_FOUND',
  ROOT_DISABLED: 'NAS_RESOURCE_ROOT_DISABLED',
  GENERATION_INVALID: 'NAS_RESOURCE_GENERATION_INVALID',
  GENERATION_CONFLICT: 'NAS_RESOURCE_GENERATION_CONFLICT',
  COMMIT_FAILED: 'NAS_RESOURCE_COMMIT_FAILED',
  PATH_INVALID: 'NAS_RESOURCE_RELATIVE_PATH_INVALID',
  OBSERVATION_INVALID: 'NAS_RESOURCE_OBSERVATION_INVALID',
  HASH_INVALID: 'NAS_RESOURCE_HASH_INVALID',
  BYTES_INVALID: 'NAS_RESOURCE_BYTES_INVALID',
  FILE_CHANGED: 'FILE_CHANGED',
  FILE_MISSING: 'FILE_MISSING',
  CANCELLED: 'NAS_SCAN_CANCELLED',
  CREDENTIAL_CONTENT: 'CREDENTIAL_CONTENT'
})

export class NasResourceCommitError extends Error {
  constructor(code, message = 'NAS resource commit failed.', relativePath = null) {
    super(message)
    this.name = 'NasResourceCommitError'
    this.code = code
    if (relativePath) this.relativePath = relativePath
  }
}

function fail(code, message, relativePath = null) {
  throw new NasResourceCommitError(code, message, relativePath)
}

const EBOOK_EXTENSIONS = new Set([
  '.azw', '.azw3', '.cb7', '.cbr', '.cbz', '.djvu', '.epub', '.fb2', '.ibooks',
  '.mobi', '.opf'
])

const AUDIO_EXTENSIONS = new Set([
  '.aac', '.aiff', '.ape', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wma'
])

const CODE_EXTENSIONS = new Set([
  '.asm', '.bash', '.c', '.cc', '.clj', '.cpp', '.cs', '.cxx', '.css', '.cjs',
  '.dart', '.ex', '.exs', '.fs', '.fsx', '.go', '.h', '.hpp', '.hs', '.java',
  '.jl', '.js', '.jsx', '.jsonc', '.kt', '.kts', '.lua', '.m', '.mjs', '.mm',
  '.php', '.pl', '.pm', '.ps1', '.py', '.r', '.rb', '.rs', '.scala', '.scss',
  '.sh', '.sql', '.swift', '.svelte', '.tcl', '.ts', '.tsx', '.vue', '.xml',
  '.zsh'
])

/**
 * Stable extension-only resource classification.  It intentionally does not
 * inspect file contents or call external metadata providers.
 */
export function classifyNasResourceType(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return 'document'
  const extension = path.posix.extname(relativePath).toLowerCase()
  if (EBOOK_EXTENSIONS.has(extension)) return 'ebook'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  return 'document'
}

export const nasResourceTypeForPath = classifyNasResourceType
export const classifyResourceType = classifyNasResourceType

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(NAS_RESOURCE_ERROR_CODES.DATABASE_REQUIRED, 'A transactional database is required.')
  }
}

function normalizeRootId(value) {
  if (typeof value === 'bigint') value = Number(value)
  if (typeof value === 'string' && POSITIVE_ID.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(NAS_RESOURCE_ERROR_CODES.ROOT_ID_REQUIRED, 'A valid scan root id is required.')
  }
  return value
}

function normalizeGeneration(value) {
  if (typeof value === 'bigint') value = Number(value)
  if (typeof value === 'string' && /^\d+$/u.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(NAS_RESOURCE_ERROR_CODES.GENERATION_INVALID, 'A valid scan generation is required.')
  }
  return value
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(NAS_RESOURCE_ERROR_CODES.PATH_INVALID, 'A relative scan path is required.')
  }
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(NAS_RESOURCE_ERROR_CODES.PATH_INVALID, 'The scan path must be a normalized relative path.')
  }
  return normalized
}

function normalizeHash(value, relativePath) {
  if (value === null || value === undefined || value === '') return null
  const hash = String(value).toLowerCase()
  if (!HASH_PATTERN.test(hash)) fail(NAS_RESOURCE_ERROR_CODES.HASH_INVALID, 'The content hash is invalid.', relativePath)
  return hash
}

function normalizeBytes(value, relativePath) {
  if (typeof value === 'bigint') value = Number(value)
  if (typeof value === 'string' && /^\d+$/u.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(NAS_RESOURCE_ERROR_CODES.BYTES_INVALID, 'The file byte count is invalid.', relativePath)
  }
  return value
}

function normalizeIntegerOrNull(value, relativePath) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const asNumber = Number(value)
    if (Number.isSafeInteger(asNumber)) return asNumber
    try { return BigInt(value) } catch {}
  }
  if (Number.isSafeInteger(value) && value >= 0) return value
  fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The file observation metadata is invalid.', relativePath)
}

function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The scan observation is invalid.')
  }
  const relativePath = normalizeRelativePath(input.relativePath ?? input.path)
  const status = input.observationStatus ?? input.status ?? (
    input.decision === 'excluded' ? 'excluded' : 'discovered'
  )
  if (!['discovered', 'excluded', 'error'].includes(status)) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The observation status is invalid.', relativePath)
  }
  const kind = input.kind ?? 'file'
  if (typeof kind !== 'string' || kind.length === 0) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The observation kind is invalid.', relativePath)
  }
  const errorCode = input.lastErrorCode ?? input.errorCode ?? input.exclusionCode ?? null
  if (errorCode !== null && (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.includes('\0'))) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The observation error code is invalid.', relativePath)
  }
  if ((status === 'error' || status === 'excluded') && errorCode === null) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'An excluded or error observation needs an error code.', relativePath)
  }
  const contentSha256 = status === 'discovered'
    ? normalizeHash(input.contentSha256 ?? input.content_sha256 ?? input.sha256, relativePath)
    : null
  const size = input.size === null || input.size === undefined
    ? null
    : normalizeIntegerOrNull(input.size, relativePath)
  const mtimeNs = input.mtimeNs === null || input.mtimeNs === undefined
    ? null
    : normalizeIntegerOrNull(input.mtimeNs, relativePath)
  const title = input.title ?? path.posix.basename(relativePath)
  if (typeof title !== 'string' || title.length === 0 || title.includes('\0')) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The resource title is invalid.', relativePath)
  }
  const resourceType = input.resourceType ?? classifyNasResourceType(relativePath)
  if (typeof resourceType !== 'string' || resourceType.trim() === '' || resourceType.includes('\0')) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'The resource type is invalid.', relativePath)
  }
  return {
    relativePath,
    kind,
    status,
    fileIdentifier: input.fileIdentifier === null || input.fileIdentifier === undefined
      ? null
      : String(input.fileIdentifier),
    size,
    mtimeNs,
    contentSha256,
    errorCode,
    title,
    resourceType
  }
}

function sourceAtPath(database, rootId, relativePath) {
  return database.prepare(`
    SELECT id, resource_id, source_kind, scan_root_id, relative_path, state,
           last_seen_generation
    FROM ${RESOURCE_SOURCE_TABLE}
    WHERE source_kind = 'nas_path' AND scan_root_id = ? AND relative_path = ?
  `).get(rootId, relativePath) ?? null
}

function sourceAtFileIdentifier(database, rootId, fileIdentifier, generation, relativePath) {
  if (!fileIdentifier) return null
  const rows = database.prepare(`
    SELECT s.id, s.resource_id, s.source_kind, s.scan_root_id, s.relative_path, s.state,
           s.last_seen_generation, e.relative_path AS entry_relative_path,
           e.last_seen_generation AS entry_generation
    FROM ${RESOURCE_SOURCE_TABLE} s
    JOIN ${NAS_SCAN_ENTRY_TABLE} e ON e.resource_source_id = s.id
    WHERE s.source_kind = 'nas_path'
      AND s.scan_root_id = ?
      AND e.file_identifier = ?
      AND e.last_seen_generation < ?
      AND e.relative_path <> ?
  `).all(rootId, fileIdentifier, generation, relativePath)
  return rows.length === 1 ? rows[0] : null
}

function createResource(database, observation) {
  const result = database.prepare(`
    INSERT INTO ${RESOURCE_TABLE} (resource_type, title)
    VALUES (?, ?)
  `).run(observation.resourceType, observation.title)
  return Number(result.lastInsertRowid)
}

function updateResourceMetadata(database, resourceId, observation) {
  database.prepare(`
    UPDATE ${RESOURCE_TABLE}
    SET resource_type = ?, title = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(observation.resourceType, observation.title, resourceId)
}

function createSource(database, rootId, resourceId, relativePath, generation, state = 'active') {
  const result = database.prepare(`
    INSERT INTO ${RESOURCE_SOURCE_TABLE}
      (resource_id, source_kind, scan_root_id, relative_path, state, last_seen_generation)
    VALUES (?, 'nas_path', ?, ?, ?, ?)
  `).run(resourceId, rootId, relativePath, state, generation)
  return Number(result.lastInsertRowid)
}

function moveSource(database, source, rootId, relativePath, generation) {
  const oldPath = source.relative_path
  if (oldPath === relativePath) return Number(source.id)

  // A previous excluded/error observation can occupy the destination entry
  // without owning a source.  Remove only that stale row before moving the
  // source's observation primary key; an owned destination would have been
  // returned by sourceAtPath and is therefore not a move candidate.
  database.prepare(`
    DELETE FROM ${NAS_SCAN_ENTRY_TABLE}
    WHERE scan_root_id = ? AND relative_path = ? AND resource_source_id IS NULL
  `).run(rootId, relativePath)
  database.prepare(`
    UPDATE ${RESOURCE_SOURCE_TABLE}
    SET relative_path = ?, state = 'active', last_seen_generation = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND scan_root_id = ?
  `).run(relativePath, generation, source.id, rootId)
  database.prepare(`
    UPDATE ${NAS_SCAN_ENTRY_TABLE}
    SET relative_path = ?
    WHERE scan_root_id = ? AND relative_path = ? AND resource_source_id = ?
  `).run(relativePath, rootId, oldPath, source.id)
  return Number(source.id)
}

function ensureContentObject(database, sha256, bytes) {
  const existing = database.prepare(`
    SELECT id, sha256, bytes
    FROM ${CONTENT_OBJECT_TABLE}
    WHERE sha256 = ? AND bytes = ?
  `).get(sha256, bytes)
  if (existing) return Number(existing.id)
  try {
    const result = database.prepare(`
      INSERT INTO ${CONTENT_OBJECT_TABLE} (sha256, bytes)
      VALUES (?, ?)
    `).run(sha256, bytes)
    return Number(result.lastInsertRowid)
  } catch (error) {
    // A concurrent scanner may have won the unique (sha256, bytes) race.  A
    // real transaction still makes this path deterministic for retries.
    const after = database.prepare(`
      SELECT id FROM ${CONTENT_OBJECT_TABLE} WHERE sha256 = ? AND bytes = ?
    `).get(sha256, bytes)
    if (after) return Number(after.id)
    throw error
  }
}

function ensureCurrentVersion(database, resourceId, contentObjectId, sha256, bytes) {
  const current = database.prepare(`
    SELECT v.id, v.version_number, c.sha256, c.bytes
    FROM ${RESOURCE_VERSION_TABLE} v
    JOIN ${CONTENT_OBJECT_TABLE} c ON c.id = v.content_object_id
    WHERE v.resource_id = ? AND v.is_current = 1
  `).get(resourceId)
  if (current && current.sha256 === sha256 && Number(current.bytes) === Number(bytes)) {
    return {
      versionId: Number(current.id),
      versionNumber: Number(current.version_number),
      created: false,
      contentObjectId
    }
  }

  if (current) {
    database.prepare(`
      UPDATE ${RESOURCE_VERSION_TABLE}
      SET is_current = 0
      WHERE resource_id = ? AND is_current = 1
    `).run(resourceId)
  }
  const maxVersion = database.prepare(`
    SELECT MAX(version_number) AS version_number
    FROM ${RESOURCE_VERSION_TABLE}
    WHERE resource_id = ?
  `).get(resourceId)?.version_number
  const versionNumber = (maxVersion === null || maxVersion === undefined)
    ? 1
    : Number(maxVersion) + 1
  const result = database.prepare(`
    INSERT INTO ${RESOURCE_VERSION_TABLE}
      (resource_id, content_object_id, version_number, is_current)
    VALUES (?, ?, ?, 1)
  `).run(resourceId, contentObjectId, versionNumber)
  return {
    versionId: Number(result.lastInsertRowid),
    versionNumber,
    created: true,
    contentObjectId
  }
}

function candidateSignal(candidateType, observation) {
  if (candidateType === 'content_hash') {
    return JSON.stringify({ sha256: observation.contentSha256, bytes: Number(observation.size) })
  }
  return JSON.stringify({ title: observation.title })
}

function insertConflictCandidate(database, candidateType, leftResourceId, rightResourceId, observation) {
  if (leftResourceId === rightResourceId) return null
  const left = Math.min(leftResourceId, rightResourceId)
  const right = Math.max(leftResourceId, rightResourceId)
  const result = database.prepare(`
    INSERT INTO ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
      (candidate_type, left_resource_id, right_resource_id, signal_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (candidate_type, left_resource_id, right_resource_id) DO NOTHING
  `).run(candidateType, left, right, candidateSignal(candidateType, observation))
  const row = database.prepare(`
    SELECT id, candidate_type, left_resource_id, right_resource_id, status
    FROM ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
    WHERE candidate_type = ? AND left_resource_id = ? AND right_resource_id = ?
  `).get(candidateType, left, right)
  return {
    id: Number(row.id),
    candidateType,
    leftResourceId: Number(row.left_resource_id),
    rightResourceId: Number(row.right_resource_id),
    created: result.changes === 1,
    status: row.status
  }
}

function findHashCandidates(database, observation, resourceId) {
  if (observation.contentSha256 === null || observation.size === null) return []
  return database.prepare(`
    SELECT DISTINCT r.id
    FROM ${RESOURCE_TABLE} r
    JOIN ${RESOURCE_VERSION_TABLE} v ON v.resource_id = r.id AND v.is_current = 1
    JOIN ${CONTENT_OBJECT_TABLE} c ON c.id = v.content_object_id
    WHERE r.id <> ? AND c.sha256 = ? AND c.bytes = ?
    ORDER BY r.id
  `).all(resourceId, observation.contentSha256, observation.size).map(({ id }) => Number(id))
}

function findTitleCandidates(database, observation, resourceId) {
  return database.prepare(`
    SELECT id FROM ${RESOURCE_TABLE}
    WHERE id <> ? AND title = ?
    ORDER BY id
  `).all(resourceId, observation.title).map(({ id }) => Number(id))
}

function addConflictCandidates(database, observation, resourceId) {
  const candidates = []
  if (observation.contentSha256 !== null && observation.size !== null) {
    for (const otherId of findHashCandidates(database, observation, resourceId)) {
      candidates.push(insertConflictCandidate(database, 'content_hash', resourceId, otherId, observation))
    }
  }
  for (const otherId of findTitleCandidates(database, observation, resourceId)) {
    candidates.push(insertConflictCandidate(database, 'title', resourceId, otherId, observation))
  }
  return candidates.filter(Boolean)
}

function upsertEntry(database, rootId, observation, sourceId, generation) {
  const contentSha256 = observation.status === 'discovered' ? observation.contentSha256 : null
  const errorCode = observation.status === 'discovered' ? null : observation.errorCode
  database.prepare(`
    INSERT INTO ${NAS_SCAN_ENTRY_TABLE}
      (scan_root_id, relative_path, resource_source_id, file_identifier, size, mtime_ns,
       content_sha256, observation_status, last_seen_generation, last_error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (scan_root_id, relative_path) DO UPDATE SET
      resource_source_id = excluded.resource_source_id,
      file_identifier = excluded.file_identifier,
      size = excluded.size,
      mtime_ns = excluded.mtime_ns,
      content_sha256 = excluded.content_sha256,
      observation_status = excluded.observation_status,
      last_seen_generation = excluded.last_seen_generation,
      last_error_code = excluded.last_error_code,
      observed_at = CURRENT_TIMESTAMP
  `).run(
    rootId,
    observation.relativePath,
    sourceId,
    observation.fileIdentifier,
    observation.size,
    observation.mtimeNs,
    contentSha256,
    observation.status,
    generation,
    errorCode
  )
}

function applyObservation(database, rootId, generation, observation) {
  const existingSource = sourceAtPath(database, rootId, observation.relativePath)

  if (observation.status === 'excluded' || observation.status === 'error') {
    let sourceId = existingSource ? Number(existingSource.id) : null
    let resourceId = existingSource ? Number(existingSource.resource_id) : null
    if (existingSource) {
      const nextState = observation.status === 'excluded' ? 'excluded' : 'active'
      database.prepare(`
        UPDATE ${RESOURCE_SOURCE_TABLE}
        SET state = ?, last_seen_generation = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextState, generation, existingSource.id)
    }
    upsertEntry(database, rootId, observation, sourceId, generation)
    return {
      status: observation.status,
      relativePath: observation.relativePath,
      sourceId,
      resourceId,
      errorCode: observation.errorCode
    }
  }

  if (observation.kind !== 'file') {
    // The security walker may be used directly by callers that accidentally
    // pass a directory record.  Keep the commit boundary safe and inert.
    return {
      status: 'ignored',
      relativePath: observation.relativePath,
      sourceId: null,
      resourceId: null
    }
  }
  if (observation.contentSha256 === null || observation.size === null) {
    fail(NAS_RESOURCE_ERROR_CODES.OBSERVATION_INVALID, 'A discovered file must have a verified hash and size.', observation.relativePath)
  }

  let source = existingSource
  let moved = false
  let createdResource = false
  if (!source) {
    source = sourceAtFileIdentifier(
      database,
      rootId,
      observation.fileIdentifier,
      generation,
      observation.relativePath
    )
    if (source) {
      moveSource(database, source, rootId, observation.relativePath, generation)
      moved = true
    }
  }

  let resourceId
  let sourceId
  if (source) {
    resourceId = Number(source.resource_id)
    sourceId = Number(source.id)
    if (!moved) {
      database.prepare(`
        UPDATE ${RESOURCE_SOURCE_TABLE}
        SET state = 'active', last_seen_generation = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(generation, source.id)
    }
    updateResourceMetadata(database, resourceId, observation)
  } else {
    resourceId = createResource(database, observation)
    sourceId = createSource(database, rootId, resourceId, observation.relativePath, generation)
    createdResource = true
  }

  const contentObjectId = ensureContentObject(database, observation.contentSha256, observation.size)
  const version = ensureCurrentVersion(
    database,
    resourceId,
    contentObjectId,
    observation.contentSha256,
    observation.size
  )
  upsertEntry(database, rootId, observation, sourceId, generation)

  const conflicts = (createdResource || moved || version.created)
    ? addConflictCandidates(database, observation, resourceId)
    : []
  let status = 'unchanged'
  if (createdResource) status = 'added'
  else if (moved) status = 'moved'
  else if (version.created) status = 'modified'
  return {
    status,
    relativePath: observation.relativePath,
    sourceId,
    resourceId,
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    versionCreated: version.created,
    contentObjectId,
    conflicts
  }
}

function normalizeCommitArguments(first, second, third) {
  if (first && typeof first.prepare === 'function') {
    if (typeof second === 'number' || typeof second === 'string' || typeof second === 'bigint') {
      return {
        database: first,
        scanRootId: second,
        observations: Array.isArray(third) ? third : [],
        generation: undefined
      }
    }
    return { database: first, ...(second ?? {}) }
  }
  return first ?? {}
}

/**
 * Commit one complete, already-hashed scan generation.  Hashing must happen
 * before this function is called; the transaction only mutates SQLite state.
 */
export function commitNasResourceScan(first, second, third) {
  const options = normalizeCommitArguments(first, second, third)
  const { database, observations = [] } = options
  assertDatabase(database)
  const rootId = normalizeRootId(options.scanRootId ?? options.rootId ?? options.id)
  if (!Array.isArray(observations)) {
    fail(NAS_RESOURCE_ERROR_CODES.INPUT_INVALID, 'Scan observations must be an array.')
  }
  const normalizedObservations = observations.map(normalizeObservation)
  const requestedGeneration = options.generation === undefined
    ? undefined
    : normalizeGeneration(options.generation)

  try {
    return database.transaction(() => {
    const root = database.prepare(`
      SELECT id, enabled, last_successful_generation
      FROM ${NAS_SCAN_ROOT_TABLE}
      WHERE id = ?
    `).get(rootId)
    if (!root) fail(NAS_RESOURCE_ERROR_CODES.ROOT_NOT_FOUND, 'The scan root was not found.')
    if (Number(root.enabled) !== 1) fail(NAS_RESOURCE_ERROR_CODES.ROOT_DISABLED, 'The scan root is disabled.')

    const previousGeneration = Number(root.last_successful_generation)
    const generation = requestedGeneration ?? previousGeneration + 1
    if (generation === previousGeneration) {
      return {
        idempotent: true,
        generation,
        previousGeneration,
        observations: [],
        outcomes: [],
        missingResourceIds: [],
        conflictCandidates: []
      }
    }
    if (generation !== previousGeneration + 1) {
      fail(NAS_RESOURCE_ERROR_CODES.GENERATION_CONFLICT, 'The scan generation fence does not match.')
    }

    const outcomes = []
    const conflictCandidates = []
    const sorted = [...normalizedObservations].sort((left, right) => (
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
    ))
    for (const observation of sorted) {
      const outcome = applyObservation(database, rootId, generation, observation)
      outcomes.push(outcome)
      if (Array.isArray(outcome.conflicts)) conflictCandidates.push(...outcome.conflicts)
    }

    const missingRows = database.prepare(`
      SELECT id, resource_id, relative_path
      FROM ${RESOURCE_SOURCE_TABLE}
      WHERE source_kind = 'nas_path' AND scan_root_id = ?
        AND (last_seen_generation IS NULL OR last_seen_generation < ?)
        AND state <> 'missing'
    `).all(rootId, generation)
    database.prepare(`
      UPDATE ${RESOURCE_SOURCE_TABLE}
      SET state = 'missing', updated_at = CURRENT_TIMESTAMP
      WHERE source_kind = 'nas_path' AND scan_root_id = ?
        AND (last_seen_generation IS NULL OR last_seen_generation < ?)
    `).run(rootId, generation)

    const updated = database.prepare(`
      UPDATE ${NAS_SCAN_ROOT_TABLE}
      SET last_successful_generation = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND last_successful_generation = ?
    `).run(generation, rootId, previousGeneration)
    if (updated.changes !== 1) {
      fail(NAS_RESOURCE_ERROR_CODES.GENERATION_CONFLICT, 'The scan generation fence changed during commit.')
    }

    return {
      idempotent: false,
      generation,
      previousGeneration,
      observations: normalizedObservations,
      outcomes,
      missingResourceIds: missingRows.map(({ resource_id }) => Number(resource_id)),
      missingSources: missingRows.map(({ id, resource_id, relative_path }) => ({
        sourceId: Number(id),
        resourceId: Number(resource_id),
        relativePath: relative_path
      })),
      conflictCandidates,
      counts: {
        added: outcomes.filter(({ status }) => status === 'added').length,
        moved: outcomes.filter(({ status }) => status === 'moved').length,
        modified: outcomes.filter(({ status }) => status === 'modified').length,
        unchanged: outcomes.filter(({ status }) => status === 'unchanged').length,
        excluded: outcomes.filter(({ status }) => status === 'excluded').length,
        errors: outcomes.filter(({ status }) => status === 'error').length,
        missing: missingRows.length,
        conflicts: conflictCandidates.length
      }
    }
    })()
  } catch (error) {
    if (error instanceof NasResourceCommitError) throw error
    fail(NAS_RESOURCE_ERROR_CODES.COMMIT_FAILED, 'The NAS resource commit failed.')
  }
}

export const commitNasScanGeneration = commitNasResourceScan
export const commitNasResourceGeneration = commitNasResourceScan
export const applyNasResourceScan = commitNasResourceScan
export const commitNasScanBatch = commitNasResourceScan
export const commitNasResourceBatch = commitNasResourceScan
export const commitNasScan = commitNasResourceScan

export function normalizeNasResourceObservation(input) {
  return normalizeObservation(input)
}
