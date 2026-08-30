import path from 'node:path'

import { getStoragePath } from '../config/storage.js'
import { DocumentContentService } from './documentDomainService.js'
import { LegacyStorageAdapter } from './legacyStorageAdapter.js'
import { StorageService } from './storageService.js'

let runtime

export function createDocumentStorageRuntime({ storageRoot, legacyRoots, randomBytes } = {}) {
  const storageService = new StorageService({
    rootPath: storageRoot ?? getStoragePath('storage'),
    ...(randomBytes ? { randomBytes } : {})
  })
  const legacyStorageAdapter = new LegacyStorageAdapter({
    roots: legacyRoots ?? [getStoragePath('uploads'), getStoragePath('documents')]
  })
  return Object.freeze({
    storageService,
    legacyStorageAdapter,
    contentService: new DocumentContentService({ storageService, legacyStorageAdapter })
  })
}

export function getDocumentStorageRuntime() {
  runtime ??= createDocumentStorageRuntime()
  return runtime
}

export function resetDocumentStorageRuntimeForTests() {
  runtime = undefined
}

export function documentOriginalName(value) {
  if (typeof value !== 'string') return 'document'
  const basename = path.posix.basename(value.replace(/\\/gu, '/'))
  const repaired = repairLegacyUtf8FileName(basename)
  const normalized = repaired
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim()
  return normalized || 'document'
}

function countHanCharacters(value) {
  return (String(value).match(/\p{Script=Han}/gu) || []).length
}

export function repairLegacyUtf8FileName(value) {
  if (typeof value !== 'string' || value === '') return value
  // Older uploads could persist a UTF-8 byte sequence after it had been decoded as Latin-1.
  // Only repair strings that carry strong mojibake signals and whose UTF-8 round-trip is valid.
  if (!/[\u0080-\u009fÃÂâåæäçèé]/u.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  if (!decoded || decoded.includes('\uFFFD')) return value
  if (countHanCharacters(decoded) <= countHanCharacters(value)) return value
  return decoded
}
