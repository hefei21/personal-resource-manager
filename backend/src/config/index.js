/**
 * 统一配置中心
 * 所有环境变量和配置项在此集中管理
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadRagVectorConfig } from './ragVector.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 加载 .env 文件
dotenv.config({ path: path.join(__dirname, '../../.env') })

/**
 * 服务器配置
 */
export const serverConfig = {
  port: parseInt(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production'
}

/**
 * 安全配置
 */
export const securityConfig = {
  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10,
  passwordMinLength: 6
}

/**
 * 数据库配置
 */
export const databaseConfig = {
  path: process.env.DB_PATH || './data/db/database.db'
}

/**
 * 存储配置
 */
export const storageConfig = {
  basePath: process.env.DATA_DIR || './data',
  paths: {
    db: process.env.DB_PATH || './data/db',
    uploads: process.env.UPLOAD_DIR || './data/uploads',
    music: process.env.MUSIC_DIR || './data/music',
    books: process.env.BOOKS_DIR || './data/books',
    docs: process.env.DOCS_DIR || './data/docs',
    temp: process.env.TEMP_DIR || './data/temp',
    logs: process.env.LOG_DIR || './data/logs'
  }
}

/**
 * 网络代理配置
 */
export const proxyConfig = {
  enabled: !!process.env.HTTP_PROXY,
  httpProxy: process.env.HTTP_PROXY,
  httpsProxy: process.env.HTTPS_PROXY
}

/**
 * Steam API 配置
 */
export const steamConfig = {
  apiKey: process.env.STEAM_API_KEY,
  baseUrl: 'https://api.steampowered.com',
  storeUrl: 'https://store.steampowered.com/api'
}

/**
 * Bangumi 配置
 */
export const bangumiConfig = {
  baseUrl: 'https://api.bgm.tv'
}

/**
 * 日志配置
 */
export const logConfig = {
  level: process.env.LOG_LEVEL || (serverConfig.isDev ? 'debug' : 'info'),
  maxFiles: parseInt(process.env.LOG_MAX_FILES) || 30,
  maxSize: process.env.LOG_MAX_SIZE || '100m'
}

/**
 * 缓存配置
 */
export const cacheConfig = {
  enabled: process.env.CACHE_ENABLED !== 'false',
  defaultTTL: parseInt(process.env.CACHE_DEFAULT_TTL) || 300,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS) || 10000
}

/**
 * 配置验证
 * 启动时检查必要配置
 */
export function validateConfig() {
  console.log('[Config] 配置验证通过')
}

// Vector search is an optional derived layer. It remains disabled unless the
// endpoint and a complete, hash-bound embedding identity are explicitly set.
export const ragVectorConfig = loadRagVectorConfig()

/**
 * 导出所有配置
 */
export default {
  server: serverConfig,
  security: securityConfig,
  database: databaseConfig,
  storage: storageConfig,
  proxy: proxyConfig,
  steam: steamConfig,
  bangumi: bangumiConfig,
  log: logConfig,
  cache: cacheConfig,
  ragVector: ragVectorConfig
}
