/**
 * 动漫封面缓存管理器 - 使用 IndexedDB 存储
 */

const DB_NAME = 'AnimeCoverCache'
const STORE_NAME = 'covers'
const DB_VERSION = 1

let db = null

/**
 * 初始化 IndexedDB
 */
export async function initAnimeCoverDB() {
  if (db) return db

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('[动漫封面缓存] IndexedDB 打开失败:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      db = request.result
      console.log('[动漫封面缓存] IndexedDB 初始化成功')
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('timestamp', 'timestamp', { unique: false })
        console.log('[动漫封面缓存] 创建对象存储:', STORE_NAME)
      }
    }
  })
}

/**
 * 获取封面缓存
 * @param {number} animeId 动漫 ID
 * @returns {Promise<string|null>} base64 封面数据
 */
export async function getAnimeCoverFromCache(animeId) {
  try {
    await initAnimeCoverDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(animeId)

      request.onsuccess = () => {
        const record = request.result
        resolve(record?.cover || null)
      }

      request.onerror = () => {
        console.error('[动漫封面缓存] 读取失败:', request.error)
        resolve(null)
      }
    })
  } catch (e) {
    console.error('[动漫封面缓存] 获取缓存失败:', e)
    return null
  }
}

/**
 * 保存封面到缓存
 * @param {number} animeId 动漫 ID
 * @param {string} coverData base64 封面数据
 */
export async function saveAnimeCoverToCache(animeId, coverData) {
  try {
    await initAnimeCoverDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      
      const record = {
        id: animeId,
        cover: coverData,
        timestamp: Date.now()
      }

      const request = store.put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => {
        console.error('[动漫封面缓存] 保存失败:', request.error)
        resolve()
      }
    })
  } catch (e) {
    console.error('[动漫封面缓存] 保存缓存失败:', e)
  }
}

export default {
  initAnimeCoverDB,
  getAnimeCoverFromCache,
  saveAnimeCoverToCache
}
