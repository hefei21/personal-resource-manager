# 项目文档索引

本目录包含个人资源管理系统的所有详细文档。

---

## 功能模块文档

| 模块 | 文档 | 说明 |
|------|------|------|
| 仪表盘 | [DASHBOARD_MANAGEMENT.md](DASHBOARD_MANAGEMENT.md) | 资源统计、存储概览、日程表（待办事项+农历） |
| 文档管理 | [DOCUMENTS_MANAGEMENT.md](DOCUMENTS_MANAGEMENT.md) | 文档上传、分类管理、版本控制、Office预览 |
| 博客管理 | [BLOG_MANAGEMENT.md](BLOG_MANAGEMENT.md) | Markdown编辑器、分类/标签、文章发布 |
| 音乐管理 | [MUSIC_MANAGEMENT.md](MUSIC_MANAGEMENT.md) | 分片上传、元数据解析、歌单管理 |
| 书籍管理 | [BOOKS_MANAGEMENT.md](BOOKS_MANAGEMENT.md) | 电子书管理、在线阅读器、进度记忆 |
| 代码管理 | [CODE_MANAGEMENT.md](CODE_MANAGEMENT.md) | Git仓库克隆、文件浏览、提交历史 |
| 书签管理 | [BOOKMARKS_FEATURE.md](BOOKMARKS_FEATURE.md) | URL收藏、图标自动获取、分类管理 |
| 动漫管理 | [ANIME_MANAGEMENT.md](ANIME_MANAGEMENT.md) | Bangumi爬虫、收藏状态、信息展示 |
| 游戏管理 | [GAMES_MANAGEMENT.md](GAMES_MANAGEMENT.md) | Steam集成、成就追踪、游戏统计 |

---

## 技术文档

| 文档 | 说明 |
|------|------|
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | 数据库表结构（23张表）、关系图、迁移历史 |
| [QUICKSTART.md](QUICKSTART.md) | 快速开始指南、开发环境搭建 |
| [CLASH_DEPLOYMENT.md](CLASH_DEPLOYMENT.md) | Clash代理部署、Docker配置 |
| [FFMPEG_SETUP.md](FFMPEG_SETUP.md) | FFmpeg配置、音频元数据解析 |
| [NAS_DEPLOYMENT.md](NAS_DEPLOYMENT.md) | NAS部署指南、数据持久化 |
| [JISPACE_MOUNT_GUIDE.md](JISPACE_MOUNT_GUIDE.md) | 极空间挂载配置 |

---

## 模块功能速览

### 仪表盘模块

- **资源统计**：8大模块数据统计卡片
- **存储概览**：数据库/文档/音乐/书籍存储大小
- **日程表**：
  - 日历月视图，支持农历/节气/节日显示
  - 待办事项管理（添加、编辑、删除、完成）
  - 确认锁定功能，防止误修改

### 文档管理模块

- 支持多种格式：PDF、Word、Excel、PPT、Markdown
- 分类/子分类拖拽排序
- 版本控制与历史记录
- Office文档在线预览

### 博客管理模块

- Markdown编辑器（实时预览）
- 分类与标签管理
- 草稿/发布状态切换
- 文章搜索与排序

### 音乐管理模块

- 大文件分片上传（断点续传）
- 音频元数据自动解析（艺术家、专辑、封面）
- 歌单管理
- 播放器控制

### 书籍管理模块

- 支持格式：TXT、EPUB、PDF、MOBI、AZW
- 在线阅读器（章节导航、字体调整）
- 阅读进度自动保存
- 书籍搜索（Anna's Archive）

### 代码管理模块

- Git/SVN仓库克隆
- 文件树浏览
- 提交历史查看
- 代码预览

### 书签管理模块

- URL收藏与分类
- 网站图标自动获取
- 快速访问

### 动漫管理模块

- Bangumi API集成
- 收藏/想看/看过状态
- 动漫信息爬取与展示
- 番剧搜索

### 游戏管理模块

- Steam库同步
- 成就追踪
- 游戏封面下载
- 游玩时长统计

---

## 数据库表结构概览

| 表名 | 说明 |
|------|------|
| users | 用户认证 |
| documents, categories, document_versions | 文档管理 |
| blog_posts, blog_categories, blog_tags, blog_post_tags | 博客管理 |
| music, playlists, playlist_songs | 音乐管理 |
| books, book_categories, reading_progress | 书籍管理 |
| code_repositories | 代码仓库 |
| bookmarks | 书签 |
| anime | 动漫 |
| games, steam_config, game_achievements | 游戏管理 |
| todos | 待办事项（日程表） |
| private_documents, private_settings | 私密空间 |

详见：[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)

---

## 文档查找指南

| 需求 | 推荐文档 |
|------|----------|
| 快速上手 | [QUICKSTART.md](QUICKSTART.md) |
| 部署到NAS | [NAS_DEPLOYMENT.md](NAS_DEPLOYMENT.md) |
| 数据库结构 | [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) |
| 功能说明 | 各模块 MANAGEMENT 文档 |

---

**最后更新**: 2026-03-27
