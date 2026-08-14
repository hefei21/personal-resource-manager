import { isDeepStrictEqual } from 'node:util'
import {
  checkMigrationCompatibility,
  COMPATIBILITY_STATUSES
} from './migrationCompatibility.js'
import {
  createMigrationPlan,
  createMigrationRegistry,
  MigrationPlanError
} from './migrationPlan.js'
import { MIGRATION_LOCK_ACTIVE } from './migrationLock.js'

const SAFE_INCOMPATIBILITY_REASONS = new Set([
  'table-missing',
  'column-incompatible',
  'table-shape-incompatible',
  'target-proof-incompatible'
])

function normalizeDiagnostics(diagnostics) {
  if (
    !diagnostics ||
    typeof diagnostics !== 'object' ||
    Array.isArray(diagnostics) ||
    typeof diagnostics.migrationId !== 'string' ||
    typeof diagnostics.category !== 'string' ||
    typeof diagnostics.reason !== 'string'
  ) return undefined

  return Object.freeze({
    migrationId: diagnostics.migrationId,
    category: diagnostics.category,
    reason: diagnostics.reason
  })
}

function createSchemaIncompatibilityDiagnostics(migrationId, compatibility) {
  return Object.freeze({
    migrationId,
    category: 'schema-compatibility',
    reason: SAFE_INCOMPATIBILITY_REASONS.has(compatibility.reason)
      ? compatibility.reason
      : 'incompatible'
  })
}

function fail(code, message, options = {}) {
  throw new MigrationAdoptionPlanError(code, message, options)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    fail(
      'MIGRATION_ADOPTION_DATABASE_INVALID',
      'Migration adoption planning requires a SQLite database connection.'
    )
  }
}

function assertActiveLock(lock) {
  if (!lock || lock.state !== MIGRATION_LOCK_ACTIVE) {
    fail(
      'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE',
      'Migration adoption planning requires an active migration lock.'
    )
  }
}

function normalizeRegistry(registry) {
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.migrations)) {
    fail('MIGRATION_ADOPTION_REGISTRY_INVALID', 'Migration adoption registry is invalid.')
  }

  let normalized
  try {
    normalized = createMigrationRegistry(registry.migrations.map((migration) => {
      const definition = {
        id: migration.id,
        checksum: migration.checksum
      }
      if (Object.hasOwn(migration, 'source')) definition.source = migration.source
      if (Object.hasOwn(migration, 'sourceVariants')) definition.sourceVariants = migration.sourceVariants
      if (Object.hasOwn(migration, 'compatibility')) {
        definition.compatibility = migration.compatibility
      }
      return definition
    }))
  } catch {
    fail('MIGRATION_ADOPTION_REGISTRY_INVALID', 'Migration adoption registry is invalid.')
  }

  if (normalized.migrations.length !== registry.migrations.length) {
    fail('MIGRATION_ADOPTION_REGISTRY_INVALID', 'Migration adoption registry is invalid.')
  }

  for (let index = 0; index < normalized.migrations.length; index += 1) {
    const source = registry.migrations[index]
    const migration = normalized.migrations[index]
    if (!isDeepStrictEqual(source, migration)) {
      fail('MIGRATION_ADOPTION_REGISTRY_INVALID', 'Migration adoption registry is invalid.')
    }
  }

  return normalized
}

function validatedPlan(registry, appliedRecords, targetVersion) {
  try {
    return createMigrationPlan(registry, appliedRecords, { targetVersion })
  } catch (error) {
    if (error instanceof MigrationPlanError) {
      fail(error.code, 'Migration adoption plan input is invalid.')
    }
    fail('MIGRATION_ADOPTION_PLAN_INVALID', 'Migration adoption plan input is invalid.')
  }
}

function summary(adoptableIds, pendingCount, stopped) {
  const result = {
    adoptable: Object.freeze(
      adoptableIds.map((id) => Object.freeze({ id }))
    ),
    adoptableCount: adoptableIds.length,
    pendingCount
  }
  if (stopped) result.stopped = Object.freeze({ ...stopped })
  return Object.freeze(result)
}

/**
 * Compute the continuous prefix of pending migrations whose declared schema
 * conditions are already satisfied. This function never writes schema,
 * migration sources, attempts, or success-ledger records.
 */
export function createMigrationAdoptionPlan({
  database,
  registry,
  appliedRecords = [],
  lock,
  targetVersion
} = {}) {
  assertDatabase(database)
  assertActiveLock(lock)
  const normalizedRegistry = normalizeRegistry(registry)
  const plan = validatedPlan(normalizedRegistry, appliedRecords, targetVersion)
  const migrationsById = new Map(
    normalizedRegistry.migrations.map((migration) => [migration.id, migration])
  )
  const adoptableIds = []

  for (const pending of plan.pending) {
    const migration = migrationsById.get(pending.id)
    if (!Object.hasOwn(migration, 'compatibility')) {
      return summary(adoptableIds, plan.pending.length, {
        id: migration.id,
        reason: 'requires-execution'
      })
    }

    assertActiveLock(lock)
    let compatibility
    try {
      compatibility = checkMigrationCompatibility(database, migration.compatibility)
    } catch {
      fail(
        'MIGRATION_ADOPTION_SCHEMA_CHECK_FAILED',
        'Migration adoption schema check failed.'
      )
    }

    if (compatibility.status === COMPATIBILITY_STATUSES.SATISFIED) {
      adoptableIds.push(migration.id)
      continue
    }
    if (compatibility.status === COMPATIBILITY_STATUSES.MISSING) {
      return summary(adoptableIds, plan.pending.length, {
        id: migration.id,
        reason: 'missing'
      })
    }
    if (compatibility.status === COMPATIBILITY_STATUSES.INCOMPATIBLE) {
      fail(
        'MIGRATION_ADOPTION_SCHEMA_INCOMPATIBLE',
        'Migration schema is incompatible with adoption.',
        {
          diagnostics: createSchemaIncompatibilityDiagnostics(
            migration.id,
            compatibility
          )
        }
      )
    }
    fail(
      'MIGRATION_ADOPTION_SCHEMA_CHECK_FAILED',
      'Migration adoption schema check failed.'
    )
  }

  return summary(adoptableIds, plan.pending.length)
}

export class MigrationAdoptionPlanError extends Error {
  constructor(code, message, { diagnostics } = {}) {
    super(message)
    this.name = 'MigrationAdoptionPlanError'
    this.code = code
    const safeDiagnostics = normalizeDiagnostics(diagnostics)
    if (safeDiagnostics) this.diagnostics = safeDiagnostics
  }
}
