import { randomUUID } from 'node:crypto'

const TASK_STATUS_SET = new Set([
  'pending',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled'
])
const METADATA_STATUS_SET = new Set(['ready', 'pending', 'partial', 'failed'])

const IDENTIFIER_PATTERN = /^[1-9]\d*$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/iu
const MAX_COUNTER = 1_000_000_000
const MAX_MUSIC_IDS = 500
const MAX_SUBJECT_VERSION_LENGTH = 128

const CODE_REPOSITORY_TASK_TYPES = Object.freeze([
  'code.repository.clone',
  'code.repository.sync',
  'code.repository.reclone'
])

const NAS_RESOURCE_TASK_TYPES = Object.freeze([
  'nas.resource.scan',
  'nas.resource.repair',
  'code.repository.git_nas.discover'
])

const RESOURCE_DOMAIN_SCOPES = new Set(['all', 'documents', 'ebooks', 'music'])

const CODE_CLONE_RESULT_MESSAGES = new Set(['克隆完成'])
const CODE_SYNC_RESULT_MESSAGES = new Set([
  '同步完成',
  '同步完成（目录缺失，已重新克隆）'
])
const CODE_RECLONE_RESULT_MESSAGES = new Set([
  '安全重克隆完成；旧的本地改动已保留为独立备份仓库'
])

const BANGUMI_SUCCESS_MESSAGE = '动漫刷新成功。'

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safePositiveIdentifier(value) {
  const text = typeof value === 'string'
    ? value.trim()
    : Number.isSafeInteger(value) && value > 0
      ? String(value)
      : ''
  if (!IDENTIFIER_PATTERN.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) && number > 0 ? String(number) : null
}

function safePositiveInteger(value) {
  const identifier = safePositiveIdentifier(value)
  if (identifier === null) return null
  return Number(identifier)
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER ? value : null
}

function safeBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeProgress(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function safeStatus(value) {
  return typeof value === 'string' && TASK_STATUS_SET.has(value) ? value : null
}

function safeSubjectVersionId(value) {
  if (value === null || value === undefined) return null
  if (Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  return normalized && normalized.length <= MAX_SUBJECT_VERSION_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null
}

function safeContentHash(value) {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value.toLowerCase() : null
}

function safeErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : null
}

function safeMetadataStatus(value) {
  return typeof value === 'string' && METADATA_STATUS_SET.has(value) ? value : null
}

function safeTimestamp(value) {
  return value === null || value === undefined
    ? null
    : typeof value === 'string' && TIMESTAMP_PATTERN.test(value)
      ? value
      : null
}

function projectTimestamps(task) {
  return Object.freeze({
    availableAt: safeTimestamp(task.availableAt),
    startedAt: safeTimestamp(task.startedAt),
    finishedAt: safeTimestamp(task.finishedAt),
    createdAt: safeTimestamp(task.createdAt),
    updatedAt: safeTimestamp(task.updatedAt)
  })
}

function projectSubject(definition, task) {
  if (task.subjectType !== definition.subjectType) return null
  if (definition.subjectId === 'owner') {
    return task.subjectId === 'owner'
      ? Object.freeze({ type: definition.subjectType, id: 'owner' })
      : null
  }
  const id = safePositiveIdentifier(task.subjectId)
  return id === null ? null : Object.freeze({ type: definition.subjectType, id })
}

function projectCodeRepositoryInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'repoId')) return null
  const repoId = safePositiveIdentifier(input.repoId)
  return repoId === null ? null : Object.freeze({ repoId })
}

function projectMusicLyricsInput(input) {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'musicIds')) return null
  const keys = Object.keys(input)
  if (keys.some((key) => key !== 'musicIds' && key !== 'force')) return null
  if (!Array.isArray(input.musicIds) || input.musicIds.length < 1 || input.musicIds.length > MAX_MUSIC_IDS) return null

  const musicIds = []
  const seen = new Set()
  for (const value of input.musicIds) {
    if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) return null
    seen.add(value)
    musicIds.push(value)
  }
  const force = input.force === undefined ? false : input.force
  if (typeof force !== 'boolean') return null
  return Object.freeze({ musicIds: Object.freeze(musicIds), force })
}

function projectEmptyInput(input) {
  return isPlainObject(input) && Object.keys(input).length === 0 ? Object.freeze({}) : null
}

function projectSearchIndexInput(input) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !['rebuild', 'includeCodeFiles'].includes(key))) return null
  const rebuild = input.rebuild === undefined ? false : input.rebuild
  const includeCodeFiles = input.includeCodeFiles === undefined ? true : input.includeCodeFiles
  if (typeof rebuild !== 'boolean' || typeof includeCodeFiles !== 'boolean') return null
  return Object.freeze({ rebuild, includeCodeFiles })
}

function projectAnimeRefreshInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'animeId')) return null
  const animeId = safePositiveInteger(input.animeId)
  return animeId === null ? null : Object.freeze({ animeId })
}

function projectEbookCoverInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'bookId')) return null
  const bookId = safePositiveInteger(input.bookId)
  return bookId === null ? null : Object.freeze({ bookId })
}

function projectSingleResourceInput(input, field) {
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, field)) return null
  const resourceId = safePositiveInteger(input[field])
  return resourceId === null ? null : Object.freeze({ [field]: resourceId })
}

function projectEbookMetadataInput(input) {
  return projectSingleResourceInput(input, 'bookId')
}

function projectMusicMetadataInput(input) {
  return projectSingleResourceInput(input, 'musicId')
}

function projectNasResourceInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, 'scanRootId') ||
    !Object.hasOwn(input, 'rulesVersion') ||
    !Object.hasOwn(input, 'generation')) return null
  const scanRootId = safePositiveInteger(input.scanRootId)
  const rulesVersion = safePositiveInteger(input.rulesVersion)
  const generation = safePositiveInteger(input.generation)
  if (scanRootId === null || rulesVersion === null || generation === null) return null
  return Object.freeze({ scanRootId, rulesVersion, generation })
}

function projectResourceDomainInput(input) {
  if (!isPlainObject(input)) return null
  const keys = Object.keys(input)
  if (!Object.hasOwn(input, 'scope') || keys.some((key) => !['scope', 'cursor', 'batchSize'].includes(key))) return null
  if (typeof input.scope !== 'string' || !RESOURCE_DOMAIN_SCOPES.has(input.scope)) return null
  const projected = { scope: input.scope }
  if (Object.hasOwn(input, 'cursor')) {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) return null
    if (input.scope === 'all') return null
    projected.cursor = input.cursor
  }
  if (Object.hasOwn(input, 'batchSize')) {
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1000) return null
    projected.batchSize = input.batchSize
  }
  return Object.freeze(projected)
}

function projectGitNasImportInput(input) {
  return projectSingleResourceInput(input, 'candidateId')
}

function cloneCodeRepositoryInput(input) {
  const projected = projectCodeRepositoryInput(input)
  return projected === null ? null : Object.freeze({ repoId: projected.repoId })
}

function cloneMusicLyricsInput(input) {
  const projected = projectMusicLyricsInput(input)
  return projected === null
    ? null
    : Object.freeze({
        musicIds: Object.freeze([...projected.musicIds]),
        force: projected.force
      })
}

function cloneEmptyInput(input) {
  const projected = projectEmptyInput(input)
  return projected === null ? null : Object.freeze({})
}

function cloneSearchIndexInput(input) {
  const projected = projectSearchIndexInput(input)
  return projected === null ? null : Object.freeze({ ...projected })
}

function cloneAnimeRefreshInput(input) {
  const projected = projectAnimeRefreshInput(input)
  return projected === null ? null : Object.freeze({ animeId: projected.animeId })
}

function cloneEbookCoverInput(input) {
  const projected = projectEbookCoverInput(input)
  return projected === null ? null : Object.freeze({ bookId: projected.bookId })
}

function cloneSingleResourceInput(input, field, projectInput) {
  const projected = projectInput(input)
  return projected === null ? null : Object.freeze({ [field]: projected[field] })
}

function cloneEbookMetadataInput(input) {
  return cloneSingleResourceInput(input, 'bookId', projectEbookMetadataInput)
}

function cloneMusicMetadataInput(input) {
  return cloneSingleResourceInput(input, 'musicId', projectMusicMetadataInput)
}

function projectCodeRepositoryResult(result, allowedMessages, allowBackupRepositoryId) {
  if (!isPlainObject(result)) return null
  const backupRepositoryId = allowBackupRepositoryId
    ? safePositiveInteger(result.backupRepositoryId)
    : null
  const message = allowedMessages.has(result.message) ? result.message : null
  if (backupRepositoryId === null && message === null) return null

  const projected = {}
  if (message !== null) projected.message = message
  if (backupRepositoryId !== null) projected.backupRepositoryId = backupRepositoryId
  return Object.freeze(projected)
}

function projectCodeCloneResult(result) {
  return projectCodeRepositoryResult(result, CODE_CLONE_RESULT_MESSAGES, false)
}

function projectCodeSyncResult(result) {
  return projectCodeRepositoryResult(result, CODE_SYNC_RESULT_MESSAGES, false)
}

function projectCodeRecloneResult(result) {
  return projectCodeRepositoryResult(result, CODE_RECLONE_RESULT_MESSAGES, true)
}

function projectMusicLyricsResult(result) {
  if (!isPlainObject(result)) return null
  const projected = {}
  let hasValue = false
  for (const key of ['total', 'success', 'failed', 'skipped']) {
    const value = safeCounter(result[key])
    if (value !== null) {
      projected[key] = value
      hasValue = true
    }
  }
  return hasValue ? Object.freeze(projected) : null
}

function projectSteamSyncResult(result) {
  if (!isPlainObject(result)) return null
  const projected = {}
  let hasValue = false
  for (const key of ['total', 'inserted', 'updated']) {
    const value = safeCounter(result[key])
    if (value !== null) {
      projected[key] = value
      hasValue = true
    }
  }
  return hasValue ? Object.freeze(projected) : null
}

function projectBangumiRefreshResult(result) {
  if (!isPlainObject(result)) return null
  const animeId = safePositiveInteger(result.animeId)
  const bangumiId = safePositiveInteger(result.bangumiId)
  const message = result.message === BANGUMI_SUCCESS_MESSAGE ? result.message : null
  if (animeId === null && bangumiId === null && message === null) return null

  const projected = {}
  if (animeId !== null) projected.animeId = animeId
  if (bangumiId !== null) projected.bangumiId = bangumiId
  if (message !== null) projected.message = message
  return Object.freeze(projected)
}

function projectEbookCoverResult(result) {
  if (!isPlainObject(result)) return null
  const bookId = safePositiveInteger(result.bookId)
  const generated = typeof result.generated === 'boolean' ? result.generated : null
  if (bookId === null && generated === null) return null

  const projected = {}
  if (bookId !== null) projected.bookId = bookId
  if (generated !== null) projected.generated = generated
  return Object.freeze(projected)
}

function projectMetadataReparseResult(result, resourceIdField) {
  if (!isPlainObject(result)) return null
  const resourceId = safePositiveInteger(result[resourceIdField])
  const updatedFields = safeCounter(result.updatedFields)
  const metadataStatus = safeMetadataStatus(result.metadataStatus)
  if (resourceId === null && updatedFields === null && metadataStatus === null) return null

  const projected = {}
  if (resourceId !== null) projected[resourceIdField] = resourceId
  if (updatedFields !== null) projected.updatedFields = updatedFields
  if (metadataStatus !== null) projected.metadataStatus = metadataStatus
  return Object.freeze(projected)
}

function projectEbookMetadataResult(result) {
  return projectMetadataReparseResult(result, 'bookId')
}

function projectMusicMetadataResult(result) {
  return projectMetadataReparseResult(result, 'musicId')
}

function projectNasResourceResult(result) {
  if (!isPlainObject(result)) return null
  const projected = {}
  let hasValue = false
  const generation = safePositiveInteger(result.generation)
  if (generation !== null) {
    projected.generation = generation
    hasValue = true
  }
  const rulesVersion = safePositiveInteger(result.rulesVersion)
  if (rulesVersion !== null) {
    projected.rulesVersion = rulesVersion
    hasValue = true
  }
  for (const key of ['visitedEntries', 'files', 'excluded']) {
    const value = safeCounter(result[key])
    if (value !== null) {
      projected[key] = value
      hasValue = true
    }
  }
  if (isPlainObject(result.counts)) {
    const counts = {}
    let hasCount = false
    for (const key of ['added', 'moved', 'modified', 'unchanged', 'excluded', 'errors', 'missing', 'conflicts']) {
      const value = safeCounter(result.counts[key])
      if (value !== null) {
        counts[key] = value
        hasCount = true
      }
    }
    if (hasCount) {
      projected.counts = Object.freeze(counts)
      hasValue = true
    }
  }
  return hasValue ? Object.freeze(projected) : null
}

function projectCounterResult(result, keys) {
  if (!isPlainObject(result)) return null
  const projected = {}
  let hasValue = false
  for (const key of keys) {
    const value = safeCounter(result[key])
    if (value !== null) {
      projected[key] = value
      hasValue = true
    }
  }
  return hasValue ? Object.freeze(projected) : null
}

function projectSearchIndexResult(result) {
  const projected = projectCounterResult(result, [
    'inserted', 'updated', 'skipped', 'deleted', 'entryCount', 'errorCount'
  ])
  if (!projected) return null
  const status = ['ready', 'partial'].includes(result.status) ? result.status : null
  return Object.freeze({ ...projected, ...(status ? { status } : {}) })
}

function projectResourceDomainResult(result) {
  return projectCounterResult(result, [
    'processed', 'resourcesCreated', 'resourcesReused', 'sourcesCreated',
    'versionsCreated', 'versionsReused', 'contentObjectsCreated',
    'contentObjectsReused', 'missingContent', 'missingRecords', 'errors', 'conflicts', 'skipped'
  ])
}

function projectGitNasDiscoveryResult(result) {
  return projectCounterResult(result, [
    'generation', 'rulesVersion', 'visitedEntries', 'candidates', 'rejected',
    'created', 'existing', 'missing'
  ])
}

function projectGitNasImportResult(result) {
  if (!isPlainObject(result)) return null
  const repositoryId = safePositiveInteger(result.repositoryId)
  const resourceId = safePositiveInteger(result.resourceId)
  const status = result.status === 'imported' || result.status === 'already-imported'
    ? result.status
    : null
  if (repositoryId === null && resourceId === null && status === null) return null
  return Object.freeze({
    ...(repositoryId === null ? {} : { repositoryId }),
    ...(resourceId === null ? {} : { resourceId }),
    ...(status === null ? {} : { status })
  })
}

function projectContentInspectionInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 3 || input.schemaVersion !== 1) return null
  const resourceVersionId = safePositiveInteger(input.resourceVersionId)
  const contentObjectId = safePositiveInteger(input.contentObjectId)
  if (resourceVersionId === null || contentObjectId === null) return null
  return Object.freeze({ schemaVersion: 1, resourceVersionId, contentObjectId })
}

function projectContentInspectionResult(result) {
  if (!isPlainObject(result) || result.schemaVersion !== 1 || !isPlainObject(result.output)) return null
  const sha256 = safeContentHash(result.output.sha256)
  const bytes = safeBytes(result.output.bytes)
  if (sha256 === null || bytes === null || typeof result.output.utf8Valid !== 'boolean') return null
  return Object.freeze({ sha256, bytes, utf8Valid: result.output.utf8Valid })
}

function createDefinition({
  taskType,
  executionClass,
  subjectType,
  subjectId,
  subjectInputField,
  mutexTaskTypes,
  projectInput,
  cloneInput,
  projectResult
}) {
  return Object.freeze({
    taskType,
    processorVersion: 'v1',
    executionClass,
    subjectType,
    subjectId,
    subjectInputField: subjectInputField ?? null,
    mutexTaskTypes: Object.freeze([...mutexTaskTypes]),
    retryableFrom: Object.freeze(['failed']),
    projectInput,
    cloneInput,
    projectResult
  })
}

export const TASK_TYPE_CATALOG = Object.freeze({
  'code.repository.clone': createDefinition({
    taskType: 'code.repository.clone',
    executionClass: 'network',
    subjectType: 'code-repository',
    subjectInputField: 'repoId',
    projectInput: projectCodeRepositoryInput,
    cloneInput: cloneCodeRepositoryInput,
    projectResult: projectCodeCloneResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'code.repository.sync': createDefinition({
    taskType: 'code.repository.sync',
    executionClass: 'network',
    subjectType: 'code-repository',
    subjectInputField: 'repoId',
    projectInput: projectCodeRepositoryInput,
    cloneInput: cloneCodeRepositoryInput,
    projectResult: projectCodeSyncResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'code.repository.reclone': createDefinition({
    taskType: 'code.repository.reclone',
    executionClass: 'network',
    subjectType: 'code-repository',
    subjectInputField: 'repoId',
    projectInput: projectCodeRepositoryInput,
    cloneInput: cloneCodeRepositoryInput,
    projectResult: projectCodeRecloneResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'music.lyrics.batch': createDefinition({
    taskType: 'music.lyrics.batch',
    executionClass: 'network',
    subjectType: 'music-library',
    subjectId: 'owner',
    projectInput: projectMusicLyricsInput,
    cloneInput: cloneMusicLyricsInput,
    projectResult: projectMusicLyricsResult,
    mutexTaskTypes: ['music.lyrics.batch']
  }),
  'games.steam.sync': createDefinition({
    taskType: 'games.steam.sync',
    executionClass: 'network',
    subjectType: 'game-library',
    subjectId: 'owner',
    projectInput: projectEmptyInput,
    cloneInput: cloneEmptyInput,
    projectResult: projectSteamSyncResult,
    mutexTaskTypes: ['games.steam.sync']
  }),
  'anime.bangumi.refresh': createDefinition({
    taskType: 'anime.bangumi.refresh',
    executionClass: 'network',
    subjectType: 'anime',
    subjectInputField: 'animeId',
    projectInput: projectAnimeRefreshInput,
    cloneInput: cloneAnimeRefreshInput,
    projectResult: projectBangumiRefreshResult,
    mutexTaskTypes: ['anime.bangumi.refresh']
  }),
  'ebook.cover.generate': createDefinition({
    taskType: 'ebook.cover.generate',
    executionClass: 'cpu',
    subjectType: 'ebook',
    subjectInputField: 'bookId',
    projectInput: projectEbookCoverInput,
    cloneInput: cloneEbookCoverInput,
    projectResult: projectEbookCoverResult,
    mutexTaskTypes: ['ebook.cover.generate']
  }),
  'ebook.metadata.reparse': createDefinition({
    taskType: 'ebook.metadata.reparse',
    executionClass: 'cpu',
    subjectType: 'ebook',
    subjectInputField: 'bookId',
    projectInput: projectEbookMetadataInput,
    cloneInput: cloneEbookMetadataInput,
    projectResult: projectEbookMetadataResult,
    mutexTaskTypes: ['ebook.metadata.reparse']
  }),
  'music.metadata.reparse': createDefinition({
    taskType: 'music.metadata.reparse',
    executionClass: 'cpu',
    subjectType: 'music',
    subjectInputField: 'musicId',
    projectInput: projectMusicMetadataInput,
    cloneInput: cloneMusicMetadataInput,
    projectResult: projectMusicMetadataResult,
    mutexTaskTypes: ['music.metadata.reparse']
  }),
  'resource.domain.adapt': createDefinition({
    taskType: 'resource.domain.adapt',
    executionClass: 'disk',
    subjectType: 'resource-domain-import',
    subjectId: 'owner',
    projectInput: projectResourceDomainInput,
    cloneInput: (input) => {
      const projected = projectResourceDomainInput(input)
      return projected === null ? null : Object.freeze({ ...projected })
    },
    projectResult: projectResourceDomainResult,
    mutexTaskTypes: ['resource.domain.adapt']
  }),
  'search.index.refresh': createDefinition({
    taskType: 'search.index.refresh',
    executionClass: 'disk',
    subjectType: 'search-index',
    subjectId: 'owner',
    projectInput: projectSearchIndexInput,
    cloneInput: cloneSearchIndexInput,
    projectResult: projectSearchIndexResult,
    mutexTaskTypes: ['search.index.refresh']
  }),
  'code.repository.git_nas.discover': createDefinition({
    taskType: 'code.repository.git_nas.discover',
    executionClass: 'disk',
    subjectType: 'nas-scan-root',
    subjectInputField: 'scanRootId',
    projectInput: projectNasResourceInput,
    cloneInput: (input) => {
      const projected = projectNasResourceInput(input)
      return projected === null ? null : Object.freeze({ ...projected })
    },
    projectResult: projectGitNasDiscoveryResult,
    mutexTaskTypes: NAS_RESOURCE_TASK_TYPES
  }),
  'code.repository.git_nas.import': createDefinition({
    taskType: 'code.repository.git_nas.import',
    executionClass: 'disk',
    subjectType: 'git-nas-candidate',
    subjectInputField: 'candidateId',
    projectInput: projectGitNasImportInput,
    cloneInput: (input) => {
      const projected = projectGitNasImportInput(input)
      return projected === null ? null : Object.freeze({ candidateId: projected.candidateId })
    },
    projectResult: projectGitNasImportResult,
    mutexTaskTypes: ['code.repository.git_nas.import']
  }),
  'nas.resource.scan': createDefinition({
    taskType: 'nas.resource.scan',
    executionClass: 'disk',
    subjectType: 'nas-scan-root',
    subjectInputField: 'scanRootId',
    projectInput: projectNasResourceInput,
    cloneInput: (input) => {
      const projected = projectNasResourceInput(input)
      return projected === null ? null : Object.freeze({ ...projected })
    },
    projectResult: projectNasResourceResult,
    mutexTaskTypes: NAS_RESOURCE_TASK_TYPES
  }),
  'nas.resource.repair': createDefinition({
    taskType: 'nas.resource.repair',
    executionClass: 'disk',
    subjectType: 'nas-scan-root',
    subjectInputField: 'scanRootId',
    projectInput: projectNasResourceInput,
    cloneInput: (input) => {
      const projected = projectNasResourceInput(input)
      return projected === null ? null : Object.freeze({ ...projected })
    },
    projectResult: projectNasResourceResult,
    mutexTaskTypes: NAS_RESOURCE_TASK_TYPES
  }),
  'content.inspect': createDefinition({
    taskType: 'content.inspect',
    executionClass: 'gpu',
    subjectType: 'resource-version',
    subjectInputField: 'resourceVersionId',
    projectInput: projectContentInspectionInput,
    cloneInput: projectContentInspectionInput,
    projectResult: projectContentInspectionResult,
    mutexTaskTypes: ['content.inspect']
  })
})

export const KNOWN_TASK_TYPES = Object.freeze(Object.keys(TASK_TYPE_CATALOG))
export const TASK_CENTER_STATUSES = Object.freeze([...TASK_STATUS_SET])

export function getTaskTypeDefinition(taskType) {
  return typeof taskType === 'string' && Object.hasOwn(TASK_TYPE_CATALOG, taskType)
    ? TASK_TYPE_CATALOG[taskType]
    : null
}

export function isKnownTaskType(taskType) {
  return getTaskTypeDefinition(taskType) !== null
}

export function projectTask(task) {
  if (!isPlainObject(task)) return null
  const definition = getTaskTypeDefinition(task.taskType)
  if (!definition) return null
  if (task.processorVersion !== definition.processorVersion ||
    task.executionClass !== definition.executionClass) return null

  const id = safePositiveInteger(task.id)
  const status = safeStatus(task.status)
  if (id === null || status === null) return null
  const subject = projectSubject(definition, task)
  if (subject === null) return null
  const input = definition.projectInput(task.input)
  if (definition.subjectInputField !== null && input !== null &&
    String(input[definition.subjectInputField]) !== subject.id) return null
  const result = definition.projectResult(task.result)
  if (definition.subjectInputField !== null && result !== null &&
    Object.hasOwn(result, definition.subjectInputField) &&
    String(result[definition.subjectInputField]) !== subject.id) return null

  return Object.freeze({
    id,
    taskType: definition.taskType,
    status,
    executionClass: definition.executionClass,
    progress: safeProgress(task.progress),
    attemptCount: safeCounter(task.attemptCount),
    maxAttempts: safeCounter(task.maxAttempts),
    subject,
    timestamps: projectTimestamps(task),
    errorCode: safeErrorCode(task.errorCode),
    input,
    result
  })
}

export function projectTasks(tasks) {
  if (!Array.isArray(tasks)) return Object.freeze([])
  return Object.freeze(tasks.map(projectTask).filter((task) => task !== null))
}

export function createTaskRetrySpec(task) {
  if (!isPlainObject(task)) return null
  const definition = getTaskTypeDefinition(task.taskType)
  if (!definition || !definition.retryableFrom.includes(task.status)) return null
  if (task.processorVersion !== definition.processorVersion ||
    task.executionClass !== definition.executionClass ||
    task.subjectType !== definition.subjectType) return null

  const subject = projectSubject(definition, task)
  const subjectVersionId = safeSubjectVersionId(task.subjectVersionId)
  if (subject === null || subjectVersionId === null) return null

  const hasContentHash = Object.hasOwn(task, 'subjectContentHash')
  const hasSha256 = Object.hasOwn(task, 'subjectContentSha256')
  const contentHash = safeContentHash(task.subjectContentHash ?? task.subjectContentSha256)
  if ((hasContentHash && task.subjectContentHash !== null && task.subjectContentHash !== undefined && contentHash === null) ||
    (hasSha256 && task.subjectContentSha256 !== null && task.subjectContentSha256 !== undefined && contentHash === null)) return null
  if (hasContentHash && hasSha256 && task.subjectContentHash !== null && task.subjectContentHash !== undefined &&
    task.subjectContentSha256 !== null && task.subjectContentSha256 !== undefined &&
    safeContentHash(task.subjectContentHash) !== safeContentHash(task.subjectContentSha256)) return null

  const input = definition.cloneInput(task.input)
  if (input === null) return null
  if (definition.subjectInputField !== null &&
    String(input[definition.subjectInputField]) !== subject.id) return null

  let runIdentity
  try {
    runIdentity = randomUUID()
  } catch {
    return null
  }

  return Object.freeze({
    identity: Object.freeze({
      taskType: definition.taskType,
      processorVersion: definition.processorVersion,
      subjectType: subject.type,
      subjectId: subject.id,
      subjectVersionId: runIdentity,
      ...(contentHash === null ? {} : { subjectContentSha256: contentHash })
    }),
    executionClass: definition.executionClass,
    input,
    mutexTaskTypes: definition.mutexTaskTypes
  })
}
