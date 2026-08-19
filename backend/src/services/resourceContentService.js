import path from 'node:path'

import { parseStorageKey } from './storageService.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const RESOURCE_KINDS = new Set(['ebooks', 'music'])

export class ResourceContentError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ResourceContentError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new ResourceContentError(code, message, cause ? { cause } : undefined)
}

function normalizeKind(kind) {
  if (typeof kind !== 'string' || !RESOURCE_KINDS.has(kind)) {
    fail('RESOURCE_KIND_INVALID', 'Resource kind is invalid.')
  }
  return kind
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() === '') {
    fail('RESOURCE_REFERENCE_INVALID', `${field} is invalid.`)
  }
  return value
}

function resolveKind(resource, options, defaultKind) {
  const requestedKind = options?.kind ?? defaultKind ?? resource?.kind
  return normalizeKind(requestedKind)
}

function assertResourceRecord(resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    fail('RESOURCE_RECORD_INVALID', 'Resource record is invalid.')
  }
}

export function resolveResourceContentReference(resource, kind) {
  assertResourceRecord(resource)
  const normalizedKind = normalizeKind(kind)
  const storageKey = optionalText(resource.storage_key, 'storage_key')
  const legacyPath = optionalText(resource.file_path, 'file_path')

  if (storageKey !== null) {
    let parsed
    try {
      parsed = parseStorageKey(storageKey)
    } catch (error) {
      fail('RESOURCE_STORAGE_METADATA_INVALID', 'Resource storage metadata is invalid.', error)
    }
    if (parsed.kind !== normalizedKind) {
      fail('RESOURCE_STORAGE_KIND_INVALID', 'Resource storage key has an invalid kind.')
    }
    if (
      typeof resource.content_sha256 !== 'string' ||
      !HASH_PATTERN.test(resource.content_sha256) ||
      !Number.isSafeInteger(resource.content_bytes) ||
      resource.content_bytes < 0
    ) {
      fail('RESOURCE_STORAGE_METADATA_INCOMPLETE', 'Resource storage metadata is incomplete.')
    }
    if (parsed.sha256 !== resource.content_sha256) {
      fail('RESOURCE_STORAGE_METADATA_MISMATCH', 'Resource storage key and hash do not match.')
    }
    return Object.freeze({
      source: 'storage',
      kind: normalizedKind,
      storageKey,
      sha256: resource.content_sha256,
      bytes: resource.content_bytes
    })
  }

  if (legacyPath !== null) {
    return Object.freeze({ source: 'legacy', kind: normalizedKind, filePath: legacyPath })
  }
  fail('RESOURCE_CONTENT_REFERENCE_MISSING', 'Resource has no readable content reference.')
}

function assertContentServices(storageService, legacyStorageAdapters) {
  if (
    !storageService ||
    typeof storageService.stat !== 'function' ||
    typeof storageService.createReadStream !== 'function'
  ) {
    fail('RESOURCE_CONTENT_SERVICES_INVALID', 'Resource storage service is invalid.')
  }
  if (
    !legacyStorageAdapters ||
    (typeof legacyStorageAdapters !== 'object' && typeof legacyStorageAdapters !== 'function')
  ) {
    fail('RESOURCE_CONTENT_SERVICES_INVALID', 'Resource legacy storage adapters are invalid.')
  }
}

function adapterFor(legacyStorageAdapters, kind) {
  const adapter = legacyStorageAdapters instanceof Map
    ? legacyStorageAdapters.get(kind)
    : typeof legacyStorageAdapters === 'function'
      ? legacyStorageAdapters(kind)
      : legacyStorageAdapters[kind]
  if (
    !adapter ||
    typeof adapter.stat !== 'function' ||
    typeof adapter.createReadStream !== 'function'
  ) {
    fail('RESOURCE_LEGACY_STORAGE_UNAVAILABLE', 'Resource legacy storage is unavailable.')
  }
  return adapter
}

function mapContentError(error) {
  if (error instanceof ResourceContentError) return error
  const code = String(error?.code ?? '')
  if (
    code === 'STORAGE_OBJECT_MISSING' ||
    code === 'LEGACY_STORAGE_FILE_MISSING'
  ) {
    return new ResourceContentError('RESOURCE_CONTENT_MISSING', 'Resource content does not exist.', { cause: error })
  }
  if (
    code === 'STORAGE_RANGE_INVALID' ||
    code === 'LEGACY_STORAGE_RANGE_INVALID'
  ) {
    return new ResourceContentError('RESOURCE_CONTENT_RANGE_INVALID', 'Resource content range is invalid.', { cause: error })
  }
  if (
    code === 'STORAGE_OBJECT_HASH_MISMATCH' ||
    code === 'STORAGE_OBJECT_COLLISION'
  ) {
    return new ResourceContentError('RESOURCE_CONTENT_INTEGRITY_FAILED', 'Resource content integrity verification failed.', { cause: error })
  }
  return new ResourceContentError('RESOURCE_CONTENT_UNAVAILABLE', 'Resource content is unavailable.', { cause: error })
}

function assertVerifiedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('RESOURCE_CONTENT_PATH_INVALID', 'Verified resource content path is invalid.')
  }
  return value
}

export class ResourceContentService {
  constructor({ storageService, legacyStorageAdapters, legacyStorageAdapter, kind } = {}) {
    const adapters = legacyStorageAdapters ?? (kind ? { [kind]: legacyStorageAdapter } : undefined)
    assertContentServices(storageService, adapters)
    this.storageService = storageService
    this.legacyStorageAdapters = adapters
    this.defaultKind = kind === undefined ? undefined : normalizeKind(kind)
  }

  forKind(kind) {
    return new ResourceContentService({
      storageService: this.storageService,
      legacyStorageAdapters: this.legacyStorageAdapters,
      kind: normalizeKind(kind)
    })
  }

  async stat(resource, options = {}) {
    const kind = resolveKind(resource, options, this.defaultKind)
    const reference = resolveResourceContentReference(resource, kind)
    try {
      if (reference.source === 'storage') {
        const metadata = await this.storageService.stat(reference.storageKey)
        if (metadata.sha256 !== reference.sha256 || metadata.bytes !== reference.bytes) {
          fail('RESOURCE_CONTENT_INTEGRITY_FAILED', 'Resource content does not match recorded metadata.')
        }
        return Object.freeze({
          source: 'storage',
          storageKey: reference.storageKey,
          sha256: reference.sha256,
          bytes: reference.bytes,
          modifiedAt: metadata.modifiedAt
        })
      }
      const metadata = await adapterFor(this.legacyStorageAdapters, kind).stat(reference.filePath)
      return Object.freeze({ source: 'legacy', bytes: metadata.bytes, modifiedAt: metadata.modifiedAt })
    } catch (error) {
      throw mapContentError(error)
    }
  }

  async createReadStream(resource, range = {}, options = {}) {
    const kind = resolveKind(resource, options, this.defaultKind)
    const reference = resolveResourceContentReference(resource, kind)
    try {
      const stream = reference.source === 'storage'
        ? await this.storageService.createReadStream(reference.storageKey, range)
        : await adapterFor(this.legacyStorageAdapters, kind).createReadStream(reference.filePath, range)
      return Object.freeze({ source: reference.source, stream })
    } catch (error) {
      throw mapContentError(error)
    }
  }

  async resolveVerifiedFilePath(resource, options = {}) {
    const kind = resolveKind(resource, options, this.defaultKind)
    const reference = resolveResourceContentReference(resource, kind)
    try {
      if (reference.source === 'storage') {
        const metadata = await this.storageService.stat(reference.storageKey)
        if (metadata.sha256 !== reference.sha256 || metadata.bytes !== reference.bytes) {
          fail('RESOURCE_CONTENT_INTEGRITY_FAILED', 'Resource content does not match recorded metadata.')
        }
        const resolver = this.storageService.resolveFilePath ?? this.storageService.objectFile
        if (typeof resolver !== 'function') {
          fail('RESOURCE_CONTENT_PATH_UNAVAILABLE', 'Managed resource content path is unavailable.')
        }
        const filePath = await resolver.call(this.storageService, reference.storageKey)
        return Object.freeze({ source: 'storage', filePath: assertVerifiedPath(filePath) })
      }
      const adapter = adapterFor(this.legacyStorageAdapters, kind)
      if (typeof adapter.resolveFile !== 'function') {
        fail('RESOURCE_CONTENT_PATH_UNAVAILABLE', 'Legacy resource content path is unavailable.')
      }
      const resolved = adapter.resolveFile(reference.filePath)
      return Object.freeze({ source: 'legacy', filePath: assertVerifiedPath(resolved.filePath) })
    } catch (error) {
      throw mapContentError(error)
    }
  }

  async resolveInternalFilePath(resource, options = {}) {
    return this.resolveVerifiedFilePath(resource, options)
  }
}

export const SUPPORTED_RESOURCE_KINDS = Object.freeze([...RESOURCE_KINDS])
