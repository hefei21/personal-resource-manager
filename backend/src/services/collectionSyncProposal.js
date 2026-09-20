import { createHash } from 'node:crypto'
import { CollectionError, activeCollectionSql } from './collectionService.js'

const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const animeSourceFields = {
  title: 'title',
  nameCn: 'name_cn',
  nameOriginal: 'name_original',
  summary: 'summary',
  coverImageUrl: 'cover_image',
  coverImageData: 'cover_image_data',
  rating: 'rating',
  ratingCount: 'rating_count',
  tags: 'tags',
  airDate: 'air_date',
  eps: 'eps',
  epsTotal: 'eps_total',
  author: 'author',
  director: 'director',
  studio: 'studio',
  infobox: 'infobox',
  characters: 'characters',
  staff: 'staff',
}
export function steamSourceSnapshot(db) {
  return hash([
    db.prepare('SELECT steam_id, api_key FROM steam_config WHERE id=1').get() ||
      null,
    db
      .prepare(
        'SELECT id,steam_appid,title,playtime_forever,playtime_2weeks,last_played FROM games ORDER BY id',
      )
      .all(),
    db
      .prepare(
        "SELECT resource_id,deleted_at FROM resource_trash_entries WHERE resource_type='game' ORDER BY resource_id",
      )
      .all(),
  ])
}
export function animeSourceSnapshot(db, id) {
  const row = db
    .prepare(
      `SELECT c.* FROM anime c WHERE c.id=? AND ${activeCollectionSql('anime')}`,
    )
    .get(id)
  if (!row) throw new CollectionError(404, '动漫不存在或已移入回收站')
  return hash([
    row.bangumi_id,
    ...Object.values(animeSourceFields).map((key) => row[key] ?? null),
  ])
}
function taskProposal(db, kind, taskId, animeId) {
  const type = kind === 'game' ? 'games.steam.sync' : 'anime.bangumi.refresh'
  const task = db
    .prepare('SELECT * FROM tasks WHERE id=? AND task_type=?')
    .get(taskId, type)
  if (
    !task ||
    task.processor_version !== 'v1' ||
    task.subject_type !== (kind === 'game' ? 'game-library' : 'anime') ||
    task.subject_id !== (kind === 'game' ? 'owner' : String(animeId))
  )
    throw new CollectionError(404, '同步任务不存在')
  if (task.status !== 'succeeded')
    throw new CollectionError(409, '候选尚未准备好')
  const result = JSON.parse(task.result_json || '{}')
  if (result.proposalVersion !== 1)
    throw new CollectionError(409, '旧任务没有可确认的候选，请重新获取')
  return { task, result }
}
export function getSyncProposal(db, kind, taskId, animeId) {
  const { result } = taskProposal(db, kind, taskId, animeId)
  if (kind === 'game') {
    const existing = new Map(
      db
        .prepare(
          `SELECT c.steam_appid,c.title,c.playtime_forever,c.playtime_2weeks,c.last_played,NOT (${activeCollectionSql('game')}) archived FROM games c`,
        )
        .all()
        .map((row) => [row.steam_appid, row]),
    )
    const items = result.games.map((game) => {
      const previous = existing.get(game.appid)
      const action = previous?.archived
        ? 'skipped'
        : !previous
          ? 'added'
          : previous.playtime_forever !== game.playtime_forever ||
              previous.playtime_2weeks !== game.playtime_2weeks ||
              previous.last_played !== game.last_played
            ? 'updated'
            : 'unchanged'
      return {
        appid: game.appid,
        title: previous?.title || game.name,
        action,
        before: previous?.playtime_forever ?? null,
        after: game.playtime_forever,
      }
    })
    return {
      taskId: Number(taskId),
      applied: Boolean(result.appliedAt),
      items,
      counts: Object.fromEntries(
        ['added', 'updated', 'skipped', 'unchanged'].map((key) => [
          key,
          items.filter((row) => row.action === key).length,
        ]),
      ),
    }
  }
  const current = db.prepare('SELECT * FROM anime WHERE id=?').get(animeId)
  if (!current) throw new CollectionError(404, '动漫不存在')
  const items = Object.entries(animeSourceFields)
    .filter(
      ([key, column]) =>
        key !== 'coverImageData' &&
        (current[column] ?? null) !== (result.values[key] ?? null),
    )
    .map(([key, column]) => ({
      field: column,
      before: current[column] ?? '',
      after: result.values[key] ?? '',
    }))
  return { taskId: Number(taskId), applied: Boolean(result.appliedAt), items }
}
export function applySyncProposal(db, kind, taskId, animeId) {
  return db.transaction(() => {
    const { result } = taskProposal(db, kind, taskId, animeId)
    if (result.appliedAt) return { alreadyApplied: true }
    const current =
      kind === 'game'
        ? steamSourceSnapshot(db)
        : animeSourceSnapshot(db, animeId)
    if (current !== result.baseSnapshot)
      throw new CollectionError(
        409,
        '本地来源数据或配置已变化，请重新获取候选再确认',
      )
    if (kind === 'game') {
      const existing = db.prepare('SELECT id FROM games WHERE steam_appid=?')
      const trashed = db.prepare(
        "SELECT 1 FROM resource_trash_entries WHERE resource_type='game' AND resource_id=?",
      )
      for (const game of result.games) {
        const row = existing.get(game.appid)
        if (row && trashed.get(row.id)) continue
        if (row)
          db.prepare(
            'UPDATE games SET playtime_forever=?,playtime_2weeks=?,last_played=? WHERE id=?',
          ).run(
            game.playtime_forever,
            game.playtime_2weeks,
            game.last_played,
            row.id,
          )
        else
          db.prepare(
            'INSERT INTO games(steam_appid,title,cover_image,playtime_forever,playtime_2weeks,last_played) VALUES(?,?,?,?,?,?)',
          ).run(
            game.appid,
            game.name,
            `https://steamcdn-a.akamaihd.net/steam/apps/${game.appid}/library_600x900.jpg`,
            game.playtime_forever,
            game.playtime_2weeks,
            game.last_played,
          )
      }
      db.prepare(
        'UPDATE steam_config SET last_sync=CURRENT_TIMESTAMP WHERE id=1',
      ).run()
    } else {
      const entries = Object.entries(animeSourceFields)
      // A failed optional cover download never erases the last usable cached cover.
      db.prepare(
        `UPDATE anime SET ${entries.map(([key, column]) => (column === 'cover_image_data' ? `${column}=COALESCE(?,${column})` : `${column}=?`)).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).run(...entries.map(([key]) => result.values[key] ?? null), animeId)
    }
    result.appliedAt = new Date().toISOString()
    db.prepare(
      "UPDATE tasks SET result_json=? WHERE id=? AND status='succeeded'",
    ).run(JSON.stringify(result), taskId)
    return { applied: true }
  })()
}
