import fs from 'fs'
import path from 'path'

export function collectPrivateSpaceInventory(database, managedRoot) {
  const rows = database.prepare(
    'SELECT file_path, size, created_at, updated_at FROM private_documents ORDER BY id'
  ).all()
  const root = path.resolve(managedRoot)
  let recordedBytes = 0
  let existingManagedFiles = 0
  let existingManagedBytes = 0
  let missingManagedFiles = 0
  let outsideManagedRoot = 0

  for (const row of rows) {
    recordedBytes += Math.max(0, Number(row.size) || 0)
    const candidate = path.resolve(String(row.file_path || ''))
    const managed = candidate === root || candidate.startsWith(`${root}${path.sep}`)
    if (!managed) {
      outsideManagedRoot++
      continue
    }
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) {
        existingManagedFiles++
        existingManagedBytes += stat.size
      } else {
        missingManagedFiles++
      }
    } catch {
      missingManagedFiles++
    }
  }

  const settingsPresent = Boolean(database.prepare(
    'SELECT 1 AS present FROM private_settings WHERE id = 1'
  ).get())

  return {
    frozen: true,
    recordCount: rows.length,
    recordedBytes,
    existingManagedFiles,
    existingManagedBytes,
    missingManagedFiles,
    outsideManagedRoot,
    settingsPresent,
    requiresMigration: rows.length > 0
  }
}
