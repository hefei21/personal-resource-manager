import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import {
  bookmarkUrl,
  bookmarkForm,
  bookmarkTags,
  getBookmark,
  listBookmarks,
  saveBookmark,
  trashBookmarks,
  restoreBookmarkFromTrash,
  permanentlyDeleteBookmark,
  previewBookmarkImport,
  importBookmarks,
  exportBookmarks,
  bookmarkMetadata,
} from '../src/services/bookmarkService.js'
import {
  createBookmarkInspector,
  bookmarkSourceHash,
} from '../src/services/bookmarkInspectTask.js'
import { OutboundRequestError } from '../src/services/outboundRequest.js'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import {
  enqueueExclusiveRun,
  getTaskById,
  listTasks,
} from '../src/services/taskStore.js'
import { projectTask } from '../src/services/taskTypeCatalog.js'

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(
    `CREATE TABLE bookmarks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,url TEXT,category TEXT,tags TEXT,description TEXT,icon TEXT,icon_data TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`,
  )
  db.exec(CREATE_RESOURCE_TRASH_SQL)
  return db
}
const input = {
  title: '工具站',
  url: 'https://example.com/',
  category: '工具',
  tags: ['开发', ' ＡＩ ', 'AI'],
  description: '工具备注',
}
test('URL validation allows stored LAN links but rejects active schemes and credentials', () => {
  assert.equal(bookmarkUrl('example.com'), 'https://example.com/')
  assert.equal(
    bookmarkUrl('http://192.168.1.2:8080'),
    'http://192.168.1.2:8080/',
  )
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    '',
  ])
    assert.throws(() => bookmarkUrl(url))
  assert.equal(
    bookmarkForm({ ...input, iconData: 'data:image/svg+xml;base64,PHN2Zz4=' })
      .icon_data,
    null,
  )
  assert.deepEqual(bookmarkTags(input.tags), ['开发', 'AI'])
})
test('exact tags, literal search, bounded stable pagination and duplicate consent', (t) => {
  const db = fixture(t),
    a = saveBookmark(db, input)
  saveBookmark(db, {
    ...input,
    url: 'https://example.org',
    title: '100% 站点',
    tags: ['开发者'],
  })
  assert.equal(listBookmarks(db, { tag: '开发' }).total, 1)
  assert.equal(listBookmarks(db, { keyword: '%' }).total, 1)
  assert.equal(listBookmarks(db, { page: 2, pageSize: 1 }).data.length, 1)
  assert.throws(() => listBookmarks(db, { pageSize: 10000 }))
  assert.throws(
    () => saveBookmark(db, input),
    (e) => e.status === 409 && e.details.duplicates[0].id === a.id,
  )
  assert.equal(saveBookmark(db, { ...input, allowDuplicate: true }).id, 3)
})
test('updates require current version and keep all local/server fields on conflict', (t) => {
  const db = fixture(t),
    a = saveBookmark(db, input),
    b = saveBookmark(
      db,
      { ...input, title: '另一端', baseVersion: a.version },
      a.id,
    )
  assert.notEqual(a.version, b.version)
  assert.throws(
    () =>
      saveBookmark(
        db,
        { ...input, title: '过期', baseVersion: a.version },
        a.id,
      ),
    (e) => e.status === 409 && e.details.current.title === '另一端',
  )
  assert.equal(getBookmark(db, a.id).title, '另一端')
})
test('trash excludes list metadata/export and preserves fields through restore; batches are atomic', (t) => {
  const db = fixture(t),
    a = saveBookmark(db, input)
  assert.throws(() => trashBookmarks(db, [a.id, 999]))
  assert.equal(listBookmarks(db).total, 1)
  trashBookmarks(db, [a.id])
  assert.equal(listBookmarks(db).total, 0)
  assert.equal(bookmarkMetadata(db).tags.length, 0)
  assert.equal(exportBookmarks(db).bookmarks.length, 0)
  restoreBookmarkFromTrash({ database: db, id: a.id })
  assert.deepEqual(getBookmark(db, a.id).tags, ['开发', 'AI'])
  assert.throws(() => permanentlyDeleteBookmark({ database: db, id: a.id }))
  trashBookmarks(db, [a.id])
  permanentlyDeleteBookmark({ database: db, id: a.id })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookmarks').get().n, 0)
})
test('HTML/JSON preview is inert, identifies invalid/duplicate rows; confirmed import is atomic and retry safe', (t) => {
  const db = fixture(t)
  saveBookmark(db, input)
  const preview = previewBookmarkImport(
    db,
    '<DL><DT><H3>工作</H3><DL><DT><A HREF="https://other.example/" TAGS="甲,乙">A &amp; B</A><DT><A HREF="javascript:alert(1)">bad</A><DT><A HREF="https://example.com">dup</A></DL></DL>',
    'html',
  )
  assert.equal(preview[0].form.title, 'A & B')
  assert.equal(preview[0].form.category, '工作')
  assert.ok(preview[1].error)
  assert.equal(preview[2].duplicate, true)
  assert.deepEqual(importBookmarks(db, [preview[0].form]), {
    imported: 1,
    skipped: 0,
  })
  assert.deepEqual(importBookmarks(db, [preview[0].form]), {
    imported: 0,
    skipped: 1,
  })
  assert.throws(() =>
    importBookmarks(db, [
      { ...input, url: 'https://atomic.example' },
      { ...input, url: 'file:///bad' },
    ]),
  )
  assert.equal(listBookmarks(db).total, 2)
  assert.equal(
    previewBookmarkImport(
      db,
      JSON.stringify(exportBookmarks(db)),
      'json',
    ).filter((r) => r.duplicate).length,
    2,
  )
})
test('inspection is read-only, abortable, source-bound and treats auth failures as restricted', async (t) => {
  const db = fixture(t),
    a = saveBookmark(db, input),
    task = {
      subjectId: String(a.id),
      input: { bookmarkId: a.id, sourceHash: bookmarkSourceHash(a.url) },
    }
  const inspector = createBookmarkInspector({
    databaseProvider: () => db,
    fetch: async () => ({ status: 403, headers: {}, data: '' }),
  })
  assert.equal(
    (await inspector({ task, signal: new AbortController().signal })).status,
    'restricted',
  )
  const blocked = createBookmarkInspector({
    databaseProvider: () => db,
    fetch: async () => {
      throw new OutboundRequestError('blocked', 'OUTBOUND_IP_FORBIDDEN')
    },
  })
  assert.equal((await blocked({ task })).status, 'blocked')
  assert.equal(getBookmark(db, a.id).title, input.title)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(inspector({ task, signal: controller.signal }))
  const stale = createBookmarkInspector({
    databaseProvider: () => db,
    fetch: async () => {
      db.prepare('UPDATE bookmarks SET url=? WHERE id=?').run(
        'https://changed.example/',
        a.id,
      )
      return { status: 200, headers: {}, data: '' }
    },
  })
  await assert.rejects(stale({ task }), /BOOKMARK_SOURCE_CHANGED/)
})
test('metadata extraction decodes title and bounds local icon suggestion without saving it', async (t) => {
  const db = fixture(t),
    a = saveBookmark(db, input)
  const run = createBookmarkInspector({
    databaseProvider: () => db,
    fetch: async (url) =>
      url.endsWith('.ico')
        ? {
            headers: { 'content-type': 'image/png' },
            data: Buffer.from('icon'),
          }
        : {
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: '<title>Safe &amp; title</title><meta name="description" content="Hello">',
            safeFinalUrl: a.url,
          },
  })
  const result = await run({
    task: {
      subjectId: String(a.id),
      input: { bookmarkId: a.id, sourceHash: bookmarkSourceHash(a.url) },
    },
  })
  assert.equal(result.title, 'Safe & title')
  assert.ok(result.iconData.startsWith('data:image/png;'))
  assert.equal(getBookmark(db, a.id).icon_data, null)
})

test('inspection tasks are durable, exclusive, source-bound and privately projected', async (t) => {
  const db = fixture(t)
  db.exec(CREATE_TASK_SCHEMA_SQL)
  const bookmark = saveBookmark(db, input)
  const identity = (run) => ({
    taskType: 'bookmark.inspect',
    processorVersion: 'v1',
    executionClass: 'network',
    subjectType: 'bookmark',
    subjectId: String(bookmark.id),
    subjectVersionId: run,
    input: {
      bookmarkId: bookmark.id,
      sourceHash: bookmarkSourceHash(bookmark.url),
    },
    maxAttempts: 1,
  })
  const first = enqueueExclusiveRun(db, identity('first'), {
    taskTypes: ['bookmark.inspect'],
  })
  const repeated = enqueueExclusiveRun(db, identity('second'), {
    taskTypes: ['bookmark.inspect'],
  })
  assert.equal(repeated.task.id, first.task.id)
  assert.equal(repeated.activeConflict, true)
  const inspect = createBookmarkInspector({
    databaseProvider: () => db,
    fetch: async () => ({ status: 403, headers: {}, data: '' }),
  })
  const result = await inspect({ task: getTaskById(db, first.task.id) })
  db.prepare(
    "UPDATE tasks SET status='succeeded',result_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(JSON.stringify(result), first.task.id)
  const persisted = listTasks(db, {
    taskType: 'bookmark.inspect',
    subjectType: 'bookmark',
    subjectId: String(bookmark.id),
    limit: 1,
    order: 'desc',
  })[0]
  assert.deepEqual(persisted.result, result)
  const projected = projectTask(persisted)
  assert.deepEqual(projected.input, { bookmarkId: bookmark.id })
  assert.equal(projected.result.status, 'restricted')
  assert.ok(!JSON.stringify(projected).includes(result.sourceHash))
  assert.ok(!JSON.stringify(projected).includes(bookmark.url))
  assert.equal(
    enqueueExclusiveRun(db, identity('third'), {
      taskTypes: ['bookmark.inspect'],
    }).created,
    true,
  )
})
