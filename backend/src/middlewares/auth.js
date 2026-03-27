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

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  )
}
