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
  const normalized = path.posix.basename(value.replace(/\\/gu, '/'))
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
  return normalized || 'document'
}
