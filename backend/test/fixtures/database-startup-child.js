if (process.env.PR_DATABASE_STARTUP_CHILD !== '1') {
  process.exit(0)
}

const capturedOutput = []
for (const method of ['log', 'error', 'warn']) {
  console[method] = (...args) => {
    capturedOutput.push(args.map((value) => String(value)).join(' '))
  }
}

try {
  const { initDatabase } = await import('../../src/config/database.js')
  const database = initDatabase()
  const result = {
    ready: true,
    legacyTablePresent: Boolean(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get()),
    controlTablesPresent: database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('prm_schema_migrations', 'prm_migration_attempts')
    `).get().count === 2,
    legacyGuardCount: database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_temp_master
      WHERE type = 'trigger' AND name LIKE 'prm_legacy_schema_migrations_%_guard'
    `).get().count
  }

  database.close()
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  const result = {
    ready: false,
    code: error?.code ?? null
  }
  if (process.env.PR_DATABASE_STARTUP_DIAGNOSTICS === '1') {
    result.causes = []
    let cause = error
    for (let depth = 0; cause && depth < 6; depth += 1) {
      result.causes.push({
        code: cause?.code ?? null,
        machineCode: cause?.machineCode ?? null
      })
      cause = cause?.cause
    }
  }
  process.stdout.write(JSON.stringify(result))
  process.exitCode = 1
}
