import rateLimit from 'express-rate-limit'
import helmet from 'helmet'

/**
 * 安全中间件配置
 * 针对读场景优化，重点防护频繁请求和恶意攻击
 */

/**
 * 获取真实客户端IP
 * 防止伪造IP攻击
 */
export const getClientIP = (req) => {
  // 信任代理时，从 X-Forwarded-For 获取
  // 格式: client, proxy1, proxy2
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    // 取第一个IP（真实客户端IP）
    const ips = forwarded.split(',').map(ip => ip.trim())
    const clientIP = ips[0]
    // 验证IP格式
    if (isValidIP(clientIP)) {
      return clientIP
    }
  }
  
  // 检查 X-Real-IP
  const realIP = req.headers['x-real-ip']
  if (realIP && isValidIP(realIP)) {
    return realIP
  }
  
  // 回退到连接IP
  return req.ip
}

/**
 * 验证IP地址格式
 */
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false
  
  // IPv4 验证
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
  
  // IPv6 验证（简化版）
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip)
}

/**
 * 登录速率限制（最严格）
 * 防止暴力破解密码
 */
export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5分钟
  max: 5, // 最多5次尝试
  message: {
    message: '登录尝试过于频繁，请5分钟后再试',
    retryAfter: '5 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 使用真实客户端IP
  keyGenerator: (req) => {
    const realIP = getClientIP(req)
    return `${realIP}-${req.body.username || 'unknown'}`
  }
})

/**
 * 私密空间密码验证限制（严格）
 * 防止暴力破解私密空间密码
 */
export const privateSpaceLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5分钟
  max: 10, // 最多10次尝试（提升用户体验）
  message: {
    message: '密码验证次数过多，请5分钟后再试',
    retryAfter: '5 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
})

/**
 * 写操作速率限制（中等）
 * 管理员才有的权限，正常使用不会触发
 */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 20, // 最多20次操作
  message: {
    message: '操作过于频繁，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 只限制已认证用户（管理员）
  skip: (req) => {
    return !req.user || req.user.isGuest
  },
  keyGenerator: (req) => getClientIP(req)
})

/**
 * 读操作速率限制（宽松）
 * 正常浏览不会触发，防止爬虫和恶意请求
 */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 200, // 最多200次请求（正常用户不会达到）
  message: {
    message: '请求过于频繁，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 使用真实客户端IP
  keyGenerator: (req) => {
    const realIP = getClientIP(req)
    return req.user?.isGuest ? `guest-${realIP}` : `user-${req.user?.id || realIP}`
  }
})

/**
 * 文件下载速率限制（严格）
 * 防止资源盗链和拖垮服务器
 */
export const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 30, // 最多30次下载
  message: {
    message: '下载请求过于频繁，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
})

/**
 * 搜索速率限制（中等）
 * 防止搜索功能被滥用
 */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 30, // 最多30次搜索
  message: {
    message: '搜索请求过于频繁，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
})

/**
 * 全局速率限制（兜底）
 * 防止整体请求过多
 * 注：/api/ebooks 资源接口有单独限制，不计入全局
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 300, // 全局最多300次请求
  message: {
    message: '服务器繁忙，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req),
  skip: (req) => {
    // 跳过电子书资源请求，使用专门的限流器
    return req.path.startsWith('/api/ebooks/') && req.path.endsWith('/resource')
  }
})

/**
 * 电子书资源限流（单独控制）
 * EPUB阅读器会并发加载多张图片，需要更宽松的限制
 */
export const ebookResourceLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 100, // 每分钟最多100次资源请求（足够阅读使用）
  message: {
    message: '资源请求过于频繁，请稍后再试'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
})

/**
 * Helmet 安全头配置
 * 防止 XSS、点击劫持等攻击
 */
export const securityHeaders = helmet({
  // 内容安全策略（允许内联样式和脚本，因为前端需要）
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"]
    }
  },
  // 防止点击劫持
  frameguard: {
    action: 'deny'
  },
  // 防止 MIME 类型嗅探
  noSniff: true,
  // XSS 过滤器
  xssFilter: true,
  // 不暴露技术栈信息
  hidePoweredBy: true,
  // 禁止 IE 执行下载
  ieNoOpen: true,
  // 禁用 DNS 预解析
  dnsPrefetchControl: {
    allow: false
  }
})

/**
 * 输入验证中间件
 * 验证分页参数，防止获取过多数据
 */
export const validatePagination = (req, res, next) => {
  const { page = 1, limit = 20 } = req.query
  
  // 转换为数字
  const pageNum = parseInt(page, 10)
  const limitNum = parseInt(limit, 10)
  
  // 验证范围
  if (isNaN(pageNum) || pageNum < 1) {
    return res.status(400).json({ message: '页码参数无效' })
  }
  
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({ message: '每页数量参数无效（1-100）' })
  }
  
  // 注入到请求对象
  req.pagination = {
    page: pageNum,
    limit: limitNum,
    offset: (pageNum - 1) * limitNum
  }
  
  next()
}

/**
 * ID 参数验证中间件
 * 防止 SQL 注入和非法参数
 */
export const validateId = (paramName = 'id') => {
  return (req, res, next) => {
    const id = req.params[paramName] || req.query[paramName]
    
    // 必须是正整数
    const idNum = parseInt(id, 10)
    if (isNaN(idNum) || idNum < 1) {
      return res.status(400).json({ message: 'ID 参数无效' })
    }
    
    next()
  }
}

/**
 * 防盗链检查中间件
 * 检查 Referer，防止资源被盗链
 */
export const checkReferer = (req, res, next) => {
  // 开发环境跳过检查
  if (process.env.NODE_ENV === 'development') {
    return next()
  }
  
  const referer = req.get('Referer')
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || []
  
  // 如果有 Referer，检查是否在白名单中
  if (referer && allowedOrigins.length > 0) {
    const refererOrigin = new URL(referer).origin
    if (!allowedOrigins.some(origin => refererOrigin.includes(origin))) {
      return res.status(403).json({ message: '禁止访问' })
    }
  }
  
  next()
}

/**
 * 慢查询检测中间件
 * 记录响应时间过长的请求
 */
export const slowQueryDetector = (threshold = 3000) => {
  return (req, res, next) => {
    const startTime = Date.now()
    
    // 监听响应完成
    res.on('finish', () => {
      const duration = Date.now() - startTime
      
      // 超过阈值记录日志
      if (duration > threshold) {
        console.warn(`⚠️  慢查询: ${req.method} ${req.url} - ${duration}ms`)
      }
    })
    
    next()
  }
}

/**
 * 外部API调用速率限制（严格）
 * Bangumi API、外部资源搜索等
 */
export const externalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 10, // 最多10次外部API调用
  message: {
    message: '外部资源请求过于频繁，请稍后再试（每分钟最多10次）',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 根据用户身份 + 真实IP 组合限制
  keyGenerator: (req) => {
    const userId = req.user?.id || 'anonymous'
    const realIP = getClientIP(req)
    return `external-${userId}-${realIP}`
  }
})

/**
 * 爬虫速率限制（非常严格）
 * Anna Archive、Nyaa、DMHY 等爬虫接口
 */
export const scraperLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 5, // 最多5次爬虫请求
  message: {
    message: '资源搜索请求过于频繁，请稍后再试（每分钟最多5次）',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 根据用户身份 + 真实IP 组合限制
  keyGenerator: (req) => {
    const userId = req.user?.id || 'anonymous'
    const realIP = getClientIP(req)
    return `scraper-${userId}-${realIP}`
  }
})

/**
 * Bangumi API 速率限制（中等）
 * Bangumi 官方API相对友好，可以稍宽松
 */
export const bangumiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 15, // 最多15次 Bangumi API 调用
  message: {
    message: 'Bangumi API 请求过于频繁，请稍后再试',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 根据用户身份 + 真实IP 限制
  keyGenerator: (req) => {
    const realIP = getClientIP(req)
    return `bangumi-${req.user?.id || realIP}`
  }
})

/**
 * 缓存绕过检查中间件
 * 如果请求命中缓存，跳过速率限制
 */
export const bypassCacheLimiter = (limiter) => {
  return (req, res, next) => {
    // 检查是否标记为缓存命中（由路由设置）
    if (req.cacheHit) {
      return next() // 缓存命中，跳过限制
    }
    
    // 缓存未命中，应用速率限制
    return limiter(req, res, next)
  }
}