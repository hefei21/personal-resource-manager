import express from 'express'

import {
  CONSISTENCY_DISPOSITIONS,
  StorageConsistencyService
} from '../services/storageConsistencyService.js'

const ISSUE_GUIDANCE = Object.freeze({
  DUPLICATE_BUSINESS_REFERENCE: Object.freeze({
    risk: '多个当前业务记录引用同一对象，可能来自误合并或重复导入。',
    suggestedAction: '核对相关资源身份和版本关系，确认前不要更改引用。',
    recoveryPath: '如确认误合并，从最近已验证备份恢复元数据映射后重新巡检。'
  }),
  EXPIRED_STAGING: Object.freeze({
    risk: '暂存对象已超过保留阈值，可能占用空间。',
    suggestedAction: '先确认没有可续提交操作，再设计幂等清理。',
    recoveryPath: '清理前保留巡检记录；需要时可由原始上传重新生成暂存对象。'
  }),
  INVALID_STAGING_ENTRY: Object.freeze({
    risk: '暂存目录包含不符合受管格式的条目。',
    suggestedAction: '人工确认条目来源和进程状态，不要自动删除。',
    recoveryPath: '在隔离副本确认后移出受管目录，并保留可恢复副本。'
  }),
  INVALID_STORAGE_KEY: Object.freeze({
    risk: '对象引用或对象布局不符合内容寻址规则。',
    suggestedAction: '核对对象类型、hash 和前缀，人工重建合法映射。',
    recoveryPath: '从已验证备份恢复原对象和引用映射，再重新巡检。'
  }),
  MISSING_OBJECT: Object.freeze({
    risk: '数据库引用存在但对象内容不可用。',
    suggestedAction: '停止覆盖或删除相关记录，先定位可验证副本。',
    recoveryPath: '从最近已验证备份恢复同一内容 hash 的对象。'
  }),
  OBJECT_HASH_MISMATCH: Object.freeze({
    risk: '对象内容与内容寻址 key 不一致，可能已损坏或被替换。',
    suggestedAction: '隔离异常对象并核对备份，禁止就地覆盖。',
    recoveryPath: '从已验证备份恢复匹配 hash 的对象，并保留异常副本用于调查。'
  }),
  OBJECT_METADATA_MISMATCH: Object.freeze({
    risk: '对象实际 hash 或大小与数据库元数据不一致。',
    suggestedAction: '核对对象与引用来源，人工选择恢复对象或修正元数据。',
    recoveryPath: '以已验证备份和内容 hash 为准恢复后重新巡检。'
  }),
  ORPHAN_OBJECT: Object.freeze({
    risk: '对象库存在未被有效业务记录引用的内容。',
    suggestedAction: '确认备份、迁移和任务均未引用后，再设计可恢复清理。',
    recoveryPath: '清理前移入带清单的隔离区，并保留回滚窗口。'
  }),
  STORAGE_METADATA_MISMATCH: Object.freeze({
    risk: '数据库中的 storage key、hash 或大小元数据彼此不一致。',
    suggestedAction: '核对当前对象和历史版本，人工修正引用关系。',
    recoveryPath: '从已验证备份恢复一致的元数据映射后重新巡检。'
  })
})

const DEFAULT_GUIDANCE = Object.freeze({
  risk: '检测到需要进一步确认的存储一致性异常。',
  suggestedAction: '保留现状并在隔离副本中确认原因。',
  recoveryPath: '从最近已验证备份恢复后重新巡检。'
})

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

async function createInspector() {
  const [{ getDatabase }, { getDocumentStorageRuntime }] = await Promise.all([
    import('../config/database.js'),
    import('../services/documentStorageRuntime.js')
  ])
  return new StorageConsistencyService({
    database: getDatabase(),
    storageService: getDocumentStorageRuntime().storageService,
    now: new Date(),
    stagingMaxAgeMs: 24 * 60 * 60 * 1000
  })
}

export function createOwnerConsistencySummary(result) {
  const bySeverity = {}
  const byDisposition = {}
  const issues = result.issues.map(value => {
    bySeverity[value.severity] = (bySeverity[value.severity] ?? 0) + 1
    byDisposition[value.disposition] = (byDisposition[value.disposition] ?? 0) + 1
    const guidance = ISSUE_GUIDANCE[value.code] ?? DEFAULT_GUIDANCE
    return Object.freeze({
      code: value.code,
      severity: value.severity,
      disposition: value.disposition,
      resourceType: value.resourceType,
      objectId: value.objectId,
      ...guidance
    })
  })
  return Object.freeze({
    inspectedAt: result.inspectedAt,
    counts: Object.freeze({
      total: result.issueCount,
      byCode: Object.freeze({ ...result.summary }),
      bySeverity: Object.freeze(bySeverity),
      byDisposition: Object.freeze(byDisposition)
    }),
    issues: Object.freeze(issues),
    repairExecutionAvailable: false,
    dispositions: CONSISTENCY_DISPOSITIONS
  })
}

export function createStorageConsistencyRouter({
  authenticate = defaultAuthenticate,
  authorize = defaultAuthorize,
  inspect = async () => (await createInspector()).inspect()
} = {}) {
  const router = express.Router()
  router.use(authenticate, authorize)
  router.get('/', async (req, res) => {
    try {
      res.json({ data: createOwnerConsistencySummary(await inspect()) })
    } catch (error) {
      console.error('[Storage consistency] inspection failed:', error?.code ?? 'UNKNOWN')
      res.status(500).json({
        message: '存储一致性巡检失败',
        code: 'STORAGE_CONSISTENCY_INSPECTION_FAILED'
      })
    }
  })
  return router
}

export default createStorageConsistencyRouter()
