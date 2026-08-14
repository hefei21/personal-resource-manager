import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  checkMigrationCompatibility,
  MigrationCompatibilityError,
  normalizeMigrationCompatibility
} from '../src/config/migrationCompatibility.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  const message = String(error?.message ?? '')
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(message)
}

let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

function compatibility(overrides = {}) {
  return {
    kind: 'column',
    table: 'items',
    column: {
      name: 'title',
      type: 'TEXT',
      notNull: true,
      defaultValue: "'ready'"
    },
    ...overrides
  }
}

function tableShape(overrides = {}) {
  return {
    strict: false,
    withoutRowid: false,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 1 },
      { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'", primaryKeyPosition: 0 }
    ],
    foreignKeys: [],
    uniqueConstraints: [],
    ...overrides
  }
}

const DUMMY_DDL_HASH = 'a'.repeat(64)

function legacyProof(shape, createTableSqlSha256 = DUMMY_DDL_HASH, indexes = [], triggers = []) {
  return { shape, createTableSqlSha256, indexes, triggers }
}

function keyedLegacyProof(proofKey, shape, createTableSqlSha256 = DUMMY_DDL_HASH, indexes = [], triggers = []) {
  return { proofKey, shape, createTableSqlSha256, indexes, triggers }
}

function tableTransition(overrides = {}) {
  return {
    kind: 'table-transition',
    table: 'items',
    target: tableShape(),
    legacy: [legacyProof(tableShape({ strict: true }))],
    ...overrides
  }
}

function targetProof(overrides = {}) {
  return {
    createTableSqlSha256: DUMMY_DDL_HASH,
    indexes: [],
    triggers: [],
    externalDependencies: {
      inboundForeignKeys: 'none',
      schemaSqlReferences: 'none'
    },
    ...overrides
  }
}

function foreignKey(overrides = {}) {
  return {
    columns: ['parent_id'],
    referencedTable: 'parents',
    referencedColumns: ['id'],
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    ...overrides
  }
}

function uniqueConstraint(overrides = {}) {
  return {
    columns: [{ name: 'title', collation: 'BINARY', descending: false }],
    ...overrides
  }
}

function tableShapeWithParent(overrides = {}) {
  return tableShape({
    columns: [
      tableShape().columns[0],
      tableShape().columns[1],
      { name: 'parent_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
    ],
    foreignKeys: [foreignKey()],
    ...overrides
  })
}

function openDatabase(schema) {
  const database = new Database(':memory:')
  database.exec(schema)
  return database
}

function tableSqlSha256(database, table = 'items') {
  const row = database
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table)
  assert.equal(typeof row?.sql, 'string')
  assert.ok(row.sql.length > 0)
  return createHash('sha256').update(Buffer.from(row.sql, 'utf8')).digest('hex')
}

function indexSqlSha256(database, name, table = 'items') {
  const row = database
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND tbl_name = ? AND name = ?")
    .get(table, name)
  assert.equal(typeof row?.sql, 'string')
  assert.ok(row.sql.length > 0)
  return createHash('sha256').update(Buffer.from(row.sql, 'utf8')).digest('hex')
}

function triggerSqlSha256(database, name, table = 'items') {
  const row = database
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = ? AND name = ?")
    .get(table, name)
  assert.equal(typeof row?.sql, 'string')
  assert.ok(row.sql.length > 0)
  return createHash('sha256').update(Buffer.from(row.sql, 'utf8')).digest('hex')
}

function metadataDatabase(column) {
  let query = 0
  return {
    prepare() {
      query += 1
      return { get: () => query === 1 ? { present: 1 } : column }
    }
  }
}

function tableMetadataColumns(shape) {
  return shape.columns.map((column, cid) => ({
    cid,
    name: column.name,
    type: column.type,
    not_null: column.notNull ? 1 : 0,
    dflt_value: column.defaultValue,
    pk: column.primaryKeyPosition,
    hidden: 0
  }))
}

test('normalizes, detaches, and deeply freezes a table-transition condition', () => {
  const input = tableTransition({
    target: tableShape({
      strict: true,
      columns: tableShape().columns.map((column) => ({ ...column, type: ` ${column.type.toLowerCase()} ` }))
    }),
    legacy: [legacyProof(tableShape()), legacyProof(tableShape({ withoutRowid: true }))]
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.target.columns[0], {
    name: 'id',
    type: 'INTEGER',
    notNull: false,
    defaultValue: null,
    primaryKeyPosition: 1
  })
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.target))
  assert.ok(Object.isFrozen(normalized.target.columns))
  assert.ok(Object.isFrozen(normalized.target.foreignKeys))
  assert.ok(Object.isFrozen(normalized.target.uniqueConstraints))
  assert.ok(normalized.target.columns.every(Object.isFrozen))
  assert.ok(Object.isFrozen(normalized.legacy))
  assert.ok(normalized.legacy.every(Object.isFrozen))
  assert.ok(normalized.legacy.every((proof) => (
    Object.isFrozen(proof.shape) &&
    Object.isFrozen(proof.shape.columns) &&
    Object.isFrozen(proof.shape.foreignKeys) &&
    Object.isFrozen(proof.shape.uniqueConstraints) &&
    Object.isFrozen(proof.indexes) &&
    proof.indexes.every(Object.isFrozen) &&
    Object.isFrozen(proof.triggers) &&
    proof.triggers.every(Object.isFrozen) &&
    typeof proof.createTableSqlSha256 === 'string'
  )))
  assert.equal(normalized.legacy[0].createTableSqlSha256, DUMMY_DDL_HASH)
  assert.deepEqual(normalized.legacy[0].indexes, [])
  assert.deepEqual(normalized.legacy[0].triggers, [])

  input.table = 'changed'
  input.target.columns[0].name = 'changed'
  input.legacy[0].shape.columns.push({
    name: 'extra', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0
  })
  assert.equal(normalized.table, 'items')
  assert.equal(normalized.target.columns[0].name, 'id')
  assert.equal(normalized.legacy[0].shape.columns.length, 2)
})

test('normalizes an explicit create policy for a missing table', () => {
  const normalized = normalizeMigrationCompatibility(tableTransition({
    missingTable: 'create',
    legacy: []
  }))

  assert.equal(normalized.missingTable, 'create')
  assert.deepEqual(normalized.legacy, [])
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.legacy))
})

test('normalizes keyed legacy proofs and rejects mixed, duplicate, or unsafe proof keys', () => {
  const first = keyedLegacyProof('legacy-a', tableShape({ strict: true }), 'a'.repeat(64))
  const second = keyedLegacyProof('legacy-b', tableShape({ withoutRowid: true }), 'b'.repeat(64))
  const input = tableTransition({ legacy: [second, first] })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.legacy.map(({ proofKey }) => proofKey), ['legacy-a', 'legacy-b'])
  assert.ok(normalized.legacy.every(Object.isFrozen))
  input.legacy[0].proofKey = 'changed'
  assert.equal(normalized.legacy[1].proofKey, 'legacy-b')

  for (const legacy of [
    [first, legacyProof(tableShape({ withoutRowid: true }), 'b'.repeat(64))],
    [first, { ...second, proofKey: 'legacy-a' }],
    [first, { ...first, proofKey: 'legacy-b' }],
    [{ ...first, proofKey: 'UPPER' }, second],
    [{ ...first, proofKey: 'a'.repeat(65) }, second]
  ]) {
    assert.throws(
      () => normalizeMigrationCompatibility(tableTransition({ legacy })),
      (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
})

test('normalizes unique constraint collations, canonical order, and nested freezes', () => {
  const input = tableTransition({
    target: tableShape({
      uniqueConstraints: [
        uniqueConstraint({
          columns: [{ name: 'title', collation: ' no  case ', descending: true }]
        }),
        uniqueConstraint({
          columns: [{ name: 'id', collation: ' binary ', descending: false }]
        })
      ]
    })
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.target.uniqueConstraints, [
    { columns: [{ name: 'id', collation: 'BINARY', descending: false }] },
    { columns: [{ name: 'title', collation: 'NO CASE', descending: true }] }
  ])
  assert.ok(Object.isFrozen(normalized.target.uniqueConstraints))
  assert.ok(normalized.target.uniqueConstraints.every((constraint) => (
    Object.isFrozen(constraint) && Object.isFrozen(constraint.columns) &&
    constraint.columns.every(Object.isFrozen)
  )))

  input.target.uniqueConstraints[0].columns[0].name = 'changed'
  input.target.uniqueConstraints.push(uniqueConstraint())
  assert.equal(normalized.target.uniqueConstraints[1].columns[0].name, 'title')
  assert.equal(normalized.target.uniqueConstraints.length, 2)
})

test('rejects malformed table-transition shapes and unsupported keys', () => {
  const valid = tableTransition()
  const targetWithoutStrict = { ...valid.target }
  delete targetWithoutStrict.strict
  const invalidInputs = [
    { ...valid, extra: true },
    { ...valid, target: targetWithoutStrict },
    { ...valid, target: { ...valid.target, columns: [] } },
    { ...valid, target: { ...valid.target, strict: 'false' } },
    { ...valid, target: { ...valid.target, withoutRowid: 0 } },
    { ...valid, target: { ...valid.target, uniqueConstraints: 'none' } },
    { ...valid, target: { ...valid.target, columns: [valid.target.columns[0], valid.target.columns[0]] } },
    {
      ...valid,
      target: {
        ...valid.target,
        columns: valid.target.columns.map((column) => ({ ...column, primaryKeyPosition: 2 }))
      }
    },
    { ...valid, legacy: [] },
    { ...valid, missingTable: 'replace' },
    { ...valid, legacy: [valid.legacy[0], { ...valid.legacy[0] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], unsupported: true }] },
    { ...valid, legacy: [{ ...valid.legacy[0], createTableSqlSha256: 'not-a-hash' }] },
    { ...valid, legacy: [{ ...valid.legacy[0], createTableSqlSha256: 'A'.repeat(63) }] },
    { ...valid, legacy: [{ ...valid.legacy[0], indexes: 'none' }] },
    { ...valid, legacy: [{ ...valid.legacy[0], indexes: [{ name: 'idx', createIndexSqlSha256: 'not-a-hash' }] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], indexes: [{ name: ' ', createIndexSqlSha256: DUMMY_DDL_HASH }] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], indexes: [{ name: 'idx', createIndexSqlSha256: DUMMY_DDL_HASH, extra: true }] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], triggers: 'none' }] },
    { ...valid, legacy: [{ ...valid.legacy[0], triggers: [{ name: 'hook', createTriggerSqlSha256: 'not-a-hash' }] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], triggers: [{ name: ' ', createTriggerSqlSha256: DUMMY_DDL_HASH }] }] },
    { ...valid, legacy: [{ ...valid.legacy[0], triggers: [{ name: 'hook', createTriggerSqlSha256: DUMMY_DDL_HASH, extra: true }] }] },
    {
      ...valid,
      legacy: [{
        ...valid.legacy[0],
        indexes: [
          { name: 'idx', createIndexSqlSha256: DUMMY_DDL_HASH },
          { name: 'idx', createIndexSqlSha256: 'b'.repeat(64) }
        ]
      }]
    },
    {
      ...valid,
      target: {
        ...valid.target,
        columns: valid.target.columns.map((column) => ({ ...column, unknown: true }))
      }
    }
  ]
  const invalidPrimaryKey = tableShape({
    columns: tableShape().columns.map((column) => ({ ...column, primaryKeyPosition: -1 }))
  })
  invalidInputs.push({ ...valid, target: invalidPrimaryKey })

  const invalidUniqueConstraints = [
    uniqueConstraint({ columns: [] }),
    uniqueConstraint({ columns: [{ name: 'unknown', collation: 'BINARY', descending: false }] }),
    uniqueConstraint({ columns: [
      { name: 'title', collation: 'BINARY', descending: false },
      { name: 'title', collation: 'BINARY', descending: false }
    ] }),
    uniqueConstraint({ columns: [{ name: 'title', collation: 'BINARY', descending: 'false' }] }),
    uniqueConstraint({ columns: [{ name: 'title', collation: '   ', descending: false }] })
  ]
  invalidInputs.push(...invalidUniqueConstraints.map((invalid) => ({
    ...valid,
    target: tableShape({ uniqueConstraints: [invalid] })
  })))
  invalidInputs.push({
    ...valid,
    target: tableShape({ uniqueConstraints: [uniqueConstraint(), uniqueConstraint()] })
  })

  for (const input of invalidInputs) {
    assert.throws(
      () => normalizeMigrationCompatibility(input),
      (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
})

test('rejects a table-transition target duplicated in legacy', () => {
  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({ legacy: [legacyProof(tableShape())] })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('normalizes legacy fingerprints and explicit indexes canonically', () => {
  const strictShape = tableShape({ strict: true })
  const withoutRowidShape = tableShape({ withoutRowid: true })
  const input = tableTransition({
    legacy: [
      legacyProof(withoutRowidShape, `  ${'B'.repeat(64)}  `),
      legacyProof(strictShape, 'a'.repeat(64), [
        { name: 'z_idx', createIndexSqlSha256: 'B'.repeat(64) },
        { name: 'a_idx', createIndexSqlSha256: `  ${'A'.repeat(64)}  ` }
      ]),
      legacyProof(strictShape, 'c'.repeat(64), [])
    ]
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.legacy.map((proof) => proof.createTableSqlSha256), [
    'b'.repeat(64),
    'a'.repeat(64),
    'c'.repeat(64)
  ])
  assert.deepEqual(normalized.legacy.map((proof) => proof.shape.strict), [false, true, true])
  assert.deepEqual(normalized.legacy[1].indexes, [
    { name: 'a_idx', createIndexSqlSha256: 'a'.repeat(64) },
    { name: 'z_idx', createIndexSqlSha256: 'b'.repeat(64) }
  ])
  assert.ok(normalized.legacy.every((proof) => Object.isFrozen(proof)))
  assert.ok(normalized.legacy.every((proof) => Object.isFrozen(proof.shape)))
  assert.ok(normalized.legacy.every((proof) => Object.isFrozen(proof.shape.columns)))
  assert.ok(Object.isFrozen(normalized.legacy[1].indexes))
  assert.ok(normalized.legacy[1].indexes.every(Object.isFrozen))

  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({
      legacy: [legacyProof(strictShape, 'a'.repeat(64)), legacyProof(strictShape, 'a'.repeat(64))]
    })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )

  assert.doesNotThrow(() => normalizeMigrationCompatibility(tableTransition({
    legacy: [
      legacyProof(strictShape, 'a'.repeat(64), []),
      legacyProof(strictShape, 'a'.repeat(64), [{ name: 'idx', createIndexSqlSha256: 'b'.repeat(64) }])
    ]
  })))
})

test('normalizes legacy persistent trigger fingerprints canonically and rejects duplicates', () => {
  const strictShape = tableShape({ strict: true })
  const input = tableTransition({
    legacy: [legacyProof(strictShape, DUMMY_DDL_HASH, [], [
      { name: 'z_hook', createTriggerSqlSha256: 'B'.repeat(64) },
      { name: 'a_hook', createTriggerSqlSha256: `  ${'A'.repeat(64)}  ` }
    ])]
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.legacy[0].triggers, [
    { name: 'a_hook', createTriggerSqlSha256: 'a'.repeat(64) },
    { name: 'z_hook', createTriggerSqlSha256: 'b'.repeat(64) }
  ])
  assert.ok(Object.isFrozen(normalized.legacy[0].triggers))
  assert.ok(normalized.legacy[0].triggers.every(Object.isFrozen))
  assert.doesNotThrow(() => normalizeMigrationCompatibility(tableTransition({
    legacy: [
      legacyProof(strictShape, DUMMY_DDL_HASH, [], [{ name: 'hook', createTriggerSqlSha256: 'a'.repeat(64) }]),
      legacyProof(strictShape, DUMMY_DDL_HASH, [], [{ name: 'hook', createTriggerSqlSha256: 'b'.repeat(64) }])
    ]
  })))
  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({
      legacy: [legacyProof(strictShape, DUMMY_DDL_HASH, [], [
        { name: 'hook', createTriggerSqlSha256: 'a'.repeat(64) },
        { name: 'hook', createTriggerSqlSha256: 'b'.repeat(64) }
      ])]
    })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('normalizes, freezes, and validates an optional target proof', () => {
  const input = tableTransition({
    targetProof: targetProof({
      createTableSqlSha256: `  ${'B'.repeat(64)}  `,
      indexes: [{ name: 'items_idx', createIndexSqlSha256: ` ${'C'.repeat(64)} ` }],
      triggers: [{ name: 'items_hook', createTriggerSqlSha256: ` ${'D'.repeat(64)} ` }]
    })
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.targetProof, {
    createTableSqlSha256: 'b'.repeat(64),
    indexes: [{ name: 'items_idx', createIndexSqlSha256: 'c'.repeat(64) }],
    triggers: [{ name: 'items_hook', createTriggerSqlSha256: 'd'.repeat(64) }],
    externalDependencies: {
      inboundForeignKeys: 'none',
      schemaSqlReferences: 'none'
    }
  })
  assert.ok(Object.isFrozen(normalized.targetProof))
  assert.ok(Object.isFrozen(normalized.targetProof.indexes))
  assert.ok(Object.isFrozen(normalized.targetProof.indexes[0]))
  assert.ok(Object.isFrozen(normalized.targetProof.triggers))
  assert.ok(Object.isFrozen(normalized.targetProof.triggers[0]))
  assert.ok(Object.isFrozen(normalized.targetProof.externalDependencies))

  input.targetProof.indexes[0].name = 'changed'
  input.targetProof.externalDependencies.inboundForeignKeys = 'changed'
  assert.equal(normalized.targetProof.indexes[0].name, 'items_idx')
  assert.equal(normalized.targetProof.externalDependencies.inboundForeignKeys, 'none')

  const invalid = [
    { ...targetProof(), extra: true },
    { ...targetProof(), createTableSqlSha256: 'not-a-hash' },
    { ...targetProof(), indexes: [{ name: 'x', createIndexSqlSha256: DUMMY_DDL_HASH, extra: true }] },
    { ...targetProof(), triggers: [{ name: 'x', createTriggerSqlSha256: DUMMY_DDL_HASH, extra: true }] },
    { ...targetProof(), externalDependencies: { inboundForeignKeys: 'none' } },
    { ...targetProof(), externalDependencies: { inboundForeignKeys: 'all', schemaSqlReferences: 'none' } },
    { ...targetProof(), externalDependencies: { inboundForeignKeys: false, schemaSqlReferences: 'none' } }
  ]
  for (const proof of invalid) {
    assert.throws(
      () => normalizeMigrationCompatibility(tableTransition({ targetProof: proof })),
      (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
  assert.throws(
    () => normalizeMigrationCompatibility({ ...tableTransition(), targetProof: undefined }),
    MigrationCompatibilityError
  )
})

test('normalizes strict target proof variants and rejects ambiguous declarations', () => {
  const first = targetProof({ createTableSqlSha256: 'b'.repeat(64) })
  const second = targetProof({
    createTableSqlSha256: 'c'.repeat(64),
    indexes: [{ name: 'items_idx', createIndexSqlSha256: 'd'.repeat(64) }]
  })
  const input = tableTransition({ targetProofVariants: [second, first] })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(
    normalized.targetProofVariants.map(({ createTableSqlSha256 }) => createTableSqlSha256),
    ['b'.repeat(64), 'c'.repeat(64)]
  )
  assert.ok(Object.isFrozen(normalized.targetProofVariants))
  assert.ok(Object.isFrozen(normalized.targetProofVariants[0]))
  assert.ok(Object.isFrozen(normalized.targetProofVariants[1].indexes))
  input.targetProofVariants[0].indexes[0].name = 'changed'
  assert.equal(normalized.targetProofVariants[1].indexes[0].name, 'items_idx')

  for (const invalid of [
    tableTransition({ targetProofVariants: [] }),
    tableTransition({ targetProofVariants: [first, { ...first }] }),
    tableTransition({ targetProof: first, targetProofVariants: [second] }),
    { ...tableTransition(), targetProofVariants: undefined }
  ]) {
    assert.throws(
      () => normalizeMigrationCompatibility(invalid),
      (error) => error instanceof MigrationCompatibilityError &&
        error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
})

test('normalizes foreign key actions, null references, canonical order, and nested freezes', () => {
  const first = foreignKey({
    columns: [' title '],
    referencedTable: ' parent_labels ',
    referencedColumns: [null],
    onUpdate: ' set   null ',
    onDelete: ' no  action '
  })
  const second = foreignKey({
    columns: ['id'],
    referencedTable: 'parents',
    referencedColumns: ['id'],
    onUpdate: ' RESTRICT ',
    onDelete: ' SET DEFAULT '
  })
  const input = tableTransition({ target: tableShape({ foreignKeys: [first, second] }) })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.target.foreignKeys, [
    {
      columns: ['id'],
      referencedTable: 'parents',
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'SET DEFAULT'
    },
    {
      columns: ['title'],
      referencedTable: 'parent_labels',
      referencedColumns: [null],
      onUpdate: 'SET NULL',
      onDelete: 'NO ACTION'
    }
  ])
  assert.ok(Object.isFrozen(normalized.target.foreignKeys[0]))
  assert.ok(Object.isFrozen(normalized.target.foreignKeys[0].columns))
  assert.ok(Object.isFrozen(normalized.target.foreignKeys[0].referencedColumns))

  first.columns[0] = 'changed'
  first.referencedColumns[0] = 'changed'
  assert.equal(normalized.target.foreignKeys[1].columns[0], 'title')
  assert.equal(normalized.target.foreignKeys[1].referencedColumns[0], null)
})

test('rejects malformed foreign keys, unsupported actions, unknown columns, and duplicates', () => {
  const valid = tableTransition()
  const invalidForeignKeys = [
    { ...foreignKey(), columns: [] },
    { ...foreignKey(), referencedColumns: [] },
    { ...foreignKey(), referencedColumns: ['id', 'other'] },
    { ...foreignKey(), columns: ['title', 'title'], referencedColumns: ['id', null] },
    { ...foreignKey(), columns: ['unknown'] },
    { ...foreignKey(), onUpdate: 'NOT VALID' },
    { ...foreignKey(), onDelete: 'NOT VALID' }
  ]

  for (const invalid of invalidForeignKeys) {
    assert.throws(
      () => normalizeMigrationCompatibility({
        ...valid,
        target: tableShape({ foreignKeys: [invalid] })
      }),
      (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
  assert.throws(
    () => normalizeMigrationCompatibility({
      ...valid,
      target: tableShape({ foreignKeys: [foreignKey(), foreignKey()] })
    }),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('includes foreign keys in target and legacy duplicate detection', () => {
  const shape = tableShape({ foreignKeys: [foreignKey({ columns: ['title'] })] })
  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({ target: shape, legacy: [legacyProof(tableShape({ foreignKeys: [foreignKey({ columns: ['title'] })] }))] })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('includes unique constraints in target and legacy duplicate detection', () => {
  const shape = tableShape({ uniqueConstraints: [uniqueConstraint()] })
  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({
      target: shape,
      legacy: [legacyProof(tableShape({ uniqueConstraints: [uniqueConstraint()] }))]
    })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('reports a matching table-transition target as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');"
  )
  try {
    const result = checkMigrationCompatibility(database, tableTransition())
    assert.deepEqual(result, {
      status: 'satisfied',
      kind: 'table-transition',
      table: 'items',
      reason: 'matched'
    })
    assert.ok(Object.isFrozen(result))
  } finally {
    database.close()
  }
})

test('keeps an undeclared target proof on the legacy target path', () => {
  const prepared = []
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('SELECT 1 AS present')) return { get: () => ({ present: 1 }) }
      if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
      if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(tableShape()) }
      if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
      if (sql.includes('pragma_index_list')) return { all: () => [{ seq: 0, name: 'unknown', is_unique: 0, origin: 'c', partial: 0 }] }
      if (sql.includes("type = 'index'")) throw new Error('legacy target path must not read index SQL')
      if (sql.includes("type = 'trigger'")) throw new Error('legacy target path must not read trigger SQL')
      throw new Error('unexpected query')
    }
  }
  assert.deepEqual(checkMigrationCompatibility(database, tableTransition()), {
    status: 'satisfied', kind: 'table-transition', table: 'items', reason: 'matched'
  })
  assert.equal(prepared.some((sql) => sql.includes("type = 'index'")), false)
  assert.equal(prepared.some((sql) => sql.includes("type = 'trigger'")), false)
})

test('reports a matching legacy table-transition shape as missing', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
  )
  try {
    const legacyShape = tableShape({
      columns: tableShape().columns.map((column) =>
        column.name === 'title' ? { ...column, notNull: false } : column
      )
    })
    const result = checkMigrationCompatibility(database, tableTransition({
      target: tableShape(),
      legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
    }))
    assert.deepEqual(result, {
      status: 'missing',
      kind: 'table-transition',
      table: 'items',
      reason: 'legacy-matched'
    })
  } finally {
    database.close()
  }
})

test('ignores arbitrary explicit indexes when the target semantic shape matches', nativeTestOptions, () => {
  const database = openDatabase([
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');",
    'CREATE INDEX arbitrary_idx ON items(title);'
  ].join('\n'))
  try {
    assert.deepEqual(checkMigrationCompatibility(database, tableTransition()), {
      status: 'satisfied',
      kind: 'table-transition',
      table: 'items',
      reason: 'matched'
    })
  } finally {
    database.close()
  }
})

test('requires exact target DDL, index, trigger, and external dependency proof', () => {
  const targetDdl = 'CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT \'ready\');'
  const targetIndex = 'CREATE INDEX items_idx ON items(title);'
  const targetTrigger = 'CREATE TRIGGER items_hook AFTER INSERT ON items BEGIN SELECT 1; END;'
  const ddlHash = createHash('sha256').update(Buffer.from(targetDdl, 'utf8')).digest('hex')
  const indexHash = createHash('sha256').update(Buffer.from(targetIndex, 'utf8')).digest('hex')
  const triggerHash = createHash('sha256').update(Buffer.from(targetTrigger, 'utf8')).digest('hex')

  function databaseWith({ indexRows = [], triggerRows = [], otherTables = {}, externalRows = [] } = {}) {
    const prepared = []
    const boundValues = []
    return {
      prepared,
      boundValues,
      database: {
        prepare(sql) {
          prepared.push(sql)
          if (sql.includes('SELECT 1 AS present')) return { get: (...values) => { boundValues.push(values); return { present: 1 } } }
          if (sql.includes('pragma_table_list')) return { get: (...values) => { boundValues.push(values); return { wr: 0, strict: 0 } } }
          if (sql.includes('pragma_table_xinfo')) return { all: (...values) => { boundValues.push(values); return tableMetadataColumns(tableShape()) } }
          if (sql.includes('FROM pragma_foreign_key_list')) {
            return { all: (...values) => { boundValues.push(values); return otherTables[values[0]] ?? [] } }
          }
          if (sql.includes('pragma_index_list')) return { all: (...values) => { boundValues.push(values); return indexRows } }
          if (sql.includes("type = 'table' AND name = ?")) return { get: (...values) => { boundValues.push(values); return { sql: targetDdl } } }
          if (sql.includes("type = 'index'")) return { get: (...values) => { boundValues.push(values); return { sql: targetIndex } } }
          if (sql.includes("type = 'trigger' AND tbl_name = ?")) return { all: (...values) => { boundValues.push(values); return triggerRows } }
          if (sql.includes("type IN ('view', 'trigger')")) return { all: (...values) => { boundValues.push(values); return externalRows } }
          if (sql.includes("type = 'table' AND lower(name)")) return { all: (...values) => { boundValues.push(values); return Object.keys(otherTables).map((name) => ({ name })) } }
          throw new Error(`unexpected query: ${sql}`)
        }
      }
    }
  }

  const base = tableTransition({
    targetProof: targetProof({
      createTableSqlSha256: ddlHash,
      indexes: [{ name: 'items_idx', createIndexSqlSha256: indexHash }],
      triggers: [{ name: 'items_hook', createTriggerSqlSha256: triggerHash }]
    })
  })
  const exact = databaseWith({
    indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }],
    triggerRows: [{ name: 'items_hook', sql: targetTrigger }]
  })
  assert.deepEqual(checkMigrationCompatibility(exact.database, base), {
    status: 'satisfied', kind: 'table-transition', table: 'items', reason: 'matched'
  })
  assert.ok(exact.prepared.every((sql) => !sql.includes('items')))
  assert.deepEqual(exact.boundValues, [
    ['items'], ['items'], ['items'], ['items'], ['items'], ['items'],
    ['items', 'items_idx'], ['items'], ['items'], ['items']
  ])

  const variants = tableTransition({
    targetProofVariants: [
      targetProof({ createTableSqlSha256: '0'.repeat(64) }),
      targetProof({
        createTableSqlSha256: ddlHash,
        indexes: [{ name: 'items_idx', createIndexSqlSha256: indexHash }],
        triggers: [{ name: 'items_hook', createTriggerSqlSha256: triggerHash }]
      })
    ]
  })
  const variantMatch = databaseWith({
    indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }],
    triggerRows: [{ name: 'items_hook', sql: targetTrigger }]
  })
  assert.deepEqual(checkMigrationCompatibility(variantMatch.database, variants), {
    status: 'satisfied', kind: 'table-transition', table: 'items', reason: 'matched'
  })
  assert.ok(variantMatch.prepared.every((sql) => !sql.includes('items')))

  const noVariantMatches = tableTransition({
    targetProofVariants: [
      targetProof({ createTableSqlSha256: '0'.repeat(64) }),
      targetProof({ createTableSqlSha256: '1'.repeat(64) })
    ]
  })
  assert.deepEqual(checkMigrationCompatibility(databaseWith().database, noVariantMatches), {
    status: 'incompatible', kind: 'table-transition', table: 'items', reason: 'target-proof-incompatible'
  })

  const mismatchCases = [
    {
      name: 'DDL',
      compatibility: tableTransition({ targetProof: targetProof({ createTableSqlSha256: '0'.repeat(64) }) }),
      options: {}
    },
    {
      name: 'index',
      compatibility: base,
      options: { indexRows: [{ seq: 0, name: 'other_idx', is_unique: 0, origin: 'c', partial: 0 }] }
    },
    {
      name: 'trigger',
      compatibility: base,
      options: { indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }] }
    },
    {
      name: 'inbound FK',
      compatibility: base,
      options: {
        indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }],
        triggerRows: [{ name: 'items_hook', sql: targetTrigger }],
        otherTables: { child: [{ id: 0, seq: 0, referenced_table: 'items' }] }
      }
    },
    {
      name: 'external schema SQL',
      compatibility: base,
      options: {
        indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }],
        triggerRows: [{ name: 'items_hook', sql: targetTrigger }],
        externalRows: [{ type: 'view', tbl_name: 'external_view', sql: 'CREATE VIEW external_view AS SELECT * FROM items;' }]
      }
    },
    {
      name: 'external trigger SQL',
      compatibility: base,
      options: {
        indexRows: [{ seq: 0, name: 'items_idx', is_unique: 0, origin: 'c', partial: 0 }],
        triggerRows: [{ name: 'items_hook', sql: targetTrigger }],
        externalRows: [{ type: 'trigger', tbl_name: 'child', sql: 'CREATE TRIGGER child_hook AFTER INSERT ON child BEGIN SELECT * FROM items; END;' }]
      }
    }
  ]
  for (const { name, compatibility, options } of mismatchCases) {
    const result = checkMigrationCompatibility(databaseWith(options).database, compatibility)
    assert.deepEqual(result, {
      status: 'incompatible', kind: 'table-transition', table: 'items', reason: 'target-proof-incompatible'
    }, name)
    assert.doesNotMatch(JSON.stringify(result), /items_idx|items_hook|CREATE|external_view|child_hook|[a-f0-9]{64}/i)
  }
})

test('proves strict target metadata and external dependencies with real SQLite', nativeTestOptions, () => {
  const database = openDatabase([
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');",
    'CREATE INDEX items_idx ON items(title);',
    'CREATE TRIGGER items_hook AFTER INSERT ON items BEGIN SELECT 1; END;'
  ].join('\n'))
  try {
    const strict = tableTransition({
      targetProofVariants: [
        targetProof({ createTableSqlSha256: '0'.repeat(64) }),
        targetProof({
          createTableSqlSha256: tableSqlSha256(database),
          indexes: [{ name: 'items_idx', createIndexSqlSha256: indexSqlSha256(database, 'items_idx') }],
          triggers: [{ name: 'items_hook', createTriggerSqlSha256: triggerSqlSha256(database, 'items_hook') }]
        })
      ]
    })
    assert.equal(checkMigrationCompatibility(database, strict).status, 'satisfied')

    database.exec('CREATE VIEW items_view AS SELECT id FROM items;')
    assert.equal(checkMigrationCompatibility(database, strict).status, 'incompatible')
    database.exec('DROP VIEW items_view; CREATE TABLE children (id INTEGER, item_id INTEGER REFERENCES items(id));')
    assert.equal(checkMigrationCompatibility(database, strict).status, 'incompatible')
  } finally {
    database.close()
  }
})

test('requires an exact explicit-index proof for a legacy table', nativeTestOptions, () => {
  const database = openDatabase([
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');",
    'CREATE INDEX items_title_idx ON items(title);'
  ].join('\n'))
  try {
    const legacyShape = tableShape({
      columns: tableShape().columns.map((column) =>
        column.name === 'title' ? { ...column, notNull: false } : column
      )
    })
    const base = {
      target: tableShape(),
      legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
    }
    assert.equal(checkMigrationCompatibility(database, tableTransition(base)).status, 'incompatible')
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        ...base,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database), [
          { name: 'items_title_idx', createIndexSqlSha256: indexSqlSha256(database, 'items_title_idx') }
        ])]
      })).status,
      'missing'
    )
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        ...base,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database), [
          { name: 'extra_idx', createIndexSqlSha256: 'b'.repeat(64) }
        ])]
      })).status,
      'incompatible'
    )
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        ...base,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database), [
          { name: 'items_title_idx', createIndexSqlSha256: 'b'.repeat(64) }
        ])]
      })).status,
      'incompatible'
    )

    const missingIndexDatabase = openDatabase(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
    )
    try {
      assert.equal(
        checkMigrationCompatibility(missingIndexDatabase, tableTransition({
          target: tableShape(),
          legacy: [legacyProof(legacyShape, tableSqlSha256(missingIndexDatabase), [
            { name: 'items_title_idx', createIndexSqlSha256: 'b'.repeat(64) }
          ])]
        })).status,
        'incompatible'
      )
    } finally {
      missingIndexDatabase.close()
    }
  } finally {
    database.close()
  }
})

test('proves ordinary, UNIQUE, partial, and expression explicit indexes by exact SQL hash', nativeTestOptions, () => {
  const cases = [
    ['items_idx', 'CREATE INDEX items_idx ON items(title);'],
    ['items_unique_idx', 'CREATE UNIQUE INDEX items_unique_idx ON items(title COLLATE NOCASE DESC);'],
    ['items_partial_idx', 'CREATE INDEX items_partial_idx ON items(title) WHERE title IS NOT NULL;'],
    ['items_expression_idx', 'CREATE INDEX items_expression_idx ON items(lower(title));']
  ]
  for (const [indexName, indexSql] of cases) {
    const database = openDatabase([
      "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');",
      indexSql
    ].join('\n'))
    try {
      const legacyShape = tableShape({
        columns: tableShape().columns.map((column) =>
          column.name === 'title' ? { ...column, notNull: false } : column
        )
      })
      assert.equal(
        checkMigrationCompatibility(database, tableTransition({
          target: tableShape(),
          legacy: [legacyProof(legacyShape, tableSqlSha256(database), [
            { name: indexName, createIndexSqlSha256: indexSqlSha256(database, indexName) }
          ])]
        })).status,
        'missing'
      )
    } finally {
      database.close()
    }
  }
})

test('proves persistent BEFORE and AFTER triggers by exact SQL hash', nativeTestOptions, () => {
  const database = openDatabase([
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');",
    'CREATE TRIGGER items_before_insert BEFORE INSERT ON items WHEN NEW.title IS NOT NULL BEGIN SELECT NEW.title; END;',
    'CREATE TRIGGER items_after_update AFTER UPDATE OF title ON items BEGIN SELECT NEW.title; END;'
  ].join('\n'))
  try {
    const legacyShape = tableShape({
      columns: tableShape().columns.map((column) =>
        column.name === 'title' ? { ...column, notNull: false } : column
      )
    })
    const triggers = [
      { name: 'items_after_update', createTriggerSqlSha256: triggerSqlSha256(database, 'items_after_update') },
      { name: 'items_before_insert', createTriggerSqlSha256: triggerSqlSha256(database, 'items_before_insert') }
    ]
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape(),
        legacy: [legacyProof(legacyShape, tableSqlSha256(database), [], triggers)]
      })).status,
      'missing'
    )
  } finally {
    database.close()
  }
})

test('treats missing, extra, and same-name-wrong-hash triggers as incompatible', nativeTestOptions, () => {
  const schema = [
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');",
    'CREATE TRIGGER items_hook BEFORE INSERT ON items BEGIN SELECT NEW.title; END;'
  ].join('\n')
  const database = openDatabase(schema)
  try {
    const legacyShape = tableShape({
      columns: tableShape().columns.map((column) =>
        column.name === 'title' ? { ...column, notNull: false } : column
      )
    })
    const exact = { name: 'items_hook', createTriggerSqlSha256: triggerSqlSha256(database, 'items_hook') }
    const proof = (triggers) => tableTransition({
      target: tableShape(),
      legacy: [legacyProof(legacyShape, tableSqlSha256(database), [], triggers)]
    })
    assert.equal(checkMigrationCompatibility(database, proof([])).status, 'incompatible')
    assert.equal(checkMigrationCompatibility(database, proof([{ ...exact, name: 'missing_hook' }])).status, 'incompatible')
    assert.equal(checkMigrationCompatibility(database, proof([{ ...exact, createTriggerSqlSha256: 'b'.repeat(64) }])).status, 'incompatible')
    assert.equal(checkMigrationCompatibility(database, proof([exact])).status, 'missing')
  } finally {
    database.close()
  }
})

test('requires an exact CREATE TABLE hash after a legacy shape match', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
  )
  try {
    const legacyShape = tableShape({
      columns: tableShape().columns.map((column) =>
        column.name === 'title' ? { ...column, notNull: false } : column
      )
    })
    const target = tableShape()
    const wrongProof = legacyProof(legacyShape, 'b'.repeat(64))
    assert.equal(checkMigrationCompatibility(database, tableTransition({ target, legacy: [wrongProof] })).status, 'incompatible')
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
      })).status,
      'missing'
    )
  } finally {
    database.close()
  }
})

test('fails closed for a semantically matching MATCH FULL foreign-key DDL variant', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parents(id) MATCH FULL ON UPDATE CASCADE ON DELETE SET NULL);"
  )
  try {
    const legacyShape = tableShapeWithParent()
    const target = tableShapeWithParent({ foreignKeys: [] })
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target,
        legacy: [legacyProof(legacyShape, 'c'.repeat(64))]
      })).status,
      'incompatible'
    )
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
      })).status,
      'missing'
    )
  } finally {
    database.close()
  }
})

test('fails closed for a semantically matching named UNIQUE constraint DDL variant', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', CONSTRAINT uq_items_title UNIQUE (title));"
  )
  try {
    const legacyShape = tableShape({ uniqueConstraints: [uniqueConstraint()] })
    const target = tableShape()
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target,
        legacy: [legacyProof(legacyShape, 'd'.repeat(64))]
      })).status,
      'incompatible'
    )
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target,
        legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
      })).status,
      'missing'
    )
  } finally {
    database.close()
  }
})

test('reports a missing table-transition table as incompatible', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE other (id INTEGER);')
  try {
    assert.deepEqual(checkMigrationCompatibility(database, tableTransition()), {
      status: 'incompatible',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-missing'
    })
  } finally {
    database.close()
  }
})

test('reports an explicitly creatable missing table as missing', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE other (id INTEGER);')
  try {
    assert.deepEqual(checkMigrationCompatibility(database, tableTransition({
      missingTable: 'create',
      legacy: []
    })), {
      status: 'missing',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-missing'
    })
  } finally {
    database.close()
  }
})

test('reports missing, extra, and reordered table columns as incompatible', nativeTestOptions, () => {
  const schemas = [
    'CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, extra BLOB);',
    'CREATE TABLE items (id INTEGER PRIMARY KEY);',
    'CREATE TABLE items (title TEXT, id INTEGER PRIMARY KEY);'
  ]
  for (const schema of schemas) {
    const database = openDatabase(schema)
    try {
      const result = checkMigrationCompatibility(database, tableTransition())
      assert.deepEqual(result, {
        status: 'incompatible',
        kind: 'table-transition',
        table: 'items',
        reason: 'table-shape-incompatible'
      })
    } finally {
      database.close()
    }
  }
})

test('compares STRICT and WITHOUT ROWID table flags', nativeTestOptions, () => {
  const strictDatabase = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready') STRICT;"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(strictDatabase, tableTransition({
        target: tableShape({ strict: true }),
        legacy: [legacyProof(tableShape())]
      })).status,
      'satisfied'
    )
    assert.equal(
      checkMigrationCompatibility(strictDatabase, tableTransition({
        legacy: [legacyProof(tableShape({ withoutRowid: true }))]
      })).reason,
      'table-shape-incompatible'
    )
  } finally {
    strictDatabase.close()
  }

  const withoutRowidShape = tableShape({
    withoutRowid: true,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKeyPosition: 1 },
      { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'", primaryKeyPosition: 0 }
    ]
  })
  const withoutRowidDatabase = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready') WITHOUT ROWID;"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(withoutRowidDatabase, tableTransition({
        target: withoutRowidShape
      })).status,
      'satisfied'
    )
  } finally {
    withoutRowidDatabase.close()
  }
})

test('reports a generated column as incompatible for table-transition', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, source TEXT, title TEXT GENERATED ALWAYS AS (source) STORED);'
  )
  try {
    const result = checkMigrationCompatibility(database, tableTransition({
      target: tableShape({
        columns: [
          tableShape().columns[0],
          { name: 'source', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
          { name: 'title', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
        ]
      })
    }))
    assert.deepEqual(result, {
      status: 'incompatible',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-shape-incompatible'
    })
  } finally {
    database.close()
  }
})

test('reports a matching single-column foreign key target as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parents(id) ON UPDATE CASCADE ON DELETE SET NULL);"
  )
  try {
    assert.deepEqual(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShapeWithParent(),
        legacy: [legacyProof(tableShapeWithParent({ foreignKeys: [] }))]
      })),
      { status: 'satisfied', kind: 'table-transition', table: 'items', reason: 'matched' }
    )
  } finally {
    database.close()
  }
})

test('reports a known legacy table without a foreign key as missing', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER);"
  )
  try {
    const legacyShape = tableShapeWithParent({ foreignKeys: [] })
    assert.deepEqual(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShapeWithParent(),
        legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
      })),
      { status: 'missing', kind: 'table-transition', table: 'items', reason: 'legacy-matched' }
    )
  } finally {
    database.close()
  }
})

test('reports a matching composite foreign key with ordered column mappings', nativeTestOptions, () => {
  const compositeForeignKey = foreignKey({
    columns: ['parent_a', 'parent_b'],
    referencedColumns: ['code_a', 'code_b'],
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT'
  })
  const compositeShape = tableShape({
    columns: [
      tableShape().columns[0],
      tableShape().columns[1],
      { name: 'parent_a', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
      { name: 'parent_b', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
    ],
    foreignKeys: [compositeForeignKey]
  })
  const database = openDatabase(
    'CREATE TABLE parents (code_a INTEGER, code_b INTEGER, PRIMARY KEY (code_a, code_b));' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_a INTEGER, parent_b INTEGER, FOREIGN KEY (parent_a, parent_b) REFERENCES parents(code_a, code_b) ON UPDATE CASCADE ON DELETE RESTRICT);"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({ target: compositeShape, legacy: [legacyProof(tableShape({ columns: compositeShape.columns, foreignKeys: [] }))] })).status,
      'satisfied'
    )
  } finally {
    database.close()
  }
})

test('treats foreign key action, mapping, and reference differences as incompatible', nativeTestOptions, () => {
  const schema =
    'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parents(id) ON UPDATE CASCADE ON DELETE SET NULL);"
  const changes = [
    { columns: ['title'] },
    { referencedTable: 'other_parents' },
    { referencedColumns: ['code'] },
    { onUpdate: 'RESTRICT' },
    { onDelete: 'CASCADE' }
  ]
  for (const change of changes) {
    const database = openDatabase(schema)
    try {
      assert.equal(
        checkMigrationCompatibility(database, tableTransition({
          target: tableShapeWithParent({ foreignKeys: [foreignKey(change)] }),
          legacy: [legacyProof(tableShapeWithParent({ foreignKeys: [] }))]
        })).status,
        'incompatible'
      )
    } finally {
      database.close()
    }
  }
})

test('treats an otherwise matching extra foreign key as incompatible', nativeTestOptions, () => {
  const extraDatabase = openDatabase(
    'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER, other_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parents(id) ON UPDATE CASCADE ON DELETE SET NULL, FOREIGN KEY (other_id) REFERENCES parents(id));"
  )
  try {
    const shape = tableShapeWithParent({
      columns: [
        ...tableShapeWithParent().columns,
        { name: 'other_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
      ]
    })
    assert.equal(checkMigrationCompatibility(extraDatabase, tableTransition({ target: shape, legacy: [legacyProof(tableShape({ columns: shape.columns, foreignKeys: [] }))] })).status, 'incompatible')
  } finally {
    extraDatabase.close()
  }
})

test('treats an otherwise matching missing foreign key as incompatible', nativeTestOptions, () => {
  const schema =
    'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parents(id) ON UPDATE CASCADE ON DELETE SET NULL);"
  const missingDatabase = openDatabase(schema)
  try {
    const shape = tableShapeWithParent({
      foreignKeys: [foreignKey(), foreignKey({ columns: ['title'], referencedColumns: ['id'] })]
    })
    assert.equal(checkMigrationCompatibility(missingDatabase, tableTransition({ target: shape, legacy: [legacyProof(tableShapeWithParent({ foreignKeys: [] }))] })).status, 'incompatible')
  } finally {
    missingDatabase.close()
  }
})

test('reports a table with no UNIQUE constraint as the empty UNIQUE baseline', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');"
  )
  try {
    assert.equal(checkMigrationCompatibility(database, tableTransition()).status, 'satisfied')
  } finally {
    database.close()
  }
})

test('reports a matching single-column UNIQUE constraint as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready' UNIQUE);"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ uniqueConstraints: [uniqueConstraint()] }),
        legacy: [legacyProof(tableShape())]
      })).status,
      'satisfied'
    )
  } finally {
    database.close()
  }
})

test('reports a known legacy table without UNIQUE as missing', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');"
  )
  try {
    const legacyShape = tableShape()
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ uniqueConstraints: [uniqueConstraint()] }),
        legacy: [legacyProof(legacyShape, tableSqlSha256(database))]
      })).status,
      'missing'
    )
  } finally {
    database.close()
  }
})

test('preserves composite UNIQUE column order and compares every UNIQUE detail', nativeTestOptions, () => {
  const composite = [
    { name: 'title', collation: 'BINARY', descending: false },
    { name: 'id', collation: 'BINARY', descending: false }
  ]
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', UNIQUE (title, id));"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ uniqueConstraints: [{ columns: composite }] }),
        legacy: [legacyProof(tableShape({ strict: true }))]
      })).status,
      'satisfied'
    )
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ uniqueConstraints: [{ columns: [...composite].reverse() }] }),
        legacy: [legacyProof(tableShape({ strict: true }))]
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('treats extra, missing, direction, and collation UNIQUE differences as incompatible', nativeTestOptions, () => {
  const cases = [
    {
      schema: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', UNIQUE (title));",
      target: tableShape({ uniqueConstraints: [uniqueConstraint({ columns: [{ name: 'id', collation: 'BINARY', descending: false }] })] })
    },
    {
      schema: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');",
      target: tableShape({ uniqueConstraints: [uniqueConstraint()] })
    },
    {
      schema: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', UNIQUE (title DESC));",
      target: tableShape({ uniqueConstraints: [uniqueConstraint()] })
    },
    {
      schema: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', UNIQUE (title COLLATE NOCASE));",
      target: tableShape({ uniqueConstraints: [uniqueConstraint()] })
    }
  ]
  for (const { schema, target } of cases) {
    const database = openDatabase(schema)
    try {
      assert.equal(
        checkMigrationCompatibility(database, tableTransition({
          target,
          legacy: [legacyProof(tableShape({ strict: true }))]
        })).status,
        'incompatible'
      )
    } finally {
      database.close()
    }
  }
})

test('proves NOCASE and DESC metadata for a table UNIQUE constraint', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready', UNIQUE (title COLLATE NOCASE DESC, id DESC));"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({
          uniqueConstraints: [{
            columns: [
              { name: 'title', collation: 'nocase', descending: true },
              { name: 'id', collation: 'binary', descending: true }
            ]
          }]
        }),
        legacy: [legacyProof(tableShape({ strict: true }))]
      })).status,
      'satisfied'
    )
  } finally {
    database.close()
  }
})

test('ignores CREATE UNIQUE INDEX origin c in this node and defers it to C2d-2b3', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready'); CREATE UNIQUE INDEX explicit_items_title ON items(title);"
  )
  try {
    assert.equal(checkMigrationCompatibility(database, tableTransition()).status, 'satisfied')
    assert.equal(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ uniqueConstraints: [uniqueConstraint()] }),
        legacy: [legacyProof(tableShape({ strict: true }))]
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('keeps table-transition summaries redacted and uses bound read-only metadata queries', () => {
  const prepared = []
  const boundValues = []
  const shape = tableShape({ uniqueConstraints: [uniqueConstraint()] })
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('sqlite_schema')) {
        return {
          get: (...values) => {
            boundValues.push(values)
            return { present: 1 }
          }
        }
      }
      if (sql.includes('pragma_table_list')) {
        return {
          get: (...values) => {
            boundValues.push(values)
            return { wr: 0, strict: 0 }
          }
        }
      }
      if (sql.includes('pragma_table_xinfo')) {
        return {
          all: (...values) => {
            boundValues.push(values)
            return tableMetadataColumns({
              ...shape,
              columns: [
                { ...shape.columns[0], defaultValue: "'/private/secret.db'" },
                shape.columns[1]
              ]
            })
          }
        }
      }
      if (sql.includes('pragma_foreign_key_list')) {
        return {
          all: (...values) => {
            boundValues.push(values)
            return []
          }
        }
      }
      if (sql.includes('pragma_index_list')) {
        return {
          all: (...values) => {
            boundValues.push(values)
            return [{ seq: 0, name: 'secret-index', is_unique: 1, origin: 'u', partial: 0 }]
          }
        }
      }
      if (sql.includes('pragma_index_xinfo')) {
        return {
          all: (...values) => {
            boundValues.push(values)
            return [
              { seqno: 0, cid: 1, name: 'title', descending: 0, coll: 'BINARY', key: 1 },
              { seqno: 1, cid: -1, name: null, descending: 0, coll: 'BINARY', key: 0 }
            ]
          }
        }
      }
      throw new Error('unexpected query')
    }
  }
  const result = checkMigrationCompatibility(database, tableTransition({ target: shape }))
  assert.deepEqual(result, {
    status: 'incompatible',
    kind: 'table-transition',
    table: 'items',
    reason: 'table-shape-incompatible'
  })
  assert.ok(prepared.every((sql) => !sql.includes('items')))
  const tableListSql = prepared.find((sql) => sql.includes('pragma_table_list'))
  assert.match(tableListSql, /schema = 'main'/)
  assert.match(tableListSql, /type = 'table'/)
  const foreignKeySql = prepared.find((sql) => sql.includes('pragma_foreign_key_list'))
  assert.match(foreignKeySql, /FROM pragma_foreign_key_list\(\?\)/i)
  assert.doesNotMatch(foreignKeySql, /(?:^|\s)(?:INSERT|UPDATE|DELETE)(?:\s|$)|writable_schema/i)
  const indexListSql = prepared.find((sql) => sql.includes('pragma_index_list'))
  const indexXinfoSql = prepared.find((sql) => sql.includes('pragma_index_xinfo'))
  assert.match(indexListSql, /FROM pragma_index_list\(\?\)/i)
  assert.match(indexXinfoSql, /FROM pragma_index_xinfo\(\?\)/i)
  assert.doesNotMatch(indexListSql, /(?:^|\s)(?:INSERT|UPDATE|DELETE)(?:\s|$)|writable_schema/i)
  assert.doesNotMatch(indexXinfoSql, /(?:^|\s)(?:INSERT|UPDATE|DELETE)(?:\s|$)|writable_schema/i)
  assert.deepEqual(boundValues, [
    ['items'],
    ['items'],
    ['items'],
    ['items'],
    ['items'],
    ['secret-index']
  ])
  assert.doesNotMatch(JSON.stringify(result), /private|secret|id|title/)
})

test('reads exact CREATE TABLE SQL with a bound mock query and never exposes it', () => {
  const secretSql = "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'secret-default');"
  const secretIndexSql = 'CREATE INDEX secret-index ON items(lower(title)) WHERE title IS NOT NULL;'
  const legacyShape = tableShape()
  const expectedHash = createHash('sha256').update(Buffer.from(secretSql, 'utf8')).digest('hex')
  const expectedIndexHash = createHash('sha256').update(Buffer.from(secretIndexSql, 'utf8')).digest('hex')
  const prepared = []
  const boundValues = []
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('SELECT 1 AS present')) return { get: (...values) => { boundValues.push(values); return { present: 1 } } }
      if (sql.includes("type = 'index'")) return { get: (...values) => { boundValues.push(values); return { sql: secretIndexSql } } }
      if (sql.includes("type = 'trigger'")) return { all: (...values) => { boundValues.push(values); return [] } }
      if (sql.includes('SELECT sql FROM main.sqlite_schema')) return { get: (...values) => { boundValues.push(values); return { sql: secretSql } } }
      if (sql.includes('pragma_table_list')) return { get: (...values) => { boundValues.push(values); return { wr: 0, strict: 0 } } }
      if (sql.includes('pragma_table_xinfo')) return { all: (...values) => { boundValues.push(values); return tableMetadataColumns(legacyShape) } }
      if (sql.includes('pragma_foreign_key_list')) return { all: (...values) => { boundValues.push(values); return [] } }
      if (sql.includes('pragma_index_list')) return { all: (...values) => { boundValues.push(values); return [{ seq: 0, name: 'secret-index', is_unique: 0, origin: 'c', partial: 1 }] } }
      throw new Error('unexpected query')
    }
  }

  const result = checkMigrationCompatibility(database, tableTransition({
    target: tableShape({ strict: true }),
    legacy: [legacyProof(legacyShape, expectedHash, [
      { name: 'secret-index', createIndexSqlSha256: expectedIndexHash }
    ])]
  }))
  assert.deepEqual(result, {
    status: 'missing',
    kind: 'table-transition',
    table: 'items',
    reason: 'legacy-matched'
  })
  assert.deepEqual(boundValues, [['items'], ['items'], ['items'], ['items'], ['items'], ['items'], ['items', 'secret-index'], ['items']])
  const schemaSql = prepared.find((sql) => sql.includes("type = 'table'"))
  assert.match(schemaSql, /FROM main\.sqlite_schema/i)
  assert.match(schemaSql, /type = 'table'/i)
  assert.match(schemaSql, /name = \?/i)
  const indexSchemaSql = prepared.find((sql) => sql.includes("type = 'index'"))
  assert.match(indexSchemaSql, /tbl_name = \?/i)
  assert.match(indexSchemaSql, /name = \?/i)
  assert.doesNotMatch(schemaSql, /secret-default|items/)
  assert.doesNotMatch(indexSchemaSql, /secret-index|lower|title|IS NOT NULL/)
  assert.doesNotMatch(JSON.stringify(result), /secret-default/)
})

test('returns only the uniquely matched keyed legacy proof identifier', () => {
  const secretSql = "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'secret-default');"
  const legacyShape = tableShape()
  const expectedHash = createHash('sha256').update(Buffer.from(secretSql, 'utf8')).digest('hex')
  const database = {
    prepare(sql) {
      if (sql.includes('SELECT 1 AS present')) return { get: () => ({ present: 1 }) }
      if (sql.includes("type = 'trigger'")) return { all: () => [] }
      if (sql.includes('SELECT sql FROM main.sqlite_schema')) return { get: () => ({ sql: secretSql }) }
      if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
      if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(legacyShape) }
      if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
      if (sql.includes('pragma_index_list')) return { all: () => [] }
      throw new Error('unexpected query')
    }
  }

  const result = checkMigrationCompatibility(database, tableTransition({
    target: tableShape({ strict: true }),
    legacy: [keyedLegacyProof('known-legacy', legacyShape, expectedHash)]
  }))
  assert.deepEqual(result, {
    status: 'missing',
    kind: 'table-transition',
    table: 'items',
    reason: 'legacy-matched',
    proofKey: 'known-legacy'
  })
  assert.doesNotMatch(JSON.stringify(result), /secret-default|CREATE TABLE|[a-f0-9]{64}/u)
})

test('reads trigger SQL with a bound table name and never exposes trigger metadata', () => {
  const secretTriggerSql = 'CREATE TRIGGER secret-hook AFTER INSERT ON items BEGIN SELECT NEW.title; END;'
  const secretTableSql = "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
  const legacyShape = tableShape()
  const expectedTableHash = createHash('sha256').update(Buffer.from(secretTableSql, 'utf8')).digest('hex')
  const expectedHash = createHash('sha256').update(Buffer.from(secretTriggerSql, 'utf8')).digest('hex')
  const prepared = []
  const boundValues = []
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('SELECT 1 AS present')) return { get: (...values) => { boundValues.push(values); return { present: 1 } } }
      if (sql.includes("type = 'trigger'")) {
        return { all: (...values) => { boundValues.push(values); return [{ name: 'secret-hook', sql: secretTriggerSql }] } }
      }
      if (sql.includes('SELECT sql FROM main.sqlite_schema')) return { get: (...values) => { boundValues.push(values); return { sql: secretTableSql } } }
      if (sql.includes('pragma_table_list')) return { get: (...values) => { boundValues.push(values); return { wr: 0, strict: 0 } } }
      if (sql.includes('pragma_table_xinfo')) return { all: (...values) => { boundValues.push(values); return tableMetadataColumns(legacyShape) } }
      if (sql.includes('pragma_foreign_key_list')) return { all: (...values) => { boundValues.push(values); return [] } }
      if (sql.includes('pragma_index_list')) return { all: (...values) => { boundValues.push(values); return [] } }
      throw new Error('unexpected query')
    }
  }

  const result = checkMigrationCompatibility(database, tableTransition({
    target: tableShape({ strict: true }),
    legacy: [legacyProof(legacyShape, expectedTableHash, [], [{ name: 'secret-hook', createTriggerSqlSha256: expectedHash }])]
  }))
  assert.deepEqual(result, {
    status: 'missing',
    kind: 'table-transition',
    table: 'items',
    reason: 'legacy-matched'
  })
  assert.deepEqual(boundValues, [['items'], ['items'], ['items'], ['items'], ['items'], ['items'], ['items']])
  const triggerSql = prepared.find((sql) => sql.includes("type = 'trigger'"))
  assert.match(triggerSql, /FROM main\.sqlite_schema/i)
  assert.match(triggerSql, /tbl_name = \?/i)
  assert.match(triggerSql, /ORDER BY name/i)
  assert.doesNotMatch(triggerSql, /secret-hook|NEW\.title|SELECT NEW/i)
  assert.doesNotMatch(JSON.stringify(result), /secret-hook|NEW\.title|CREATE TRIGGER|[a-f0-9]{64}/i)
})

test('fails closed and redacts malformed persistent trigger metadata without native SQLite', () => {
  const sensitiveName = 'sensitive-trigger-name'
  const sensitiveSql = 'CREATE TRIGGER sensitive-trigger-name AFTER INSERT ON items BEGIN SELECT secret_business_value; END;'
  const secretTableSql = "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
  const legacyShape = tableShape()
  const expectedTableHash = createHash('sha256').update(Buffer.from(secretTableSql, 'utf8')).digest('hex')
  const malformedRows = [
    { label: 'non-array rows', rows: { name: sensitiveName, sql: sensitiveSql } },
    { label: 'empty name', rows: [{ name: '', sql: sensitiveSql }] },
    { label: 'blank name', rows: [{ name: '   ', sql: sensitiveSql }] },
    {
      label: 'duplicate name',
      rows: [
        { name: sensitiveName, sql: sensitiveSql },
        { name: sensitiveName, sql: sensitiveSql }
      ]
    },
    { label: 'non-string sql', rows: [{ name: sensitiveName, sql: { secret: sensitiveSql } }] },
    { label: 'blank sql', rows: [{ name: sensitiveName, sql: ' \t ' }] }
  ]

  for (const { label, rows } of malformedRows) {
    const database = {
      prepare(sql) {
        if (sql.includes('SELECT 1 AS present')) return { get: () => ({ present: 1 }) }
        if (sql.includes("type = 'trigger'")) return { all: () => rows }
        if (sql.includes('SELECT sql FROM main.sqlite_schema')) return { get: () => ({ sql: secretTableSql }) }
        if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
        if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(legacyShape) }
        if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
        if (sql.includes('pragma_index_list')) return { all: () => [] }
        throw new Error(`unexpected query for ${label}`)
      }
    }

    const result = checkMigrationCompatibility(database, tableTransition({
      target: tableShape({ strict: true }),
      legacy: [legacyProof(legacyShape, expectedTableHash)]
    }))
    assert.deepEqual(result, {
      status: 'incompatible',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-shape-incompatible'
    })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitiveName))
    assert.doesNotMatch(JSON.stringify(result), /secret_business_value/)
  }
})

test('does not read explicit index SQL when target semantics match', () => {
  const prepared = []
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('SELECT 1 AS present')) return { get: () => ({ present: 1 }) }
      if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
      if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(tableShape()) }
      if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
      if (sql.includes('pragma_index_list')) {
        return { all: () => [{ seq: 0, name: 'unknown-explicit', is_unique: 0, origin: 'c', partial: 0 }] }
      }
      if (sql.includes("type = 'index'")) throw new Error('explicit index SQL must not be queried')
      if (sql.includes("type = 'trigger'")) throw new Error('trigger SQL must not be queried')
      throw new Error('unexpected query')
    }
  }

  assert.equal(checkMigrationCompatibility(database, tableTransition()).status, 'satisfied')
  assert.equal(prepared.some((sql) => sql.includes("type = 'index'")), false)
})

test('treats malformed CREATE TABLE SQL metadata as incompatible without disclosure', () => {
  const legacyShape = tableShape()
  for (const sqlValue of ['', 42, null]) {
    const database = {
      prepare(sql) {
        if (sql.includes('SELECT 1 AS present')) return { get: () => ({ present: 1 }) }
        if (sql.includes('SELECT sql FROM main.sqlite_schema')) return { get: () => ({ sql: sqlValue }) }
        if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
        if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(legacyShape) }
        if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
        if (sql.includes('pragma_index_list')) return { all: () => [] }
        throw new Error('unexpected query')
      }
    }
    assert.deepEqual(
      checkMigrationCompatibility(database, tableTransition({
        target: tableShape({ strict: true }),
        legacy: [legacyProof(legacyShape, DUMMY_DDL_HASH)]
      })),
      { status: 'incompatible', kind: 'table-transition', table: 'items', reason: 'table-shape-incompatible' }
    )
  }
})

test('rejects UNIQUE xinfo cid/name mismatches without exposing metadata', () => {
  const shape = tableShape({ uniqueConstraints: [uniqueConstraint()] })
  const database = {
    prepare(sql) {
      if (sql.includes('sqlite_schema')) return { get: () => ({ present: 1 }) }
      if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
      if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(shape) }
      if (sql.includes('pragma_foreign_key_list')) return { all: () => [] }
      if (sql.includes('pragma_index_list')) {
        return { all: () => [{ seq: 0, name: 'secret-index', is_unique: 1, origin: 'u', partial: 0 }] }
      }
      if (sql.includes('pragma_index_xinfo')) {
        return {
          all: () => [
            { seqno: 0, cid: 0, name: 'title', descending: 0, coll: 'BINARY', key: 1 },
            { seqno: 1, cid: -1, name: null, descending: 0, coll: 'BINARY', key: 0 }
          ]
        }
      }
      throw new Error('unexpected query')
    }
  }

  const result = checkMigrationCompatibility(database, tableTransition({
    target: shape,
    legacy: [legacyProof(tableShape({ strict: true }))]
  }))
  assert.deepEqual(result, {
    status: 'incompatible',
    kind: 'table-transition',
    table: 'items',
    reason: 'table-shape-incompatible'
  })
  assert.doesNotMatch(JSON.stringify(result), /secret|index|id|title/)
})

test('treats malformed foreign key pragma metadata as incompatible without exposing metadata', () => {
  const shape = tableShape()
  const database = {
    prepare(sql) {
      if (sql.includes('sqlite_schema')) return { get: () => ({ present: 1 }) }
      if (sql.includes('pragma_table_list')) return { get: () => ({ wr: 0, strict: 0 }) }
      if (sql.includes('pragma_table_xinfo')) return { all: () => tableMetadataColumns(shape) }
      if (sql.includes('pragma_foreign_key_list')) {
        return { all: () => [{ id: 0, seq: 1, referenced_table: 'parents', local_column: 'title', referenced_column: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION' }] }
      }
      if (sql.includes('pragma_index_list')) return { all: () => [{ seq: 0, name: 'items_idx', is_unique: 1, origin: 'x', partial: 0 }] }
      throw new Error('unexpected query')
    }
  }
  assert.deepEqual(checkMigrationCompatibility(database, tableTransition()), {
    status: 'incompatible', kind: 'table-transition', table: 'items', reason: 'table-shape-incompatible'
  })
})

test('redacts table-transition metadata query failures', () => {
  const database = {
    prepare() {
      throw new Error('C:\\private\\nas.sqlite secret-business-row')
    }
  }
  assert.throws(
    () => checkMigrationCompatibility(database, tableTransition()),
    (error) => {
      assert.ok(error instanceof MigrationCompatibilityError)
      assert.equal(error.code, 'MIGRATION_COMPATIBILITY_CHECK_FAILED')
      assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row|items|title/)
      return true
    }
  )
})

test('reports a missing table as incompatible', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE other (id INTEGER);')
  try {
    assert.deepEqual(
      checkMigrationCompatibility(database, compatibility()),
      {
        status: 'incompatible',
        kind: 'column',
        table: 'items',
        column: 'title',
        reason: 'table-missing'
      }
    )
  } finally {
    database.close()
  }
})

test('reports a missing column as missing', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE items (id INTEGER);')
  try {
    assert.equal(checkMigrationCompatibility(database, compatibility()).status, 'missing')
  } finally {
    database.close()
  }
})

test('reports a fully matching column as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER, title text NOT NULL DEFAULT 'ready', extra BLOB);"
  )
  try {
    const result = checkMigrationCompatibility(database, compatibility())
    assert.equal(result.status, 'satisfied')
    assert.ok(Object.isFrozen(result))
  } finally {
    database.close()
  }
})

test('reports a generated column as incompatible', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (source TEXT, title TEXT GENERATED ALWAYS AS (source) STORED);'
  )
  try {
    const result = checkMigrationCompatibility(database, compatibility({
      column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: null }
    }))
    assert.equal(result.status, 'incompatible')
    assert.equal(result.reason, 'column-incompatible')
  } finally {
    database.close()
  }
})

test('normalizes type case and formatting whitespace without merging declarations', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (title varchar ( 255 ) NOT NULL DEFAULT 0);'
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: ' VARCHAR(255) ', notNull: true, defaultValue: '0' }
      })).status,
      'satisfied'
    )
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'INTEGER', notNull: true, defaultValue: '0' }
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('reports NOT NULL and default conflicts as incompatible', nativeTestOptions, () => {
  const database = openDatabase("CREATE TABLE items (title TEXT DEFAULT 'ready');")
  try {
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'" }
      })).status,
      'incompatible'
    )
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: "'other'" }
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('does not expose database paths, default expressions, or row content on check failure', () => {
  const database = {
    prepare() {
      throw new Error('C:\\private\\nas.sqlite secret-business-row')
    }
  }
  assert.throws(
    () => checkMigrationCompatibility(database, compatibility()),
    (error) => {
      assert.ok(error instanceof MigrationCompatibilityError)
      assert.equal(error.code, 'MIGRATION_COMPATIBILITY_CHECK_FAILED')
      assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row/)
      return true
    }
  )
})

test('treats unexpected column metadata as incompatible without native SQLite', () => {
  for (const column of [
    { name: 'other', type: 'TEXT', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: '', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: 'VARCHAR(255)', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: 'TEXT', not_null: 1, dflt_value: "('ready')", hidden: 0 }
  ]) {
    assert.equal(
      checkMigrationCompatibility(metadataDatabase(column), compatibility()).status,
      'incompatible'
    )
  }
})

test('requires hidden metadata to identify an ordinary column without native SQLite', () => {
  const ordinary = {
    name: 'title',
    type: 'TEXT',
    not_null: 1,
    dflt_value: "'ready'",
    hidden: 0
  }
  assert.equal(
    checkMigrationCompatibility(metadataDatabase(ordinary), compatibility()).status,
    'satisfied'
  )

  for (const hidden of [2, 3, undefined, 'unexpected']) {
    const column = { ...ordinary, hidden }
    if (hidden === undefined) delete column.hidden
    const result = checkMigrationCompatibility(metadataDatabase(column), compatibility())
    assert.equal(result.status, 'incompatible')
    assert.equal(result.reason, 'column-incompatible')
    assert.ok(!('hidden' in result))
  }
})

test('does not include schema values beyond the declared object in summaries', nativeTestOptions, () => {
  const database = openDatabase("CREATE TABLE items (title TEXT DEFAULT 'secret-business-row');")
  try {
    const result = checkMigrationCompatibility(database, compatibility({
      column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: "'other'" }
    }))
    assert.equal(result.status, 'incompatible')
    assert.doesNotMatch(JSON.stringify(result), /secret-business-row/)
  } finally {
    database.close()
  }
})
