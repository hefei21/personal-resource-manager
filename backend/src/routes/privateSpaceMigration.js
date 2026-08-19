import express from 'express'

const CONFIRMATION = 'EXPAND_PRIVATE_SPACE'
const CONFIRMATION_REQUIRED_CODE = 'PRIVATE_MIGRATION_CONFIRMATION_REQUIRED'
const EXPAND_BLOCKED_CODE = 'PRIVATE_MIGRATION_EXPAND_BLOCKED'
const EXPAND_FAILED_CODE = 'PRIVATE_MIGRATION_EXPAND_FAILED'
const VERIFY_FAILED_CODE = 'PRIVATE_MIGRATION_VERIFY_FAILED'

const PUBLIC_CHECK_KEYS = Object.freeze([
  'oldRecordCount',
  'mappingCount',
  'sourceTotalBytes',
  'fileExistence',
  'sourceHashes',
  'targetStorage',
  'duplicateContent',
  'bounds'
])

const PUBLIC_STAT_KEYS = Object.freeze([
  'recordCount',
  'mappingCount',
  'mappedCount',
  'sourceBytes',
  'targetBytes',
  'uniqueContentCount',
  'duplicateContentGroups',
  'duplicateContentCount',
  'uniqueObjectCount',
  'uniqueObjectBytes',
  'migratedCount',
  'skippedCount',
  'failedCount',
  'reusedObjectCount',
  'outsideRootCount',
  'missingSourceCount',
  'symlinkCount',
  'nonRegularFileCount',
  'sizeMismatchCount',
  'hashMismatchCount'
])

function defaultAuthenticate(req, res, next) {
  import('../middlewares/auth.js')
    .then(({ authenticateToken }) => authenticateToken(req, res, next))
    .catch(next)
}

function defaultAuthorize(req, res, next) {
  import('../middlewares/auth.js')
    .then(({ requireOwner }) => requireOwner(req, res, next))
    .catch(next)
}

async function defaultExpand() {
  const [
    { getDatabase },
    { getDocumentStorageRuntime },
    { expandPrivateSpace }
  ] = await Promise.all([
    import('../config/database.js'),
    import('../services/documentStorageRuntime.js'),
    import('../services/privateSpaceMigration.js')
  ])
  return expandPrivateSpace({
    database: getDatabase(),
    runtime: getDocumentStorageRuntime()
  })
}

async function defaultVerify() {
  const [
    { getDatabase },
    { getDocumentStorageRuntime },
    { verifyPrivateSpace }
  ] = await Promise.all([
    import('../config/database.js'),
    import('../services/documentStorageRuntime.js'),
    import('../services/privateSpaceMigration.js')
  ])
  return verifyPrivateSpace({
    database: getDatabase(),
    runtime: getDocumentStorageRuntime()
  })
}

function stableIssueToken(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value)
    ? value
    : fallback
}

function countBy(issues, field, fallback) {
  const counts = {}
  for (const issue of issues) {
    const key = stableIssueToken(issue?.[field], fallback)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  )
}

export function createPrivateSpaceMigrationSummary(result, operation) {
  const verified = result?.verified === true
  const checks = Object.fromEntries(
    PUBLIC_CHECK_KEYS
      .filter(key => typeof result?.checks?.[key] === 'boolean')
      .map(key => [key, result.checks[key]])
  )
  const stats = Object.fromEntries(
    PUBLIC_STAT_KEYS
      .filter(key => Number.isFinite(result?.stats?.[key]))
      .map(key => [key, result.stats[key]])
  )
  const issues = Array.isArray(result?.issues) ? result.issues : []

  return {
    operation,
    verified,
    checks,
    stats,
    issueCounts: {
      total: issues.length,
      byCode: countBy(issues, 'code', 'PRIVATE_MIGRATION_UNKNOWN_ISSUE'),
      bySeverity: countBy(issues, 'severity', 'unknown'),
      byDisposition: countBy(issues, 'disposition', 'unknown')
    },
    legacyCleanupAvailable: false,
    contractRetirementAllowed: verified
  }
}

function hasExactConfirmation(req) {
  const body = req.body
  return Boolean(
    req.is('application/json') === 'application/json' &&
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    body.confirmation === CONFIRMATION
  )
}

function logOperationFailure(operation, error) {
  console.error(`[Private migration] ${operation} failed:`, error?.code ?? 'UNKNOWN')
}

export function createPrivateSpaceMigrationRouter({
  authenticate = defaultAuthenticate,
  authorize = defaultAuthorize,
  expand = defaultExpand,
  verify = defaultVerify
} = {}) {
  const router = express.Router()
  router.use(authenticate, authorize)

  router.get('/verify', async (req, res) => {
    try {
      const result = await verify()
      return res.status(200).json(createPrivateSpaceMigrationSummary(result, 'verify'))
    } catch (error) {
      logOperationFailure('verify', error)
      return res.status(500).json({ code: VERIFY_FAILED_CODE })
    }
  })

  router.post('/expand', async (req, res) => {
    if (!hasExactConfirmation(req)) {
      return res.status(400).json({ code: CONFIRMATION_REQUIRED_CODE })
    }

    try {
      const result = await expand()
      const summary = createPrivateSpaceMigrationSummary(result, 'expand')
      if (!summary.verified) {
        return res.status(409).json({
          code: EXPAND_BLOCKED_CODE,
          summary
        })
      }
      return res.status(200).json(summary)
    } catch (error) {
      logOperationFailure('expand', error)
      return res.status(500).json({ code: EXPAND_FAILED_CODE })
    }
  })

  return router
}

export default createPrivateSpaceMigrationRouter()
