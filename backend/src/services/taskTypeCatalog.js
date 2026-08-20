const TASK_STATUS_SET = new Set([
  'pending',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled'
])

const IDENTIFIER_PATTERN = /^[1-9]\d*$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_COUNTER = 1_000_000_000
const MAX_MUSIC_IDS = 500

const CODE_REPOSITORY_TASK_TYPES = Object.freeze([
  'code.repository.clone',
  'code.repository.sync',
  'code.repository.reclone'
])

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

function safeProgress(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function safeStatus(value) {
  return typeof value === 'string' && TASK_STATUS_SET.has(value) ? value : null
}

function safeErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : null
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

function createDefinition({ taskType, executionClass, subjectType, subjectId, mutexTaskTypes, projectInput, projectResult }) {
  return Object.freeze({
    taskType,
    processorVersion: 'v1',
    executionClass,
    subjectType,
    subjectId,
    mutexTaskTypes: Object.freeze([...mutexTaskTypes]),
    retryableFrom: Object.freeze(['failed']),
    projectInput,
    projectResult
  })
}

export const TASK_TYPE_CATALOG = Object.freeze({
  'code.repository.clone': createDefinition({
    taskType: 'code.repository.clone',
    executionClass: 'network',
    subjectType: 'code-repository',
    projectInput: projectCodeRepositoryInput,
    projectResult: projectCodeCloneResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'code.repository.sync': createDefinition({
    taskType: 'code.repository.sync',
    executionClass: 'network',
    subjectType: 'code-repository',
    projectInput: projectCodeRepositoryInput,
    projectResult: projectCodeSyncResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'code.repository.reclone': createDefinition({
    taskType: 'code.repository.reclone',
    executionClass: 'network',
    subjectType: 'code-repository',
    projectInput: projectCodeRepositoryInput,
    projectResult: projectCodeRecloneResult,
    mutexTaskTypes: CODE_REPOSITORY_TASK_TYPES
  }),
  'music.lyrics.batch': createDefinition({
    taskType: 'music.lyrics.batch',
    executionClass: 'network',
    subjectType: 'music-library',
    subjectId: 'owner',
    projectInput: projectMusicLyricsInput,
    projectResult: projectMusicLyricsResult,
    mutexTaskTypes: ['music.lyrics.batch']
  }),
  'games.steam.sync': createDefinition({
    taskType: 'games.steam.sync',
    executionClass: 'network',
    subjectType: 'game-library',
    subjectId: 'owner',
    projectInput: projectEmptyInput,
    projectResult: projectSteamSyncResult,
    mutexTaskTypes: ['games.steam.sync']
  }),
  'anime.bangumi.refresh': createDefinition({
    taskType: 'anime.bangumi.refresh',
    executionClass: 'network',
    subjectType: 'anime',
    projectInput: projectAnimeRefreshInput,
    projectResult: projectBangumiRefreshResult,
    mutexTaskTypes: ['anime.bangumi.refresh']
  }),
  'ebook.cover.generate': createDefinition({
    taskType: 'ebook.cover.generate',
    executionClass: 'cpu',
    subjectType: 'ebook',
    projectInput: projectEbookCoverInput,
    projectResult: projectEbookCoverResult,
    mutexTaskTypes: ['ebook.cover.generate']
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
    input: definition.projectInput(task.input),
    result: definition.projectResult(task.result)
  })
}

export function projectTasks(tasks) {
  if (!Array.isArray(tasks)) return Object.freeze([])
  return Object.freeze(tasks.map(projectTask).filter((task) => task !== null))
}
