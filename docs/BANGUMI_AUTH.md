# Bangumi API 认证配置说明

## 为什么需要认证？

Bangumi API 对未认证请求有默认限制：
- **未认证请求**：搜索结果数量受限（可能10-30条不等）
- **认证请求**：可以获取更多结果（最多100条，我们设置50条）

---

## 快速获取 Access Token（推荐）

### 步骤1：生成Token

1. 访问：https://next.bgm.tv/demo/access-token
2. 使用Bangumi账号登录
3. 选择Token有效期（推荐选择 **365天**）
4. 点击"生成新Token"
5. **复制生成的Access Token**

### 步骤2：配置环境变量

在 `docker-compose.yml` 的后端服务中添加环境变量：

```yaml
backend:
  environment:
    - BANGUMI_ACCESS_TOKEN=你复制的Access_Token
    # 其他环境变量...
```

或者修改 `.env` 文件（如果使用）：

```
BANGUMI_ACCESS_TOKEN=你复制的Access_Token
```

### 步骤3：重启服务

```bash
docker-compose restart backend
```

或者重新构建：

```bash
docker-compose up -d --build backend
```

---

## 智能Token管理

系统会自动检测Token状态：

### ✅ Token有效时
- **不显示任何提示**（不打扰用户）
- 搜索功能正常使用

### ⚠️ Token失效时
- **自动显示警告提示**
- 提示："⚠️ Bangumi Token 已失效，请重新配置"
- 提供"更新Token"按钮

### 🔍 检测机制
- **实时检测**：搜索时如果返回401错误，立即标记Token失效
- **定期验证**：每小时验证一次Token有效性（避免频繁API调用）
- **智能缓存**：验证结果缓存1小时，减少不必要的API请求

---

## Token有效期选择

| 有效期 | 刷新频率 | 推荐场景 |
|--------|---------|---------|
| **7天** | 每周一次 | 频繁使用，安全性优先 |
| **14天** | 每两周一次 | 平衡使用和安全 |
| **30天** | 每月一次 | 偶尔使用 |
| **90天** | 每季度一次 | 低频使用 |
| **180天** | 每半年一次 | 很少使用 |
| **365天** | 每年一次 | 长期稳定使用（推荐） |

**推荐选择365天**，一年只需要刷新一次！

---

## Token过期处理

### 自动检测
系统会在以下情况检测Token失效：
1. 搜索时返回401错误
2. 定期验证（每小时）

### 手动更新
当看到"⚠️ Bangumi Token 已失效"提示时：
1. 点击"更新Token"按钮
2. 访问 https://next.bgm.tv/demo/access-token
3. 生成新Token（选择365天有效期）
4. 更新 `docker-compose.yml` 中的 `BANGUMI_ACCESS_TOKEN`
5. 重启后端：`docker-compose restart backend`

---

## 为什么从10条变成20条？

你可能会看到搜索结果从10条变成20条，这是正常的：

1. **Bangumi API动态限制**：
   - 未认证请求：可能返回10-30条不等
   - 认证请求：最多100条（我们请求50条）

2. **影响因素**：
   - 搜索关键词的匹配度
   - Bangumi服务器负载
   - API版本差异

3. **推荐做法**：
   - 配置Token以获得稳定的结果数量
   - 选择365天有效期减少维护成本

---

## 常见问题

### Q: 不配置Token会怎样？
A: 搜索结果数量受限（可能10-30条），但功能正常使用。

### Q: Token泄露了怎么办？
A: 访问 https://next.bgm.tv/demo/access-token 撤销旧Token，生成新Token。

### Q: 如何测试Token是否有效？
A: 系统会自动检测。如果失效，前端会显示警告提示。

### Q: Token有效期选多久最合适？
A: 推荐选择365天，一年刷新一次即可。

### Q: 为什么不一直显示"Token已配置"？
A: 为了不打扰用户，只在Token失效时显示警告。Token有效时不显示任何提示。

### Q: 搜索时看到"Token已失效"提示怎么办？
A: 点击"更新Token"按钮，生成新Token并配置，然后重启后端即可。

---

## 技术细节

代码位置：
- 后端：`backend/src/routes/anime.js`
- 前端：`frontend/src/views/Anime.vue`

### 后端Token验证逻辑

```javascript
// Token状态缓存（避免频繁验证）
let tokenStatusCache = {
  isValid: null,
  lastCheck: 0,
  ttl: 3600000 // 1小时缓存
}

// 验证Token是否有效
async function validateToken() {
  // 使用缓存
  if (缓存有效) return 缓存结果

  // 调用API验证
  const response = await axios.get('/subjects/1')
  return response.status !== 401
}

// 搜索时捕获401错误
axios.post('/search/subjects').catch(error => {
  if (error.response?.status === 401) {
    tokenStatusCache.isValid = false
  }
})
```

### 前端提示逻辑

```vue
<!-- 只在Token失效时显示 -->
<t-card v-if="tokenStatus.hasToken && !tokenStatus.isValid" theme="warning">
  <t-space align="center">
    <t-icon name="error-circle" />
    <span>⚠️ Bangumi Token 已失效，请重新配置</span>
    <t-button @click="openTokenPage">更新 Token</t-button>
  </t-space>
</t-card>
```
