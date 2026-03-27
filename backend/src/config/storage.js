import fs from 'fs'
import path from 'path'

// 存储路径配置
const paths = {
  documents: process.env.DOCUMENTS_PATH || path.join(process.env.DATA_PATH, 'documents'),
  music: process.env.MUSIC_PATH || path.join(process.env.DATA_PATH, 'music'),
  books: process.env.BOOKS_PATH || path.join(process.env.DATA_PATH, 'books'),
  uploads: process.env.UPLOADS_PATH || path.join(process.env.DATA_PATH, 'uploads'),
  logs: process.env.LOGS_PATH || path.join(process.env.DATA_PATH, 'logs')
}

// 确保所有必要目录存在
export function ensureDirectories() {
  Object.values(paths).forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`✓ 创建目录: ${dir}`)
    }
  })
}

// 获取存储路径
export function getStoragePath(type) {
  return paths[type]
}

export { paths }
