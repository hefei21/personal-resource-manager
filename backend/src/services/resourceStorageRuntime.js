import { getStoragePath } from '../config/storage.js'
import { LegacyStorageAdapter } from './legacyStorageAdapter.js'
import { ResourceContentService } from './resourceContentService.js'
import { StorageService } from './storageService.js'

let runtime

function normalizeRoots(value, fieldName) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  throw new TypeError(`${fieldName} must be a path or an array of paths.`)
}

export function createResourceStorageRuntime({
  storageRoot,
  ebooksLegacyRoot,
  booksLegacyRoot,
  musicLegacyRoot,
  legacyRoots,
  legacyRootsByKind,
  randomBytes
} = {}) {
  const storageService = new StorageService({
    rootPath: storageRoot ?? getStoragePath('storage'),
    ...(randomBytes ? { randomBytes } : {})
  })
  const configuredRoots = legacyRootsByKind && typeof legacyRootsByKind === 'object'
    ? legacyRootsByKind
    : {}
  const ebookRoots = configuredRoots.ebooks ?? ebooksLegacyRoot ?? booksLegacyRoot ?? legacyRoots ?? getStoragePath('books')
  const legacyStorageAdapters = {
    ebooks: new LegacyStorageAdapter({ roots: normalizeRoots(ebookRoots, 'ebooksLegacyRoot') })
  }
  const musicRoots = configuredRoots.music ?? musicLegacyRoot ?? getStoragePath('music')
  legacyStorageAdapters.music = new LegacyStorageAdapter({ roots: normalizeRoots(musicRoots, 'musicLegacyRoot') })
  Object.freeze(legacyStorageAdapters)
  const contentService = new ResourceContentService({
    storageService,
    legacyStorageAdapters,
    kind: 'ebooks'
  })
  return Object.freeze({
    storageService,
    legacyStorageAdapters,
    contentService,
    contentServiceFor: (kind) => contentService.forKind(kind)
  })
}

export function getResourceStorageRuntime() {
  runtime ??= createResourceStorageRuntime()
  return runtime
}

export function resetResourceStorageRuntimeForTests() {
  runtime = undefined
}
