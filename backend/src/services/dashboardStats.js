// Dashboard totals describe the active library, never recovery-bin contents.
export function dashboardStats(db, { isGuest = false } = {}) {
  const activeCount = (table, type, extra = '') => db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} c WHERE NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t WHERE t.resource_type=? AND t.resource_id=c.id
    ) ${extra}`
  ).get(type).count
  const animeVisibility = isGuest ? ' AND (c.is_hidden=0 OR c.is_hidden IS NULL)' : ''
  return {
    documents: activeCount('documents', 'document'),
    music: activeCount('music', 'music'),
    books: activeCount('books', 'ebook'),
    games: activeCount('games', 'game'),
    code: db.prepare('SELECT COUNT(*) AS count FROM code_repositories').get().count,
    bookmarks: activeCount('bookmarks', 'bookmark'),
    blog: { total: activeCount('blog_posts', 'note') },
    anime: {
      total: activeCount('anime', 'anime', animeVisibility),
      ...Object.fromEntries(['want_to_watch', 'watching', 'watched'].map(status => [
        status, activeCount('anime', 'anime', `${animeVisibility} AND c.status='${status}'`)
      ]))
    }
  }
}
