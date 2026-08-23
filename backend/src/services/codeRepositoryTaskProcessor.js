import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import axios from 'axios'
import { getDatabase } from '../config/database.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'
import { classifyNetworkTaskFailure, taskNetworkError } from './networkTaskError.js'
import {
  RepositorySecurityError,
  resolveManagedRepositoryPath,
  validateGitRemoteUrl
} from './repositorySecurity.js'

const execFileAsync = promisify(execFile)

export const CODE_REPOSITORY_TASK_TYPES = Object.freeze([
  'code.repository.clone',
  'code.repository.sync',
  'code.repository.reclone'
])
export const CODE_REPOSITORY_PROCESSOR_VERSION = 'v1'
export const CODE_REPOSITORY_EXECUTION_CLASS = 'network'
export const CODE_REPOSITORY_SUBJECT_TYPE = 'code-repository'

const CODE_BASE_PATH = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')
const SAFE_GIT_CONFIG = Object.freeze([
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never'
])
const GIT_OPERATION_TIMEOUT_MS = 300_000
const GIT_STATUS_TIMEOUT_MS = 30_000
const TASK_ID_PATTERN = /^[1-9]\d*$/u
const GITHUB_REPOSITORY_PATTERN = /github\.com\/([^/]+)\/([^/.]+)/u

const REPOSITORY_DIRTY_LABELS = Object.freeze({
  modified: '修改',
  deleted: '删除',
  untracked: '未跟踪',
  typeChanged: '类型变化',
  other: '其他'
})

const REPOSITORY_DIRTY_MESSAGE = (summary) => {
  const details = Object.entries(REPOSITORY_DIRTY_LABELS)
    .filter(([key]) => summary[key] > 0)
    .map(([key, label]) => `${label} ${summary[key]}`)
    .join('、')
  return `检测到 ${summary.total} 个本地改动（${details}），已停止同步以避免覆盖。可选择安全重克隆，旧文件会保留为独立备份。`
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new TaskProcessorError({
      code: 'TASK_CANCELLED',
      summary: '代码仓库任务已取消。',
      retryable: false
    })
  }
}

function taskError(code, summary, retryable = false, causeCategory) {
  return new TaskProcessorError({ code, summary, retryable, ...(causeCategory ? { causeCategory } : {}) })
}

function mapProcessorError(error, operation) {
  if (error instanceof TaskProcessorError) return error
  if (error instanceof RepositorySecurityError) {
    return taskError(error.code, error.message, false)
  }
  const operationLabel = operation === 'sync'
    ? '同步'
    : operation === 'reclone'
      ? '安全重克隆'
      : '克隆'
  return taskError(
    operation === 'sync' ? 'GIT_SYNC_FAILED' : 'GIT_CLONE_FAILED',
    `代码仓库${operationLabel}失败。`,
    true
  )
}

function normalizeTaskId(task) {
  const raw = task?.id
  const value = String(raw ?? '')
  if (!TASK_ID_PATTERN.test(value)) {
    throw taskError('TASK_ID_INVALID', '代码仓库任务标识无效。', false)
  }
  return value
}

function getRepositoryId(task) {
  const input = task?.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw taskError('TASK_INPUT_INVALID', '代码仓库任务输入无效。', false)
  }
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'repoId') {
    throw taskError('TASK_INPUT_INVALID', '代码仓库任务输入包含不支持的字段。', false)
  }
  const value = String(input.repoId ?? '')
  if (!TASK_ID_PATTERN.test(value)) {
    throw taskError('TASK_INPUT_INVALID', '代码仓库标识无效。', false)
  }
  return value
}

function createDefaultGitRunner(execFileFunction = execFileAsync) {
  return (args, options = {}) => execFileFunction(
    'git',
    [...SAFE_GIT_CONFIG, ...args],
    {
      timeout: options.timeout ?? GIT_STATUS_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    }
  )
}

export function createGitRunner(execFileFunction = execFileAsync) {
  if (typeof execFileFunction !== 'function') {
    throw new TypeError('execFileFunction must be a function')
  }
  return createDefaultGitRunner(execFileFunction)
}

function ensureManagedPath(storageRoot, storedPath, { mustExist = false } = {}) {
  const candidatePath = resolveManagedRepositoryPath(storageRoot, storedPath)
  let stats
  try {
    stats = fs.lstatSync(candidatePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (mustExist) {
      throw taskError('REPOSITORY_PATH_MISSING', '代码仓库目录不存在。', false)
    }
    const parentPath = path.dirname(candidatePath)
    resolveManagedRepositoryPath(storageRoot, parentPath, {
      mustExist: true,
      allowRoot: true
    })
    return candidatePath
  }

  if (stats.isSymbolicLink()) {
    throw taskError('REPOSITORY_PATH_SYMLINK', '代码仓库目录不能是符号链接。', false)
  }
  if (mustExist) {
    return resolveManagedRepositoryPath(storageRoot, storedPath, { mustExist: true })
  }
  return candidatePath
}

function ensureDirectory(repositoryPath, code = 'REPOSITORY_PATH_INVALID') {
  try {
    const stats = fs.lstatSync(repositoryPath)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw taskError(code, '代码仓库目录无效。', false)
    }
  } catch (error) {
    if (error instanceof TaskProcessorError) throw error
    if (error?.code === 'ENOENT') throw taskError('REPOSITORY_PATH_MISSING', '代码仓库目录不存在。', false)
    throw error
  }
}

function pathExists(candidatePath) {
  try {
    fs.lstatSync(candidatePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function isSafePartialCloneDirectory(repositoryPath) {
  ensureManagedPathForRemoval(repositoryPath)
  ensureDirectory(repositoryPath)
  const entries = fs.readdirSync(repositoryPath, { withFileTypes: true })
  if (entries.length === 0) return true
  return entries.length === 1 && entries[0].name === '.git'
}

function ensureManagedPathForRemoval(repositoryPath) {
  const stats = fs.lstatSync(repositoryPath)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw taskError('REPOSITORY_PATH_INVALID', '代码仓库目录无效。', false)
  }
}

function removeSafePartialCloneDirectory(repositoryPath) {
  if (!pathExists(repositoryPath)) return
  if (!isSafePartialCloneDirectory(repositoryPath)) {
    throw taskError('REPOSITORY_TARGET_OCCUPIED', '代码仓库目标目录包含未受管内容，未执行删除。', false)
  }
  fs.rmSync(repositoryPath, { recursive: true, force: true })
}

async function isValidGitRepository(repositoryPath, runGit, signal) {
  if (!pathExists(repositoryPath)) return false
  ensureDirectory(repositoryPath)
  try {
    throwIfAborted(signal)
    const result = await runGit([
      '-C', repositoryPath,
      'rev-parse',
      '--is-inside-work-tree'
    ], { timeout: GIT_STATUS_TIMEOUT_MS, signal })
    return String(result?.stdout ?? '').trim() === 'true'
  } catch (error) {
    if (isAbortError(error, signal)) throwIfAborted(signal)
    return false
  }
}

function parseGitProgress(output) {
  const text = String(output ?? '')
  const patterns = [
    { pattern: /Counting objects:\s*(\d+)%/u, start: 0, scale: 0.3, message: '正在计数对象' },
    { pattern: /Compressing objects:\s*(\d+)%/u, start: 30, scale: 0.2, message: '正在压缩对象' },
    { pattern: /Receiving objects:\s*(\d+)%/u, start: 50, scale: 0.4, message: '正在接收对象' },
    { pattern: /Resolving deltas:\s*(\d+)%/u, start: 90, scale: 0.1, message: '正在解析 deltas' }
  ]
  let selected = null
  for (const candidate of patterns) {
    const match = text.match(candidate.pattern)
    if (match) {
      selected = {
        progress: Math.min(99, candidate.start + Math.round(Number(match[1]) * candidate.scale)),
        message: `${candidate.message}... ${match[1]}%`
      }
    }
  }
  if (!selected && text.includes('remote: Enumerating objects')) {
    return { progress: 5, message: '正在枚举对象...' }
  }
  return selected
}

function cloneGitWithProgress(url, repositoryPath, {
  signal,
  progress,
  spawnProcess = spawn
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout = null
    let progressChain = Promise.resolve()
    let progressError = null
    let networkFailure = null

    const settle = (callback) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      Promise.resolve(progressChain)
        .then(() => {
          if (progressError) throw progressError
          return callback()
        })
        .then(resolve, reject)
    }

    try {
      throwIfAborted(signal)
      const proc = spawnProcess(
        'git',
        [...SAFE_GIT_CONFIG, 'clone', '--progress', '--depth', '50', url, repositoryPath],
        {
          windowsHide: true,
          signal,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0'
          }
        }
      )

      const queueProgress = (value) => {
        progressChain = progressChain
          .then(() => progress(value))
          .catch((error) => {
            progressError ??= error
            try { proc.kill() } catch {}
          })
      }

      proc.stderr?.on('data', (data) => {
        networkFailure ??= classifyNetworkTaskFailure({ message: String(data) })
        const parsed = parseGitProgress(data)
        if (parsed) queueProgress(parsed.progress)
      })
      proc.on('error', (error) => {
        settle(() => {
          if (isAbortError(error, signal)) throwIfAborted(signal)
          throw taskNetworkError(error, {
            code: 'GIT_CLONE_FAILED',
            summary: '代码仓库克隆失败。',
            retryable: true
          })
        })
      })
      proc.on('close', (code) => {
        settle(() => {
          throwIfAborted(signal)
          if (code !== 0) {
            if (networkFailure?.code) {
              throw taskError(
                networkFailure.code,
                networkFailure.summary,
                networkFailure.retryable,
                networkFailure.causeCategory
              )
            }
            throw taskError('GIT_CLONE_FAILED', '代码仓库克隆失败。', true, networkFailure?.causeCategory)
          }
        })
      })
      timeout = setTimeout(() => {
        try { proc.kill() } catch {}
        settle(() => {
          throw taskError('GIT_CLONE_TIMEOUT', '代码仓库克隆超时。', true)
        })
      }, GIT_OPERATION_TIMEOUT_MS)
      timeout.unref?.()
    } catch (error) {
      settle(() => {
        if (isAbortError(error, signal)) throwIfAborted(signal)
        throw error
      })
    }
  })
}

export function summarizeGitPorcelain(output) {
  const entries = String(output ?? '').split('\0').filter(Boolean)
  const summary = { modified: 0, deleted: 0, untracked: 0, typeChanged: 0, other: 0, total: 0 }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 2) continue
    const status = entry.slice(0, 2)
    summary.total += 1
    if (status === '??') summary.untracked += 1
    else if (status.includes('T')) summary.typeChanged += 1
    else if (status.includes('D')) summary.deleted += 1
    else if (status.includes('M') || status.includes('A')) summary.modified += 1
    else summary.other += 1
    if ((status.includes('R') || status.includes('C')) && index + 1 < entries.length) index += 1
  }
  return Object.freeze(summary)
}

async function getRepositoryChangeSummary(repositoryPath, runGit, signal) {
  try {
    const { stdout } = await runGit([
      '-C', repositoryPath,
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all'
    ], { timeout: GIT_STATUS_TIMEOUT_MS, signal })
    return summarizeGitPorcelain(stdout)
  } catch (error) {
    if (isAbortError(error, signal)) throwIfAborted(signal)
    throw taskError('GIT_STATUS_FAILED', '无法读取代码仓库状态。', true)
  }
}

async function runGitOperation(runGit, args, { signal, operationCode, retryable = true } = {}) {
  try {
    throwIfAborted(signal)
    return await runGit(args, {
      timeout: GIT_OPERATION_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      signal
    })
  } catch (error) {
    if (isAbortError(error, signal)) throwIfAborted(signal)
    throw taskNetworkError(error, {
      code: operationCode,
      summary: 'Git 操作失败。',
      retryable
    })
  }
}

async function defaultFetchAndSaveLanguages(repoId, repoUrl, database) {
  const githubMatch = repoUrl.match(GITHUB_REPOSITORY_PATTERN)
  if (!githubMatch) return
  const [, owner, repo] = githubMatch
  try {
    const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/languages`, {
      timeout: 10_000,
      headers: { Accept: 'application/vnd.github.v3+json' }
    })
    const languageData = response.data
    const total = Object.values(languageData).reduce((sum, value) => sum + value, 0)
    if (total <= 0) return
    const languages = Object.entries(languageData)
      .map(([name, bytes]) => ({
        name,
        percentage: Math.round((bytes / total) * 100)
      }))
      .sort((first, second) => second.percentage - first.percentage)
      .slice(0, 5)
    database.prepare('UPDATE code_repositories SET languages = ? WHERE id = ?')
      .run(JSON.stringify(languages), repoId)
  } catch (error) {
    console.warn('[仓库] 语言统计获取失败，保留 Git 操作结果。')
  }
}

async function fetchLanguagesSafely(fetchLanguages, repo, database) {
  try {
    await fetchLanguages(repo.id, repo.url, database)
  } catch {
    console.warn('[仓库] 语言统计保存失败，保留 Git 操作结果。')
  }
}

function loadRepository(database, repoId, storageRoot) {
  const repo = database.prepare(`
    SELECT id, name, url, description, local_path, type, last_sync
      FROM code_repositories
     WHERE id = ?
  `).get(repoId)
  if (!repo) throw taskError('REPOSITORY_NOT_FOUND', '代码仓库不存在。', false)
  // NAS Git repositories are deliberately imported as read-only projections.
  // Keep this guard before URL validation and before any filesystem/Git write
  // path so a forged persistent task cannot turn a NAS source into a mutable
  // desktop repository.
  if (repo.type === 'git_nas') {
    throw taskError('GIT_NAS_READ_ONLY', 'NAS Git 仓库为只读来源。', false)
  }
  if (repo.type !== 'git') {
    throw taskError('SVN_RETIRED', '仅支持 Git 仓库。', false)
  }
  const safeUrl = validateGitRemoteUrl(repo.url)
  const repositoryPath = ensureManagedPath(storageRoot, repo.local_path)
  return Object.freeze({ ...repo, url: safeUrl, repositoryPath })
}

function updateLastSync(database, repoId) {
  database.prepare('UPDATE code_repositories SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(repoId)
}

function prepareCloneTarget(repositoryPath) {
  if (!pathExists(repositoryPath)) return
  if (isSafePartialCloneDirectory(repositoryPath)) {
    fs.rmSync(repositoryPath, { recursive: true, force: true })
    return
  }
  throw taskError('REPOSITORY_TARGET_OCCUPIED', '代码仓库目标目录包含未受管内容，未执行删除。', false)
}

async function cloneIntoTarget({
  url,
  repositoryPath,
  runGit,
  spawnProcess,
  signal,
  progress
}) {
  if (await isValidGitRepository(repositoryPath, runGit, signal)) {
    return false
  }
  prepareCloneTarget(repositoryPath)
  await cloneGitWithProgress(url, repositoryPath, { signal, progress, spawnProcess })
  return true
}

async function completeGitOperation({
  database,
  repo,
  progress,
  fetchLanguages,
  message
}) {
  await progress(90)
  updateLastSync(database, repo.id)
  await fetchLanguagesSafely(fetchLanguages, repo, database)
  await progress(100)
  return { message }
}

async function executeClone({
  database,
  repo,
  runGit,
  spawnProcess,
  signal,
  progress,
  fetchLanguages,
  message = '克隆完成'
}) {
  await progress(0)
  try {
    await cloneIntoTarget({
      url: repo.url,
      repositoryPath: repo.repositoryPath,
      runGit,
      spawnProcess,
      signal,
      progress
    })
    return await completeGitOperation({ database, repo, progress, fetchLanguages, message })
  } catch (error) {
    const removableCloneFailureCodes = new Set([
      'GIT_CLONE_FAILED',
      'GIT_CLONE_TIMEOUT',
      'PROXY_DNS_FAILED',
      'PROXY_CONNECTION_FAILED'
    ])
    if (!(error instanceof TaskProcessorError) || removableCloneFailureCodes.has(error.code)) {
      try { removeSafePartialCloneDirectory(repo.repositoryPath) } catch {}
    }
    throw error
  }
}

async function executeSync({
  database,
  repo,
  runGit,
  spawnProcess,
  signal,
  progress,
  fetchLanguages
}) {
  await progress(0)
  if (!pathExists(repo.repositoryPath)) {
    return executeClone({
      database,
      repo,
      runGit,
      spawnProcess,
      signal,
      progress,
      fetchLanguages,
      message: '同步完成（目录缺失，已重新克隆）'
    })
  }

  ensureDirectory(repo.repositoryPath)
  if (!await isValidGitRepository(repo.repositoryPath, runGit, signal)) {
    throw taskError('REPOSITORY_NOT_GIT', '代码仓库目录不是有效的 Git 仓库。', false)
  }
  const changeSummary = await getRepositoryChangeSummary(repo.repositoryPath, runGit, signal)
  if (changeSummary.total > 0) {
    throw taskError('REPOSITORY_DIRTY', REPOSITORY_DIRTY_MESSAGE(changeSummary), false)
  }
  await progress(30)
  await runGitOperation(runGit, [
    '-C', repo.repositoryPath,
    'pull',
    '--ff-only'
  ], {
    signal,
    operationCode: 'GIT_SYNC_FAILED',
    retryable: true
  })
  return completeGitOperation({
    database,
    repo,
    progress,
    fetchLanguages,
    message: '同步完成'
  })
}

function stableReclonePaths(repositoryPath, storageRoot, taskId) {
  const baseName = path.basename(repositoryPath)
  const directory = path.dirname(repositoryPath)
  const temporaryPath = path.join(directory, `${baseName}.reclone-${taskId}.tmp`)
  const backupPath = path.join(directory, `${baseName}.local-backup-${taskId}`)
  ensureManagedPath(storageRoot, temporaryPath)
  ensureManagedPath(storageRoot, backupPath)
  return { temporaryPath, backupPath }
}

function findBackupRepository(database, backupPath) {
  return database.prepare(`
    SELECT id, name, url, local_path, type, last_sync
      FROM code_repositories
     WHERE local_path = ?
     LIMIT 1
  `).get(backupPath) ?? null
}

function createBackupRepository(database, repo, backupPath) {
  const existing = findBackupRepository(database, backupPath)
  if (existing) {
    if (existing.id === repo.id || existing.type !== 'git' || existing.url !== repo.url) {
      throw taskError('RECLONE_BACKUP_PATH_OCCUPIED', '安全重克隆备份目标已被占用。', false)
    }
    return { entry: existing, created: false }
  }
  if (pathExists(backupPath)) {
    throw taskError('RECLONE_BACKUP_PATH_OCCUPIED', '安全重克隆备份目标已被占用。', false)
  }
  const result = database.prepare(`
    INSERT INTO code_repositories
      (name, url, description, local_path, type, last_sync)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `${repo.name}（同步前本地备份）`,
    repo.url,
    '安全重克隆时自动保留；包含当时未提交的本地改动。',
    backupPath,
    'git',
    repo.last_sync
  )
  return {
    entry: {
      id: result.lastInsertRowid,
      url: repo.url,
      local_path: backupPath,
      type: 'git'
    },
    created: true
  }
}

async function executeReclone({
  database,
  repo,
  taskId,
  storageRoot,
  runGit,
  spawnProcess,
  signal,
  progress,
  fetchLanguages
}) {
  await progress(0)
  const { temporaryPath, backupPath } = stableReclonePaths(repo.repositoryPath, storageRoot, taskId)
  const targetExists = pathExists(repo.repositoryPath)
  let backupEntry = findBackupRepository(database, backupPath)

  if (targetExists) {
    ensureDirectory(repo.repositoryPath)
    if (!await isValidGitRepository(repo.repositoryPath, runGit, signal)) {
      throw taskError('REPOSITORY_NOT_GIT', '代码仓库目录不是有效的 Git 仓库。', false)
    }
    const changeSummary = await getRepositoryChangeSummary(repo.repositoryPath, runGit, signal)
    if (changeSummary.total === 0) {
      if (backupEntry && pathExists(backupPath)) {
        await progress(90)
        updateLastSync(database, repo.id)
        await fetchLanguagesSafely(fetchLanguages, repo, database)
        await progress(100)
        return {
          message: '安全重克隆完成；旧的本地改动已保留为独立备份仓库',
          backupRepositoryId: Number(backupEntry.id)
        }
      }
      throw taskError('REPOSITORY_CLEAN', '仓库当前没有本地改动，请直接同步。', false)
    }
    if (pathExists(backupPath)) {
      throw taskError('RECLONE_BACKUP_PATH_OCCUPIED', '安全重克隆备份目标已被占用。', false)
    }
  } else if (!backupEntry || !pathExists(backupPath)) {
    throw taskError('REPOSITORY_PATH_MISSING', '代码仓库目录不存在。', false)
  }

  await progress(10)
  if (!await isValidGitRepository(temporaryPath, runGit, signal)) {
    prepareCloneTarget(temporaryPath)
    await cloneGitWithProgress(repo.url, temporaryPath, {
      signal,
      progress,
      spawnProcess
    })
  }
  ensureDirectory(temporaryPath)

  let createdBackupEntry = false
  if (!backupEntry) {
    const outcome = createBackupRepository(database, repo, backupPath)
    backupEntry = outcome.entry
    createdBackupEntry = outcome.created
  }

  let originalMoved = false
  let switched = false
  try {
    if (targetExists && !pathExists(backupPath)) {
      fs.renameSync(repo.repositoryPath, backupPath)
      originalMoved = true
    }

    if (!pathExists(repo.repositoryPath)) {
      if (pathExists(temporaryPath)) {
        fs.renameSync(temporaryPath, repo.repositoryPath)
      } else {
        throw taskError('RECLONE_TEMPORARY_MISSING', '安全重克隆临时目录不存在。', true)
      }
      switched = true
    } else if (pathExists(backupPath) && await isValidGitRepository(repo.repositoryPath, runGit, signal)) {
      switched = true
    } else {
      throw taskError('RECLONE_TARGET_OCCUPIED', '安全重克隆不会覆盖现有目标目录。', false)
    }

    await progress(90)
    updateLastSync(database, repo.id)
    await fetchLanguagesSafely(fetchLanguages, repo, database)
    await progress(100)
    return {
      message: '安全重克隆完成；旧的本地改动已保留为独立备份仓库',
      backupRepositoryId: Number(backupEntry.id)
    }
  } catch (error) {
    if (originalMoved && !switched && !pathExists(repo.repositoryPath) && pathExists(backupPath)) {
      try {
        fs.renameSync(backupPath, repo.repositoryPath)
        originalMoved = false
      } catch {}
    }
    if (!switched) {
      try { removeSafePartialCloneDirectory(temporaryPath) } catch {}
      if (createdBackupEntry && !originalMoved) {
        try { database.prepare('DELETE FROM code_repositories WHERE id = ?').run(backupEntry.id) } catch {}
      }
    }
    throw error
  }
}

export function createCodeRepositoryTaskProcessor({
  database,
  databaseProvider = getDatabase,
  codeBasePath = CODE_BASE_PATH,
  runGit = createDefaultGitRunner(),
  spawnProcess = spawn,
  fetchLanguages = defaultFetchAndSaveLanguages
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof runGit !== 'function') throw new TypeError('runGit must be a function')
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function')
  if (typeof fetchLanguages !== 'function') throw new TypeError('fetchLanguages must be a function')

  return async function processCodeRepositoryTask(context = {}) {
    const task = context.task
    const signal = context.signal
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    const operation = task?.taskType === 'code.repository.clone'
      ? 'clone'
      : task?.taskType === 'code.repository.sync'
        ? 'sync'
        : task?.taskType === 'code.repository.reclone'
          ? 'reclone'
          : null
    if (!operation) throw taskError('TASK_TYPE_UNSUPPORTED', '代码仓库任务类型不受支持。', false)

    try {
      throwIfAborted(signal)
      const databaseConnection = getDatabaseForTask()
      const repoId = getRepositoryId(task)
      const repository = loadRepository(databaseConnection, repoId, codeBasePath)
      const taskId = normalizeTaskId(task)
      if (operation === 'clone') {
        return await executeClone({
          database: databaseConnection,
          repo: repository,
          runGit,
          spawnProcess,
          signal,
          progress,
          fetchLanguages
        })
      }
      if (operation === 'sync') {
        return await executeSync({
          database: databaseConnection,
          repo: repository,
          runGit,
          spawnProcess,
          signal,
          progress,
          fetchLanguages
        })
      }
      return await executeReclone({
        database: databaseConnection,
        repo: repository,
        taskId,
        storageRoot: codeBasePath,
        runGit,
        spawnProcess,
        signal,
        progress,
        fetchLanguages
      })
    } catch (error) {
      throw mapProcessorError(error, operation)
    }
  }
}

const registeredProcessor = createCodeRepositoryTaskProcessor()
registerTaskProcessor('code.repository.clone', 'v1', 'network', registeredProcessor)
registerTaskProcessor('code.repository.sync', 'v1', 'network', registeredProcessor)
registerTaskProcessor('code.repository.reclone', 'v1', 'network', registeredProcessor)

export default registeredProcessor
