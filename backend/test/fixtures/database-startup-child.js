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
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const Database = require('better-sqlite3')
      const diagnosticDatabase = new Database(process.env.DB_PATH, { readonly: true })
      result.attempts = diagnosticDatabase.prepare(`
        SELECT migration_id, status, error_category, safe_error_summary
        FROM prm_migration_attempts
        ORDER BY attempt_id
      `).all()
      diagnosticDatabase.close()
    } catch (diagnosticError) {
      result.diagnosticCode = diagnosticError?.code ?? diagnosticError?.name ?? 'DIAGNOSTIC_FAILED'
    }
  }
  process.stdout.write(JSON.stringify(result))
  process.exitCode = 1
}
