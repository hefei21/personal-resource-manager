import { getRedisClient, isRedisConnected } from './redis.js'

/**
 * 缓存工具类（支持 Redis 和内存缓存降级）
 */
class CacheManager {
  constructor() {
    // 内存缓存降级方案
    this.memoryCache = new Map()
    this.memoryCacheExpiry = new Map()
    
    // 缓存失效队列：记录删除失败的键
    this.invalidationQueue = new Set()
    this.processingQueue = false
    
    // 启动定期清理任务（每30秒）
    this.startInvalidationWorker()
  }
  
  /**
   * 启动缓存失效队列处理任务
   */
  startInvalidationWorker() {
    setInterval(() => {
      this.processInvalidationQueue()
    }, 30000)
  }
  
  /**
   * 处理缓存失效队列
   */
  async processInvalidationQueue() {
    if (this.processingQueue || this.invalidationQueue.size === 0) {
      return
    }
    
    if (!isRedisConnected()) {
      return // Redis未连接，稍后重试
    }
    
    this.processingQueue = true
    const keys = Array.from(this.invalidationQueue)
    
    for (const key of keys) {
      try {
        const client = getRedisClient()
        await client.del(key)
        this.invalidationQueue.delete(key)
        console.log(`[Cache] 队列清理成功: ${key}`)
      } catch (error) {
        console.error(`[Cache] 队列清理失败: ${key}`, error)
        // 保留在队列中，下次重试
      }
    }
    
    this.processingQueue = false
  }
  
  /**
   * 添加到失效队列
   */
  addToInvalidationQueue(key) {
    this.invalidationQueue.add(key)
    console.log(`[Cache] 添加到失效队列: ${key}`)
  }

  /**
   * 获取缓存
   * @param {string} key - 缓存键
   * @returns {any} 缓存值或 null
   */
  async get(key) {
    // 优先使用 Redis
    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        const value = await client.get(key)
        if (value !== null) {
          console.log(`[Redis] 命中缓存: ${key}`)
          return JSON.parse(value)
        }
        return null
      } catch (error) {
        console.error('[Redis] 获取缓存失败:', error)
        // Redis 失败，降级到内存缓存
      }
    }

    // 内存缓存降级
    const memoryValue = this.memoryCache.get(key)
    if (memoryValue !== undefined) {
      // 检查是否过期
      const expiry = this.memoryCacheExpiry.get(key)
      if (expiry && Date.now() > expiry) {
        this.memoryCache.delete(key)
        this.memoryCacheExpiry.delete(key)
        return null
      }
      console.log(`[Memory] 命中缓存: ${key}`)
      return memoryValue
    }

    return null
  }

  /**
   * 设置缓存
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间（秒），默认 5 分钟
   */
  async set(key, value, ttl = 300) {
    // 优先使用 Redis
    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        await client.setEx(key, ttl, JSON.stringify(value))
        console.log(`[Redis] 设置缓存: ${key}, TTL: ${ttl}s`)
        return true
      } catch (error) {
        console.error('[Redis] 设置缓存失败:', error)
        // Redis 失败，降级到内存缓存
      }
    }

    // 内存缓存降级
    this.memoryCache.set(key, value)
    this.memoryCacheExpiry.set(key, Date.now() + ttl * 1000)
    console.log(`[Memory] 设置缓存: ${key}, TTL: ${ttl}s`)
    return true
  }

  /**
   * 删除缓存
   * @param {string} key - 缓存键
   */
  async del(key) {
    let redisSuccess = false
    
    // Redis
    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        await client.del(key)
        console.log(`[Redis] 删除缓存: ${key}`)
        redisSuccess = true
      } catch (error) {
        console.error('[Redis] 删除缓存失败，加入队列:', key, error)
        // 删除失败，添加到失效队列稍后重试
        this.addToInvalidationQueue(key)
      }
    } else {
      // Redis未连接，添加到失效队列
      this.addToInvalidationQueue(key)
    }

    // 内存缓存始终删除
    this.memoryCache.delete(key)
    this.memoryCacheExpiry.delete(key)
    
    return redisSuccess || true
  }

  /**
   * 批量删除缓存（支持通配符）
   * @param {string} pattern - 缓存键模式（如 "doc:*"）
   */
  async delPattern(pattern) {
    // Redis
    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        const keys = await client.keys(pattern)
        if (keys.length > 0) {
          await client.del(keys)
          console.log(`[Redis] 删除缓存模式: ${pattern}, 数量: ${keys.length}`)
        }
      } catch (error) {
        console.error('[Redis] 删除缓存模式失败:', error)
      }
    }

    // 内存缓存（简单实现）
    for (const key of this.memoryCache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.memoryCache.delete(key)
        this.memoryCacheExpiry.delete(key)
      }
    }
    return true
  }

  /**
   * 简单的模式匹配（仅支持 * 通配符）
   */
  matchPattern(key, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return regex.test(key)
  }

  /**
   * 清空所有缓存
   */
  async clear() {
    // Redis
    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        await client.flushDb()
        console.log('[Redis] 清空所有缓存')
      } catch (error) {
        console.error('[Redis] 清空缓存失败:', error)
      }
    }

    // 内存缓存
    this.memoryCache.clear()
    this.memoryCacheExpiry.clear()
    return true
  }

  /**
   * 获取缓存统计信息
   */
  async getStats() {
    const stats = {
      redis: isRedisConnected() ? 'connected' : 'disconnected',
      memoryCacheSize: this.memoryCache.size
    }

    if (isRedisConnected()) {
      try {
        const client = getRedisClient()
        
        // 获取键数量
        const dbSize = await client.dbSize()
        stats.redisKeyCount = dbSize
        
        // 获取Redis详细信息
        const info = await client.info('memory')
        const memoryMatch = info.match(/used_memory_human:(\S+)/)
        const memoryPeakMatch = info.match(/used_memory_peak_human:(\S+)/)
        
        if (memoryMatch) {
          stats.redisMemoryUsed = memoryMatch[1]
        }
        if (memoryPeakMatch) {
          stats.redisMemoryPeak = memoryPeakMatch[1]
        }
        
        // 获取键空间信息
        const keySpace = await client.info('keyspace')
        const dbMatch = keySpace.match(/db0:keys=(\d+),expires=(\d+)/)
        if (dbMatch) {
          stats.redisKeys = parseInt(dbMatch[1])
          stats.redisExpires = parseInt(dbMatch[2])
        }
        
      } catch (error) {
        console.error('[Redis] 获取统计信息失败:', error)
        stats.error = error.message
      }
    }

    return stats
  }
}

// 导出单例
export const cache = new CacheManager()

/**
 * 缓存键命名规范
 * 格式：模块:资源:操作[:ID]
 * 例如：
 * - doc:categories          文档分类列表
 * - doc:tags                文档标签列表
 * - doc:detail:123          文档详情（ID=123）
 * - music:artists           音乐艺术家列表
 * - music:albums            音乐专辑列表
 * - game:achievements:456   游戏成就（游戏ID=456）
 */
export const CacheKeys = {
  // 文档管理
  DOC_CATEGORIES: 'doc:categories',
  DOC_TAGS: 'doc:tags',
  DOC_DETAIL: (id) => `doc:detail:${id}`,
  DOC_LIST: (params) => `doc:list:${JSON.stringify(params)}`,
  
  // 音乐管理
  MUSIC_ARTISTS: 'music:artists',
  MUSIC_ALBUMS: 'music:albums',
  MUSIC_PLAYLISTS: 'music:playlists',
  MUSIC_DETAIL: (id) => `music:detail:${id}`,
  MUSIC_LIST: (params) => `music:list:${JSON.stringify(params)}`,
  
  // 书籍管理
  BOOK_CATEGORIES: 'book:categories',
  BOOK_DETAIL: (id) => `book:detail:${id}`,
  BOOK_LIST: (params) => `book:list:${JSON.stringify(params)}`,
  
  // 游戏管理
  GAME_ACHIEVEMENTS: (id) => `game:achievements:${id}`,
  GAME_DETAIL: (id) => `game:detail:${id}`,
  GAME_LIST: (params) => `game:list:${JSON.stringify(params)}`,
  
  // 动漫管理
  ANIME_DETAIL: (id) => `anime:detail:${id}`,
  ANIME_LIST: (params) => `anime:list:${JSON.stringify(params)}`,
  
  // 仪表盘
  DASHBOARD_STATS: 'dashboard:stats',
  DASHBOARD_RECENT: 'dashboard:recent'
}

/**
 * 缓存过期时间（秒）
 */
export const CacheTTL = {
  SHORT: 60,           // 1 分钟 - 用于频繁变化的数据
  MEDIUM: 300,         // 5 分钟 - 用于列表数据
  LONG: 1800,          // 30 分钟 - 用于不常变化的数据
  VERY_LONG: 3600      // 1 小时 - 用于几乎不变的数据
}
