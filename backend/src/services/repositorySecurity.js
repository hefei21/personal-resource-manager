import fs from 'node:fs'
import path from 'node:path'

export class RepositorySecurityError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RepositorySecurityError'
    this.code = code
  }
}

function assertInside(rootPath, candidatePath, allowRoot = false) {
  const relative = path.relative(rootPath, candidatePath)
  const outside = relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)

  if (outside || (!allowRoot && relative === '')) {
    throw new RepositorySecurityError(
      '仓库路径超出受管存储目录',
      'REPOSITORY_PATH_OUTSIDE_ROOT'
    )
  }
}

export function resolveManagedRepositoryPath(
  storageRoot,
  storedPath,
  options = {}
) {
  if (!storedPath || typeof storedPath !== 'string') {
    throw new RepositorySecurityError(
      '仓库路径无效',
      'REPOSITORY_PATH_INVALID'
    )
  }

  const rootPath = path.resolve(storageRoot)
  const candidatePath = path.resolve(storedPath)
  assertInside(rootPath, candidatePath, options.allowRoot === true)

  if (options.mustExist === true) {
    const realRoot = fs.realpathSync(rootPath)
    const realCandidate = fs.realpathSync(candidatePath)
    assertInside(realRoot, realCandidate, options.allowRoot === true)
    return realCandidate
  }

  return candidatePath
}

export function resolveRepositoryEntry(
  storageRoot,
  repositoryPath,
  relativePath = '',
  options = {}
) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath)
  ) {
    throw new RepositorySecurityError(
      '仓库内路径无效',
      'REPOSITORY_ENTRY_INVALID'
    )
  }

  const managedRepository = resolveManagedRepositoryPath(
    storageRoot,
    repositoryPath,
    { mustExist: true }
  )
  const candidatePath = path.resolve(managedRepository, relativePath)
  assertInside(
    managedRepository,
    candidatePath,
    options.allowRepositoryRoot === true
  )

  if (options.mustExist !== false) {
    const realCandidate = fs.realpathSync(candidatePath)
    assertInside(
      managedRepository,
      realCandidate,
      options.allowRepositoryRoot === true
    )
    return realCandidate
  }

  return candidatePath
}

export function validateGitRemoteUrl(value) {
  if (!value || typeof value !== 'string') {
    throw new RepositorySecurityError(
      'Git 仓库 URL 无效',
      'GIT_REMOTE_INVALID'
    )
  }

  let remote
  try {
    remote = new URL(value.trim())
  } catch {
    throw new RepositorySecurityError(
      '仅支持完整的 HTTPS 或 SSH Git URL',
      'GIT_REMOTE_UNSUPPORTED'
    )
  }

  if (!['https:', 'ssh:'].includes(remote.protocol) || !remote.hostname) {
    throw new RepositorySecurityError(
      '仅支持 HTTPS 或 SSH Git URL',
      'GIT_REMOTE_UNSUPPORTED'
    )
  }

  if (remote.password || (remote.protocol === 'https:' && remote.username)) {
    throw new RepositorySecurityError(
      '仓库 URL 不得包含凭据',
      'GIT_REMOTE_CREDENTIALS_FORBIDDEN'
    )
  }

  return remote.toString()
}

export function validateCommitHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new RepositorySecurityError(
      '提交哈希无效',
      'COMMIT_HASH_INVALID'
    )
  }
  return value
}

export function normalizeCommitLimit(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(100, Math.max(1, parsed))
}
