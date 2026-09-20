import { createHash } from 'node:crypto'

const kinds = {
  game: {
    table: 'games',
    statuses: ['unplayed', 'playing', 'played', 'dropped', 'wishlist'],
    sorts: [
      'title',
      'updated_at',
      'created_at',
      'playtime_forever',
      'playtime_2weeks',
      'last_played',
      'user_rating',
    ],
  },
  anime: {
    table: 'anime',
    statuses: ['none', 'want_to_watch', 'watching', 'watched', 'on_hold'],
    sorts: [
      'title',
      'updated_at',
      'created_at',
      'air_date',
      'rating',
      'user_rating',
      'status',
    ],
  },
}
export class CollectionError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
function definition(kind) {
  if (!kinds[kind]) throw new CollectionError(400, '资源类型无效')
  return kinds[kind]
}
export function activeCollectionSql(kind, alias = 'c') {
  definition(kind)
  return `NOT EXISTS (SELECT 1 FROM resource_trash_entries t WHERE t.resource_type='${kind}' AND t.resource_id=${alias}.id)`
}
export const personalVersion = (row) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        row.status,
        Number(row.is_favorite || 0),
        Number(row.user_rating || 0),
        row.notes || '',
        Number(row.is_hidden || 0),
      ]),
    )
    .digest('hex')
function parseJson(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback
  } catch {
    return fallback
  }
}
function project(kind, row) {
  const result = { ...row, version: personalVersion(row) }
  if (kind === 'anime') {
    result.tags = row.tags ? row.tags.split(',') : []
    for (const field of ['infobox', 'characters', 'staff'])
      result[field] = parseJson(row[field], [])
  }
  return result
}
export function getCollectionItem(db, kind, id) {
  const { table } = definition(kind)
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1)
    throw new CollectionError(404, '条目不存在')
  const row = db
    .prepare(
      `SELECT c.* FROM ${table} c WHERE c.id=? AND ${activeCollectionSql(kind)}`,
    )
    .get(id)
  if (!row) throw new CollectionError(404, '条目不存在或已移入回收站')
  return project(kind, row)
}
export function listCollection(db, kind, query = {}) {
  const { table, sorts, statuses } = definition(kind)
  const page = Number(query.page || 1),
    pageSize = Number(query.pageSize || 24)
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new CollectionError(400, '分页参数无效')
  const clauses = [activeCollectionSql(kind)],
    params = []
  if (query.status) {
    if (!statuses.includes(query.status))
      throw new CollectionError(400, '状态无效')
    clauses.push('c.status=?')
    params.push(query.status)
  }
  if (query.favorite === 'true') clauses.push('c.is_favorite=1')
  if (kind === 'anime' && query.hideHidden === 'true')
    clauses.push('COALESCE(c.is_hidden,0)=0')
  if (query.keyword) {
    const term =
      '%' +
      String(query.keyword)
        .slice(0, 200)
        .replace(/[\\%_]/g, '\\$&') +
      '%'
    clauses.push(
      "(c.title LIKE ? ESCAPE '\\' OR c.name_original LIKE ? ESCAPE '\\'" +
        (kind === 'anime' ? " OR c.name_cn LIKE ? ESCAPE '\\')" : ')'),
    )
    params.push(term, term)
    if (kind === 'anime') params.push(term)
  }
  if (kind === 'game')
    for (const [key, column] of [
      ['genre', 'genres'],
      ['platform', 'platforms'],
    ]) {
      if (query[key]) {
        clauses.push(`c.${column} LIKE ?`)
        params.push('%' + String(query[key]).slice(0, 100) + '%')
      }
    }
  const where = clauses.join(' AND ')
  const sort = sorts.includes(query.sortBy)
    ? query.sortBy
    : kind === 'game'
      ? 'playtime_2weeks'
      : 'updated_at'
  const order = String(query.sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const total = db
    .prepare(`SELECT COUNT(*) n FROM ${table} c WHERE ${where}`)
    .get(...params).n
  const data = db
    .prepare(
      `SELECT c.* FROM ${table} c WHERE ${where} ORDER BY c.${sort} IS NULL, c.${sort} ${order}, c.id ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map((row) => {
      const item = project(kind, row)
      if (kind === 'anime') item.cover_image_data = undefined
      return item
    })
  const counts = db
    .prepare(
      `SELECT c.status, COUNT(*) count FROM ${table} c WHERE ${activeCollectionSql(kind)} GROUP BY c.status`,
    )
    .all()
  return { data, total, page, pageSize, counts }
}
function assertVersion(row, input) {
  if (!input?.baseVersion) throw new CollectionError(428, '请刷新条目后再保存')
  if (row.version !== input.baseVersion)
    throw new CollectionError(
      409,
      '其他设备已修改此条目。你的修改仍保留，请重新载入后核对',
    )
}
export function saveCollectionPersonal(db, kind, id, input) {
  const { table, statuses } = definition(kind)
  return db.transaction(() => {
    const row = getCollectionItem(db, kind, id)
    assertVersion(row, input)
    const status = input.status ?? row.status,
      rating = input.userRating ?? row.user_rating
    if (!statuses.includes(status)) throw new CollectionError(400, '状态无效')
    if (
      typeof rating !== 'number' ||
      !Number.isFinite(rating) ||
      rating < 0 ||
      rating > 10 ||
      rating * 2 !== Math.floor(rating * 2)
    )
      throw new CollectionError(400, '评分需为 0–10，最小间隔 0.5')
    if (input.isFavorite !== undefined && typeof input.isFavorite !== 'boolean')
      throw new CollectionError(400, '收藏状态无效')
    const favorite =
      input.isFavorite === undefined
        ? row.is_favorite
        : Number(input.isFavorite)
    if (kind === 'game') {
      const notes = input.notes ?? row.notes ?? ''
      if (typeof notes !== 'string' || notes.length > 5000)
        throw new CollectionError(400, '备注最长 5000 字')
      db.prepare(
        'UPDATE games SET status=?,is_favorite=?,user_rating=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
      ).run(status, favorite, rating, notes, id)
    } else {
      if (input.isHidden !== undefined && typeof input.isHidden !== 'boolean')
        throw new CollectionError(400, '隐藏状态无效')
      db.prepare(
        `UPDATE ${table} SET status=?,is_favorite=?,user_rating=?,is_hidden=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).run(
        status,
        favorite,
        rating,
        input.isHidden === undefined ? row.is_hidden : Number(input.isHidden),
        id,
      )
    }
    return getCollectionItem(db, kind, id)
  })()
}
export function trashCollectionItem(db, kind, id, input) {
  return db.transaction(() => {
    assertVersion(getCollectionItem(db, kind, id), input)
    db.prepare(
      'INSERT INTO resource_trash_entries(resource_type,resource_id,deleted_at,purge_after,metadata_json) VALUES(?,?,?,?,?)',
    ).run(
      kind,
      id,
      new Date().toISOString(),
      new Date(Date.now() + 30 * 86400000).toISOString(),
      '{"state":"deleted"}',
    )
    return { id: Number(id) }
  })()
}
export function restoreCollectionItem({
  database: db,
  resourceType: kind,
  id,
  purge = false,
}) {
  const { table } = definition(kind)
  return db.transaction(() => {
    const entry = db
      .prepare(
        'SELECT metadata_json FROM resource_trash_entries WHERE resource_type=? AND resource_id=?',
      )
      .get(kind, id)
    if (!entry || !db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))
      throw Object.assign(new Error('Not in trash'), {
        code: 'COLLECTION_TRASH_NOT_FOUND',
      })
    if (parseJson(entry.metadata_json, {}).state !== 'deleted')
      throw Object.assign(new Error('Invalid trash state'), {
        code: 'COLLECTION_TRASH_PURGE_IN_PROGRESS',
      })
    if (purge) {
      if (kind === 'game')
        db.prepare('DELETE FROM game_achievements WHERE game_id=?').run(id)
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)
    }
    db.prepare(
      'DELETE FROM resource_trash_entries WHERE resource_type=? AND resource_id=?',
    ).run(kind, id)
    return { id: Number(id) }
  })()
}
