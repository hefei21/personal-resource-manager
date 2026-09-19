import express from 'express'
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireOwner } from '../middlewares/auth.js'
import {
  BookmarkError,
  listBookmarks,
  getBookmark,
  saveBookmark,
  trashBookmarks,
  bookmarkMetadata,
  previewBookmarkImport,
  importBookmarks,
  exportBookmarks,
  duplicateBookmarks,
} from '../services/bookmarkService.js'
import {
  enqueueExclusiveRun,
  getTaskById,
  listTasks,
} from '../services/taskStore.js'
import { registerTaskProcessor } from '../services/taskRuntime.js'
import {
  BOOKMARK_INSPECT_TASK,
  bookmarkSourceHash,
  createBookmarkInspector,
} from '../services/bookmarkInspectTask.js'

const router = express.Router()
router.use(authenticateToken, requireOwner)
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})
const handle = (fn) => (req, res) => {
  try {
    const data = fn(getDatabase(), req)
    res.json(data)
  } catch (error) {
    const known = error instanceof BookmarkError
    if (!known) console.error('[Bookmarks]', error.code || error.name)
    res
      .status(known ? error.status : 500)
      .json({
        message: known ? error.message : '书签操作失败，请重试',
        ...(known ? error.details : {}),
      })
  }
}
router.get(
  '/',
  handle((db, req) => listBookmarks(db, req.query)),
)
router.get(
  '/metadata',
  handle((db) => ({ data: bookmarkMetadata(db) })),
)
router.get(
  '/tags',
  handle((db) => ({ data: bookmarkMetadata(db).tags.map((t) => t.name) })),
)
router.get(
  '/duplicates',
  handle((db, req) => ({
    data: duplicateBookmarks(db, req.query.url, Number(req.query.exclude) || 0),
  })),
)
router.get(
  '/export',
  handle((db) => ({ data: exportBookmarks(db) })),
)
router.post(
  '/import-preview',
  handle((db, req) => ({
    data: previewBookmarkImport(db, req.body.content, req.body.format),
  })),
)
router.post(
  '/import',
  handle((db, req) => ({ data: importBookmarks(db, req.body.items) })),
)
// Legacy network endpoints no longer issue requests on blur or batch across the library.
router.get('/fetch-title', (_req, res) =>
  res.status(410).json({ message: '请先保存书签，再主动获取网站信息' }),
)
router.post('/batch-download-icons', (_req, res) =>
  res.status(410).json({ message: '请在单项详情中主动获取网站信息' }),
)
router.post(
  '/batch-delete',
  handle((db, req) => ({ data: trashBookmarks(db, req.body.ids) })),
)
router.get(
  '/:id',
  handle((db, req) => ({ data: getBookmark(db, req.params.id) })),
)
router.get(
  '/:id/inspection',
  handle((db, req) => {
    const bookmark = getBookmark(db, req.params.id),
      task = listTasks(db, {
        taskType: BOOKMARK_INSPECT_TASK,
        subjectType: 'bookmark',
        subjectId: String(bookmark.id),
        limit: 1,
        order: 'desc',
      })[0]
    if (!task || task.input.sourceHash !== bookmarkSourceHash(bookmark.url))
      return { data: null }
    return {
      data: {
        taskId: task.id,
        status: task.status,
        result: task.status === 'succeeded' ? task.result : null,
      },
    }
  }),
)
router.post(
  '/',
  handle((db, req) => ({ data: saveBookmark(db, req.body) })),
)
router.put(
  '/:id',
  handle((db, req) => ({ data: saveBookmark(db, req.body, req.params.id) })),
)
router.delete(
  '/:id',
  handle((db, req) => ({ data: trashBookmarks(db, [Number(req.params.id)]) })),
)
router.post(
  '/:id/inspect',
  handle((db, req) => {
    const bookmark = getBookmark(db, req.params.id)
    const outcome = enqueueExclusiveRun(
      db,
      {
        taskType: BOOKMARK_INSPECT_TASK,
        processorVersion: 'v1',
        subjectType: 'bookmark',
        subjectId: String(bookmark.id),
        subjectVersionId: randomUUID(),
        executionClass: 'network',
        input: {
          bookmarkId: bookmark.id,
          sourceHash: bookmarkSourceHash(bookmark.url),
        },
        maxAttempts: 1,
      },
      { taskTypes: [BOOKMARK_INSPECT_TASK] },
    )
    return { data: { taskId: outcome.task.id, status: outcome.task.status } }
  }),
)
router.get(
  '/:id/inspect/:taskId',
  handle((db, req) => {
    const bookmark = getBookmark(db, req.params.id),
      task = getTaskById(db, req.params.taskId)
    if (
      !task ||
      task.taskType !== BOOKMARK_INSPECT_TASK ||
      task.subjectId !== String(bookmark.id)
    )
      throw new BookmarkError(404, '检测任务不存在')
    if (task.input.sourceHash !== bookmarkSourceHash(bookmark.url))
      throw new BookmarkError(409, '链接已修改，请重新检测')
    return {
      data: {
        taskId: task.id,
        status: task.status,
        result: task.status === 'succeeded' ? task.result : null,
      },
    }
  }),
)
registerTaskProcessor(
  BOOKMARK_INSPECT_TASK,
  'v1',
  'network',
  createBookmarkInspector({ databaseProvider: getDatabase }),
)
export default router
