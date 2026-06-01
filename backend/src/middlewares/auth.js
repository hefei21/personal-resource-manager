import jwt from 'jsonwebtoken'
import { runWithContext } from '../utils/dbContext.js'
import { setCurrentReq } from '../config/database.js'

// 强制从环境变量读取JWT密钥，拒绝使用默认值
const JWT_SECRET = process.env.JWT_SECRET

if (!JWT_SECRET) {
  console.error('错误: JWT_SECRET 环境变量未设置')
  console.error('请在 .env 文件或环境变量中设置 JWT_SECRET')
  console.error('示例: JWT_SECRET=your-random-secret-key-at-least-32-characters')
  process.exit(1)
}

if (JWT_SECRET === 'your-secret-key' || JWT_SECRET.length < 32) {
  console.error('错误: JWT_SECRET 不能使用默认值或太短')
  console.error('请设置一个至少32个字符的随机字符串')
  process.exit(1)
}

export function authenticateToken(req, res, next) {
  // 优先从 Authorization 头获取 token，其次从 URL 参数获取
  const authHeader = req.headers['authorization']
  let token = authHeader && authHeader.split(' ')[1]
  
  // 如果头中没有，尝试从 URL 参数获取
  if (!token && req.query.token) {
    token = req.query.token
  }

  if (!token) {
    return res.status(401).json({ message: '需要认证' })
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: '无效的令牌' })
    }
    req.user = user
    
    // 设置 currentReq 以便 getDatabase() 能够获取当前用户
    setCurrentReq(req)
    
    // 在请求结束时清除 currentReq
    res.on('finish', () => {
      setCurrentReq(null)
    })
    
    // 设置数据库上下文，让 getDatabase() 能根据用户返回正确的数据库
    const context = {
      username: user?.username || null,
      userId: user?.id || null,
      isGuest: user?.isGuest || false,
      req: req  // 保存 req 对象以便后续使用
    }
    
    runWithContext(context, () => {
      next()
    })
  })
}

/**
 * 要求写权限 - 拒绝游客的所有写操作
 * 必须在 authenticateToken 之后使用
 */
export function requireWritePermission(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: '需要认证' })
  }
  
  if (req.user.isGuest) {
    return res.status(403).json({ 
      message: '游客无权执行此操作',
      code: 'GUEST_NO_PERMISSION'
    })
  }
  
  next()
}

export function generateToken(user, isGuest = false) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username,
      isGuest: isGuest  // 在 token 中标记是否为游客
    },
    JWT_SECRET,
    { expiresIn: isGuest ? '24h' : (process.env.JWT_EXPIRE || '30d') }  // 游客 token 24小时，普通用户30天
  )
}
