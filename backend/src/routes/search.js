import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken } from '../middlewares/auth.js'

const router = express.Router()

// 全局搜索
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword } = req.query
    if (!keyword) {
      return res.status(400).json({ message: '请输入搜索关键词' })
    }

    const db = getDatabase()
    const searchPattern = `%${keyword}%`

    // 同步查询所有资源类型
    const documentStmt = db.prepare(
      'SELECT id, title, category, "document" as type FROM documents WHERE title LIKE ? OR tags LIKE ?'
    )
    const documentResults = documentStmt.all(searchPattern, searchPattern)

    const musicStmt = db.prepare(
      'SELECT id, title, artist, "music" as type FROM music WHERE title LIKE ? OR artist LIKE ? OR tags LIKE ?'
    )
    const musicResults = musicStmt.all(searchPattern, searchPattern, searchPattern)

    const codeStmt = db.prepare(
      'SELECT id, name, url, "code" as type FROM code_repositories WHERE name LIKE ? OR url LIKE ? OR tags LIKE ?'
    )
    const codeResults = codeStmt.all(searchPattern, searchPattern, searchPattern)

    const bookmarkStmt = db.prepare(
      'SELECT id, title, url, "bookmark" as type FROM bookmarks WHERE title LIKE ? OR url LIKE ? OR tags LIKE ?'
    )
    const bookmarkResults = bookmarkStmt.all(searchPattern, searchPattern, searchPattern)

    const animeStmt = db.prepare(
      'SELECT id, title, "anime" as type FROM anime WHERE title LIKE ?'
    )
    const animeResults = animeStmt.all(searchPattern)

    const allResults = [
      ...documentResults,
      ...musicResults,
      ...codeResults,
      ...bookmarkResults,
      ...animeResults
    ]

    res.json({
      data: allResults,
      total: allResults.length,
      summary: {
        documents: documentResults.length,
        music: musicResults.length,
        code: codeResults.length,
        bookmarks: bookmarkResults.length,
        anime: animeResults.length
      }
    })
  } catch (error) {
    console.error('搜索错误:', error)
    res.status(500).json({ message: '搜索失败' })
  }
})

export default router
