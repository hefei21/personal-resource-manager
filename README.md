# 个人资源管理系统

一个全功能的个人资源管理系统，支持文档、音乐、书籍、博客、动漫等资源管理。

![仪表盘首页](./docs/screenshots/01-dashboard-home.png)

![License](https://img.shields.io/badge/license-MIT-blue)
![Vue](https://img.shields.io/badge/Vue-3.4-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18+-green)

## ✨ 功能特性

### 📄 文档管理
- 多级分类、标签管理
- 文件上传、在线预览（PDF、Word、Excel）
- 版本控制、隐私空间

![文档管理](./docs/screenshots/02-documents.png)

### 🎵 音乐管理
- FFprobe 元数据解析（支持 MP3/FLAC/M4A）
- 大文件分片上传、断点续传
- 播放列表、全局播放器

![音乐管理](./docs/screenshots/04-music.png)

### 📚 书籍管理
- 在线阅读器（EPUB/PDF/TXT）
- 阅读进度保存
- Anna's Archive / Nyaa 资源搜索

![书籍管理](./docs/screenshots/05-books.png)

### 📝 博客管理
- Markdown 编辑器（实时预览）
- 分类标签、草稿/发布管理
- 代码高亮（Atom 主题）

![博客管理](./docs/screenshots/03-blog.png)

### 🎬 动漫管理
- Bangumi API 集成（支持认证）
- 收藏、评分、想看/看过标记
- Nyaa 资源搜索
- 封面懒加载（IndexedDB 缓存）
- 详情页优化（数据库优先）

![动漫管理](./docs/screenshots/09-anime.png)

### 💻 代码仓库管理
- Git 仓库链接管理
- 代码文件预览（支持语法高亮）
- 提交历史查看

![代码管理](./docs/screenshots/08-code.png)

### 🔖 书签管理
- URL 收藏、图标自动获取
- 分类标签管理
- 批量导入导出

![书签管理](./docs/screenshots/06-bookmarks.png)

### 🎮 游戏管理
- Steam 库集成
- 成就追踪
- 游戏时长统计

![游戏管理](./docs/screenshots/07-games.png)

### 🔒 安全功能
- IP 黑名单管理
- 外部 API 限流
- 访问日志记录
- 安全响应头

### 其他功能
- 🔍 全局搜索
- 👥 权限管理（管理员/游客）
- 📊 仪表盘统计
- 📝 系统日志查看

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| **前端** | Vue 3.4 + Vite 5.0 + 原生组件 |
| **后端** | Node.js 18 + Express 4.18 |
| **数据库** | SQLite（better-sqlite3） |
| **解析** | FFprobe（音频）、PDF.js（文档） |
| **部署** | Docker Compose |

> **注意**：所有 UI 组件均为原生 Vue + CSS 实现，不依赖第三方组件库

## 🏗 项目架构

### PC/移动端分离架构

系统采用条件渲染实现响应式适配，各模块独立维护 PC 和移动端组件：

```
frontend/src/
├── views/              # 主入口（条件渲染）
│   ├── Anime.vue
│   ├── Music.vue
│   └── ...
├── pc/pages/           # PC 端组件
│   ├── AnimePC.vue
│   ├── MusicPC.vue
│   └── ...
└── mobile/pages/       # 移动端组件
    ├── AnimeMobile.vue
    ├── MusicMobile.vue
    └── ...
```

**主入口示例** (`views/Music.vue`):
```vue
<template>
  <MusicMobile v-if="isMobile" />
  <MusicPC v-else />
</template>
```

- **PC 端**: 表格布局、批量操作、分屏预览
- **移动端**: 卡片布局、触摸优化、底部操作栏

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/你的用户名/personal-resource-manager.git
cd personal-resource-manager

# 2. 复制配置文件
cp backend/.env.example backend/.env

# 3. 修改配置（重要！）
# 编辑 docker-compose.yml，修改数据目录路径
# 编辑 backend/.env，设置 JWT_SECRET

# 4. 启动服务
docker-compose up -d

# 5. 访问
# 前端：http://localhost:5173
# 后端：http://localhost:3000
```

### 方式二：本地开发

```bash
# 安装依赖
cd backend && npm install
cd frontend && npm install

# 配置环境变量
cd backend && cp .env.example .env

# 启动后端
cd backend && npm run dev

# 启动前端（新终端）
cd frontend && npm run dev
```

### 默认登录

- **用户名**：`admin`
- **密码**：`admin123`

⚠️ **生产环境请立即修改默认密码！**

## ⚙️ 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 密钥（必须修改） | - |
| `DATA_PATH` | 数据存储路径 | `/app/data` |
| `HTTP_PROXY` | 代理地址（用于爬虫） | - |

详见：[backend/.env.example](backend/.env.example)

### Docker 挂载路径

编辑 `docker-compose.yml`，修改以下路径：

```yaml
volumes:
  - ./data/db:/app/data/database      # 数据库
  - ./data/docs:/app/data/documents   # 文档
  - ./data/music:/app/data/music      # 音乐
  - ./data/books:/app/data/books      # 书籍
```

## 📖 文档

### 部署与配置
- [快速开始](docs/QUICKSTART.md)
- [数据库结构](docs/DATABASE_SCHEMA.md)
- [Docker 部署](docs/NAS_DEPLOYMENT.md)
- [FFmpeg 配置](docs/FFMPEG_SETUP.md)
- [Clash 代理](docs/CLASH_DEPLOYMENT.md)

### 安全与运维
- [权限管理系统](docs/PERMISSION_SYSTEM.md)
- [安全加固指南](docs/SECURITY_HARDENING_GUIDE.md)
- [IP 黑名单](docs/IP_BLACKLIST.md)
- [外部 API 限流](docs/EXTERNAL_API_RATE_LIMIT.md)

### 功能模块
- [书籍管理](docs/BOOKS_MANAGEMENT.md)
- [文档管理](docs/DOCUMENTS_MANAGEMENT.md)
- [音乐管理](docs/MUSIC_MANAGEMENT.md)
- [动漫管理](docs/ANIME_MANAGEMENT.md)
- [博客管理](docs/BLOG_MANAGEMENT.md)
- [游戏管理](docs/GAMES_MANAGEMENT.md)
- [代码管理](docs/CODE_MANAGEMENT.md)
- [书签管理](docs/BOOKMARKS_FEATURE.md)
- [仪表盘](docs/DASHBOARD_MANAGEMENT.md)

## 🔒 安全提示

1. **修改默认密码**：首次启动后立即修改 admin 密码
2. **设置 JWT_SECRET**：使用强随机密钥
3. **HTTPS**：生产环境建议配置 HTTPS
4. **防火墙**：限制端口访问
5. **备份**：定期备份数据库和上传文件

## 👥 权限管理

系统支持两种角色：

### 管理员
- 完整的读写权限
- 可以执行所有操作
- Token 有效期：7天
- 支持修改密码

### 游客
- 只读权限，可浏览所有资源
- 可以播放音乐、阅读书籍、预览文档
- 无法执行任何写操作（上传、删除、修改等）
- Token 有效期：24小时
- 使用 sessionStorage（关闭浏览器自动清除）

详细说明请查看：[权限管理系统](docs/PERMISSION_SYSTEM.md)

## 📝 开发计划

- [x] ~~移动端适配~~ ✅ **已完成**（PC/移动端分离架构）
- [x] ~~权限管理系统~~ ✅ **已完成**（管理员/游客双角色）
- [x] ~~安全加固~~ ✅ **已完成**（IP黑名单、限流、日志）
- [ ] 全文搜索（SQLite FTS5）
- [ ] 多用户支持
- [ ] API 开放
- [ ] 数据导出

## 🐛 已知问题修复

### 架构重构（2026-05-29）
- **PC/移动端分离架构**：各模块独立维护 PC 和移动端组件，通过条件渲染实现响应式适配
  - PC端：原生 Vue + CSS 组件，表格布局，支持批量操作
  - 移动端：原生 Vue + CSS 组件，卡片布局，触摸优化
- **UI 组件库移除**：完全移除 TDesign 依赖，所有组件使用原生实现，解决移动端兼容性问题
- **后端服务层抽取**：新增 `backend/src/services/` 目录，业务逻辑更清晰
- **安全功能增强**：
  - IP 黑名单管理（自动/手动封禁可疑IP）
  - 外部 API 限流（防止滥用 Bangumi 等第三方接口）
  - 访问日志记录（审计追踪）
  - 安全响应头（X-Frame-Options、X-Content-Type-Options 等）

### UI 优化（2026-04-03）
- **悬停提示问题**：改用浏览器原生 title 属性，解决重复悬停框和样式冲突问题（影响模块：音乐、动漫、书籍、书签）
- **加载状态优化**：所有列表页实现骨架屏效果，页面框架立即显示，内容区域显示加载动画
- **表格布局优化**：修复音乐和动漫管理页面的表格列对齐问题，确保表头与内容左对齐
- **游客权限优化**：所有写操作按钮对游客显示为禁用状态，提供明确的权限提示

### 功能增强（2026-04-02）
- **权限管理系统**：实现完整的游客模式，支持只读访问所有资源
- **Cloudflare Tunnel**：添加 Cloudflare Tunnel 部署方案，支持无需公网IP的安全访问

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT License

---

**如有问题，请查看 [文档](docs/) 或提交 Issue。**
