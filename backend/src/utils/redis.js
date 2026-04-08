import { createClient } from 'redis'

let redisClient = null
let isConnected = false

/**
 * 初始化 Redis 连接
 */
export async function initRedis() {
  if (redisClient) {
    return redisClient
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
  
  redisClient = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        // 重连策略：最多重试 5 次，每次间隔递增
        if (retries > 5) {
          console.error('Redis 连接失败，已达到最大重试次数')
          return new Error('Redis 连接失败')
        }
        console.log(`Redis 重连中... 第 ${retries} 次`)
        return Math.min(retries * 100, 3000) // 最多 3 秒
      }
    }
  })

  redisClient.on('error', (err) => {
    console.error('Redis 错误:', err)
    isConnected = false
  })

  redisClient.on('connect', () => {
    console.log('Redis 连接成功')
    isConnected = true
  })

  redisClient.on('disconnect', () => {
    console.log('Redis 断开连接')
    isConnected = false
  })

  try {
    await redisClient.connect()
    return redisClient
  } catch (error) {
    console.error('Redis 连接失败:', error)
    // 连接失败时返回 null，缓存功能将降级为不缓存
    return null
  }
}

/**
 * 获取 Redis 客户端
 */
export function getRedisClient() {
  return redisClient
}

/**
 * 检查 Redis 是否已连接
 */
export function isRedisConnected() {
  return isConnected && redisClient !== null
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis() {
  if (redisClient) {
    await redisClient.quit()
    redisClient = null
    isConnected = false
  }
}
