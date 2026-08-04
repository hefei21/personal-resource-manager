import { createClient } from 'redis'

let redisClient = null
let reconnectAttempts = 0
let lastErrorLogAt = 0

const INITIAL_CONNECT_WAIT_MS = 2000
const ERROR_LOG_INTERVAL_MS = 30000

export function redisReconnectDelay(retries) {
  const safeRetries = Number.isFinite(retries) ? Math.max(0, retries) : 0
  return Math.min(250 * (2 ** Math.min(safeRetries, 6)), 10000)
}

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
      // NAS 长期在线，Redis 可能被单独重启；持续退避重连而不是永久放弃。
      reconnectStrategy: redisReconnectDelay
    }
  })

  redisClient.on('error', (err) => {
    const now = Date.now()
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      console.error('Redis 暂不可用:', {
        code: err?.code || 'UNKNOWN',
        message: err?.message || '连接错误',
        reconnectAttempts
      })
      lastErrorLogAt = now
    }
  })

  redisClient.on('connect', () => {
    console.log('Redis TCP 连接已建立')
  })

  redisClient.on('ready', () => {
    console.log(reconnectAttempts > 0 ? 'Redis 已恢复连接' : 'Redis 连接成功')
    reconnectAttempts = 0
    lastErrorLogAt = 0
  })

  redisClient.on('reconnecting', () => {
    reconnectAttempts++
    if (reconnectAttempts === 1 || reconnectAttempts % 10 === 0) {
      console.warn(`Redis 重连等待中（第 ${reconnectAttempts} 次）`)
    }
  })

  redisClient.on('end', () => {
    console.log('Redis 连接已关闭')
  })

  const connectionAttempt = redisClient.connect()
  connectionAttempt.catch((error) => {
    console.error('Redis 连接循环已停止:', error?.message || error)
  })

  const connectedDuringStartup = await Promise.race([
    connectionAttempt.then(() => true).catch(() => false),
    new Promise(resolve => setTimeout(() => resolve(false), INITIAL_CONNECT_WAIT_MS))
  ])
  if (!connectedDuringStartup) {
    console.warn('Redis 启动连接尚未就绪，应用暂时使用内存缓存并继续后台重连')
  }
  return redisClient
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
  return Boolean(redisClient?.isReady)
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis() {
  if (redisClient) {
    try {
      if (redisClient.isReady) {
        await redisClient.quit()
      } else if (redisClient.isOpen) {
        await redisClient.disconnect()
      }
    } catch (error) {
      console.warn('关闭 Redis 连接时出现非阻断错误:', error?.message || error)
    }
    redisClient = null
    reconnectAttempts = 0
    lastErrorLogAt = 0
  }
}
