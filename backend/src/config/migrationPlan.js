import { createHash } from 'node:crypto'
import {
  MigrationCompatibilityError,
  normalizeMigrationCompatibility
} from './migrationCompatibility.js'

const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9][a-z0-9._-]*$/
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/
const PROOF_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SOURCE_VARIANT_KEYS = ['proofKey', 'source']
const APPLIED_STATUSES = new Set(['applied', 'failed', 'running'])

/**
 * Stable, deliberately simple ordering for migration identifiers.
 *
 * The comparison is based on code points rather than localeCompare(), whose
 * result can vary with the host locale. Migration IDs are ASCII-only anyway,
 * so this also makes the ordering easy to reproduce in other runtimes.
 */
function compareMigrationIds(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function fail(code, message, details = {}) {
  throw new MigrationPlanError(code, message, details)
}

function assertMigrationId(id) {
  if (typeof id !== 'string' || !MIGRATION_ID_PATTERN.test(id)) {
    fail(
      'MIGRATION_ID_INVALID',
      'Migration id must match /^\\d{4}_[a-z0-9][a-z0-9._-]*$/.',
      { id: typeof id === 'string' ? id : undefined }
    )
  }
}

function assertChecksum(checksum, fieldName = 'checksum') {
  if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    fail(
      'MIGRATION_CHECKSUM_INVALID',
      `${fieldName} must be a lowercase SHA-256 hex digest.`,
      { fieldName }
    )
  }
}

function publicMigration(migration) {
  const publicValue = { id: migration.id, checksum: migration.checksum }
  if (migration.compatibility !== undefined) {
    publicValue.compatibility = migration.sourceVariants === undefined
      ? migration.compatibility
      : redactCompatibilityProofKeys(migration.compatibility)
  }
  return Object.freeze(publicValue)
}

function redactCompatibilityProofKeys(compatibility) {
  if (compatibility.kind !== 'table-transition') return compatibility
  return Object.freeze({
    kind: compatibility.kind,
    table: compatibility.table,
    target: compatibility.target,
    legacy: Object.freeze(compatibility.legacy.map(({ proofKey, ...proof }) => Object.freeze(proof)))
  })
}

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    checksum: record.checksum,
    status: record.status
  })
}

/**
 * Error raised for a malformed registry or a plan that cannot safely run.
 * Callers can branch on `code` without parsing human-readable messages.
 */
export class MigrationPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MigrationPlanError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/**
 * Compute the checksum of the exact explicit migration source text.
 * When supplied, the normalized compatibility condition is appended to a
 * separate hash domain. No function serialization or runtime formatting is
 * involved.
 */
export function computeMigrationChecksum(source, compatibility) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    fail('MIGRATION_SOURCE_INVALID', 'Migration source must be non-empty text.')
  }

  const normalizedSource = source.replace(/\r\n?/g, '\n')
  const hash = createHash('sha256').update(Buffer.from(normalizedSource, 'utf8'))
  if (compatibility !== undefined) {
    const normalizedCompatibility = normalizeCompatibilityForPlan(compatibility)
    hash.update(Buffer.from('\n\\0migration-compatibility\\0', 'utf8'))
    hash.update(Buffer.from(JSON.stringify(normalizedCompatibility), 'utf8'))
  }
  return hash.digest('hex')
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length)
  hash.update(bytes)
}

function normalizeSourceText(source, fieldName) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    fail('MIGRATION_SOURCE_INVALID', `${fieldName} must be non-empty text.`)
  }
  return source.replace(/\r\n?/g, '\n')
}

function normalizeSourceVariants(sourceVariants, compatibility) {
  if (!Array.isArray(sourceVariants) || sourceVariants.length === 0) {
    fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'sourceVariants must be a non-empty array.')
  }
  if (compatibility?.kind !== 'table-transition') {
    fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'sourceVariants require table-transition compatibility.')
  }
  if (compatibility.legacy.some((proof) => !Object.hasOwn(proof, 'proofKey'))) {
    fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'Every legacy proof must declare proofKey.')
  }

  const proofKeys = new Set(compatibility.legacy.map((proof) => proof.proofKey))
  const seen = new Set()
  const normalized = sourceVariants.map((variant, index) => {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
      fail('MIGRATION_SOURCE_VARIANTS_INVALID', `sourceVariants[${index}] must be an object.`)
    }
    const keys = Object.keys(variant).sort()
    if (keys.length !== SOURCE_VARIANT_KEYS.length || keys.some((key, keyIndex) => key !== [...SOURCE_VARIANT_KEYS].sort()[keyIndex])) {
      fail('MIGRATION_SOURCE_VARIANTS_INVALID', `sourceVariants[${index}] contains unsupported or missing fields.`)
    }
    if (typeof variant.proofKey !== 'string' || !PROOF_KEY_PATTERN.test(variant.proofKey)) {
      fail('MIGRATION_SOURCE_VARIANTS_INVALID', `sourceVariants[${index}].proofKey is invalid.`)
    }
    if (seen.has(variant.proofKey)) {
      fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'sourceVariants contains a duplicate proofKey.')
    }
    if (!proofKeys.has(variant.proofKey)) {
      fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'sourceVariants contains an orphan proofKey.')
    }
    seen.add(variant.proofKey)
    return Object.freeze({
      proofKey: variant.proofKey,
      source: normalizeSourceText(variant.source, `sourceVariants[${index}].source`)
    })
  })
  if (seen.size !== proofKeys.size) {
    fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'sourceVariants must cover every legacy proof.')
  }
  normalized.sort((left, right) => compareMigrationIds(left.proofKey, right.proofKey))
  return Object.freeze(normalized)
}

function computeSourceVariantsChecksum(sourceVariants, compatibility) {
  const hash = createHash('sha256')
  hash.update(Buffer.from('\0migration-source-variants-v1\0', 'utf8'))
  updateLengthPrefixed(hash, JSON.stringify(compatibility))
  for (const variant of sourceVariants) {
    updateLengthPrefixed(hash, variant.proofKey)
    updateLengthPrefixed(hash, variant.source)
  }
  return hash.digest('hex')
}

function normalizeCompatibilityForPlan(compatibility) {
  try {
    return normalizeMigrationCompatibility(compatibility)
  } catch (error) {
    if (error instanceof MigrationCompatibilityError) {
      fail(error.code, error.message, error.details)
    }
    throw error
  }
}

/**
 * Validate and normalize one migration definition.
 *
 * `source` is intentionally a required explicit text representation (SQL or
 * another documented migration source format). Its exact UTF-8 bytes are
 * hashed after CRLF and CR are normalized to LF. Other source bytes are kept
 * unchanged.
 */
export function defineMigration(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('MIGRATION_DEFINITION_INVALID', 'Migration definition must be an object.')
  }

  const { id } = definition
  assertMigrationId(id)
  const hasSource = Object.hasOwn(definition, 'source')
  const hasSourceVariants = Object.hasOwn(definition, 'sourceVariants')
  const allowedKeys = new Set([
    'id', 'checksum', 'compatibility', hasSource ? 'source' : 'sourceVariants'
  ])
  if (Object.keys(definition).some((key) => !allowedKeys.has(key))) {
    fail('MIGRATION_DEFINITION_INVALID', 'Migration definition contains unsupported fields.')
  }
  if (hasSource === hasSourceVariants) {
    fail('MIGRATION_SOURCE_INVALID', 'Migration must declare exactly one of source or sourceVariants.')
  }
  const compatibility = definition.compatibility === undefined
    ? undefined
    : normalizeCompatibilityForPlan(definition.compatibility)
  const source = hasSource ? definition.source : undefined
  if (
    hasSource &&
    compatibility?.kind === 'table-transition' &&
    compatibility.legacy.some((proof) => Object.hasOwn(proof, 'proofKey'))
  ) {
    fail('MIGRATION_SOURCE_VARIANTS_INVALID', 'proofKey is only supported with sourceVariants.')
  }
  const sourceVariants = hasSourceVariants
    ? normalizeSourceVariants(definition.sourceVariants, compatibility)
    : undefined
  const computedChecksum = hasSource
    ? computeMigrationChecksum(source, compatibility)
    : computeSourceVariantsChecksum(sourceVariants, compatibility)

  if (definition.checksum !== undefined) {
    assertChecksum(definition.checksum)
    if (definition.checksum !== computedChecksum) {
      fail(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Migration ${id} checksum does not match its explicit source.`,
        { id }
      )
    }
  }

  const migration = { id, checksum: computedChecksum }
  if (hasSource) migration.source = source
  else migration.sourceVariants = sourceVariants
  if (compatibility !== undefined) migration.compatibility = compatibility
  return Object.freeze(migration)
}

/**
 * Create a deterministic immutable registry. Definitions are sorted by ID and
 * duplicate IDs are rejected before a registry is returned.
 */
export function createMigrationRegistry(definitions = []) {
  if (!Array.isArray(definitions)) {
    fail('MIGRATION_REGISTRY_INVALID', 'Migration definitions must be an array.')
  }

  const migrations = definitions.map(defineMigration).sort((left, right) =>
    compareMigrationIds(left.id, right.id)
  )

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].id === migrations[index].id) {
      fail('MIGRATION_ID_DUPLICATE', `Migration id ${migrations[index].id} is duplicated.`, {
        id: migrations[index].id
      })
    }
  }

  return Object.freeze({ migrations: Object.freeze(migrations) })
}

/**
 * Return a new registry with one definition added; the existing registry is
 * never mutated.
 */
export function registerMigration(registry, definition) {
  assertRegistry(registry)
  return createMigrationRegistry([...registry.migrations, definition])
}

function assertRegistry(registry) {
  if (
    !registry ||
    !Array.isArray(registry.migrations) ||
    registry.migrations.some((migration) => !migration || typeof migration.id !== 'string')
  ) {
    fail('MIGRATION_REGISTRY_INVALID', 'Expected a registry created by createMigrationRegistry.')
  }
}

function normalizeAppliedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('MIGRATION_RECORD_INVALID', 'Applied migration records must be objects.')
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    fail('MIGRATION_RECORD_INVALID', 'Applied migration record id must be non-empty text.')
  }

  assertChecksum(record.checksum, 'record checksum')

  const status = record.status ?? 'applied'
  if (!APPLIED_STATUSES.has(status)) {
    fail(
      'MIGRATION_RECORD_STATUS_INVALID',
      `Migration record ${record.id} has unsupported status ${String(status)}.`,
      { id: record.id }
    )
  }

  return { id: record.id, checksum: record.checksum, status }
}

function resolveTargetVersion(migrations, targetVersion) {
  if (migrations.length === 0) {
    if (targetVersion !== undefined && targetVersion !== null) {
      fail('MIGRATION_TARGET_UNKNOWN', `Migration target ${String(targetVersion)} is not registered.`)
    }
    return null
  }

  const resolvedTarget = targetVersion ?? migrations[migrations.length - 1].id
  const targetIndex = migrations.findIndex(({ id }) => id === resolvedTarget)
  if (targetIndex === -1) {
    fail('MIGRATION_TARGET_UNKNOWN', `Migration target ${String(resolvedTarget)} is not registered.`, {
      targetVersion: resolvedTarget
    })
  }

  return { targetVersion: resolvedTarget, targetIndex }
}

/**
 * Build a read-only migration plan from registry metadata and an applied-record
 * snapshot. This function has no database, filesystem, or application-startup
 * side effects.
 */
export function createMigrationPlan(registry, appliedRecords = [], options = {}) {
  assertRegistry(registry)
  if (!Array.isArray(appliedRecords)) {
    fail('MIGRATION_RECORDS_INVALID', 'Applied migration records must be an array.')
  }

  const records = appliedRecords.map(normalizeAppliedRecord)
  const recordsById = new Map()
  for (const record of records) {
    if (recordsById.has(record.id)) {
      fail('MIGRATION_RECORD_DUPLICATE', `Migration record ${record.id} is duplicated.`, {
        id: record.id
      })
    }
    recordsById.set(record.id, record)
  }

  for (const record of records) {
    if (record.status === 'failed' || record.status === 'running') {
      fail(
        'MIGRATION_RECORD_BLOCKED',
        `Migration record ${record.id} has blocking status ${record.status}.`,
        { id: record.id, status: record.status }
      )
    }
  }

  const { targetVersion, targetIndex } = resolveTargetVersion(
    registry.migrations,
    options.targetVersion
  ) ?? { targetVersion: null, targetIndex: -1 }
  const registeredById = new Map(registry.migrations.map((migration) => [migration.id, migration]))

  for (const record of records) {
    const migration = registeredById.get(record.id)
    if (migration && migration.checksum !== record.checksum) {
      fail(
        'MIGRATION_CHECKSUM_DRIFT',
        `Applied migration ${record.id} checksum differs from the registered checksum.`,
        { id: record.id }
      )
    }
  }

  const appliedRegisteredIndexes = registry.migrations
    .map((migration, index) => (recordsById.has(migration.id) ? index : -1))
    .filter((index) => index !== -1)

  const appliedBeyondTarget = appliedRegisteredIndexes.filter((index) => index > targetIndex)
  if (appliedBeyondTarget.length > 0) {
    const appliedIds = appliedBeyondTarget.map((index) => registry.migrations[index].id)
    fail(
      'MIGRATION_TARGET_BEHIND_APPLIED',
      `Migration target ${String(targetVersion)} is earlier than applied migrations ${appliedIds.join(', ')}.`,
      { targetVersion, appliedIds }
    )
  }

  if (appliedRegisteredIndexes.length > 0) {
    const lastAppliedIndex = appliedRegisteredIndexes[appliedRegisteredIndexes.length - 1]
    const missingIds = registry.migrations
      .slice(0, lastAppliedIndex)
      .filter(({ id }) => !recordsById.has(id))
      .map(({ id }) => id)

    if (missingIds.length > 0) {
      const subsequentAppliedIds = appliedRegisteredIndexes
        .filter((index) => index > 0 && recordsById.has(registry.migrations[index].id))
        .map((index) => registry.migrations[index].id)
      fail(
        'MIGRATION_HISTORY_GAP',
        `Applied migration history is missing ${missingIds.join(', ')} before ${registry.migrations[lastAppliedIndex].id}.`,
        { missingIds, subsequentAppliedIds }
      )
    }
  }

  const inScope = registry.migrations.slice(0, targetIndex + 1)
  const deferred = registry.migrations.slice(targetIndex + 1)
  const applied = inScope.filter(({ id }) => recordsById.has(id)).map(publicMigration)
  const pending = inScope.filter(({ id }) => !recordsById.has(id)).map(publicMigration)
  const deferredMigrations = deferred.map(publicMigration)
  const unknownHistory = records
    .filter(({ id }) => !registeredById.has(id))
    .sort((left, right) => compareMigrationIds(left.id, right.id))
    .map(publicRecord)

  return Object.freeze({
    targetVersion,
    registered: Object.freeze(registry.migrations.map(publicMigration)),
    applied: Object.freeze(applied),
    pending: Object.freeze(pending),
    deferred: Object.freeze(deferredMigrations),
    unknownHistory: Object.freeze(unknownHistory)
  })
}

export { MIGRATION_ID_PATTERN }
