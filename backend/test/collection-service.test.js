import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { enqueueTask } from '../src/services/taskStore.js'
import {
  getCollectionItem,
  listCollection,
  saveCollectionPersonal,
  trashCollectionItem,
  restoreCollectionItem,
} from '../src/services/collectionService.js'
import {
  steamSourceSnapshot,
  animeSourceSnapshot,
  getSyncProposal,
  applySyncProposal,
  animeSourceFields,
} from '../src/services/collectionSyncProposal.js'

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys = ON')
  const source = readFileSync(
    new URL('../src/config/database.js', import.meta.url),
    'utf8',
  )
  for (const table of ['games', 'anime', 'steam_config', 'game_achievements']) {
    const sql = source.match(
      new RegExp(
        '`(CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\))`',
      ),
    )?.[1]
    assert.ok(sql, `actual schema for ${table}`)
    db.exec(sql)
  }
  db.exec(
    "CREATE TABLE resource_trash_entries(resource_type TEXT,resource_id INTEGER,deleted_at TEXT,purge_after TEXT,metadata_json TEXT,PRIMARY KEY(resource_type,resource_id)); INSERT INTO steam_config(id,steam_id,api_key) VALUES(1,'synthetic-id','synthetic-key'); INSERT INTO games(steam_appid,title,playtime_forever) VALUES(10,'Alpha',60),(20,'Beta',120); INSERT INTO anime(bangumi_id,title,name_cn) VALUES(1,'Anime A','作品甲'),(2,'Anime B','作品乙')",
  )
  db.exec(CREATE_TASK_SCHEMA_SQL)
  return db
}
function proposal(db, kind, result, subject = 1) {
  const task = enqueueTask(db, {
    taskType: kind === 'game' ? 'games.steam.sync' : 'anime.bangumi.refresh',
    processorVersion: 'v1',
    executionClass: 'network',
    subjectType: kind === 'game' ? 'game-library' : 'anime',
    subjectId: kind === 'game' ? 'owner' : String(subject),
    subjectVersionId: String(Math.random()),
    input: kind === 'game' ? {} : { animeId: subject },
  }).task
  db.prepare(
    "UPDATE tasks SET status='succeeded',result_json=? WHERE id=?",
  ).run(JSON.stringify({ proposalVersion: 1, ...result }), task.id)
  return task.id
}
test('collections paginate deterministically, honor sorting and reject invalid filters', (t) => {
  const db = fixture(t)
  assert.equal(
    listCollection(db, 'game', {
      sortBy: 'title',
      sortOrder: 'ASC',
      pageSize: 1,
    }).data[0].title,
    'Alpha',
  )
  assert.equal(
    listCollection(db, 'game', { sortBy: 'playtime_forever', pageSize: 1 })
      .data[0].title,
    'Beta',
  )
  assert.equal(listCollection(db, 'anime', { keyword: '作品甲' }).total, 1)
  for (const query of [
    { page: -1 },
    { pageSize: 1000 },
    { page: 1.2 },
    { status: 'unsupported' },
  ])
    assert.throws(
      () => listCollection(db, 'game', query),
      (e) => e.status === 400,
    )
  assert.equal(listCollection(db, 'anime', { keyword: '%' }).total, 0)
})
test('personal state merges partial fields and rejects stale/invalid cross-device writes', (t) => {
  const db = fixture(t),
    original = getCollectionItem(db, 'game', 1)
  assert.throws(
    () => saveCollectionPersonal(db, 'game', 1, { status: 'playing' }),
    (e) => e.status === 428,
  )
  const saved = saveCollectionPersonal(db, 'game', 1, {
    baseVersion: original.version,
    status: 'playing',
    userRating: 8.5,
    notes: 'Keep this',
  })
  assert.throws(
    () =>
      saveCollectionPersonal(db, 'game', 1, {
        baseVersion: original.version,
        status: 'played',
      }),
    (e) => e.status === 409,
  )
  const next = saveCollectionPersonal(db, 'game', 1, {
    baseVersion: saved.version,
    isFavorite: true,
  })
  assert.equal(next.notes, 'Keep this')
  assert.equal(next.user_rating, 8.5)
  assert.equal(next.status, 'playing')
  for (const input of [
    { userRating: NaN },
    { userRating: Infinity },
    { userRating: 11 },
    { userRating: 2.3 },
    { isFavorite: 'true' },
    { status: 'watching' },
    { notes: 'x'.repeat(5001) },
  ])
    assert.throws(
      () =>
        saveCollectionPersonal(db, 'game', 1, {
          baseVersion: next.version,
          ...input,
        }),
      (e) => e.status === 400,
    )
})
test('trash retains metadata and personal state, restores both kinds, purges only explicit trash', (t) => {
  const db = fixture(t)
  for (const kind of ['game', 'anime']) {
    const row = getCollectionItem(db, kind, 1)
    trashCollectionItem(db, kind, 1, { baseVersion: row.version })
    assert.equal(listCollection(db, kind).total, 1)
    assert.throws(
      () => getCollectionItem(db, kind, 1),
      (e) => e.status === 404,
    )
    assert.throws(
      () =>
        saveCollectionPersonal(db, kind, 1, {
          baseVersion: row.version,
          isFavorite: true,
        }),
      (e) => e.status === 404,
    )
    restoreCollectionItem({ database: db, resourceType: kind, id: 1 })
    assert.equal(getCollectionItem(db, kind, 1).version, row.version)
    assert.throws(
      () =>
        restoreCollectionItem({
          database: db,
          resourceType: kind,
          id: 1,
          purge: true,
        }),
      (e) => e.code === 'COLLECTION_TRASH_NOT_FOUND',
    )
    trashCollectionItem(db, kind, 1, { baseVersion: row.version })
    restoreCollectionItem({
      database: db,
      resourceType: kind,
      id: 1,
      purge: true,
    })
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) n FROM ${kind === 'game' ? 'games' : 'anime'} WHERE id=1`,
        )
        .get().n,
      0,
    )
  }
})
test('Steam proposal is explicit, idempotent, preserves personal records and skips archived games', (t) => {
  const db = fixture(t),
    old = getCollectionItem(db, 'game', 1),
    archived = getCollectionItem(db, 'game', 2)
  trashCollectionItem(db, 'game', 2, { baseVersion: archived.version })
  const games = [
    {
      appid: 10,
      name: 'Provider title',
      playtime_forever: 360,
      playtime_2weeks: 60,
      last_played: null,
    },
    {
      appid: 20,
      name: 'Archived',
      playtime_forever: 500,
      playtime_2weeks: 50,
      last_played: null,
    },
    {
      appid: 30,
      name: 'New game',
      playtime_forever: 0,
      playtime_2weeks: 0,
      last_played: null,
    },
  ]
  const id = proposal(db, 'game', {
    baseSnapshot: steamSourceSnapshot(db),
    games,
  })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM games').get().n, 2)
  assert.deepEqual(getSyncProposal(db, 'game', id).counts, {
    added: 1,
    updated: 1,
    skipped: 1,
    unchanged: 0,
  })
  saveCollectionPersonal(db, 'game', 1, {
    baseVersion: old.version,
    status: 'playing',
    notes: 'Personal',
    userRating: 9,
  })
  applySyncProposal(db, 'game', id)
  assert.deepEqual(applySyncProposal(db, 'game', id), { alreadyApplied: true })
  const row = getCollectionItem(db, 'game', 1)
  assert.equal(row.title, 'Alpha')
  assert.equal(row.playtime_forever, 360)
  assert.equal(row.notes, 'Personal')
  assert.equal(row.user_rating, 9)
  assert.equal(
    db.prepare('SELECT playtime_forever FROM games WHERE id=2').get()
      .playtime_forever,
    120,
  )
  assert.equal(listCollection(db, 'game').total, 2)
})
test('source changes invalidate stale proposals, empty Steam results never delete anything', (t) => {
  const db = fixture(t),
    id = proposal(db, 'game', {
      baseSnapshot: steamSourceSnapshot(db),
      games: [],
    })
  applySyncProposal(db, 'game', id)
  assert.equal(listCollection(db, 'game').total, 2)
  const stale = proposal(db, 'game', {
    baseSnapshot: steamSourceSnapshot(db),
    games: [],
  })
  db.prepare("UPDATE steam_config SET api_key='changed' WHERE id=1").run()
  assert.throws(
    () => applySyncProposal(db, 'game', stale),
    (e) => e.status === 409,
  )
  assert.throws(
    () => getSyncProposal(db, 'anime', stale, 1),
    (e) => e.status === 404,
  )
})
test('Bangumi candidate applies source-only changes, guards subject and trash, keeps cached cover', (t) => {
  const db = fixture(t)
  db.prepare("UPDATE anime SET cover_image_data='cached' WHERE id=1").run()
  const values = Object.fromEntries(
    Object.keys(animeSourceFields).map((key) => [key, null]),
  )
  values.title = 'Updated'
  values.nameCn = '更新标题'
  const id = proposal(db, 'anime', {
    baseSnapshot: animeSourceSnapshot(db, 1),
    values,
  })
  const row = getCollectionItem(db, 'anime', 1)
  saveCollectionPersonal(db, 'anime', 1, {
    baseVersion: row.version,
    status: 'on_hold',
    userRating: 8,
  })
  assert.throws(
    () => getSyncProposal(db, 'anime', id, 2),
    (e) => e.status === 404,
  )
  applySyncProposal(db, 'anime', id, 1)
  assert.equal(getCollectionItem(db, 'anime', 1).status, 'on_hold')
  assert.equal(getCollectionItem(db, 'anime', 1).user_rating, 8)
  assert.equal(getCollectionItem(db, 'anime', 1).cover_image_data, 'cached')
  const next = proposal(db, 'anime', {
    baseSnapshot: animeSourceSnapshot(db, 1),
    values,
  })
  trashCollectionItem(db, 'anime', 1, {
    baseVersion: getCollectionItem(db, 'anime', 1).version,
  })
  assert.throws(
    () => applySyncProposal(db, 'anime', next, 1),
    (e) => e.status === 404,
  )
})
test('proposal confirmation rolls back all writes and receipt on database failure', (t) => {
  const db = fixture(t)
  const id = proposal(db, 'game', {
    baseSnapshot: steamSourceSnapshot(db),
    games: [
      {
        appid: 10,
        name: 'Alpha',
        playtime_forever: 100,
        playtime_2weeks: 0,
        last_played: null,
      },
      {
        appid: 30,
        name: 'New',
        playtime_forever: 0,
        playtime_2weeks: 0,
        last_played: null,
      },
    ],
  })
  db.exec(
    "CREATE TRIGGER reject_game BEFORE INSERT ON games BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  )
  assert.throws(() => applySyncProposal(db, 'game', id))
  assert.equal(getCollectionItem(db, 'game', 1).playtime_forever, 60)
  assert.equal(getSyncProposal(db, 'game', id).applied, false)
})
