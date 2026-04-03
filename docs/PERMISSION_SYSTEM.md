# 权限管理系统

## 概述

实现了完整的权限管理系统，支持管理员和游客两种角色。

## 角色说明

### 管理员
- 拥有完整的读写权限
- 可以执行所有操作，包括创建、更新、删除等
- 可以修改密码
- Token 有效期：7天（可配置）
- 登录方式：用户名 + 密码登录

### 游客
- 只拥有只读权限
- 可以浏览所有资源
- 无法执行任何写操作（创建、更新、删除）
- Token 有效期：24小时
- 登录方式：点击"游客访问"按钮
- 使用 sessionStorage 存储 token（关闭浏览器后自动清除）

#### 游客可访问的功能

**1. 文档管理**
- ✅ 浏览所有分类和文档
- ✅ 搜索文档
- ✅ 预览文档内容（PDF、文本等）
- ✅ 查看文档版本历史
- ❌ 访问私密空间（需要密码）
- ❌ 创建、编辑、删除分类
- ❌ 上传、更新、删除文档
- ❌ 修改私密空间密码

**2. 音乐管理**
- ✅ 浏览所有音乐和播放列表
- ✅ 搜索音乐
- ✅ 播放音乐
- ✅ 查看歌词
- ❌ 上传、更新、删除音乐
- ❌ 创建、编辑、删除播放列表
- ❌ 下载歌词
- ❌ 音乐去重
- ⚠️ 播放模式和音量不会被记忆（不保存到 localStorage）

**3. 书籍管理**
- ✅ 浏览所有分类和书籍
- ✅ 搜索书籍
- ✅ 在线阅读书籍
- ✅ 查看阅读进度
- ❌ 创建、编辑、删除分类
- ❌ 上传、更新、删除书籍
- ❌ 保存阅读进度（只能查看）

**4. 动漫管理**
- ✅ 浏览所有动漫
- ✅ 搜索动漫
- ✅ 查看动漫详情
- ✅ 从 Bangumi 搜索动漫
- ✅ 查看资源站点测试结果
- ❌ 导入、更新、删除动漫
- ❌ 修改观看状态和评分
- ❌ 切换收藏状态
- ❌ 批量下载封面
- ❌ 测试资源站点

**5. 游戏管理**
- ✅ 浏览所有游戏
- ✅ 搜索游戏
- ✅ 查看游戏详情
- ✅ 查看成就数据
- ❌ 配置 Steam
- ❌ 同步游戏库
- ❌ 更新、删除游戏
- ❌ 修改游戏状态和评分
- ❌ 批量下载封面

**6. 书签管理**
- ✅ 浏览所有书签
- ✅ 搜索书签
- ✅ 点击书签访问链接
- ❌ 创建、更新、删除书签
- ❌ 批量下载图标

**7. 代码仓库**
- ✅ 浏览所有仓库
- ✅ 查看仓库内容
- ❌ 创建、更新、删除仓库
- ❌ 同步仓库

**8. 博客管理**
- ✅ 浏览所有文章（已发布）
- ✅ 搜索文章
- ✅ 预览文章内容
- ❌ 查看、创建、编辑草稿
- ❌ 创建、更新、删除文章
- ❌ 管理分类和标签

#### 游客模式的 UI 表现

1. **按钮状态**
   - 所有写操作按钮显示为禁用状态（灰色）
   - 鼠标悬停时显示"游客无权操作"提示

2. **隐藏功能**
   - 私密空间的创建、删除按钮隐藏
   - 批量操作按钮隐藏或禁用

3. **特殊处理**
   - 音乐播放器：播放模式和音量调节可用，但不会被保存
   - 书籍阅读器：阅读进度只读，不会自动保存
   - 动漫搜索：可以搜索 Bangumi，但不能导入

## 后端实现

### 1. 认证中间件 (`backend/src/middlewares/auth.js`)

#### `authenticateToken(req, res, next)`
验证用户身份，从请求头或URL参数中获取token并验证。

#### `requireWritePermission(req, res, next)`
要求写权限，必须在 `authenticateToken` 之后使用。
- 检查用户是否为游客
- 如果是游客，返回 403 错误，错误码为 `GUEST_NO_PERMISSION`
- 如果不是游客，继续执行

#### `generateToken(user, isGuest = false)`
生成 JWT token
- `isGuest` 参数标记是否为游客
- 游客 token 24小时后过期
- 管理员 token 7天后过期

### 2. 认证路由 (`backend/src/routes/auth.js`)

#### POST `/api/auth/login`
管理员登录
- 验证用户名和密码
- 返回 token 和用户信息（`isGuest: false`）

#### POST `/api/auth/guest-login`
游客登录
- 创建虚拟游客用户
- 返回 token 和用户信息（`isGuest: true`）

#### POST `/api/auth/change-password`
修改密码（仅管理员）
- 需要验证旧密码
- 新密码长度至少6位
- 使用 `requireWritePermission` 中间件

### 3. 路由权限保护

所有写操作路由都已添加 `requireWritePermission` 中间件：

#### 文档管理 (`backend/src/routes/documents.js`)
- POST `/api/documents/categories` - 创建分类
- PUT `/api/documents/categories/:id` - 更新分类
- DELETE `/api/documents/categories/:id` - 删除分类
- PUT `/api/documents/categories/reorder` - 重排序分类
- POST `/api/documents/upload` - 上传文档
- PUT `/api/documents/:id/content` - 更新文档内容
- PUT `/api/documents/:id` - 更新文档元数据
- PUT `/api/documents/batch/update` - 批量更新文档
- DELETE `/api/documents/:id` - 删除文档
- POST `/api/documents/private/upload` - 上传私密文档
- POST `/api/documents/private/change-password` - 修改私密空间密码
- DELETE `/api/documents/private/:id` - 删除私密文档

#### 音乐管理 (`backend/src/routes/music.js`)
- POST `/api/music/upload-chunk` - 上传分片
- POST `/api/music/check-duplicate` - 检查重复
- POST `/api/music/merge-chunks` - 合并分片
- DELETE `/api/music/cancel-upload` - 取消上传
- POST `/api/music/start-upload` - 开始上传
- DELETE `/api/music/cancel-all-uploads` - 取消所有上传
- POST `/api/music/:id/reparse` - 重新解析
- PUT `/api/music/:id` - 更新音乐信息
- DELETE `/api/music/:id` - 删除音乐
- POST `/api/music/batch-delete` - 批量删除
- POST `/api/music/remove-duplicates` - 去重
- POST `/api/music/playlists` - 创建播放列表
- PUT `/api/music/playlists/:id` - 更新播放列表
- DELETE `/api/music/playlists/:id` - 删除播放列表
- POST `/api/music/playlists/:id/songs` - 添加歌曲到播放列表
- DELETE `/api/music/playlists/:id/songs/:songId` - 从播放列表移除歌曲
- POST `/api/music/playlists/:id/songs/batch-remove` - 批量移除歌曲
- PUT `/api/music/playlists/:id/songs/reorder` - 重排序播放列表
- POST `/api/music/lyrics/batch-download` - 批量下载歌词
- PUT `/api/music/:id/lyrics` - 更新歌词
- POST `/api/music/clean-sample-lyrics` - 清理示例歌词

#### 书籍管理 (`backend/src/routes/books.js`)
- POST `/api/ebooks/categories` - 创建分类
- PUT `/api/ebooks/categories/:id` - 更新分类
- DELETE `/api/ebooks/categories/:id` - 删除分类
- PUT `/api/ebooks/categories/reorder` - 重排序分类
- POST `/api/ebooks/upload-chunk` - 上传分片
- POST `/api/ebooks/merge-chunks` - 合并分片
- DELETE `/api/ebooks/cancel-upload` - 取消上传
- POST `/api/ebooks/parse-metadata` - 解析元数据
- POST `/api/ebooks/upload` - 上传书籍
- POST `/api/ebooks/upload-with-path` - 按路径上传
- DELETE `/api/ebooks/:id` - 删除书籍
- POST `/api/ebooks/batch-delete` - 批量删除
- PUT `/api/ebooks/:id` - 更新书籍信息
- POST `/api/ebooks/:id/progress` - 保存阅读进度
- DELETE `/api/ebooks/:id/cache` - 清除缓存

#### 游戏管理 (`backend/src/routes/games.js`)
- POST `/api/games/steam/config` - 保存 Steam 配置
- DELETE `/api/games/steam/config` - 删除 Steam 配置
- POST `/api/games/steam/sync` - 同步 Steam 库
- POST `/api/games/:id/fetch-achievements` - 获取成就
- PUT `/api/games/:id` - 更新游戏信息
- DELETE `/api/games/:id` - 删除游戏
- POST `/api/games/:id/favorite` - 切换收藏
- POST `/api/games/:id/status` - 更新状态
- POST `/api/games/:id/rating` - 评分
- POST `/api/games/batch-download-covers` - 批量下载封面
- POST `/api/games/clear-covers` - 清除封面
- POST `/api/games/:id/refresh-cover` - 刷新封面

#### 动漫管理 (`backend/src/routes/anime.js`)
- POST `/api/anime/import` - 导入动漫
- PUT `/api/anime/:id` - 更新动漫信息
- POST `/api/anime/:id/favorite` - 切换收藏
- POST `/api/anime/:id/status` - 更新观看状态
- POST `/api/anime/:id/rating` - 评分
- POST `/api/anime/:id/refresh` - 刷新信息
- PUT `/api/anime/:id/toggle-hidden` - 切换隐藏状态
- DELETE `/api/anime/:id` - 删除动漫
- POST `/api/anime/batch-download-covers` - 批量下载封面

#### 书签管理 (`backend/src/routes/bookmarks.js`)
- POST `/api/bookmarks` - 创建书签
- PUT `/api/bookmarks/:id` - 更新书签
- DELETE `/api/bookmarks/:id` - 删除书签
- POST `/api/bookmarks/batch-delete` - 批量删除
- POST `/api/bookmarks/batch-download-icons` - 批量下载图标

#### 代码仓库 (`backend/src/routes/code.js`)
- POST `/api/code` - 创建仓库
- PUT `/api/code/:id` - 更新仓库
- DELETE `/api/code/:id` - 删除仓库
- POST `/api/code/:id/sync` - 同步仓库

#### 待办事项 (`backend/src/routes/todos.js`)
- POST `/api/todos` - 创建待办
- PUT `/api/todos/:id` - 更新待办
- DELETE `/api/todos/:id` - 删除待办

#### 博客 (`backend/src/routes/blog.js`)
- 所有写操作都已添加权限保护

## 前端实现

### 1. 登录页面 (`frontend/src/views/Login.vue`)

- 添加"游客访问"按钮
- 游客登录使用 `authStore.guestLogin()`
- 登录成功后跳转到首页

### 2. 认证 Store (`frontend/src/stores/auth.js`)

```javascript
// 管理员登录
login(username, password, remember = true)

// 游客登录
guestLogin()

// 检查是否为游客
isGuest()

// 退出登录
logout()
```

### 3. API 配置 (`frontend/src/api/index.js`)

- Token 存储优先级：localStorage > sessionStorage
- 游客模式使用 sessionStorage（关闭浏览器后自动清除）
- 管理员模式可选择使用 localStorage（记住登录状态）
- 添加游客登录 API：`guestLogin()`
- 添加修改密码 API：`changePassword()`

### 4. 错误处理

API 拦截器处理 403 错误：
- 当错误码为 `GUEST_NO_PERMISSION` 时，记录警告日志
- 前端可以根据错误码显示友好提示

### 5. 布局组件 (`frontend/src/views/Layout.vue`)

- 管理员可以点击用户名修改密码
- 游客模式下用户名不可点击

## 使用指南

### 管理员登录
1. 访问系统登录页面
2. 输入用户名和密码
3. 勾选"记住登录状态"（可选）
4. 点击"登录"按钮

### 游客访问
1. 访问系统登录页面
2. 点击"游客访问"按钮
3. 自动获得只读权限
4. 可以浏览所有资源，但无法进行任何修改操作
5. 关闭浏览器后，游客登录状态自动清除

### 游客模式使用示例

**场景1：音乐播放**
- 游客可以播放音乐、查看歌词
- 可以调整播放模式和音量
- 但这些设置不会被保存，下次登录需要重新设置
- 不能创建或修改播放列表

**场景2：书籍阅读**
- 游客可以在线阅读书籍
- 可以查看之前的阅读进度
- 但阅读进度不会自动保存
- 不能上传或删除书籍

**场景3：文档浏览**
- 游客可以浏览所有分类和文档
- 可以搜索和预览文档
- 可以查看版本历史
- 但不能上传、编辑或删除文档
- 可以访问私密空间（需要输入密码）

**场景4：动漫浏览**
- 游客可以浏览动漫库
- 可以从 Bangumi 搜索动漫
- 但不能导入到本地库
- 不能修改观看状态或评分

### 修改密码（仅管理员）
1. 登录后点击右上角的用户名
2. 在弹出的对话框中输入旧密码和新密码
3. 点击"确认修改"
4. 修改成功后自动退出，需要重新登录

### 游客限制
游客尝试执行写操作时：
- 后端返回 403 错误
- 错误消息：`游客无权执行此操作`
- 错误码：`GUEST_NO_PERMISSION`

## 安全考虑

1. **Token 过期时间**：游客 token 24小时过期，管理员 token 7天过期
2. **Session 清理**：游客使用 sessionStorage，关闭浏览器后自动清除
3. **密码加密**：使用 bcryptjs 进行密码哈希
4. **权限验证**：每个写操作路由都进行权限检查
5. **错误处理**：前端和后端都有完善的错误处理机制

## 部署说明

权限管理系统已集成到现有系统中，无需额外配置。系统会自动：
- 检测用户角色（管理员/游客）
- 根据角色限制操作权限
- 返回适当的错误信息

## 更新日志

### 2026-04-03
- 详细补充游客功能文档
- 添加各模块游客权限说明
- 添加游客模式使用示例
- 添加游客模式 UI 表现说明

### 2026-04-02
- 实现完整的权限管理系统
- 添加游客登录功能
- 为所有后端路由添加权限检查
- 前端支持游客模式
- 添加修改密码功能（仅管理员）

## 常见问题

**Q: 游客可以修改自己的登录状态吗？**
A: 不可以。游客使用 sessionStorage，关闭浏览器后自动清除。游客无法修改为管理员权限。

**Q: 游客的播放列表设置会被保存吗？**
A: 不会。游客的播放模式、音量等设置不会被保存到 localStorage，每次登录都需要重新设置。

**Q: 游客可以访问私密空间吗？**
A: 不可以。游客无法访问私密空间，只有管理员才能访问。

**Q: 游客可以搜索 Bangumi 动漫吗？**
A: 可以。游客可以从 Bangumi 搜索动漫，但不能导入到本地库。

**Q: 如何区分当前是管理员还是游客？**
A: 登录后，右上角显示用户名。管理员的用户名可点击修改密码，游客的用户名不可点击。
