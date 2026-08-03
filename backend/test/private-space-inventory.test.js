import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { collectPrivateSpaceInventory } from '../src/services/privateSpaceInventory.js'

test('private-space inventory counts metadata without returning paths or titles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-private-inventory-'))
  const existing = path.join(root, 'existing.txt')
  fs.writeFileSync(existing, 'synthetic')
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE private_documents (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, size INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE private_settings (id INTEGER PRIMARY KEY, password TEXT);
  `)
  const insert = db.prepare('INSERT INTO private_documents (title, file_path, size) VALUES (?, ?, ?)')
  insert.run('secret title', existing, 9)
  insert.run('missing title', path.join(root, 'missing.txt'), 10)
  insert.run('external title', path.join(path.dirname(root), 'external.txt'), 11)
  db.prepare("INSERT INTO private_settings (id, password) VALUES (1, 'hash')").run()

  const inventory = collectPrivateSpaceInventory(db, root)
  assert.deepEqual(inventory, {
    frozen: true,
    recordCount: 3,
    recordedBytes: 30,
    existingManagedFiles: 1,
    existingManagedBytes: 9,
    missingManagedFiles: 1,
    outsideManagedRoot: 1,
    settingsPresent: true,
    requiresMigration: true
  })
  assert.equal(JSON.stringify(inventory).includes('secret title'), false)
  assert.equal(JSON.stringify(inventory).includes(root), false)
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})
