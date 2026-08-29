import express from 'express'

import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { CacheKeys, cache } from '../utils/cache.js'
import { getDocumentStorageRuntime } from '../services/documentStorageRuntime.js'
import { getResourceStorageRuntime } from '../services/resourceStorageRuntime.js'
import { permanentlyDeleteDocument, restoreDocumentFromTrash } from '../services/documentTrashService.js'
import { permanentlyDeleteEbook, restoreEbookFromTrash } from '../services/ebookTrashService.js'
import { permanentlyDeleteMusic, restoreMusicFromTrash } from '../services/musicTrashService.js'
import { scheduleRagSourceRefresh } from '../services/ragLifecycleService.js'
import {
  listResourceTrash,
  normalizeResourceTrashSelection,
  ResourceTrashError
} from '../services/resourceTrashService.js'

const router = express.Router()

const PUBLIC_MESSAGES = Object.freeze({
  RESOURCE_TRASH_QUERY_INVALID: '回收站筛选条件无效',
  RESOURCE_TRASH_TYPE_UNSUPPORTED: '该资源类型尚未接入统一回收站',
  RESOURCE_TRASH_SELECTION_INVALID: '请选择有效的回收站条目',
  RESOURCE_TRASH_SELECTION_DUPLICATE: '批量选择中存在重复条目',
  DOCUMENT_TRASH_NOT_FOUND: '该文档已不在回收站中',
  EBOOK_TRASH_NOT_FOUND: '该电子书已不在回收站中',
  MUSIC_TRASH_NOT_FOUND: '该音频已不在回收站中',
  DOCUMENT_TRASH_PURGE_IN_PROGRESS: '该文档正在执行永久清理，无法恢复',
  EBOOK_TRASH_PURGE_IN_PROGRESS: '该电子书正在执行永久清理，无法恢复',
  MUSIC_TRASH_PURGE_IN_PROGRESS: '该音频正在执行永久清理，无法恢复',
  DOCUMENT_TRASH_LEGACY_MIGRATION_REQUIRED: '该文档仍使用旧存储，完成存储迁移后才能永久删除',
  EBOOK_TRASH_LEGACY_MIGRATION_REQUIRED: '该电子书仍使用旧存储，完成存储迁移后才能永久删除',
  MUSIC_TRASH_LEGACY_MIGRATION_REQUIRED: '该音频仍使用旧存储，完成存储迁移后才能永久删除'
})

function errorStatus(error) {
  const code = error?.code || ''
  if (code.endsWith('_NOT_FOUND') || code === 'DOCUMENT_NOT_FOUND' || code === 'EBOOK_NOT_FOUND' || code === 'MUSIC_NOT_FOUND') return 404
  if (code.includes('PURGE_IN_PROGRESS') || code.includes('MIGRATION_REQUIRED')) return 409
  if (error instanceof ResourceTrashError || code.endsWith('_ID_INVALID') || code.endsWith('_INPUT_INVALID')) return 400
  return 500
}

function publicError(error, fallback = '回收站操作失败') {
  const status = errorStatus(error)
  return Object.freeze({
    status,
    code: status === 500 ? 'RESOURCE_TRASH_OPERATION_FAILED' : error.code,
    message: status === 500 ? fallback : (PUBLIC_MESSAGES[error.code] || fallback)
  })
}

function sendTrashError(res, error, fallback) {
  const projected = publicError(error, fallback)
  if (projected.status === 500) console.error('[ResourceTrash]', error?.code || error?.name || 'UNKNOWN')
  return res.status(projected.status).json({ message: projected.message, code: projected.code })
}

async function invalidateResourceCaches(resourceType) {
  if (resourceType === 'ebook') await cache.del(CacheKeys.BOOK_CATEGORIES)
  if (resourceType === 'music') {
    await Promise.all([
      cache.del(CacheKeys.MUSIC_ARTISTS),
      cache.del(CacheKeys.MUSIC_ALBUMS),
      cache.del(CacheKeys.MUSIC_PLAYLISTS)
    ])
  }
}

async function scheduleRestoreIndex(database, resourceType, resourceId) {
  if (!['document', 'ebook'].includes(resourceType)) return null
  try {
    await scheduleRagSourceRefresh({
      database,
      sourceType: resourceType,
      sourceId: resourceId,
      reasonCode: 'RAG_SOURCE_RESTORED'
    })
    return null
  } catch (error) {
    console.error('[ResourceTrash] restored resource index refresh failed:', error?.code || error?.name || 'UNKNOWN')
    return 'RESOURCE_RESTORED_INDEX_REFRESH_FAILED'
  }
}

async function restoreItem({ database, resourceType, resourceId }) {
  let result
  if (resourceType === 'document') {
    result = restoreDocumentFromTrash({ database, id: resourceId })
  } else if (resourceType === 'ebook') {
    result = restoreEbookFromTrash({ database, id: resourceId })
  } else if (resourceType === 'music') {
    result = restoreMusicFromTrash({ database, id: resourceId })
  } else {
    throw new ResourceTrashError('RESOURCE_TRASH_TYPE_UNSUPPORTED', 'Resource trash type is unsupported.')
  }
  await invalidateResourceCaches(resourceType)
  const warningCode = await scheduleRestoreIndex(database, resourceType, resourceId)
  return Object.freeze({ resourceType, resourceId, result, warningCode })
}

async function permanentlyDeleteItem({ database, resourceType, resourceId }) {
  let result
  if (resourceType === 'document') {
    result = await permanentlyDeleteDocument({
      database,
      storageService: getDocumentStorageRuntime().storageService,
      id: resourceId
    })
  } else if (resourceType === 'ebook') {
    result = await permanentlyDeleteEbook({
      database,
      storageService: getResourceStorageRuntime().storageService,
      id: resourceId
    })
  } else if (resourceType === 'music') {
    result = await permanentlyDeleteMusic({
      database,
      storageService: getResourceStorageRuntime().storageService,
      id: resourceId
    })
  } else {
    throw new ResourceTrashError('RESOURCE_TRASH_TYPE_UNSUPPORTED', 'Resource trash type is unsupported.')
  }
  await invalidateResourceCaches(resourceType)
  return Object.freeze({ resourceType, resourceId, result })
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      data: listResourceTrash({
        database: getDatabase(),
        filters: req.query
      })
    })
  } catch (error) {
    return sendTrashError(res, error, '加载统一回收站失败')
  }
})

router.post('/batch-restore', authenticateToken, requireWritePermission, async (req, res) => {
  let selection
  try {
    selection = normalizeResourceTrashSelection(req.body?.items)
  } catch (error) {
    return sendTrashError(res, error, '批量恢复选择无效')
  }

  const database = getDatabase()
  const results = []
  for (const item of selection) {
    try {
      const restored = await restoreItem({ database, ...item })
      results.push({ ...item, success: true, warningCode: restored.warningCode })
    } catch (error) {
      const projected = publicError(error, '恢复失败')
      results.push({ ...item, success: false, code: projected.code, message: projected.message })
    }
  }

  const succeeded = results.filter((item) => item.success).length
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    data: {
      results,
      summary: { requested: results.length, succeeded, failed: results.length - succeeded }
    },
    message: succeeded === results.length ? '批量恢复成功' : '批量恢复已完成，部分条目需要处理'
  })
})

router.post('/:type/:id/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const [item] = normalizeResourceTrashSelection([{
      resourceType: req.params.type,
      resourceId: req.params.id
    }], { maximum: 1 })
    const data = await restoreItem({ database: getDatabase(), ...item })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data, message: data.warningCode ? '资源已恢复，索引刷新将在稍后重试' : '资源已恢复' })
  } catch (error) {
    return sendTrashError(res, error, '恢复资源失败')
  }
})

router.delete('/:type/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const [item] = normalizeResourceTrashSelection([{
      resourceType: req.params.type,
      resourceId: req.params.id
    }], { maximum: 1 })
    const data = await permanentlyDeleteItem({ database: getDatabase(), ...item })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data, message: '资源已永久删除' })
  } catch (error) {
    return sendTrashError(res, error, '永久删除资源失败')
  }
})

export default router
