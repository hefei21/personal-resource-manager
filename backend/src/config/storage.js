import fs from 'fs'
import path from 'path'

// 存储路径配置
const dataPath = process.env.DATA_PATH || path.resolve('data')
const paths = {
  storage: process.env.STORAGE_PATH || path.join(dataPath, 'storage'),
  documents: process.env.DOCUMENTS_PATH || path.join(dataPath, 'documents'),
  music: process.env.MUSIC_PATH || path.join(dataPath, 'music'),
  books: process.env.BOOKS_PATH || path.join(dataPath, 'books'),
  uploads: process.env.UPLOADS_PATH || path.join(dataPath, 'uploads'),
  logs: process.env.LOGS_PATH || path.join(dataPath, 'logs')
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
