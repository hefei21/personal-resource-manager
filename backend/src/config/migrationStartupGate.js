import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  acquireMigrationLock,
  isMigrationLockBusyError,
  MIGRATION_LOCK_BUSY
} from './migrationLock.js'
import { adoptMigrationPrefix } from './migrationAdoption.js'
import { createMigrationPlan } from './migrationPlan.js'
import {
  ensureMigrationControlTables,
  listAppliedMigrations
} from './migrationControlStore.js'
import { executeMigrationBatch } from './migrationExecutor.js'
import { reconcileStartedMigrationAttempts } from './migrationRecovery.js'

const LEGACY_TABLE = 'schema_migrations'
const LEGACY_GUARDS = Object.freeze([
  Object.freeze({ name: 'prm_legacy_schema_migrations_insert_guard', event: 'INSERT' }),
  Object.freeze({ name: 'prm_legacy_schema_migrations_update_guard', event: 'UPDATE' }),
  Object.freeze({ name: 'prm_legacy_schema_migrations_delete_guard', event: 'DELETE' })
])
const LEGACY_EMPTY_FINGERPRINT = Object.freeze({
  present: false,
  schemaHash: null,
  rowCount: 0,
  contentHash: null
})
const MUTATING_OPERATIONS = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE'])
const IDENTIFIER_CHARS = /[A-Za-z0-9_$]/

export const MIGRATION_STARTUP_GATE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'MIGRATION_STARTUP_GATE_INPUT_INVALID',
  DATABASE_INVALID: 'MIGRATION_STARTUP_GATE_DATABASE_INVALID',
  DATABASE_PATH_INVALID: 'MIGRATION_STARTUP_GATE_DATABASE_PATH_INVALID',
  DATABASE_PATH_MISMATCH: 'MIGRATION_STARTUP_GATE_DATABASE_PATH_MISMATCH',
  LEGACY_MUTATION_BLOCKED: 'MIGRATION_STARTUP_GATE_LEGACY_MUTATION_BLOCKED',
  LEGACY_FINGERPRINT_CHANGED: 'MIGRATION_STARTUP_GATE_LEGACY_FINGERPRINT_CHANGED',
  FAILED: 'MIGRATION_STARTUP_GATE_FAILED',
  RELEASE_FAILED: 'MIGRATION_STARTUP_GATE_RELEASE_FAILED'
})

const SAFE_MESSAGES = Object.freeze({
  [MIGRATION_STARTUP_GATE_ERROR_CODES.INPUT_INVALID]: 'Migration startup gate input is invalid.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_INVALID]: 'Migration startup gate database is invalid.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_INVALID]: 'Migration startup gate database path is invalid.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_MISMATCH]: 'Migration startup gate database path does not match the connection.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_MUTATION_BLOCKED]: 'Migration startup gate rejected a legacy table mutation.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_FINGERPRINT_CHANGED]: 'Migration startup gate detected a legacy table change.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED]: 'Migration startup gate failed.',
  [MIGRATION_STARTUP_GATE_ERROR_CODES.RELEASE_FAILED]: 'Migration startup gate could not release its lock.'
})

export class MigrationStartupGateError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] ?? SAFE_MESSAGES[MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED], { cause, causes } = {}) {
    super(message, { cause })
    this.name = 'MigrationStartupGateError'
    this.code = code
    if (causes) this.causes = Object.freeze([...causes])
  }
}

function fail(code, cause) {
  throw new MigrationStartupGateError(code, SAFE_MESSAGES[code], { cause })
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function normalizeMainDbPath(mainDbPath) {
  if (typeof mainDbPath !== 'string' || mainDbPath.trim() === '' || mainDbPath.startsWith('file:')) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_INVALID)
  }
  if (mainDbPath.trim() === ':memory:') {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_INVALID)
  }
  return path.resolve(mainDbPath)
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.name !== 'string' ||
    database.name.trim() === '' ||
    database.name === ':memory:' ||
    database.name.startsWith('file:') ||
    database.open !== true ||
    database.constructor?.name !== 'Database' ||
    typeof database.prepare !== 'function' ||
    typeof database.exec !== 'function' ||
    typeof database.transaction !== 'function' ||
    typeof database.pragma !== 'function'
  ) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_INVALID)
  }
}

function sameFile(left, right) {
  if (left.dev === right.dev && left.ino === right.ino && left.ino !== 0) return true
  try {
    return fs.realpathSync.native(left.path) === fs.realpathSync.native(right.path)
  } catch {
    return false
  }
}

function validateDatabasePath(database, mainDbPath) {
  assertDatabase(database)
  const resolvedMainDbPath = normalizeMainDbPath(mainDbPath)
  const databaseName = path.resolve(database.name)
  let mainStat
  let databaseStat
  try {
    mainStat = fs.statSync(resolvedMainDbPath)
    databaseStat = fs.statSync(databaseName)
  } catch (error) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_INVALID, error)
  }
  if (!mainStat.isFile() || !databaseStat.isFile()) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_INVALID)
  }
  if (!sameFile(
    { path: resolvedMainDbPath, ...mainStat },
    { path: databaseName, ...databaseStat }
  )) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_MISMATCH)
  }
  return resolvedMainDbPath
}

function stableValue(value) {
  if (value === null) return null
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { type: 'buffer', value: value.toString('base64') }
  }
  if (value instanceof Uint8Array) {
    return { type: 'buffer', value: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return { type: 'number', value: String(value) }
  return value
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function readLegacyFingerprint(database) {
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(LEGACY_TABLE)
  if (!table) return LEGACY_EMPTY_FINGERPRINT

  const tableInfo = database.pragma(`table_info('${LEGACY_TABLE}')`)
  const rows = database.prepare(`SELECT * FROM "${LEGACY_TABLE}"`).all()
  const schemaHash = sha256(stableSerialize({ sql: table.sql, tableInfo }))
  const serializedRows = rows.map(stableSerialize).sort()
  const contentHash = sha256(stableSerialize(serializedRows))
  return Object.freeze({
    present: true,
    schemaHash,
    rowCount: rows.length,
    contentHash
  })
}

function installLegacyReadOnlyGuards(database) {
  for (const { name, event } of LEGACY_GUARDS) {
    database.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS "${name}"
      BEFORE ${event} ON main."${LEGACY_TABLE}"
      BEGIN
        SELECT RAISE(ABORT, 'MIGRATION_LEGACY_TABLE_READ_ONLY');
      END;
    `)
    const trigger = database.prepare(
      'SELECT sql FROM sqlite_temp_master WHERE type = \'trigger\' AND name = ?'
    ).get(name)
    if (
      typeof trigger?.sql !== 'string' ||
      !trigger.sql.includes(`BEFORE ${event}`) ||
      !trigger.sql.includes(`MIGRATION_LEGACY_TABLE_READ_ONLY`)
    ) {
      fail(MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED)
    }
  }
}

function tokenizeSql(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '-' && next === '-') {
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index = Math.min(source.length, index + 2)
      continue
    }
    if (character === "'") {
      let value = ''
      index += 1
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          value += "'"
          index += 2
          continue
        }
        if (source[index] === "'") {
          index += 1
          break
        }
        value += source[index]
        index += 1
      }
      tokens.push({ kind: 'string', value })
      continue
    }
    if (character === '"' || character === '`') {
      const quote = character
      let value = ''
      index += 1
      while (index < source.length) {
        if (source[index] === quote && source[index + 1] === quote) {
          value += quote
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        value += source[index]
        index += 1
      }
      tokens.push({ kind: 'identifier', value: value.toLowerCase() })
      continue
    }
    if (character === '[') {
      let value = ''
      index += 1
      while (index < source.length && source[index] !== ']') value += source[index++]
      index = Math.min(source.length, index + 1)
      tokens.push({ kind: 'identifier', value: value.toLowerCase() })
      continue
    }
    if (IDENTIFIER_CHARS.test(character)) {
      let value = character
      index += 1
      while (index < source.length && IDENTIFIER_CHARS.test(source[index])) value += source[index++]
      tokens.push({ kind: 'word', value: value.toUpperCase() })
      continue
    }
    if (character === ';' || character === '.') tokens.push({ kind: 'punctuation', value: character })
    index += 1
  }
  return tokens
}

function identifierAt(tokens, index) {
  const token = tokens[index]
  return token?.kind !== 'punctuation' && token?.value?.toLowerCase() === LEGACY_TABLE
}

function legacyTableAt(tokens, index) {
  if (identifierAt(tokens, index)) return true
  return (
    tokens[index]?.kind !== undefined &&
    tokens[index]?.kind !== 'punctuation' &&
    tokens[index + 1]?.value === '.' &&
    identifierAt(tokens, index + 2)
  )
}

function hasIdentifierAfter(tokens, start, marker) {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === marker) {
      let candidate = index + 1
      while (tokens[candidate]?.value === 'IF' || tokens[candidate]?.value === 'NOT' || tokens[candidate]?.value === 'EXISTS') candidate += 1
      return legacyTableAt(tokens, candidate)
    }
  }
  return false
}

function legacyMutationDetected(source) {
  const tokens = tokenizeSql(source)
  let statementStart = 0
  for (let index = 0; index <= tokens.length; index += 1) {
    if (index !== tokens.length && tokens[index].value !== ';') continue
    const statement = tokens.slice(statementStart, index)
    statementStart = index + 1
    for (let operationIndex = 0; operationIndex < statement.length; operationIndex += 1) {
      const operation = statement[operationIndex].value
      if (!MUTATING_OPERATIONS.has(operation)) continue
      if (operation === 'UPDATE' && legacyTableAt(statement, operationIndex + 1)) return true
      if (operation === 'INSERT' || operation === 'REPLACE') {
        if (hasIdentifierAfter(statement, operationIndex + 1, 'INTO')) return true
      } else if (operation === 'DELETE') {
        if (hasIdentifierAfter(statement, operationIndex + 1, 'FROM')) return true
      } else if (operation === 'ALTER' || operation === 'DROP') {
        for (const objectType of ['TABLE', 'VIEW', 'INDEX', 'TRIGGER']) {
          if (hasIdentifierAfter(statement, operationIndex + 1, objectType)) return true
        }
        if (operation === 'ALTER' && hasIdentifierAfter(statement, operationIndex + 1, 'TO')) return true
      } else if (operation === 'CREATE') {
        for (const objectType of ['TABLE', 'VIEW', 'INDEX', 'TRIGGER']) {
          if (hasIdentifierAfter(statement, operationIndex + 1, objectType)) return true
        }
        if (hasIdentifierAfter(statement, operationIndex + 1, 'ON')) return true
      }
    }
  }
  return false
}

function assertRegistrySources(registry) {
  if (!registry || !Array.isArray(registry.migrations)) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.INPUT_INVALID)
  }
  for (const migration of registry.migrations) {
    if (typeof migration?.source !== 'string' || legacyMutationDetected(migration.source)) {
      fail(MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_MUTATION_BLOCKED)
    }
  }
}

function fingerprintsEqual(left, right) {
  return left.present === right.present &&
    left.schemaHash === right.schemaHash &&
    left.rowCount === right.rowCount &&
    left.contentHash === right.contentHash
}

function assertLegacyFingerprintUnchanged(before, after) {
  if (!fingerprintsEqual(before, after)) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_FINGERPRINT_CHANGED)
  }
}

function mapAppliedRecords(records) {
  return records.map(({ migrationId, checksum }) => ({
    id: migrationId,
    checksum,
    status: 'applied'
  }))
}

function safeOperationError(error) {
  if (error instanceof MigrationStartupGateError) return error
  if (isMigrationLockBusyError(error) || error?.code === MIGRATION_LOCK_BUSY) {
    return new MigrationStartupGateError(MIGRATION_LOCK_BUSY, 'migration lock is busy', { cause: error })
  }
  return new MigrationStartupGateError(MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED, undefined, { cause: error })
}

function combinedFailure(operationFailure, releaseFailure) {
  const operationCause = operationFailure.cause ?? operationFailure
  const releaseCause = releaseFailure.cause ?? releaseFailure
  return new MigrationStartupGateError(
    operationFailure.code,
    operationFailure.message,
    {
      cause: new AggregateError([operationCause, releaseCause], 'Migration startup gate operation and release failed.'),
      causes: [operationCause, releaseCause]
    }
  )
}

function runLockedGate({ database, mainDbPath, registry, targetVersion, now, lockOptions }, resolvedMainDbPath, lock) {
  const legacyBefore = readLegacyFingerprint(database)
  if (legacyBefore.present) installLegacyReadOnlyGuards(database)
  ensureMigrationControlTables(database)
  const recovery = reconcileStartedMigrationAttempts({ database, lock, now })
  const adoption = adoptMigrationPrefix({ database, registry, lock, targetVersion, now })
  const appliedRecords = mapAppliedRecords(listAppliedMigrations(database))
  const plan = createMigrationPlan(registry, appliedRecords, { targetVersion })
  const execution = executeMigrationBatch({ database, registry, plan, lock, now })
  const legacyAfter = readLegacyFingerprint(database)
  assertLegacyFingerprintUnchanged(legacyBefore, legacyAfter)

  return deepFreeze({
    recovery: {
      scannedCount: recovery.scannedCount,
      appliedCount: recovery.appliedCount,
      interruptedCount: recovery.interruptedCount
    },
    adoption: {
      adoptedCount: adoption.adoptedCount,
      skippedCount: adoption.skippedCount,
      totalAdoptable: adoption.totalAdoptable,
      records: [...adoption.adopted, ...adoption.skipped].map(({ id, status }) => ({ id, status })),
      ...(adoption.stopped ? { stopped: { ...adoption.stopped } } : {})
    },
    execution: {
      executedCount: execution.executedCount,
      skippedCount: execution.skippedCount,
      total: execution.total,
      records: [...execution.executed, ...execution.skipped].map(({ id, status }) => ({ id, status }))
    },
    targetVersion: plan.targetVersion,
    legacyTablePresent: legacyBefore.present
  })
}

/**
 * Coordinate one migration startup pass. This function owns only the lock
 * lifecycle; application startup decides when to call it in C1b-4b.
 */
export function runMigrationStartupGate(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail(MIGRATION_STARTUP_GATE_ERROR_CODES.INPUT_INVALID)
  }
  const { database, mainDbPath, registry, targetVersion, now, lockOptions } = options
  let resolvedMainDbPath
  let lock = null
  let result
  let operationFailure = null
  let releaseFailure = null

  try {
    resolvedMainDbPath = validateDatabasePath(database, mainDbPath)
    assertRegistrySources(registry)
    lock = acquireMigrationLock(resolvedMainDbPath, lockOptions)
    result = runLockedGate({ database, mainDbPath, registry, targetVersion, now, lockOptions }, resolvedMainDbPath, lock)
  } catch (error) {
    operationFailure = safeOperationError(error)
  } finally {
    if (lock) {
      try {
        lock.release()
      } catch (error) {
        releaseFailure = new MigrationStartupGateError(
          MIGRATION_STARTUP_GATE_ERROR_CODES.RELEASE_FAILED,
          undefined,
          { cause: error }
        )
      }
    }
  }

  if (operationFailure && releaseFailure) throw combinedFailure(operationFailure, releaseFailure)
  if (operationFailure) throw operationFailure
  if (releaseFailure) throw releaseFailure
  return result
}
