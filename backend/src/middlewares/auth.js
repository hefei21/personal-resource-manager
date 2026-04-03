import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

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
    next()
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
    { expiresIn: isGuest ? '24h' : (process.env.JWT_EXPIRE || '7d') }  // 游客 token 24小时过期
  )
}
