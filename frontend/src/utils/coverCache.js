/**
 * 封面缓存管理器 - 使用 IndexedDB 存储
 * 解决 sessionStorage 配额限制问题（IndexedDB 没有大小限制）
 */

const DB_NAME = 'MusicCoverCache'
const STORE_NAME = 'covers'
const DB_VERSION = 1

let db = null

/**
 * 初始化 IndexedDB
 */
export async function initCoverDB() {
  if (db) return db

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('[封面缓存] IndexedDB 打开失败:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      db = request.result
      console.log('[封面缓存] IndexedDB 初始化成功')
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        // 创建存储对象，以音乐 ID 为主键
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('timestamp', 'timestamp', { unique: false })
        console.log('[封面缓存] 创建对象存储:', STORE_NAME)
      }
    }
  })
}

/**
 * 获取封面缓存
 * @param {number} musicId 音乐 ID
 * @returns {Promise<string|null>} base64 封面数据
 */
export async function getCoverFromCache(musicId) {
  try {
    await initCoverDB()
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(musicId)

      request.onsuccess = () => {
        const record = request.result
        if (record) {
          // 更新访问时间（用于 LRU）
          updateAccessTime(musicId)
          resolve(record.cover)
        } else {
          resolve(null)
        }
      }

      request.onerror = () => {
        console.error('[封面缓存] 读取失败:', request.error)
        resolve(null)
      }
    })
  } catch (e) {
    console.error('[封面缓存] 获取缓存失败:', e)
    return null
  }
}

/**
 * 保存封面到缓存
 * @param {number} musicId 音乐 ID
 * @param {string} coverData base64 封面数据
 */
export async function saveCoverToCache(musicId, coverData) {
  try {
    await initCoverDB()
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      
      const record = {
        id: musicId,
        cover: coverData,
        timestamp: Date.now(),
        accessedAt: Date.now()
      }

      const request = store.put(record)

      request.onsuccess = () => {
        resolve()
      }

      request.onerror = () => {
        console.error('[封面缓存] 保存失败:', request.error)
        resolve() // 不抛出错误，避免影响主流程
      }

      transaction.oncomplete = () => {
        // 检查是否需要清理旧缓存
        checkAndCleanCache()
      }
    })
  } catch (e) {
    console.error('[封面缓存] 保存缓存失败:', e)
  }
}

/**
 * 更新访问时间（用于 LRU 清理）
 */
async function updateAccessTime(musicId) {
  try {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(musicId)

    request.onsuccess = () => {
      const record = request.result
      if (record) {
        record.accessedAt = Date.now()
        store.put(record)
      }
    }
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

/**
 * 检查并清理旧缓存（保留最近访问的 300 个）
 */
async function checkAndCleanCache() {
  try {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const countRequest = store.count()

    countRequest.onsuccess = async () => {
      const count = countRequest.result
      const MAX_CACHE_SIZE = 300

      if (count > MAX_CACHE_SIZE) {
        console.log(`[封面缓存] 缓存数量 ${count} 超过限制，开始清理...`)
        await cleanOldCache(count - MAX_CACHE_SIZE)
      }
    }
  } catch (e) {
    console.error('[封面缓存] 检查缓存失败:', e)
  }
}

/**
 * 清理旧缓存（基于 LRU 策略）
 * @param {number} deleteCount 要删除的数量
 */
async function cleanOldCache(deleteCount) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const index = store.index('timestamp')
    
    // 按时间戳排序（旧数据在前）
    const cursorRequest = index.openCursor()
    let deleted = 0

    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor && deleted < deleteCount) {
        store.delete(cursor.primaryKey)
        deleted++
        cursor.continue()
      } else {
        console.log(`[封面缓存] 已清理 ${deleted} 个旧缓存`)
        resolve()
      }
    }

    cursorRequest.onerror = () => {
      console.error('[封面缓存] 清理失败:', cursorRequest.error)
      resolve()
    }
  })
}

/**
 * 清空所有缓存
 */
export async function clearAllCache() {
  try {
    await initCoverDB()
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()

      request.onsuccess = () => {
        console.log('[封面缓存] 已清空所有缓存')
        resolve()
      }

      request.onerror = () => {
        console.error('[封面缓存] 清空失败:', request.error)
        resolve()
      }
    })
  } catch (e) {
    console.error('[封面缓存] 清空缓存失败:', e)
  }
}

/**
 * 批量获取封面缓存
 * @param {number[]} musicIds 音乐 ID 数组
 * @returns {Promise<Object>} { id: cover } 映射
 */
export async function batchGetCovers(musicIds) {
  const result = {}
  
  try {
    await initCoverDB()
    
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    
    const promises = musicIds.map(id => {
      return new Promise((resolve) => {
        const request = store.get(id)
        request.onsuccess = () => {
          const record = request.result
          if (record) {
            result[id] = record.cover
          }
          resolve()
        }
        request.onerror = () => resolve()
      })
    })
    
    await Promise.all(promises)
  } catch (e) {
    console.error('[封面缓存] 批量获取失败:', e)
  }
  
  return result
}

export default {
  initCoverDB,
  getCoverFromCache,
  saveCoverToCache,
  clearAllCache,
  batchGetCovers
}
