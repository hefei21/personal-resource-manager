import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeMigrationChecksum,
  createMigrationPlan,
  createMigrationRegistry,
  defineMigration,
  MigrationPlanError,
  registerMigration
} from '../src/config/migrationPlan.js'

const source = (name) => `-- migration ${name}\nCREATE TABLE ${name} (id INTEGER);\n`
const definition = (id) => ({ id, source: source(id) })

function errorCode(action) {
  return thrownError(action).code
}

function thrownError(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationPlanError)
    return error
  }
  assert.fail('Expected migration plan action to throw.')
}

test('sorts registered migration IDs deterministically and exposes only metadata', () => {
  const registry = createMigrationRegistry([
    definition('0002_add_index'),
    definition('0001_initial'),
    definition('0010_finalize')
  ])
  const plan = createMigrationPlan(registry)

  assert.deepEqual(plan.registered.map(({ id }) => id), [
    '0001_initial',
    '0002_add_index',
    '0010_finalize'
  ])
  assert.ok(plan.registered.every((migration) => !('source' in migration)))
  assert.doesNotMatch(JSON.stringify(plan), /CREATE TABLE/)
  assert.equal(plan.targetVersion, '0010_finalize')
})

test('rejects invalid and duplicate migration IDs', () => {
  assert.equal(errorCode(() => createMigrationRegistry([definition('1_initial')])), 'MIGRATION_ID_INVALID')
  assert.equal(errorCode(() => createMigrationRegistry([definition('0001_INITIAL')])), 'MIGRATION_ID_INVALID')
  assert.equal(
    errorCode(() => createMigrationRegistry([definition('0001_initial'), definition('0001_initial')])),
    'MIGRATION_ID_DUPLICATE'
  )
})

test('computes a repeatable SHA-256 checksum from exact source text', () => {
  const first = computeMigrationChecksum('SELECT 1;\nSELECT 2;\n')
  const second = computeMigrationChecksum('SELECT 1;\nSELECT 2;\n')
  const crlf = computeMigrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')
  const cr = computeMigrationChecksum('SELECT 1;\rSELECT 2;\r')
  const differentContent = computeMigrationChecksum('SELECT 1;\nSELECT 3;\n')

  assert.equal(first, second)
  assert.equal(first, crlf)
  assert.equal(first, cr)
  assert.notEqual(first, differentContent)
  assert.equal(defineMigration({ id: '0001_initial', source: 'SELECT 1;' }).checksum, computeMigrationChecksum('SELECT 1;'))
  assert.equal(
    errorCode(() => defineMigration({ id: '0001_initial', source: 'SELECT 1;', checksum: '0'.repeat(64) })),
    'MIGRATION_CHECKSUM_MISMATCH'
  )
})

test('keeps the checksum of a migration without compatibility unchanged', () => {
  assert.equal(
    defineMigration({ id: '0001_initial', source: 'SELECT 1;' }).checksum,
    '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a'
  )
})

test('normalizes and freezes a column compatibility condition', () => {
  const input = {
    kind: 'column',
    table: 'items',
    column: {
      name: 'title',
      type: ' varchar ( 255 ) ',
      notNull: true,
      defaultValue: " 'ready' "
    }
  }
  const migration = defineMigration({ id: '0001_initial', source: 'SELECT 1;', compatibility: input })

  assert.deepEqual(migration.compatibility, {
    kind: 'column',
    table: 'items',
    column: {
      name: 'title',
      type: 'VARCHAR(255)',
      notNull: true,
      defaultValue: "'ready'"
    }
  })
  assert.ok(Object.isFrozen(migration))
  assert.ok(Object.isFrozen(migration.compatibility))
  assert.ok(Object.isFrozen(migration.compatibility.column))

  input.table = 'changed'
  input.column.type = 'INTEGER'
  input.column.defaultValue = 'changed'
  assert.equal(migration.compatibility.table, 'items')
  assert.equal(migration.compatibility.column.type, 'VARCHAR(255)')
  assert.equal(migration.compatibility.column.defaultValue, "'ready'")

  const plan = createMigrationPlan(createMigrationRegistry([migration]))
  assert.deepEqual(plan.pending[0].compatibility, migration.compatibility)
  assert.ok(Object.isFrozen(plan.pending[0].compatibility))
})

test('includes normalized compatibility content in the checksum', () => {
  const base = {
    kind: 'column',
    table: 'items',
    column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: null }
  }
  const checksum = defineMigration({ id: '0001_initial', source: 'SELECT 1;', compatibility: base }).checksum
  const reordered = {
    column: { defaultValue: null, notNull: false, type: ' text ', name: 'title' },
    table: 'items',
    kind: 'column'
  }
  assert.equal(
    defineMigration({ id: '0001_initial', source: 'SELECT 1;', compatibility: reordered }).checksum,
    checksum
  )

  for (const change of [
    { table: 'other', column: base.column },
    { table: base.table, column: { ...base.column, name: 'summary' } },
    { table: base.table, column: { ...base.column, type: 'INTEGER' } },
    { table: base.table, column: { ...base.column, notNull: true } },
    { table: base.table, column: { ...base.column, defaultValue: '0' } }
  ]) {
    assert.notEqual(
      defineMigration({ id: '0001_initial', source: 'SELECT 1;', compatibility: { kind: 'column', ...change } }).checksum,
      checksum
    )
  }
})

test('registerMigration returns a new immutable registry', () => {
  const initial = createMigrationRegistry([definition('0001_initial')])
  const extended = registerMigration(initial, definition('0002_add_index'))

  assert.deepEqual(extended.migrations.map(({ id }) => id), ['0001_initial', '0002_add_index'])
  assert.deepEqual(initial.migrations.map(({ id }) => id), ['0001_initial'])
})

test('plans all applied migrations and a partially applied registry', () => {
  const registry = createMigrationRegistry([
    definition('0001_initial'),
    definition('0002_add_index'),
    definition('0003_finalize')
  ])
  const plan = createMigrationPlan(registry, [
    { id: '0001_initial', checksum: registry.migrations[0].checksum },
    { id: '0002_add_index', checksum: registry.migrations[1].checksum }
  ])

  assert.deepEqual(plan.applied.map(({ id }) => id), ['0001_initial', '0002_add_index'])
  assert.deepEqual(plan.pending.map(({ id }) => id), ['0003_finalize'])
  assert.deepEqual(plan.unknownHistory, [])
})

test('returns an empty pending list when every target migration is applied', () => {
  const registry = createMigrationRegistry([definition('0001_initial'), definition('0002_add_index')])
  const plan = createMigrationPlan(registry, registry.migrations.map(({ id, checksum }) => ({ id, checksum })))

  assert.deepEqual(plan.applied.map(({ id }) => id), ['0001_initial', '0002_add_index'])
  assert.deepEqual(plan.pending, [])
})

test('supports a target version that truncates the pending plan', () => {
  const registry = createMigrationRegistry([
    definition('0001_initial'),
    definition('0002_add_index'),
    definition('0003_finalize')
  ])
  const plan = createMigrationPlan(registry, [], { targetVersion: '0002_add_index' })

  assert.equal(plan.targetVersion, '0002_add_index')
  assert.deepEqual(plan.pending.map(({ id }) => id), ['0001_initial', '0002_add_index'])
  assert.deepEqual(plan.deferred.map(({ id }) => id), ['0003_finalize'])
})

test('blocks a non-contiguous applied history and reports both sides of the gap', () => {
  const registry = createMigrationRegistry([
    definition('0001_initial'),
    definition('0002_add_index'),
    definition('0003_finalize')
  ])
  const error = thrownError(() =>
    createMigrationPlan(registry, [
      { id: '0001_initial', checksum: registry.migrations[0].checksum },
      { id: '0003_finalize', checksum: registry.migrations[2].checksum }
    ])
  )

  assert.equal(error.code, 'MIGRATION_HISTORY_GAP')
  assert.deepEqual(error.details.missingIds, ['0002_add_index'])
  assert.deepEqual(error.details.subsequentAppliedIds, ['0003_finalize'])
})

test('blocks a target that is behind any applied registered migration', () => {
  const registry = createMigrationRegistry([
    definition('0001_initial'),
    definition('0002_add_index'),
    definition('0003_finalize')
  ])
  const appliedRecords = registry.migrations.map(({ id, checksum }) => ({ id, checksum }))
  const error = thrownError(() =>
    createMigrationPlan(registry, appliedRecords, { targetVersion: '0002_add_index' })
  )

  assert.equal(error.code, 'MIGRATION_TARGET_BEHIND_APPLIED')
  assert.deepEqual(error.details.appliedIds, ['0003_finalize'])
})

test('rejects checksum drift in an applied record', () => {
  const registry = createMigrationRegistry([definition('0001_initial')])
  assert.equal(
    errorCode(() => createMigrationPlan(registry, [{ id: '0001_initial', checksum: '0'.repeat(64) }])),
    'MIGRATION_CHECKSUM_DRIFT'
  )
})

test('rejects duplicate, failed, and running application records', () => {
  const registry = createMigrationRegistry([definition('0001_initial')])
  const checksum = registry.migrations[0].checksum

  assert.equal(
    errorCode(() =>
      createMigrationPlan(registry, [
        { id: '0001_initial', checksum },
        { id: '0001_initial', checksum }
      ])
    ),
    'MIGRATION_RECORD_DUPLICATE'
  )
  assert.equal(
    errorCode(() => createMigrationPlan(registry, [{ id: '0001_initial', checksum, status: 'failed' }])),
    'MIGRATION_RECORD_BLOCKED'
  )
  assert.equal(
    errorCode(() => createMigrationPlan(registry, [{ id: '0001_initial', checksum, status: 'running' }])),
    'MIGRATION_RECORD_BLOCKED'
  )
})

test('retains unknown history records without treating them as pending migrations', () => {
  const registry = createMigrationRegistry([definition('0001_initial')])
  const unknown = { id: '9999_retired', checksum: 'a'.repeat(64), status: 'applied' }
  const plan = createMigrationPlan(registry, [unknown])

  assert.deepEqual(plan.pending.map(({ id }) => id), ['0001_initial'])
  assert.deepEqual(plan.unknownHistory, [unknown])
})

test('blocks unknown failed and running history records', () => {
  const registry = createMigrationRegistry([definition('0001_initial')])
  for (const status of ['failed', 'running']) {
    assert.equal(
      errorCode(() =>
        createMigrationPlan(registry, [{ id: '9999_retired', checksum: 'a'.repeat(64), status }])
      ),
      'MIGRATION_RECORD_BLOCKED'
    )
  }
})

test('rejects an unknown target and malformed application records', () => {
  const registry = createMigrationRegistry([definition('0001_initial')])

  assert.equal(
    errorCode(() => createMigrationPlan(registry, [], { targetVersion: '0002_missing' })),
    'MIGRATION_TARGET_UNKNOWN'
  )
  assert.equal(
    errorCode(() => createMigrationPlan(registry, [{ id: '0001_initial', checksum: 'not-a-checksum' }])),
    'MIGRATION_CHECKSUM_INVALID'
  )
  assert.equal(
    errorCode(() => createMigrationPlan(registry, [{ id: '0001_initial', checksum: registry.migrations[0].checksum, status: 'unknown' }])),
    'MIGRATION_RECORD_STATUS_INVALID'
  )
})
