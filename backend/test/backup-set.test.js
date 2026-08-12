import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { BACKUP_SET_MANIFEST_FILE, verifyBackupSet } from '../src/config/backupSet.js'

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-backup-set-manifest-'))
}

test('rejects a missing or malformed top-level backup set manifest', () => {
  const root = makeRoot()
  try {
    assert.throws(() => verifyBackupSet({ backupDirectory: root }), {
      code: 'BACKUP_SET_MANIFEST_INVALID'
    })
    fs.writeFileSync(path.join(root, BACKUP_SET_MANIFEST_FILE), '{}')
    assert.throws(() => verifyBackupSet({ backupDirectory: root }), {
      code: 'BACKUP_SET_MANIFEST_INVALID'
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects component manifests that do not match the bound backup set', () => {
  const root = makeRoot()
  try {
    const databaseManifest = '{"database":"original"}\n'
    const resourceManifest = '{"resources":"original"}\n'
    fs.writeFileSync(path.join(root, 'manifest.json'), databaseManifest)
    fs.writeFileSync(path.join(root, 'resources.json'), resourceManifest)
    fs.writeFileSync(path.join(root, BACKUP_SET_MANIFEST_FILE), JSON.stringify({
      formatVersion: 1,
      kind: 'backup-set',
      components: {
        database: { file: 'manifest.json', sha256: sha256(databaseManifest) },
        resources: { file: 'resources.json', sha256: sha256(resourceManifest) }
      }
    }))
    fs.writeFileSync(path.join(root, 'resources.json'), '{"resources":"replacement"}\n')
    assert.throws(() => verifyBackupSet({ backupDirectory: root }), {
      code: 'BACKUP_SET_COMPONENT_MISMATCH'
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
