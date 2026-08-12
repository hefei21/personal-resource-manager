import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  RESOURCE_BACKUP_MANIFEST_FILE,
  RESOURCE_BACKUP_OBJECTS_DIRECTORY,
  createResourceBackup,
  restoreResourceBackup,
  verifyResourceBackup
} from '../src/config/resourceBackup.js'

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-resource-backup-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }

test('backs up only explicitly listed managed files with deterministic paths', () => {
  const directory = root()
  try {
    const documents = path.join(directory, 'documents')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(path.join(documents, 'nested'), { recursive: true })
    fs.mkdirSync(backup)
    const listed = path.join(documents, 'nested', 'listed.txt')
    fs.writeFileSync(listed, 'listed')
    fs.writeFileSync(path.join(documents, 'not-listed.txt'), 'excluded')
    const result = createResourceBackup({
      backupDirectory: backup,
      entries: [{ kind: 'documents', rootPath: documents, sourcePath: listed }]
    })
    assert.deepEqual(result.manifest.entries.map(({ kind, path: itemPath, bytes }) => ({ kind, path: itemPath, bytes })), [
      { kind: 'documents', path: 'documents/nested/listed.txt', bytes: 6 }
    ])
    assert.equal(fs.existsSync(path.join(backup, RESOURCE_BACKUP_OBJECTS_DIRECTORY, 'documents', 'not-listed.txt')), false)
    assert.equal(verifyResourceBackup({ backupDirectory: backup }).manifest.entries.length, 1)
  } finally { cleanup(directory) }
})

test('rejects outside-root, missing and duplicate resource entries without creating a package', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(managed)
    fs.mkdirSync(backup)
    const inside = path.join(managed, 'inside.txt')
    const outside = path.join(directory, 'outside.txt')
    fs.writeFileSync(inside, 'inside')
    fs.writeFileSync(outside, 'outside')
    assert.throws(() => createResourceBackup({
      backupDirectory: backup,
      entries: [{ kind: 'documents', rootPath: managed, sourcePath: outside }]
    }), { code: 'RESOURCE_BACKUP_SOURCE_OUTSIDE_ROOT' })
    assert.equal(fs.existsSync(path.join(backup, RESOURCE_BACKUP_MANIFEST_FILE)), false)
    assert.throws(() => createResourceBackup({
      backupDirectory: backup,
      entries: [
        { kind: 'documents', rootPath: managed, sourcePath: inside },
        { kind: 'documents', rootPath: managed, sourcePath: inside }
      ]
    }), { code: 'RESOURCE_BACKUP_TARGET_DUPLICATE' })
  } finally { cleanup(directory) }
})

test('detects resource and manifest tampering', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(managed)
    fs.mkdirSync(backup)
    const source = path.join(managed, 'file.txt')
    fs.writeFileSync(source, 'original')
    createResourceBackup({ backupDirectory: backup, entries: [{ kind: 'documents', rootPath: managed, sourcePath: source }] })
    fs.appendFileSync(path.join(backup, RESOURCE_BACKUP_OBJECTS_DIRECTORY, 'documents', 'file.txt'), 'tampered')
    assert.throws(() => verifyResourceBackup({ backupDirectory: backup }), { code: 'RESOURCE_BACKUP_HASH_MISMATCH' })
  } finally { cleanup(directory) }
})

test('rejects unlisted package files and unsafe manifest paths', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(managed)
    fs.mkdirSync(backup)
    const source = path.join(managed, 'file.txt')
    fs.writeFileSync(source, 'original')
    createResourceBackup({ backupDirectory: backup, entries: [{ kind: 'documents', rootPath: managed, sourcePath: source }] })
    const extra = path.join(backup, RESOURCE_BACKUP_OBJECTS_DIRECTORY, 'documents', 'extra.txt')
    fs.writeFileSync(extra, 'extra')
    assert.throws(() => verifyResourceBackup({ backupDirectory: backup }), { code: 'RESOURCE_BACKUP_UNLISTED_FILE' })
    fs.rmSync(extra)

    const manifestPath = path.join(backup, RESOURCE_BACKUP_MANIFEST_FILE)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.entries[0].path = 'documents/../escape.txt'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => verifyResourceBackup({ backupDirectory: backup }), { code: 'RESOURCE_BACKUP_MANIFEST_INVALID' })
  } finally { cleanup(directory) }
})

test('restores verified resources to a new isolated directory', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(path.join(managed, 'nested'), { recursive: true })
    fs.mkdirSync(backup)
    const source = path.join(managed, 'nested', 'file.txt')
    fs.writeFileSync(source, 'restorable')
    createResourceBackup({ backupDirectory: backup, entries: [{ kind: 'documents', rootPath: managed, sourcePath: source }] })
    const target = path.join(directory, 'restored')
    const result = restoreResourceBackup({ backupDirectory: backup, targetDirectory: target })
    assert.equal(result.targetDirectory, fs.realpathSync.native(target))
    assert.equal(fs.readFileSync(path.join(target, 'documents', 'nested', 'file.txt'), 'utf8'), 'restorable')
  } finally { cleanup(directory) }
})

test('refuses existing and overlapping restore targets without changing them', () => {
  const directory = root()
  try {
    const backup = path.join(directory, 'backup')
    const existing = path.join(directory, 'existing')
    fs.mkdirSync(backup)
    fs.mkdirSync(existing)
    const sentinel = path.join(existing, 'keep.txt')
    fs.writeFileSync(sentinel, 'keep')
    assert.throws(() => restoreResourceBackup({ backupDirectory: backup, targetDirectory: existing }), {
      code: 'RESOURCE_RESTORE_TARGET_EXISTS'
    })
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep')
    assert.throws(() => restoreResourceBackup({ backupDirectory: backup, targetDirectory: path.join(backup, 'restore') }), {
      code: 'RESOURCE_BACKUP_PATH_OVERLAP'
    })
  } finally { cleanup(directory) }
})

test('fails before writing when the destination reports insufficient space', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(managed)
    fs.mkdirSync(backup)
    const source = path.join(managed, 'file.txt')
    fs.writeFileSync(source, 'requires-space')
    assert.throws(() => createResourceBackup({
      backupDirectory: backup,
      entries: [{ kind: 'documents', rootPath: managed, sourcePath: source }],
      statfs: () => ({ bavail: 0, bsize: 4096 })
    }), { code: 'RESOURCE_BACKUP_SPACE_INSUFFICIENT' })
    assert.deepEqual(fs.readdirSync(backup), [])
  } finally { cleanup(directory) }
})

test('fails before restoring when the destination reports insufficient space', () => {
  const directory = root()
  try {
    const managed = path.join(directory, 'managed')
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(managed)
    fs.mkdirSync(backup)
    const source = path.join(managed, 'file.txt')
    fs.writeFileSync(source, 'requires-space')
    createResourceBackup({
      backupDirectory: backup,
      entries: [{ kind: 'documents', rootPath: managed, sourcePath: source }]
    })
    const target = path.join(directory, 'restore')
    assert.throws(() => restoreResourceBackup({
      backupDirectory: backup,
      targetDirectory: target,
      statfs: () => ({ bavail: 0, bsize: 4096 })
    }), { code: 'RESOURCE_RESTORE_SPACE_INSUFFICIENT' })
    assert.equal(fs.existsSync(target), false)
  } finally { cleanup(directory) }
})
