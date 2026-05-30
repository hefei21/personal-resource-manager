# 🔒 安全加固部署指南

**更新日期**: 2026-04-13  
**适用场景**: 读场景优化，防护频繁请求和恶意攻击

---

## 📋 快速部署

### 1. 安装安全依赖

```bash
cd backend
npm install express-rate-limit helmet
```

### 2. 生成强密钥

```bash
# JWT 密钥（64字节）
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 默认密码（16字节）
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### 3. 配置环境变量

```bash
# 复制示例文件
cp backend/.env.production.example backend/.env.production

# 编辑配置
nano backend/.env.production
```

**必须修改的配置**：
```bash
JWT_SECRET=<刚才生成的JWT密钥>
DEFAULT_PASSWORD=<刚才生成的随机密码>
CORS_ORIGIN=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
```

### 4. 修改 docker-compose.yml

```yaml
services:
  backend:
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET}  # 从环境变量读取
      - DEFAULT_PASSWORD=${DEFAULT_PASSWORD}
      - CORS_ORIGIN=https://your-domain.com
```

### 5. 重新部署

```bash
docker-compose down
docker-compose build backend
docker-compose up -d
```

---

## 🛡️ 安全措施说明

### 1. 速率限制策略

| 接口类型 | 限制规则 | 说明 |
|---------|---------|------|
| **登录接口** | 5次/5分钟 | 防止暴力破解密码 |
| **私密空间密码** | 3次/5分钟 | 防止暴力破解私密空间 |
| **写操作** | 20次/分钟 | 管理员操作，正常使用不会触发 |
| **读操作** | 200次/分钟 | 正常浏览，防止爬虫滥用 |
| **文件下载** | 30次/分钟 | 防止资源盗链 |
| **搜索接口** | 30次/分钟 | 防止搜索功能滥用 |
| **全局限制** | 300次/分钟 | 兜底防护 |
| **Bangumi API** | 15次/分钟 | 外部API调用，相对宽松 |
| **爬虫接口** | 5次/分钟 | Anna Archive、Nyaa、DMHY等，非常严格 |

**特殊说明**：
- ✅ 缓存命中：不消耗速率限制次数
- ✅ 游客限制更严格：防止匿名滥用
- ⚠️ 爬虫接口：触发目标网站WAF风险高

### 2. 安全响应头

使用 Helmet 中间件添加以下安全头：

- ✅ `X-Frame-Options: DENY` - 防止点击劫持
- ✅ `X-Content-Type-Options: nosniff` - 防止 MIME 嗅探
- ✅ `X-XSS-Protection: 1; mode=block` - XSS 过滤器
- ✅ `Content-Security-Policy` - 内容安全策略
- ✅ `X-Powered-By` - 隐藏技术栈信息

### 3. CORS 限制

**生产环境**：只允许白名单域名访问  
**开发环境**：允许所有来源（方便调试）

### 4. 错误信息脱敏

**生产环境**：只返回通用错误信息  
**开发环境**：返回详细错误信息（含堆栈）

### 5. 慢查询检测

记录响应时间超过 3 秒的请求，便于性能优化。

---

## 🔍 安全验证

### 1. 检查安全头

```bash
curl -I https://your-domain.com/api/stats
```

**预期输出**：
```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Content-Security-Policy: default-src 'self'; ...
```

### 2. 测试速率限制

```bash
# 登录接口（5次后应被限制）
for i in {1..10}; do
  curl -X POST https://your-domain.com/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"wrong"}'
  echo ""
done
```

**预期输出**（第6次开始）：
```json
{"message":"登录尝试过于频繁，请5分钟后再试"}
```

### 3. 测试 CORS

```bash
curl -H "Origin: https://evil.com" \
     -H "Access-Control-Request-Method: POST" \
     -X OPTIONS https://your-domain.com/api/auth/login
```

**预期输出**（生产环境）：
```
HTTP/1.1 403 Forbidden
```

---

## 🚨 安全监控

### 1. 查看速率限制日志

```bash
docker logs pr-manager-backend | grep "Too many requests"
```

### 2. 查看慢查询日志

```bash
docker logs pr-manager-backend | grep "慢查询"
```

### 3. 查看安全事件

```bash
# 登录失败
docker logs pr-manager-backend | grep "用户不存在\|密码不匹配"

# 速率限制触发
docker logs pr-manager-backend | grep "请求过于频繁"
```

---

## 🛠️ 高级配置

### 1. 自定义速率限制

编辑 `backend/src/middlewares/security.js`：

```javascript
// 例如：调整读操作限制为 100次/分钟
export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,  // 修改这里
  // ...
})
```

### 2. 添加 IP 白名单

```javascript
// 在 loginLimiter 中添加
skip: (req) => {
  const whitelistIPs = ['192.168.1.100', '10.0.0.1']
  return whitelistIPs.includes(req.ip)
}
```

### 3. 禁用某些安全头

```javascript
// 在 securityHeaders 配置中
export const securityHeaders = helmet({
  frameguard: false,  // 如果需要 iframe 嵌入
  contentSecurityPolicy: false  // 如果有兼容性问题
})
```

---

## ⚠️ 注意事项

### 1. 首次部署

- ✅ 必须修改 JWT_SECRET
- ✅ 必须修改 DEFAULT_PASSWORD
- ✅ 必须配置 CORS_ORIGIN

### 2. 反向代理

如果使用 Nginx 反向代理，需要配置：

```nginx
# 传递真实 IP
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

# 信任代理
app.set('trust proxy', 1)  # 在 index.js 中添加
```

### 3. 性能影响

- 速率限制：内存消耗极小（< 1MB）
- Helmet 安全头：性能影响可忽略
- 慢查询检测：仅增加微秒级延迟

---

## 📞 问题排查

### 问题：登录后提示"请求过于频繁"

**原因**：触发了速率限制  
**解决**：
1. 等待 5 分钟后重试
2. 检查是否有脚本自动登录
3. 调整速率限制参数

### 问题：前端跨域错误

**原因**：CORS 配置不匹配  
**解决**：
1. 检查 `CORS_ORIGIN` 环境变量
2. 确保前端域名在白名单中

### 问题：安全头导致功能异常

**原因**：Content-Security-Policy 过于严格  
**解决**：
1. 检查浏览器控制台 CSP 错误
2. 调整 CSP 配置（添加必要的域名）

---

## 📊 安全评分对比

| 安全措施 | 修复前 | 修复后 |
|---------|--------|--------|
| **速率限制** | ❌ 无 | ✅ 多级限制 |
| **安全响应头** | ❌ 无 | ✅ Helmet 全套 |
| **CORS 保护** | ⚠️ 允许所有 | ✅ 白名单限制 |
| **错误信息脱敏** | ❌ 暴露详情 | ✅ 生产环境隐藏 |
| **登录保护** | ⚠️ 无限制 | ✅ 5次/5分钟 |
| **防盗链** | ❌ 无 | ✅ Referer 检查 |
| **慢查询检测** | ❌ 无 | ✅ 3秒阈值 |

**总体评分**: 3.0/5.0 → **4.5/5.0** ⭐

---

## 📝 更新日志

### 2026-04-13 - 安全加固版本

- ✅ 添加 Helmet 安全头中间件
- ✅ 添加多级速率限制策略
- ✅ 修复 CORS 配置漏洞
- ✅ 错误信息生产环境脱敏
- ✅ 移除日志中的敏感信息
- ✅ 添加慢查询检测
- ✅ 创建环境变量配置模板

---

## 🔗 相关文档

- [安全审计报告](./security-quick-fix.md)
- [安全检查脚本](./security-check.sh)
- [部署指南](../README.md)