/**
 * Configuration contract for the NAS directory scanner.
 *
 * This module deliberately contains no filesystem or database access.  The
 * scanner service owns all path validation and traversal behaviour; keeping
 * rule normalisation here makes the persisted rules JSON small and explicit.
 */

export const NAS_SCAN_RULES_VERSION = 1
export const DEFAULT_USE_GITIGNORE = true
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_MAX_DEPTH = 64
export const MAX_NAS_SCAN_GLOB_COUNT = 256
export const MAX_NAS_SCAN_GLOB_LENGTH = 1024
export const MAX_NAS_SCAN_EXTENSION_COUNT = 128

// These are defence-in-depth defaults.  They are always retained even when a
// caller supplies a custom list: a negation can never make a safety path safe.
export const DEFAULT_EXCLUDED_GLOBS = Object.freeze([
  '**/.git',
  '**/.git/**',
  '**/.hg',
  '**/.hg/**',
  '**/.svn',
  '**/.svn/**',
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/cache',
  '**/cache/**',
  '**/.cache',
  '**/.cache/**',
  '**/derived',
  '**/derived/**',
  '**/derived-cache',
  '**/derived-cache/**',
  '**/generated',
  '**/generated/**',
  '**/__pycache__',
  '**/__pycache__/**',
  '**/.pytest_cache',
  '**/.pytest_cache/**',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/target',
  '**/target/**',
  '**/artifacts',
  '**/artifacts/**'
])

export const DEFAULT_CREDENTIAL_GLOBS = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.ssh',
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.aws/config',
  '**/.docker/config.json',
  '**/credentials.json',
  '**/*credentials*.json',
  '**/secrets.json',
  '**/*secret*',
  '**/*token*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa',
  '**/id_rsa.*',
  '**/id_ed25519',
  '**/id_ed25519.*',
  '**/service-account*.json',
  '**/kubeconfig'
])

export class NasScanRulesError extends Error {
  constructor(code, message = 'NAS scan rules are invalid.') {
    super(message)
    this.name = 'NasScanRulesError'
    this.code = code
  }
}

function fail(code, message) {
  throw new NasScanRulesError(code, message)
}

function asPatternArray(value, code) {
  if (!Array.isArray(value)) fail(code, 'NAS scan glob rules must be arrays.')
  if (value.length > MAX_NAS_SCAN_GLOB_COUNT) fail(code, 'NAS scan glob rules contain too many patterns.')
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.length === 0 ||
      pattern.length > MAX_NAS_SCAN_GLOB_LENGTH || pattern.includes('\0')) {
      fail(code, 'NAS scan glob rules contain an invalid pattern.')
    }
    // Git-style rules are POSIX rules even when the scanner runs on Windows.
    const normalized = pattern.replaceAll('\\', '/').trim()
    if (!normalized) fail(code, 'NAS scan glob rules contain an empty pattern.')
    return normalized
  })
}

function normalizeExtensions(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) fail('NAS_SCAN_ALLOWED_EXTENSIONS_INVALID', 'Allowed extensions must be an array or null.')
  if (value.length > MAX_NAS_SCAN_EXTENSION_COUNT) {
    fail('NAS_SCAN_ALLOWED_EXTENSIONS_INVALID', 'Allowed extensions contain too many values.')
  }
  return value.map((extension) => {
    if (typeof extension !== 'string' || extension.length === 0 || extension.includes('\0')) {
      fail('NAS_SCAN_ALLOWED_EXTENSIONS_INVALID', 'Allowed extensions contain an invalid value.')
    }
    const normalized = extension.trim().toLowerCase()
    if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('*')) {
      fail('NAS_SCAN_ALLOWED_EXTENSIONS_INVALID', 'Allowed extensions contain an invalid value.')
    }
    return normalized.startsWith('.') ? normalized : `.${normalized}`
  }).filter((extension, index, values) => values.indexOf(extension) === index)
}

function normalizeMaxFileBytes(value) {
  if (value === undefined) return DEFAULT_MAX_FILE_BYTES
  if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_MAX_FILE_BYTES) {
    fail('NAS_SCAN_MAX_FILE_BYTES_INVALID', 'Maximum file size is invalid.')
  }
  return value
}

function normalizeMaxDepth(value) {
  if (value === undefined) return DEFAULT_MAX_DEPTH
  if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_MAX_DEPTH) {
    fail('NAS_SCAN_MAX_DEPTH_INVALID', 'Maximum scan depth is invalid.')
  }
  return value
}

/**
 * Return the canonical, persistable rule object for version 1.
 *
 * Safety patterns are merged with caller patterns and are therefore not
 * removable by a later negation.  `followSymlinks` is intentionally not part
 * of the returned object: symlink following is a fixed security property.
 */
export function normalizeNasScanRules(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('NAS_SCAN_RULES_INVALID', 'NAS scan rules must be an object.')
  }

  if (Object.hasOwn(input, 'followSymlinks')) {
    fail('NAS_SCAN_FOLLOW_SYMLINKS_UNSUPPORTED', 'NAS scan symlink following is fixed off.')
  }

  const allowedKeys = new Set([
    'version', 'rulesVersion', 'useGitignore', 'maxFileBytes', 'allowedExtensions',
    'excludedGlobs', 'credentialGlobs', 'maxDepth'
  ])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    fail('NAS_SCAN_RULES_INVALID', 'NAS scan rules contain unsupported fields.')
  }
  if (Object.hasOwn(input, 'version') && Object.hasOwn(input, 'rulesVersion') &&
    input.version !== input.rulesVersion) {
    fail('NAS_SCAN_RULES_VERSION_UNSUPPORTED', 'NAS scan rule versions conflict.')
  }

  const version = input.version ?? input.rulesVersion ?? NAS_SCAN_RULES_VERSION
  if (version !== NAS_SCAN_RULES_VERSION) {
    fail('NAS_SCAN_RULES_VERSION_UNSUPPORTED', 'NAS scan rules version is unsupported.')
  }

  const useGitignore = input.useGitignore ?? DEFAULT_USE_GITIGNORE
  if (typeof useGitignore !== 'boolean') {
    fail('NAS_SCAN_USE_GITIGNORE_INVALID', 'useGitignore must be boolean.')
  }

  const excludedGlobs = input.excludedGlobs === undefined
    ? []
    : asPatternArray(input.excludedGlobs, 'NAS_SCAN_EXCLUDED_GLOBS_INVALID')
  const credentialGlobs = input.credentialGlobs === undefined
    ? []
    : asPatternArray(input.credentialGlobs, 'NAS_SCAN_CREDENTIAL_GLOBS_INVALID')

  return Object.freeze({
    version: NAS_SCAN_RULES_VERSION,
    useGitignore,
    maxFileBytes: normalizeMaxFileBytes(input.maxFileBytes),
    allowedExtensions: Object.freeze(normalizeExtensions(input.allowedExtensions)),
    excludedGlobs: Object.freeze([...excludedGlobs]),
    credentialGlobs: Object.freeze([...credentialGlobs]),
    maxDepth: normalizeMaxDepth(input.maxDepth)
  })
}

export const DEFAULT_NAS_SCAN_RULES = normalizeNasScanRules()
