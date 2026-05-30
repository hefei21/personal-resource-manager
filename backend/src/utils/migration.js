/**
 * 数据迁移工具
 * 用于一次性压缩数据库中已存在的 base64 封面图片和书籍封面文件
 */

import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { getDatabase } from '../config/database.js'
import { compressBase64Image, compressImage } from './imageCompress.js'
import { getStoragePath } from '../config/storage.js'

// 迁移状态文件路径（放在数据库同目录，确保与数据库一起持久化）
const MIGRATION_FLAG_FILE = path.join(process.env.DATA_PATH || '/app/data', 'database', '.migration_compressed_covers')

/**
 * 检查迁移是否已完成
 */
export function isMigrationCompleted() {
  return fs.existsSync(MIGRATION_FLAG_FILE)
}

/**
 * 标记迁移已完成
 */
function markMigrationCompleted(stats) {
  const dir = path.dirname(MIGRATION_FLAG_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(MIGRATION_FLAG_FILE, JSON.stringify({
    completedAt: new Date().toISOString(),
    ...stats
  }, null, 2))
  console.log('✅ 迁移完成标志已写入:', MIGRATION_FLAG_FILE)
}

/**
 * 压缩书籍封面文件（磁盘上的图片文件）
 */
async function compressBookCoverFiles() {
  console.log('\n📚 处理书籍封面文件...')
  const coversDir = path.join(getStoragePath('books'), 'covers')
  
  if (!fs.existsSync(coversDir)) {
    console.log('  书籍封面目录不存在，跳过')
    return { total: 0, compressed: 0, skipped: 0, savedBytes: 0 }
  }
  
  const files = fs.readdirSync(coversDir).filter(f => 
    /\.(jpg|jpeg|png|gif|webp)$/i.test(f)
  )
  
  const stats = { total: files.length, compressed: 0, skipped: 0, savedBytes: 0 }
  
  for (const file of files) {
    try {
      const filePath = path.join(coversDir, file)
      const originalData = fs.readFileSync(filePath)
      const originalSize = originalData.length
      
      // 压缩图片
      const compressedData = await compressImage(originalData, { 
        maxWidth: 500, 
        maxHeight: 500, 
        quality: 85 
      })
      
      const newSize = compressedData.length
      const saved = originalSize - newSize
      
      if (saved > 100) { // 只在节省超过100字节时才重写
        // 保存压缩后的文件（统一使用 .jpg 扩展名）
        const newFileName = file.replace(/\.(png|gif|webp)$/i, '.jpg')
        const newFilePath = path.join(coversDir, newFileName)
        
        fs.writeFileSync(newFilePath, compressedData)
        
        // 如果文件名改变了，删除旧文件
        if (newFileName !== file) {
          fs.unlinkSync(filePath)
          // 更新数据库中的路径
          const db = getDatabase()
          db.prepare('UPDATE books SET cover_image = ? WHERE cover_image = ?').run(newFilePath, filePath)
        }
        
        stats.compressed++
        stats.savedBytes += saved
        console.log(`  ✓ ${file}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB (节省 ${(saved/1024).toFixed(1)}KB)`)
      } else {
        stats.skipped++
      }
    } catch (err) {
      console.error(`  ✗ ${file}: 压缩失败 - ${err.message}`)
    }
  }
  
  return stats
}

/**
 * 执行封面图片压缩迁移
 */
export async function migrateCompressCovers() {
  // 检查是否已迁移
  if (isMigrationCompleted()) {
    console.log('⏭️ 封面压缩迁移已完成，跳过')
    return { skipped: true }
  }

  console.log('🔄 开始封面图片压缩迁移...')
  const db = getDatabase()
  const stats = {
    music: { total: 0, compressed: 0, skipped: 0, savedBytes: 0 },
    anime: { total: 0, compressed: 0, skipped: 0, savedBytes: 0 },
    games: { total: 0, compressed: 0, skipped: 0, savedBytes: 0 },
    books: { total: 0, compressed: 0, skipped: 0, savedBytes: 0 }
  }

  try {
    // 压缩音乐封面
    console.log('\n📀 处理音乐封面...')
    const musicRows = db.prepare('SELECT id, title, cover_image FROM music WHERE cover_image IS NOT NULL').all()
    stats.music.total = musicRows.length
    
    for (const row of musicRows) {
      try {
        // 检查是否是 base64 格式
        if (!row.cover_image.startsWith('data:image')) {
          stats.music.skipped++
          continue
        }
        
        const originalSize = row.cover_image.length
        const compressed = await compressBase64Image(row.cover_image, { 
          maxWidth: 500, 
          maxHeight: 500, 
          quality: 85 
        })
        const newSize = compressed.length
        const saved = originalSize - newSize
        
        if (saved > 0) {
          db.prepare('UPDATE music SET cover_image = ? WHERE id = ?').run(compressed, row.id)
          stats.music.compressed++
          stats.music.savedBytes += saved
          console.log(`  ✓ [${row.id}] ${row.title}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB (节省 ${(saved/1024).toFixed(1)}KB)`)
        } else {
          stats.music.skipped++
        }
      } catch (err) {
        console.error(`  ✗ [${row.id}] ${row.title}: 压缩失败 - ${err.message}`)
      }
    }

    // 压缩动漫封面
    console.log('\n🎬 处理动漫封面...')
    const animeRows = db.prepare('SELECT id, title, cover_image FROM anime WHERE cover_image IS NOT NULL').all()
    stats.anime.total = animeRows.length
    
    for (const row of animeRows) {
      try {
        // 检查是否是 base64 格式
        if (!row.cover_image.startsWith('data:image')) {
          stats.anime.skipped++
          continue
        }
        
        const originalSize = row.cover_image.length
        const compressed = await compressBase64Image(row.cover_image, { 
          maxWidth: 500, 
          maxHeight: 500, 
          quality: 85 
        })
        const newSize = compressed.length
        const saved = originalSize - newSize
        
        if (saved > 0) {
          db.prepare('UPDATE anime SET cover_image = ? WHERE id = ?').run(compressed, row.id)
          stats.anime.compressed++
          stats.anime.savedBytes += saved
          console.log(`  ✓ [${row.id}] ${row.title}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB (节省 ${(saved/1024).toFixed(1)}KB)`)
        } else {
          stats.anime.skipped++
        }
      } catch (err) {
        console.error(`  ✗ [${row.id}] ${row.title}: 压缩失败 - ${err.message}`)
      }
    }

    // 压缩游戏封面
    console.log('\n🎮 处理游戏封面...')
    const gameRows = db.prepare('SELECT id, title, cover_image_data FROM games WHERE cover_image_data IS NOT NULL').all()
    stats.games.total = gameRows.length
    
    for (const row of gameRows) {
      try {
        // 检查是否是 base64 格式
        if (!row.cover_image_data.startsWith('data:image')) {
          stats.games.skipped++
          continue
        }
        
        const originalSize = row.cover_image_data.length
        const compressed = await compressBase64Image(row.cover_image_data, { 
          maxWidth: 500, 
          maxHeight: 500, 
          quality: 85 
        })
        const newSize = compressed.length
        const saved = originalSize - newSize
        
        if (saved > 0) {
          db.prepare('UPDATE games SET cover_image_data = ? WHERE id = ?').run(compressed, row.id)
          stats.games.compressed++
          stats.games.savedBytes += saved
          console.log(`  ✓ [${row.id}] ${row.title}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB (节省 ${(saved/1024).toFixed(1)}KB)`)
        } else {
          stats.games.skipped++
        }
      } catch (err) {
        console.error(`  ✗ [${row.id}] ${row.title}: 压缩失败 - ${err.message}`)
      }
    }

    // 压缩书籍封面文件
    const bookStats = await compressBookCoverFiles()
    stats.books = bookStats

    // 计算总节省空间
    const totalSaved = stats.music.savedBytes + stats.anime.savedBytes + stats.games.savedBytes + stats.books.savedBytes
    console.log(`\n📊 迁移统计:`)
    console.log(`   音乐: ${stats.music.compressed}/${stats.music.total} 压缩, 节省 ${(stats.music.savedBytes/1024/1024).toFixed(2)}MB`)
    console.log(`   动漫: ${stats.anime.compressed}/${stats.anime.total} 压缩, 节省 ${(stats.anime.savedBytes/1024/1024).toFixed(2)}MB`)
    console.log(`   游戏: ${stats.games.compressed}/${stats.games.total} 压缩, 节省 ${(stats.games.savedBytes/1024/1024).toFixed(2)}MB`)
    console.log(`   书籍: ${stats.books.compressed}/${stats.books.total} 压缩, 节省 ${(stats.books.savedBytes/1024/1024).toFixed(2)}MB`)
    console.log(`   总计节省: ${(totalSaved/1024/1024).toFixed(2)}MB`)

    // 标记迁移完成
    markMigrationCompleted({
      ...stats,
      totalSavedBytes: totalSaved
    })

    return { success: true, stats }
  } catch (error) {
    console.error('❌ 迁移失败:', error)
    return { success: false, error: error.message }
  }
}
