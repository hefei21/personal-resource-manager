/**
 * 上传状态管理器 - 使用 IndexedDB 存储
 * 支持断点续传：保存文件引用和上传进度
 */

const DB_NAME = 'MusicUploadState'
const STORE_NAME = 'uploads'
const DB_VERSION = 1

let db = null

/**
 * 初始化 IndexedDB
 */
export async function initUploadDB() {
  if (db) return db

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('[上传状态] IndexedDB 打开失败:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      db = request.result
      console.log('[上传状态] IndexedDB 初始化成功')
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'fileId' })
        store.createIndex('timestamp', 'timestamp', { unique: false })
        console.log('[上传状态] 创建对象存储:', STORE_NAME)
      }
    }
  })
}

/**
 * 保存上传状态
 * @param {string} fileId 文件ID
 * @param {File} file 文件对象
 * @param {number} totalChunks 总分片数
 */
export async function saveUploadState(fileId, file, totalChunks) {
  try {
    await initUploadDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      
      const record = {
        fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        totalChunks,
        // 注意：File 对象可以存储在 IndexedDB 中
        file: file,
        timestamp: Date.now()
      }

      const request = store.put(record)

      request.onsuccess = () => {
        resolve()
      }

      request.onerror = () => {
        console.error('[上传状态] 保存失败:', request.error)
        resolve()
      }
    })
  } catch (e) {
    console.error('[上传状态] 保存上传状态失败:', e)
  }
}

/**
 * 获取上传状态
 * @param {string} fileId 文件ID
 */
export async function getUploadState(fileId) {
  try {
    await initUploadDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(fileId)

      request.onsuccess = () => {
        resolve(request.result || null)
      }

      request.onerror = () => {
        console.error('[上传状态] 读取失败:', request.error)
        resolve(null)
      }
    })
  } catch (e) {
    console.error('[上传状态] 获取上传状态失败:', e)
    return null
  }
}

/**
 * 获取所有未完成的上传
 */
export async function getAllPendingUploads() {
  try {
    await initUploadDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()

      request.onsuccess = () => {
        resolve(request.result || [])
      }

      request.onerror = () => {
        console.error('[上传状态] 获取所有上传失败:', request.error)
        resolve([])
      }
    })
  } catch (e) {
    console.error('[上传状态] 获取所有上传失败:', e)
    return []
  }
}

/**
 * 删除上传状态
 * @param {string} fileId 文件ID
 */
export async function deleteUploadState(fileId) {
  try {
    await initUploadDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(fileId)

      request.onsuccess = () => {
        resolve()
      }

      request.onerror = () => {
        console.error('[上传状态] 删除失败:', request.error)
        resolve()
      }
    })
  } catch (e) {
    console.error('[上传状态] 删除上传状态失败:', e)
  }
}

/**
 * 清理过期的上传状态（超过 24 小时）
 */
export async function cleanExpiredUploads() {
  try {
    await initUploadDB()
    
    const all = await getAllPendingUploads()
    const now = Date.now()
    const expiredIds = []
    
    for (const upload of all) {
      if (now - upload.timestamp > 24 * 60 * 60 * 1000) {
        expiredIds.push(upload.fileId)
      }
    }
    
    for (const fileId of expiredIds) {
      await deleteUploadState(fileId)
    }
    
    if (expiredIds.length > 0) {
      console.log(`[上传状态] 清理了 ${expiredIds.length} 个过期上传`)
    }
  } catch (e) {
    console.error('[上传状态] 清理过期上传失败:', e)
  }
}

export default {
  initUploadDB,
  saveUploadState,
  getUploadState,
  getAllPendingUploads,
  deleteUploadState,
  cleanExpiredUploads
}
