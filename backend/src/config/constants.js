/**
 * 全局常量配置
 * 集中管理所有魔法数字和配置项
 */

// 分页配置
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 30,
  MAX_PAGE_SIZE: 100,
  MIN_PAGE_SIZE: 5
}

// 超时配置
export const TIMEOUT = {
  HTTP_REQUEST: 15000,        // HTTP 请求超时 (ms)
  DB_QUERY: 30000,            // 数据库查询超时 (ms)
  FILE_UPLOAD: 300000,        // 文件上传超时 (ms) - 5分钟
  CACHE_TTL: {
    SHORT: 60,                // 1分钟
    MEDIUM: 300,              // 5分钟
    LONG: 3600,               // 1小时
    DAY: 86400                // 24小时
  }
}

// 图片配置
export const IMAGE = {
  COMPRESS: {
    MAX_WIDTH: 500,
    MAX_HEIGHT: 500,
    QUALITY: 85
  },
  THUMBNAIL: {
    MAX_WIDTH: 200,
    MAX_HEIGHT: 200,
    QUALITY: 80
  },
  COVER: {
    MAX_WIDTH: 800,
    MAX_HEIGHT: 800,
    QUALITY: 90
  }
}

// 文件配置
export const FILE = {
  MAX_SIZE: {
    DEFAULT: 500 * 1024 * 1024,    // 默认 500MB
    IMAGE: 10 * 1024 * 1024,       // 图片 10MB
    VIDEO: 2048 * 1024 * 1024      // 视频 2GB
  },
  CHUNK_SIZE: 2 * 1024 * 1024,     // 分片大小 2MB
  TEMP_DIR: 'temp'
}

// 音乐配置
export const MUSIC = {
  SUPPORTED_FORMATS: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'],
  METADATA_BATCH_SIZE: 100         // 元数据批量处理大小
}

// Steam API 配置
export const STEAM = {
  SYNC_BATCH_SIZE: 50,
  COVER_RETRY_COUNT: 3,
  API_TIMEOUT: 15000,
  RATE_LIMIT_DELAY: 1000           // API 调用间隔 (ms)
}

// 安全配置
export const SECURITY = {
  JWT_SECRET_MIN_LENGTH: 32,
  BCRYPT_SALT_ROUNDS: 10,
  MAX_LOGIN_ATTEMPTS: 5,
  LOGIN_LOCKOUT_TIME: 900          // 15分钟
}

// 缓存键前缀
export const CACHE_PREFIX = {
  MUSIC_LIST: 'music:list',
  MUSIC_DETAIL: 'music:detail',
  GAME_LIST: 'games:list',
  GAME_DETAIL: 'games:detail',
  DOCUMENT_LIST: 'documents:list',
  ANIME_LIST: 'anime:list',
  BLOG_LIST: 'blog:list',
  STATS: 'stats'
}
