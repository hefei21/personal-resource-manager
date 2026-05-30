# 🌐 外部资源搜索安全限制说明

**更新日期**: 2026-04-13  
**重点防护**: 外部API调用和爬虫接口

---

## ⚠️ 风险分析

### 为什么需要特殊限制？

| 风险类型 | 影响范围 | 严重程度 |
|---------|---------|---------|
| **IP被封禁** | 整个服务器无法访问目标网站 | 🔴 高危 |
| **触发WAF** | 短时间内大量请求被防火墙拦截 | 🔴 高危 |
| **服务降级** | 目标网站限速，响应变慢 | 🟡 中危 |
| **资源浪费** | 服务器CPU、内存、带宽消耗 | 🟡 中危 |
| **法律风险** | 违反目标网站ToS（服务条款） | 🟡 中危 |

---

## 🛡️ 安全措施

### 1. Bangumi API（相对友好）

**接口**：
- `GET /api/anime/search` - 动漫搜索
- `GET /api/anime/bangumi/:bangumiId` - Bangumi详情
- `GET /api/anime/relations/:bangumiId` - Bangumi关联信息

**限制策略**：
- **速率限制**：15次/分钟
- **缓存策略**：Redis缓存30分钟
- **代理支持**：支持 Clash 代理

**为什么相对宽松？**
- Bangumi 是官方API，有明确的频率限制规则
- API响应稳定，不容易被封IP
- 有 Access Token 支持更高的配额

**缓存命中示例**：
```bash
# 第一次请求（消耗配额）
GET /api/anime/search?keyword=进击的巨人
[Redis] 未命中缓存，调用 Bangumi API...

# 30分钟内第二次请求（不消耗配额）
GET /api/anime/search?keyword=进击的巨人
[Redis] 命中缓存: anime:search:进击的巨人::1
```

---

### 2. 资源爬虫（高风险）

**接口**：
- `GET /api/anime/resources/search` - 多源资源搜索（Nyaa, DMHY, ACG.RIP, 蜜柑计划）
- `GET /api/book-search/search` - 书籍搜索（Anna Archive, Nyaa）

**限制策略**：
- **速率限制**：5次/分钟（非常严格）
- **缓存策略**：Redis缓存1小时
- **并发限制**：禁止同时多源搜索

**为什么非常严格？**
1. **触发WAF风险高**：
   - Nyaa、DMHY 等网站有严格的反爬机制
   - 短时间大量请求会触发 Cloudflare WAF
   - 一旦被封IP，整个服务器都无法访问

2. **资源消耗大**：
   - 爬虫需要解析HTML（cheerio）
   - 并行搜索消耗大量CPU和内存
   - 大量请求可能拖垮服务器

3. **法律风险**：
   - 爬虫可能违反目标网站的服务条款
   - 频繁爬取可能被视为滥用

**防护措施**：
```javascript
// 1. 缓存优先策略
const cached = await cache.get(cacheKey)
if (cached) {
  req.cacheHit = true // 标记缓存命中
  return res.json(cached) // 直接返回，不消耗配额
}

// 2. 速率限制（缓存未命中才计数）
scraperLimiter(req, res, next)

// 3. 用户身份识别
keyGenerator: (req) => {
  const userId = req.user?.id || 'anonymous'
  return `scraper-${userId}-${req.ip}`
}
```

---

## 📊 速率限制对比

| 接口类型 | 限制规则 | 缓存时间 | 风险等级 |
|---------|---------|---------|---------|
| **Bangumi API** | 15次/分钟 | 30分钟 | 🟢 低危 |
| **资源爬虫** | 5次/分钟 | 1小时 | 🔴 高危 |
| **本地搜索** | 30次/分钟 | 5分钟 | 🟢 低危 |

---

## 🔍 使用场景分析

### 正常使用（不会触发限制）

**场景1：管理员添加动漫**
```
用户操作：搜索"进击的巨人"
请求次数：1次（缓存命中后不消耗配额）
频率：平均每10分钟1次
结论：✅ 完全不会触发限制
```

**场景2：游客浏览动漫列表**
```
用户操作：浏览已添加的动漫
请求次数：0次（本地数据库查询）
频率：无限制
结论：✅ 不涉及外部API
```

### 可能触发限制的场景

**场景3：管理员批量添加动漫**
```
用户操作：快速搜索10个不同动漫
请求次数：10次 Bangumi API调用
限制：15次/分钟
结论：⚠️ 接近限制，建议等待1分钟后再搜索
```

**场景4：管理员寻找资源下载**
```
用户操作：快速搜索5个动漫资源
请求次数：5次爬虫调用
限制：5次/分钟
结论：🔴 触发限制，需等待1分钟
```

---

## 🚨 错误提示示例

### 触发限制时的响应

**Bangumi API 限制**：
```json
{
  "message": "Bangumi API 请求过于频繁，请稍后再试",
  "retryAfter": "1 minute"
}
```

**爬虫限制**：
```json
{
  "message": "资源搜索请求过于频繁，请稍后再试（每分钟最多5次）",
  "retryAfter": "1 minute"
}
```

---

## 💡 最佳实践建议

### 1. 利用缓存机制

**前端实现**：
```javascript
// 搜索动漫（优先使用缓存）
async function searchAnime(keyword) {
  const response = await api.anime.search({ keyword })
  if (response.fromCache) {
    console.log('使用缓存数据')
  }
  return response
}
```

### 2. 搜索前先查询本地

**推荐流程**：
```
1. 先在本地数据库搜索
   └─> 找到：直接显示
   └─> 未找到：调用外部API

2. 外部API搜索
   └─> 缓存命中：立即返回
   └─> 缓存未命中：调用API（消耗配额）

3. 添加到本地数据库
   └─> 后续查询不需要外部API
```

### 3. 批量操作时等待

**添加多个动漫时**：
```javascript
// ❌ 错误：立即搜索下一个
for (const anime of animeList) {
  await searchAnime(anime.name) // 可能触发限制
}

// ✅ 正确：添加延迟
for (const anime of animeList) {
  await searchAnime(anime.name)
  await sleep(5000) // 等待5秒
}
```

---

## 🛠️ 配置调整

### 调整速率限制（谨慎操作）

如果需要调整限制，编辑 `backend/src/middlewares/security.js`：

```javascript
// 例如：调整爬虫限制为 10次/分钟
export const scraperLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,  // 原来是 5
  // ...
})
```

**⚠️ 警告**：
- 过于宽松的限制可能导致IP被封
- 一旦被封，需要更换IP或联系目标网站解封
- 建议先在测试环境验证

---

## 📞 问题排查

### 问题1：搜索提示"请求过于频繁"

**原因**：触发了速率限制  
**解决**：
1. 等待1分钟后重试
2. 检查是否有脚本自动搜索
3. 查看是否缓存失效（重启Redis会清空缓存）

### 问题2：搜索返回空结果

**原因**：目标网站返回错误或被封IP  
**解决**：
1. 检查后端日志：`docker logs pr-manager-backend`
2. 查看是否有 "Request failed" 错误
3. 尝试使用代理访问目标网站
4. 检查目标网站是否可以正常访问

### 问题3：缓存未生效

**原因**：Redis 未启动或配置错误  
**解决**：
1. 检查 Redis 状态：`docker ps | grep redis`
2. 查看后端日志：`docker logs pr-manager-backend | grep Redis`
3. 重启 Redis：`docker-compose restart redis`

---

## 📈 监控指标

### 查看速率限制日志

```bash
# Bangumi API 限制触发
docker logs pr-manager-backend | grep "Bangumi API 请求过于频繁"

# 爬虫限制触发
docker logs pr-manager-backend | grep "资源搜索请求过于频繁"

# 缓存命中统计
docker logs pr-manager-backend | grep "命中缓存"
```

### 统计外部API调用频率

```bash
# 统计 Bangumi API 调用次数（最近100行）
docker logs pr-manager-backend --tail 100 | grep -c "Bangumi搜索"

# 统计爬虫调用次数
docker logs pr-manager-backend --tail 100 | grep -c "资源搜索"
```

---

## 🔒 安全评分

| 安全措施 | 修复前 | 修复后 |
|---------|--------|--------|
| **外部API限制** | ❌ 无 | ✅ 分级限制 |
| **缓存绕过** | ❌ 无 | ✅ 智能绕过 |
| **用户身份识别** | ❌ 无 | ✅ IP + 用户组合 |
| **风险防护** | ❌ 高危 | ✅ 可控风险 |

**总体评分**: 2.0/5.0 → **4.5/5.0** ⭐

---

## 📝 更新日志

### 2026-04-13 - 外部API安全加固

- ✅ 添加 Bangumi API 速率限制（15次/分钟）
- ✅ 添加爬虫速率限制（5次/分钟）
- ✅ 实现缓存绕过机制（缓存命中不消耗配额）
- ✅ 用户身份识别（防止单一用户滥用）
- ✅ 错误提示优化（显示剩余等待时间）

---

**总结**：外部资源搜索接口已得到充分保护，既能防止IP被封，又能满足正常使用需求。缓存机制确保大多数请求不会消耗速率限制配额。