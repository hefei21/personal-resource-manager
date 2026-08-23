import {
  NAS_SCAN_ROOT_TABLE,
  RESOURCE_CONFLICT_CANDIDATE_TABLE,
  RESOURCE_SOURCE_TABLE,
  NAS_SCAN_ENTRY_TABLE
} from '../config/resourceModelSchema.js'
import { normalizeNasScanRules } from '../config/nasScan.js'
import { canonicalizeNasScanRoot } from './nasScanSecurity.js'

const POSITIVE_ID = /^[1-9]\d*$/u
const MAX_NAME_LENGTH = 160
const MAX_RULES_VERSION = Number.MAX_SAFE_INTEGER - 1

export const NAS_SCAN_ROOT_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'NAS_SCAN_ROOT_INPUT_INVALID',
  NOT_FOUND: 'NAS_SCAN_ROOT_NOT_FOUND',
  CONFLICT: 'NAS_SCAN_ROOT_CONFLICT',
  PATH_INVALID: 'NAS_SCAN_ROOT_PATH_INVALID',
  RULES_INVALID: 'NAS_SCAN_ROOT_RULES_INVALID',
  WRITE_FAILED: 'NAS_SCAN_ROOT_WRITE_FAILED'
})

export class NasScanRootServiceError extends Error {
  constructor(code, message = 'NAS scan root operation failed.', cause = undefined) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'NasScanRootServiceError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new NasScanRootServiceError(code, message, cause)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(NAS_SCAN_ROOT_ERROR_CODES.WRITE_FAILED, 'NAS scan root storage is unavailable.')
  }
}

function normalizeId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The scan root id is invalid.')
    return value
  }
  if (typeof value !== 'string' || !POSITIVE_ID.test(value.trim())) {
    fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The scan root id is invalid.')
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The scan root id is invalid.')
  return id
}

function normalizeName(value) {
  if (typeof value !== 'string') fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The scan root name is invalid.')
  const name = value.normalize('NFKC').trim()
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The scan root name is invalid.')
  }
  return name
}

function normalizeEnabled(value) {
  if (typeof value !== 'boolean') fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The enabled flag is invalid.')
  return value
}

function assertBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The NAS scan root body is invalid.')
  }
}

function parseRules(row) {
  try {
    return normalizeNasScanRules(JSON.parse(row.rules_json))
  } catch (error) {
    if (error instanceof NasScanRootServiceError) throw error
    fail(NAS_SCAN_ROOT_ERROR_CODES.WRITE_FAILED, 'Stored NAS scan rules are invalid.', error)
  }
}

function safeCount(value) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function ruleSummary(rules) {
  return Object.freeze({
    version: rules.version,
    useGitignore: rules.useGitignore,
    maxFileBytes: rules.maxFileBytes,
    maxDepth: rules.maxDepth,
    allowedExtensionCount: rules.allowedExtensions?.length ?? 0,
    excludedGlobCount: rules.excludedGlobs?.length ?? 0,
    credentialGlobCount: rules.credentialGlobs?.length ?? 0
  })
}

function projectRoot(row, counts = {}) {
  if (!row) return null
  const rules = parseRules(row)
  return Object.freeze({
    id: Number(row.id),
    name: row.name,
    enabled: Number(row.enabled) === 1,
    rulesVersion: Number(row.rules_version),
    lastSuccessfulGeneration: Number(row.last_successful_generation),
    rules: ruleSummary(rules),
    counts: Object.freeze({
      active: safeCount(counts.active),
      missing: safeCount(counts.missing),
      excluded: safeCount(counts.excluded),
      errors: safeCount(counts.errors),
      conflicts: safeCount(counts.conflicts)
    })
  })
}

function readRoot(database, id) {
  return database.prepare(`
    SELECT id, name, root_path, enabled, rules_json, rules_version,
           last_successful_generation, created_at, updated_at
    FROM ${NAS_SCAN_ROOT_TABLE}
    WHERE id = ?
  `).get(id) ?? null
}

function readCounts(database, id) {
  const sources = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN state = 'missing' THEN 1 ELSE 0 END), 0) AS missing,
      COALESCE(SUM(CASE WHEN state = 'excluded' THEN 1 ELSE 0 END), 0) AS excluded
    FROM ${RESOURCE_SOURCE_TABLE}
    WHERE scan_root_id = ?
  `).get(id) ?? {}
  const errors = database.prepare(`
    SELECT COUNT(*) AS count
    FROM ${NAS_SCAN_ENTRY_TABLE}
    WHERE scan_root_id = ? AND observation_status = 'error'
  `).get(id)?.count
  const conflicts = database.prepare(`
    SELECT COUNT(DISTINCT c.id) AS count
    FROM ${RESOURCE_CONFLICT_CANDIDATE_TABLE} c
    JOIN ${RESOURCE_SOURCE_TABLE} s
      ON s.resource_id = c.left_resource_id OR s.resource_id = c.right_resource_id
    WHERE s.scan_root_id = ? AND c.status = 'pending'
  `).get(id)?.count
  return {
    active: sources.active,
    missing: sources.missing,
    excluded: sources.excluded,
    errors,
    conflicts
  }
}

function projectWithCounts(database, row) {
  return projectRoot(row, readCounts(database, row.id))
}

function mapWriteError(error) {
  if (error instanceof NasScanRootServiceError) throw error
  if (String(error?.code ?? '').includes('CONSTRAINT') || String(error?.message ?? '').includes('UNIQUE')) {
    fail(NAS_SCAN_ROOT_ERROR_CODES.CONFLICT, 'The NAS scan root conflicts with an existing root.', error)
  }
  fail(NAS_SCAN_ROOT_ERROR_CODES.WRITE_FAILED, 'The NAS scan root could not be saved.', error)
}

function createService({
  canonicalize = canonicalizeNasScanRoot,
  normalize = normalizeNasScanRules
} = {}) {
  const normalizeRulesForService = (value) => {
    try {
      return normalize(value ?? {})
    } catch (error) {
      fail(NAS_SCAN_ROOT_ERROR_CODES.RULES_INVALID, 'The NAS scan rules are invalid.', error)
    }
  }
  const normalizePathForService = (value) => {
    try {
      return canonicalize(value)
    } catch (error) {
      fail(NAS_SCAN_ROOT_ERROR_CODES.PATH_INVALID, 'The NAS scan root path is invalid.', error)
    }
  }

  function list(database) {
    assertDatabase(database)
    try {
      return Object.freeze(database.prepare(`
        SELECT id, name, root_path, enabled, rules_json, rules_version,
               last_successful_generation, created_at, updated_at
        FROM ${NAS_SCAN_ROOT_TABLE}
        ORDER BY id ASC
      `).all().map((row) => projectWithCounts(database, row)))
    } catch (error) {
      mapWriteError(error)
    }
  }

  function get(database, rawId) {
    assertDatabase(database)
    const id = normalizeId(rawId)
    try {
      const row = readRoot(database, id)
      return row ? projectWithCounts(database, row) : null
    } catch (error) {
      mapWriteError(error)
    }
  }

  function create(database, body = {}) {
    assertDatabase(database)
    assertBodyObject(body)
    const allowed = new Set(['name', 'rootPath', 'rules', 'enabled'])
    if (Object.keys(body).some((key) => !allowed.has(key)) || !Object.hasOwn(body, 'name') || !Object.hasOwn(body, 'rootPath')) {
      fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The NAS scan root body is invalid.')
    }
    const name = normalizeName(body.name)
    const rootPath = normalizePathForService(body.rootPath)
    const rules = normalizeRulesForService(body.rules ?? {})
    const enabled = body.enabled === undefined ? true : normalizeEnabled(body.enabled)
    try {
      const outcome = database.transaction(() => database.prepare(`
        INSERT INTO ${NAS_SCAN_ROOT_TABLE}
          (name, root_path, enabled, rules_json, rules_version, last_successful_generation)
        VALUES (?, ?, ?, ?, 1, 0)
      `).run(name, rootPath, enabled ? 1 : 0, JSON.stringify(rules)))()
      return projectWithCounts(database, readRoot(database, Number(outcome.lastInsertRowid)))
    } catch (error) {
      mapWriteError(error)
    }
  }

  function update(database, rawId, body = {}) {
    assertDatabase(database)
    assertBodyObject(body)
    const allowed = new Set(['name', 'rootPath', 'rules', 'enabled'])
    if (Object.keys(body).some((key) => !allowed.has(key)) || Object.keys(body).length === 0) {
      fail(NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID, 'The NAS scan root body is invalid.')
    }
    const id = normalizeId(rawId)
    try {
      const current = readRoot(database, id)
      if (!current) return null
      const name = Object.hasOwn(body, 'name') ? normalizeName(body.name) : current.name
      const rootPath = Object.hasOwn(body, 'rootPath')
        ? normalizePathForService(body.rootPath)
        : current.root_path
      const rules = Object.hasOwn(body, 'rules')
        ? normalizeRulesForService(body.rules)
        : parseRules(current)
      const enabled = Object.hasOwn(body, 'enabled') ? normalizeEnabled(body.enabled) : Number(current.enabled) === 1
      const rulesJson = JSON.stringify(rules)
      // The task contract uses rules_version as the complete scan-config
      // revision. A root path change must therefore invalidate already queued
      // work just like a rules change; otherwise a stale task could scan a new
      // path under the old idempotency identity.
      const scanConfigChanged = rulesJson !== current.rules_json || rootPath !== current.root_path
      const nextRulesVersion = scanConfigChanged ? Number(current.rules_version) + 1 : Number(current.rules_version)
      if (!Number.isSafeInteger(nextRulesVersion) || nextRulesVersion < 1 || nextRulesVersion > MAX_RULES_VERSION) {
        fail(NAS_SCAN_ROOT_ERROR_CODES.WRITE_FAILED, 'The NAS scan root rules version is exhausted.')
      }
      database.transaction(() => {
        database.prepare(`
          UPDATE ${NAS_SCAN_ROOT_TABLE}
          SET name = ?, root_path = ?, enabled = ?, rules_json = ?, rules_version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(name, rootPath, enabled ? 1 : 0, rulesJson, nextRulesVersion, id)
        if (scanConfigChanged) {
          // A Git source is meaningful only under the scan configuration that
          // most recently discovered it.  Fence reads/imports until a new
          // discovery validates the same relative path under this revision.
          database.prepare(`
            UPDATE ${RESOURCE_SOURCE_TABLE}
               SET state = 'missing', updated_at = CURRENT_TIMESTAMP
             WHERE scan_root_id = ? AND source_kind = 'git_nas'
          `).run(id)
        }
      })()
      return projectWithCounts(database, readRoot(database, id))
    } catch (error) {
      mapWriteError(error)
    }
  }

  function disable(database, rawId) {
    return update(database, rawId, { enabled: false })
  }

  function status(database, rawId) {
    return get(database, rawId)
  }

  return Object.freeze({ list, get, create, update, disable, status })
}

export const nasScanRootService = createService()
export const createNasScanRootService = createService
export const projectNasScanRoot = projectRoot
export const normalizeNasScanRootId = normalizeId

export function listNasScanRoots(database) {
  return nasScanRootService.list(database)
}

export function getNasScanRoot(database, id) {
  return nasScanRootService.get(database, id)
}

export function createNasScanRoot(database, body) {
  return nasScanRootService.create(database, body)
}

export function updateNasScanRoot(database, id, body) {
  return nasScanRootService.update(database, id, body)
}

export function disableNasScanRoot(database, id) {
  return nasScanRootService.disable(database, id)
}

export function getNasScanRootStatus(database, id) {
  return nasScanRootService.status(database, id)
}
