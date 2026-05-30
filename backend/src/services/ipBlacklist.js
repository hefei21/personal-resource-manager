import { getDatabase } from '../config/database.js'

// IP黑名单配置
const BLACKLIST_CONFIG = {
  // 自动拉黑阈值：10分钟内触发404次数
  max404Count: 20,
  // 检查窗口：10分钟
  windowMs: 10 * 60 * 1000,
  // 拉黑时长：默认24小时（可根据严重程度调整）
  blockDurationMs: 24 * 60 * 60 * 1000,
  // 永久拉黑阈值：1小时内触发404次数
  permanentBlockThreshold: 100,
  // 清理过期记录的间隔
  cleanupIntervalMs: 60 * 60 * 1000 // 1小时
}

// 内存缓存：当前活跃的可疑IP（用于快速统计）
const suspiciousIps = new Map()

// 内存缓存：已拉黑IP（避免频繁查询数据库）
let blacklistedIpsCache = new Set()
let lastCacheUpdate = 0
let lastCacheSize = 0  // 记录上次缓存大小，用于判断是否有变化
const CACHE_TTL = 60 * 1000 // 缓存1分钟

/**
 * 初始化IP黑名单表
 */
export function initIpBlacklistTable() {
  try {
    const db = getDatabase()
    
    // 创建IP黑名单表
    db.exec(`
      CREATE TABLE IF NOT EXISTS ip_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_permanent BOOLEAN DEFAULT 0,
        triggered_count INTEGER DEFAULT 1,
        first_404_at DATETIME,
        last_404_at DATETIME,
        notes TEXT
      )
    `)
    
    // 创建404记录表（用于统计）
    db.exec(`
      CREATE TABLE IF NOT EXISTS ip_404_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL,
        path TEXT NOT NULL,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    
    // 创建索引
    db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_ip ON ip_blacklist(ip_address)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON ip_blacklist(expires_at)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_404_records_ip ON ip_404_records(ip_address)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_404_records_time ON ip_404_records(created_at)`)
    
    console.log('[IP黑名单] 数据库表初始化完成')
    
    // 启动定时清理任务
    startCleanupTask()
    
    // 加载现有黑名单到内存
    refreshBlacklistCache()
    
  } catch (error) {
    console.error('[IP黑名单] 初始化失败:', error.message)
  }
}

/**
 * 刷新内存中的黑名单缓存
 */
function refreshBlacklistCache() {
  try {
    const db = getDatabase()
    const now = new Date().toISOString()
    
    // 获取所有未过期的拉黑记录
    const rows = db.prepare(`
      SELECT ip_address FROM ip_blacklist 
      WHERE is_permanent = 1 OR expires_at > ?
    `).all(now)
    
    blacklistedIpsCache = new Set(rows.map(r => r.ip_address))
    lastCacheUpdate = Date.now()

    // 只有黑名单数量变化时才打印日志
    const currentSize = blacklistedIpsCache.size
    if (currentSize !== lastCacheSize) {
      console.log(`[IP黑名单] 缓存刷新完成，当前拉黑IP数量: ${currentSize}`)
      lastCacheSize = currentSize
    }
  } catch (error) {
    console.error('[IP黑名单] 缓存刷新失败:', error.message)
  }
}

/**
 * 检查IP是否在黑名单中
 */
export function isBlacklisted(ipAddress) {
  // 检查内存缓存
  if (Date.now() - lastCacheUpdate > CACHE_TTL) {
    refreshBlacklistCache()
  }
  
  if (blacklistedIpsCache.has(ipAddress)) {
    return true
  }
  
  return false
}

/**
 * 获取黑名单中间件（在攻击拦截前执行）
 */
export function ipBlacklistMiddleware(req, res, next) {
  const clientIp = getClientIp(req)
  
  if (isBlacklisted(clientIp)) {
    console.warn(`[IP黑名单] 拒绝访问: ${clientIp} 请求 ${req.method} ${req.path}`)
    return res.status(403).json({
      message: '您的IP已被列入黑名单，请联系管理员',
      code: 'IP_BLOCKED'
    })
  }
  
  next()
}

/**
 * 记录404请求并检查是否需要拉黑
 */
export function record404AndCheck(req) {
  const clientIp = getClientIp(req)
  const path = req.path
  const userAgent = req.get('user-agent') || ''
  const now = Date.now()
  
  // 跳过本地IP
  if (isLocalIp(clientIp)) {
    return
  }
  
  try {
    const db = getDatabase()
    
    // 记录到数据库
    db.prepare(`
      INSERT INTO ip_404_records (ip_address, path, user_agent)
      VALUES (?, ?, ?)
    `).run(clientIp, path, userAgent)
    
    // 更新内存统计
    if (!suspiciousIps.has(clientIp)) {
      suspiciousIps.set(clientIp, {
        count: 1,
        firstTime: now,
        lastTime: now,
        paths: new Set([path])
      })
    } else {
      const record = suspiciousIps.get(clientIp)
      record.count++
      record.lastTime = now
      record.paths.add(path)
      
      // 检查是否需要拉黑
      checkAndBlockIp(clientIp, record)
    }
    
    // 清理过期的内存记录
    cleanupSuspiciousIps()
    
  } catch (error) {
    console.error('[IP黑名单] 记录404失败:', error.message)
  }
}

/**
 * 检查并拉黑IP
 */
function checkAndBlockIp(ipAddress, record) {
  const now = Date.now()
  const windowStart = now - BLACKLIST_CONFIG.windowMs
  
  // 检查是否在时间窗口内
  if (record.firstTime < windowStart) {
    // 重置统计
    record.count = 1
    record.firstTime = now
    record.paths.clear()
    return
  }
  
  // 检查是否达到永久拉黑阈值
  if (record.count >= BLACKLIST_CONFIG.permanentBlockThreshold) {
    blockIp(ipAddress, '频繁访问不存在的接口（自动永久拉黑）', true, record)
    console.warn(`[IP黑名单] 🚨 永久拉黑IP: ${ipAddress}, 404次数: ${record.count}`)
    return
  }
  
  // 检查是否达到临时拉黑阈值
  if (record.count >= BLACKLIST_CONFIG.max404Count) {
    blockIp(ipAddress, '频繁访问不存在的接口（自动拉黑24小时）', false, record)
    console.warn(`[IP黑名单] ⚠️ 临时拉黑IP: ${ipAddress}, 404次数: ${record.count}`)
  }
}

/**
 * 拉黑IP
 */
function blockIp(ipAddress, reason, isPermanent = false, record = null) {
  try {
    const db = getDatabase()
    const now = new Date()
    const expiresAt = isPermanent ? null : new Date(now.getTime() + BLACKLIST_CONFIG.blockDurationMs)
    
    // 检查是否已存在
    const existing = db.prepare('SELECT * FROM ip_blacklist WHERE ip_address = ?').get(ipAddress)
    
    if (existing) {
      // 更新现有记录
      db.prepare(`
        UPDATE ip_blacklist 
        SET triggered_count = triggered_count + 1,
            last_404_at = ?,
            is_permanent = ?,
            expires_at = ?,
            notes = ?
        WHERE ip_address = ?
      `).run(
        now.toISOString(),
        isPermanent ? 1 : 0,
        expiresAt ? expiresAt.toISOString() : null,
        record ? `访问路径: ${Array.from(record.paths).join(', ')}` : null,
        ipAddress
      )
    } else {
      // 创建新记录
      db.prepare(`
        INSERT INTO ip_blacklist 
        (ip_address, reason, expires_at, is_permanent, triggered_count, first_404_at, last_404_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ipAddress,
        reason,
        expiresAt ? expiresAt.toISOString() : null,
        isPermanent ? 1 : 0,
        record ? record.count : 1,
        record ? new Date(record.firstTime).toISOString() : now.toISOString(),
        now.toISOString(),
        record ? `访问路径: ${Array.from(record.paths).join(', ')}` : null
      )
    }
    
    // 更新内存缓存
    blacklistedIpsCache.add(ipAddress)
    
    // 从可疑列表中移除（已处理）
    suspiciousIps.delete(ipAddress)
    
  } catch (error) {
    console.error('[IP黑名单] 拉黑IP失败:', error.message)
  }
}

/**
 * 手动拉黑IP（管理员接口用）
 */
export function manualBlockIp(ipAddress, reason, durationHours = 24) {
  try {
    const db = getDatabase()
    const now = new Date()
    const expiresAt = durationHours === -1 ? null : new Date(now.getTime() + durationHours * 60 * 60 * 1000)
    const isPermanent = durationHours === -1
    
    db.prepare(`
      INSERT OR REPLACE INTO ip_blacklist 
      (ip_address, reason, blocked_at, expires_at, is_permanent, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ipAddress, reason, now.toISOString(), expiresAt ? expiresAt.toISOString() : null, isPermanent ? 1 : 0, '手动拉黑')
    
    blacklistedIpsCache.add(ipAddress)
    
    console.log(`[IP黑名单] 手动拉黑IP: ${ipAddress}, 原因: ${reason}`)
    return { success: true }
  } catch (error) {
    console.error('[IP黑名单] 手动拉黑失败:', error.message)
    return { success: false, message: error.message }
  }
}

/**
 * 解除拉黑
 */
export function unblockIp(ipAddress) {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM ip_blacklist WHERE ip_address = ?').run(ipAddress)
    blacklistedIpsCache.delete(ipAddress)
    
    console.log(`[IP黑名单] 解除拉黑IP: ${ipAddress}`)
    return { success: true }
  } catch (error) {
    console.error('[IP黑名单] 解除拉黑失败:', error.message)
    return { success: false, message: error.message }
  }
}

/**
 * 查询黑名单列表
 */
export function queryBlacklist(params = {}) {
  try {
    const db = getDatabase()
    const { page = 1, pageSize = 50, keyword } = params
    
    let where = '1=1'
    const args = []
    
    if (keyword) {
      where += ' AND (ip_address LIKE ? OR reason LIKE ? OR notes LIKE ?)'
      const kw = `%${keyword}%`
      args.push(kw, kw, kw)
    }
    
    const offset = (page - 1) * pageSize
    
    const total = db.prepare(`SELECT COUNT(*) as count FROM ip_blacklist WHERE ${where}`).get(...args)?.count || 0
    const data = db.prepare(`
      SELECT * FROM ip_blacklist 
      WHERE ${where} 
      ORDER BY blocked_at DESC 
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, offset)
    
    return { data, total, page, pageSize }
  } catch (error) {
    console.error('[IP黑名单] 查询失败:', error.message)
    return { data: [], total: 0, page: 1, pageSize: 50 }
  }
}

/**
 * 获取黑名单统计
 */
export function getBlacklistStats() {
  try {
    const db = getDatabase()
    const now = new Date().toISOString()
    
    const total = db.prepare('SELECT COUNT(*) as count FROM ip_blacklist').get()?.count || 0
    const permanent = db.prepare('SELECT COUNT(*) as count FROM ip_blacklist WHERE is_permanent = 1').get()?.count || 0
    const active = db.prepare('SELECT COUNT(*) as count FROM ip_blacklist WHERE is_permanent = 1 OR expires_at > ?').get(now)?.count || 0
    const todayBlocked = db.prepare(`SELECT COUNT(*) as count FROM ip_blacklist WHERE DATE(blocked_at) = DATE('now')`).get()?.count || 0
    
    return { total, permanent, active, todayBlocked }
  } catch (error) {
    console.error('[IP黑名单] 获取统计失败:', error.message)
    return { total: 0, permanent: 0, active: 0, todayBlocked: 0 }
  }
}

/**
 * 清理过期的可疑IP记录
 */
function cleanupSuspiciousIps() {
  const now = Date.now()
  const expireTime = now - BLACKLIST_CONFIG.windowMs
  
  for (const [ip, record] of suspiciousIps) {
    if (record.lastTime < expireTime) {
      suspiciousIps.delete(ip)
    }
  }
}

/**
 * 定时清理任务
 */
function startCleanupTask() {
  setInterval(() => {
    try {
      const db = getDatabase()
      const now = new Date().toISOString()
      
      // 删除过期的404记录（保留7天用于分析）
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const deleted404 = db.prepare('DELETE FROM ip_404_records WHERE created_at < ?').run(sevenDaysAgo)
      
      // 删除过期的拉黑记录
      const deletedBlacklist = db.prepare('DELETE FROM ip_blacklist WHERE is_permanent = 0 AND expires_at < ?').run(now)
      
      if (deleted404.changes > 0 || deletedBlacklist.changes > 0) {
        console.log(`[IP黑名单] 清理完成: 删除${deleted404.changes}条404记录, ${deletedBlacklist.changes}条过期拉黑记录`)
      }
      
      // 刷新缓存
      refreshBlacklistCache()
      
    } catch (error) {
      console.error('[IP黑名单] 清理任务失败:', error.message)
    }
  }, BLACKLIST_CONFIG.cleanupIntervalMs)
}

/**
 * 获取客户端真实IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip ||
         'unknown'
}

/**
 * 检查是否是本地IP
 */
function isLocalIp(ip) {
  if (!ip || ip === 'unknown') return true
  if (ip === '127.0.0.1' || ip === '::1') return true
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

export default {
  initIpBlacklistTable,
  ipBlacklistMiddleware,
  record404AndCheck,
  manualBlockIp,
  unblockIp,
  queryBlacklist,
  getBlacklistStats,
  isBlacklisted
}
