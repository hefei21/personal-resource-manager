# IP黑名单自动防护方案

## 功能概述

自动检测并拉黑频繁访问不存在接口（404）的恶意IP，防止扫描攻击和暴力破解。

## 核心机制

### 1. 自动检测规则

| 条件 | 阈值 | 处理方式 |
|------|------|----------|
| 10分钟内404次数 | ≥20次 | 临时拉黑24小时 |
| 1小时内404次数 | ≥100次 | 永久拉黑 |

### 2. 执行流程

```
请求 → IP黑名单检查 → 攻击拦截 → 访问日志记录
                              ↓
                        404响应 → 记录并检查阈值 → 自动拉黑
```

### 3. 数据库表结构

#### ip_blacklist（黑名单表）
```sql
CREATE TABLE ip_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL UNIQUE,    -- IP地址
  reason TEXT NOT NULL,                -- 拉黑原因
  blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 拉黑时间
  expires_at DATETIME,                 -- 过期时间（NULL表示永久）
  is_permanent BOOLEAN DEFAULT 0,      -- 是否永久
  triggered_count INTEGER DEFAULT 1,   -- 触发次数
  first_404_at DATETIME,               -- 首次404时间
  last_404_at DATETIME,                -- 最后404时间
  notes TEXT                           -- 备注（记录访问路径等）
)
```

#### ip_404_records（404记录表）
```sql
CREATE TABLE ip_404_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,            -- IP地址
  path TEXT NOT NULL,                  -- 访问路径
  user_agent TEXT,                     -- User-Agent
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

## 后端实现

### 1. 中间件执行顺序

```javascript
// index.js 中的中间件顺序（重要！）
1. ipBlacklistMiddleware  // IP黑名单检查（最优先）
2. securityHeaders        // 安全头
3. ...
4. 攻击拦截中间件         // 扫描路径拦截
5. 访问日志中间件         // 记录日志，检测404
```

### 2. 服务文件

- `backend/src/services/ipBlacklist.js` - 黑名单核心服务
- `backend/src/services/logger.js` - 访问日志（集成404检测）

### 3. 管理接口

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/admin/blacklist` | GET | 管理员 | 获取黑名单列表 |
| `/api/admin/blacklist/stats` | GET | 管理员 | 获取统计数据 |
| `/api/admin/blacklist/block` | POST | 管理员 | 手动拉黑IP |
| `/api/admin/blacklist/unblock` | POST | 管理员 | 解除拉黑 |

### 4. 请求示例

#### 手动拉黑
```bash
POST /api/admin/blacklist/block
{
  "ipAddress": "165.154.63.11",
  "reason": "频繁扫描不存在的接口",
  "durationHours": 24  // -1表示永久
}
```

#### 解除拉黑
```bash
POST /api/admin/blacklist/unblock
{
  "ipAddress": "165.154.63.11"
}
```

## 前端实现

### 1. 管理页面

- **入口**：访问日志页面 → 点击「IP黑名单」按钮
- **组件**：`frontend/src/views/admin/Blacklist.vue`
- **使用方式**：在 Logs.vue 中以抽屉形式打开

### 2. 功能特性

- 统计卡片：累计拉黑、生效中、永久拉黑、今日新增
- 黑名单列表：分页展示、搜索筛选
- 手动拉黑：支持设置时长（24小时/7天/30天/永久）
- 一键解除：解除拉黑状态

### 3. 代码结构

```
Logs.vue
├── 访问日志列表
├── 「IP黑名单」按钮
└── t-drawer（抽屉）
    └── Blacklist.vue（黑名单管理面板）
```

## 配置说明

### 黑名单阈值配置

在 `ipBlacklist.js` 中修改：

```javascript
const BLACKLIST_CONFIG = {
  max404Count: 20,           // 10分钟内触发404次数阈值
  windowMs: 10 * 60 * 1000,  // 统计窗口（10分钟）
  blockDurationMs: 24 * 60 * 60 * 1000,  // 临时拉黑时长（24小时）
  permanentBlockThreshold: 100,  // 永久拉黑阈值（1小时）
  cleanupIntervalMs: 60 * 60 * 1000  // 清理任务间隔（1小时）
}
```

### 本地IP白名单

以下IP段不会触发自动拉黑：
- 127.0.0.1, ::1（本地回环）
- 192.168.x.x（私有网络）
- 10.x.x.x（私有网络）
- 172.16-31.x.x（私有网络）

## 自动清理任务

1. **404记录清理**：保留7天后自动删除
2. **过期拉黑记录**：临时拉黑过期后自动删除
3. **内存缓存刷新**：每分钟刷新一次黑名单缓存

## 日志输出

```
[IP黑名单] 缓存刷新完成，当前拉黑IP数量: 5
[IP黑名单] ⚠️ 临时拉黑IP: 165.154.63.11, 404次数: 25
[IP黑名单] 🚨 永久拉黑IP: 192.168.1.100, 404次数: 105
[IP黑名单] 拒绝访问: 165.154.63.11 请求 GET /api/shop/getKF
```

## 注意事项

1. **中间件顺序很重要**：黑名单检查必须在攻击拦截之前
2. **内存缓存优化**：使用内存缓存避免频繁查询数据库
3. **不会误伤正常用户**：
   - 本地IP自动跳过
   - 阈值设置合理（20次404在10分钟内）
   - 临时拉黑24小时后自动解除

## 集成日志模块分类

在 `logger.js` 中，被黑名单拦截的请求会记录：
- module: '攻击拦截'（如果是扫描路径）
- 或者直接返回 403 不会进入日志记录（如果是已拉黑IP）
