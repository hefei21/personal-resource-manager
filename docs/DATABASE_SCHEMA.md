# 数据库表结构文档

## 数据库信息
- **数据库类型**: SQLite (better-sqlite3)
- **数据库文件**: `{DATA_PATH}/database/app.db`
- **日志模式**: WAL (Write-Ahead Logging)
- **编码**: UTF-8

---

## 表结构详情

### 1. users - 用户表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 用户ID |
| username | TEXT | UNIQUE NOT NULL | - | 用户名（唯一） |
| password | TEXT | NOT NULL | - | 密码（bcrypt加密） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**索引**: `username` (UNIQUE)

**默认用户**:
- 用户名: `admin` (可通过环境变量 `DEFAULT_USERNAME` 修改)
- 密码: `admin123` (可通过环境变量 `DEFAULT_PASSWORD` 修改)

---

### 2. documents - 文档表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 文档ID |
| title | TEXT | NOT NULL | - | 文档标题 |
| category | TEXT | - | NULL | 一级分类 |
| subcategory | TEXT | - | NULL | 二级及以下分类（路径形式） |
| tags | TEXT | - | NULL | 标签（逗号分隔） |
| file_path | TEXT | NOT NULL | - | 文件存储路径 |
| version | REAL | - | 1.0 | 版本号 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**字段说明**:
- `category`: 一级分类名称
- `subcategory`: 二级及以下分类路径，如 "技术/前端/Vue"
- `version`: 浮点数版本号，如 1.0, 1.1, 2.0

---

### 3. categories - 分类表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 分类ID |
| name | TEXT | NOT NULL | - | 分类名称 |
| parent_id | INTEGER | FOREIGN KEY | NULL | 父分类ID |
| path | TEXT | NOT NULL | - | 分类完整路径 |
| level | INTEGER | NOT NULL | 0 | 分类层级（0为根分类） |
| sort_order | INTEGER | - | 0 | 排序顺序（数字越小越靠前） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**外键约束**:
- `parent_id` REFERENCES `categories(id)` ON DELETE CASCADE

**字段说明**:
- `path`: 完整分类路径，如 "技术/前端/Vue"
- `level`: 层级深度，根分类为 0，每下一级 +1
- `sort_order`: 用户自定义排序，拖拽排序时会更新此字段

**示例数据**:
```
id | name   | parent_id | path         | level | sort_order
---|--------|-----------|--------------|-------|------------
1  | 技术   | NULL      | 技术         | 0     | 0
2  | 前端   | 1         | 技术/前端    | 1     | 0
3  | Vue    | 2         | 技术/前端/Vue| 2     | 0
```

---

### 4. document_versions - 文档版本表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 版本ID |
| document_id | INTEGER | NOT NULL | - | 所属文档ID |
| version | INTEGER | NOT NULL | - | 版本号 |
| file_path | TEXT | NOT NULL | - | 该版本的文件路径 |
| note | TEXT | - | NULL | 版本说明 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**外键约束**:
- `document_id` REFERENCES `documents(id)` ON DELETE CASCADE

**说明**:
- 每次文档更新时，会创建新的版本记录
- 保留历史版本文件，支持版本回退

---

### 5. music - 音乐表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 音乐ID |
| title | TEXT | NOT NULL | - | 歌曲名称 |
| artist | TEXT | - | NULL | 艺术家 |
| album | TEXT | - | NULL | 专辑名称 |
| duration | INTEGER | - | 0 | 时长（秒） |
| file_path | TEXT | NOT NULL | - | 文件存储路径 |
| file_size | INTEGER | - | 0 | 文件大小（字节） |
| file_type | TEXT | - | NULL | 文件类型（mp3, flac 等） |
| cover_image | TEXT | - | NULL | 封面图片（base64） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 6. playlists - 歌单表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 歌单ID |
| name | TEXT | NOT NULL UNIQUE | - | 歌单名称 |
| description | TEXT | - | NULL | 歌单描述 |
| cover_image | TEXT | - | NULL | 歌单封面（base64） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 7. playlist_songs - 歌单歌曲关联表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 关联ID |
| playlist_id | INTEGER | NOT NULL | - | 歌单ID |
| music_id | INTEGER | NOT NULL | - | 音乐ID |
| sort_order | INTEGER | - | 0 | 排序顺序 |
| added_at | DATETIME | - | CURRENT_TIMESTAMP | 添加时间 |

**外键约束**:
- `playlist_id` REFERENCES `playlists(id)` ON DELETE CASCADE
- `music_id` REFERENCES `music(id)` ON DELETE CASCADE

---

### 8. code_repositories - 代码仓库表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 仓库ID |
| name | TEXT | NOT NULL | - | 仓库名称 |
| url | TEXT | NOT NULL | - | 仓库URL |
| description | TEXT | - | NULL | 描述信息 |
| category | TEXT | - | NULL | 分类 |
| tags | TEXT | - | NULL | 标签（逗号分隔） |
| current_version | TEXT | - | NULL | 当前版本 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 7. code_versions - 代码版本表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 版本ID |
| repository_id | INTEGER | NOT NULL | - | 所属仓库ID |
| version | TEXT | NOT NULL | - | 版本号 |
| note | TEXT | - | NULL | 版本说明 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**外键约束**:
- `repository_id` REFERENCES `code_repositories(id)` ON DELETE CASCADE

---

### 9. bookmarks - 书签表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 书签ID |
| title | TEXT | NOT NULL | - | 书签标题 |
| url | TEXT | NOT NULL | - | 网址 |
| category | TEXT | - | NULL | 分类 |
| tags | TEXT | - | NULL | 标签（逗号分隔） |
| description | TEXT | - | NULL | 描述信息 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 10. anime - 动漫表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 动漫ID |
| bangumi_id | INTEGER | UNIQUE | NULL | Bangumi ID |
| title | TEXT | NOT NULL | - | 动漫名称 |
| name_cn | TEXT | - | NULL | 中文名 |
| name_original | TEXT | - | NULL | 原名（日文名） |
| summary | TEXT | - | NULL | 简介 |
| cover_image | TEXT | - | NULL | 封面图片URL |
| rating | REAL | - | NULL | 评分 |
| rating_count | INTEGER | - | 0 | 评分人数 |
| tags | TEXT | - | NULL | 标签（逗号分隔） |
| air_date | TEXT | - | NULL | 上映日期 |
| eps | INTEGER | - | 0 | 已播出集数 |
| eps_total | INTEGER | - | 0 | 总集数 |
| author | TEXT | - | NULL | 原作者 |
| director | TEXT | - | NULL | 监督 |
| studio | TEXT | - | NULL | 动画制作公司 |
| infobox | TEXT | - | NULL | 详细信息（JSON） |
| characters | TEXT | - | NULL | 角色声优（JSON） |
| staff | TEXT | - | NULL | 制作人员（JSON） |
| status | TEXT | - | 'none' | 观看状态 |
| is_favorite | INTEGER | - | 0 | 是否收藏（0/1） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**索引**: `bangumi_id` (UNIQUE)

**字段说明**:
- `bangumi_id`: Bangumi 番剧 ID，唯一索引
- `name_cn`: 中文名称
- `name_original`: 原名（通常为日文名）
- `rating_count`: 评分总人数
- `air_date`: 上映日期，格式如 "2024-04-01"
- `eps`: 已播出集数
- `eps_total`: 总集数
- `author`: 原作者（从 infobox 提取）
- `director`: 监督/导演（从 infobox 提取）
- `studio`: 动画制作公司（从 infobox 提取）
- `infobox`: Bangumi 详细信息，JSON 格式存储
- `characters`: 角色和声优信息，JSON 格式存储
- `staff`: 制作人员信息，JSON 格式存储
- `status`: 观看状态，可选值: 'none', 'watching', 'watched'
- `is_favorite`: 是否收藏，0=否，1=是

---

### 11. book_categories - 书籍分类表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 分类ID |
| name | TEXT | NOT NULL UNIQUE | - | 分类名称 |
| sort_order | INTEGER | - | 0 | 排序顺序 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

---

### 12. books - 书籍表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 书籍ID |
| title | TEXT | NOT NULL | - | 书名 |
| author | TEXT | - | NULL | 作者 |
| year | TEXT | - | NULL | 出版年份 |
| publisher | TEXT | - | NULL | 出版社 |
| isbn | TEXT | - | NULL | ISBN |
| description | TEXT | - | NULL | 简介 |
| cover_image | TEXT | - | NULL | 封面图片路径 |
| category_id | INTEGER | FOREIGN KEY | NULL | 分类ID |
| file_path | TEXT | NOT NULL | - | 文件存储路径 |
| file_type | TEXT | - | NULL | 文件类型（txt/epub/pdf等） |
| file_size | INTEGER | - | NULL | 文件大小（字节） |
| total_pages | INTEGER | - | 0 | 总页数/章节数 |
| content_cache | TEXT | - | NULL | EPUB内容缓存（JSON） |
| last_read_at | DATETIME | - | NULL | 最后阅读时间 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**外键约束**:
- `category_id` REFERENCES `book_categories(id)` ON DELETE SET NULL

**字段说明**:
- `content_cache`: EPUB 解析后的章节内容，JSON 格式存储，避免重复解析
- `last_read_at`: 用于「最近阅读」排序

---

### 13. book_chapters - 书籍目录表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 目录ID |
| book_id | INTEGER | NOT NULL | - | 书籍ID |
| title | TEXT | - | NULL | 章节标题 |
| chapter_index | INTEGER | NOT NULL | - | 章节索引 |
| start_position | INTEGER | - | 0 | 起始位置（字节） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**外键约束**:
- `book_id` REFERENCES `books(id)` ON DELETE CASCADE

**索引**:
- `book_id` + `chapter_index` (复合索引)

**字段说明**:
- `chapter_index`: 章节顺序索引，从 0 开始
- `start_position`: 在TXT文件中的起始字节位置

---

### 14. reading_progress - 阅读进度表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 进度ID |
| book_id | INTEGER | NOT NULL | - | 书籍ID |
| user_id | INTEGER | - | NULL | 用户ID（NULL表示游客） |
| current_page | INTEGER | - | 0 | 当前章节索引 |
| cfi | TEXT | - | NULL | EPUB CFI定位字符串 |
| progress | REAL | - | 0 | 总进度百分比 |
| font_size | INTEGER | - | 16 | 字体大小 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**外键约束**:
- `book_id` REFERENCES `books(id)` ON DELETE CASCADE
- `user_id` REFERENCES `users(id)` ON DELETE CASCADE

**唯一约束**:
- `UNIQUE(book_id, user_id)` - 每本书每个用户只有一条进度记录

**字段说明**:
- `current_page`: 当前阅读的章节索引（从 0 开始）
- `cfi`: EPUB标准CFI定位字符串，精准定位阅读位置
- `progress`: 总阅读进度百分比
- `user_id`: 支持多用户进度隔离，管理员和游客的进度独立保存

---

### 24. schema_migrations - 数据库迁移记录表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 记录ID |
| migration_name | TEXT | NOT NULL UNIQUE | - | 迁移名称 |
| applied_at | DATETIME | - | CURRENT_TIMESTAMP | 应用时间 |

**字段说明**:
- `migration_name`: 迁移脚本名称，如 "add_reading_progress_user_id"
- `applied_at`: 迁移执行时间

**用途**:
- 记录已执行的数据库迁移
- 防止重复迁移
- 支持幂等性迁移脚本

---

### 15. blog_posts - 博客文章表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 文章ID |
| title | TEXT | NOT NULL | - | 文章标题 |
| content | TEXT | - | NULL | 文章内容（Markdown） |
| category_id | INTEGER | FOREIGN KEY | NULL | 分类ID |
| status | TEXT | - | 'draft' | 状态：draft/published |
| is_top | INTEGER | - | 0 | 是否置顶 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**外键约束**:
- `category_id` REFERENCES `blog_categories(id)` ON DELETE SET NULL

---

### 15. blog_categories - 博客分类表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 分类ID |
| name | TEXT | NOT NULL | - | 分类名称 |
| parent_id | INTEGER | FOREIGN KEY | NULL | 父分类ID |
| sort_order | INTEGER | - | 0 | 排序顺序 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

**外键约束**:
- `parent_id` REFERENCES `blog_categories(id)` ON DELETE CASCADE

---

### 17. blog_tags - 博客标签表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 标签ID |
| name | TEXT | NOT NULL UNIQUE | - | 标签名称 |
| color | TEXT | - | NULL | 标签颜色 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |

---

### 18. blog_post_tags - 文章标签关联表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 关联ID |
| post_id | INTEGER | NOT NULL | - | 文章ID |
| tag_id | INTEGER | NOT NULL | - | 标签ID |

**外键约束**:
- `post_id` REFERENCES `blog_posts(id)` ON DELETE CASCADE
- `tag_id` REFERENCES `blog_tags(id)` ON DELETE CASCADE

---

### 19. games - 游戏表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 游戏ID |
| steam_appid | INTEGER | UNIQUE | NULL | Steam App ID |
| title | TEXT | NOT NULL | - | 游戏标题 |
| description | TEXT | - | NULL | 游戏简介 |
| cover_image | TEXT | - | NULL | 封面图片URL |
| cover_image_data | TEXT | - | NULL | 封面图片（base64） |
| developers | TEXT | - | NULL | 开发商 |
| publishers | TEXT | - | NULL | 发行商 |
| release_date | TEXT | - | NULL | 发行日期 |
| genres | TEXT | - | NULL | 游戏类型 |
| platforms | TEXT | - | NULL | 支持平台 |
| playtime_forever | INTEGER | - | 0 | 总游玩时长（分钟） |
| playtime_2weeks | INTEGER | - | 0 | 两周内游玩时长 |
| last_played | DATETIME | - | NULL | 最后游玩时间 |
| status | TEXT | - | 'unplayed' | 游戏状态 |
| is_favorite | INTEGER | - | 0 | 是否收藏 |
| user_rating | INTEGER | - | 0 | 用户评分（0-10） |
| achievements_total | INTEGER | - | 0 | 成就总数 |
| achievements_completed | INTEGER | - | 0 | 已完成成就数 |
| notes | TEXT | - | NULL | 备注 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

**索引**: `steam_appid` (UNIQUE)

---

### 20. steam_config - Steam 配置表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY | 1 | 配置ID（固定为1） |
| steam_id | TEXT | - | NULL | Steam ID |
| api_key | TEXT | - | NULL | Steam Web API Key |
| last_sync | DATETIME | - | NULL | 最后同步时间 |
| auto_sync | INTEGER | - | 0 | 是否自动同步 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 21. game_achievements - 游戏成就表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 成就ID |
| game_id | INTEGER | NOT NULL | - | 游戏ID |
| achievement_id | TEXT | NOT NULL | - | 成就API名称 |
| name | TEXT | - | NULL | 成就名称 |
| description | TEXT | - | NULL | 成就描述 |
| icon | TEXT | - | NULL | 成就图标URL |
| icon_gray | TEXT | - | NULL | 未解锁图标URL |
| is_achieved | INTEGER | - | 0 | 是否已解锁 |
| unlock_time | DATETIME | - | NULL | 解锁时间 |
| global_percent | REAL | - | 0 | 全球完成率 |

**外键约束**:
- `game_id` REFERENCES `games(id)` ON DELETE CASCADE

---

### 22. private_documents - 私密文件表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 文件ID |
| title | TEXT | NOT NULL | - | 文件标题 |
| file_path | TEXT | NOT NULL | - | 文件路径 |
| size | INTEGER | - | 0 | 文件大小 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 23. private_settings - 私密空间设置表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY | 1 | 设置ID（固定为1） |
| password | TEXT | - | NULL | 密码哈希 |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

### 25. todos - 待办事项表

| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|--------|------|------|--------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | - | 待办ID |
| text | TEXT | NOT NULL | - | 待办内容 |
| date | TEXT | NOT NULL | - | 日期（YYYY-MM-DD） |
| completed | INTEGER | - | 0 | 是否完成（0/1） |
| confirmed | INTEGER | - | 0 | 是否确认锁定（0/1） |
| created_at | DATETIME | - | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | - | CURRENT_TIMESTAMP | 更新时间 |

---

## 表关系图

```
users (用户)
  └─ 独立表，用于认证

documents (文档)
  └─ document_versions (文档版本) [1:N]
  └─ categories (通过 category/subcategory 字段关联)

categories (分类)
  └─ 自关联 (parent_id -> id) [树形结构]

books (书籍)
  └─ book_categories (分类) [N:1]
  └─ book_chapters (目录) [1:N]
  └─ reading_progress (进度) [1:N] 按用户隔离

music (音乐)
  └─ playlists (歌单) [N:M] 通过 playlist_songs 关联

playlists (歌单)
  └─ playlist_songs (歌曲关联) [1:N]

code_repositories (代码仓库)
  └─ 独立表

bookmarks (书签)
  └─ 独立表

anime (动漫)
  └─ 独立表

blog_posts (博客文章)
  └─ blog_categories (分类) [N:1]
  └─ blog_post_tags (标签关联) [1:N]
  └─ blog_tags (标签) [N:M]

games (游戏)
  └─ game_achievements (成就) [1:N]
  └─ steam_config (Steam配置) [全局配置]

todos (待办事项)
  └─ 独立表（按日期查询）

private_documents (私密文件)
  └─ private_settings (私密空间密码) [全局配置]
```

---

## 数据库迁移历史

### 2026-05-XX
- ✅ 添加 `reading_progress.user_id` 字段（多用户进度隔离）
- ✅ 修改 `reading_progress` 唯一约束为 `UNIQUE(book_id, user_id)`
- ✅ 添加 `reading_progress.cfi` 字段（EPUB精准定位）
- ✅ 添加 `book_chapters` 表（书籍目录）
- ✅ 添加 `schema_migrations` 表（迁移记录）

### 2026-03-19
- ✅ 添加 `book_categories` 表（书籍分类）
- ✅ 添加 `books` 表（书籍信息）
- ✅ 添加 `reading_progress` 表（阅读进度）
- ✅ 扩展 `anime` 表字段（name_cn, name_original, rating_count, air_date, eps, eps_total, author, director, studio, infobox, characters, staff）

### 2026-03-18
- ✅ 添加 `categories.sort_order` 字段（支持拖拽排序）
- ✅ 添加 `book_categories.sort_order` 字段（支持拖拽排序）
- ✅ 添加 `blog_categories.sort_order` 字段（支持拖拽排序）

### 历史迁移
- ✅ 添加 `documents.subcategory` 字段（支持多级分类）
- ✅ 修改 `documents.version` 字段类型为 REAL

---

## 索引优化建议

当前已自动创建的索引：
- `users.username` (UNIQUE)
- `anime.bangumi_id` (UNIQUE)
- `games.steam_appid` (UNIQUE)
- `blog_tags.name` (UNIQUE)
- `playlists.name` (UNIQUE)
- `book_categories.name` (UNIQUE)
- `reading_progress.book_id` + `reading_progress.user_id` (复合UNIQUE)
- `schema_migrations.migration_name` (UNIQUE)
- 所有 PRIMARY KEY 字段

建议添加的索引（如果查询性能有问题）：
```sql
CREATE INDEX idx_documents_category ON documents(category);
CREATE INDEX idx_documents_tags ON documents(tags);
CREATE INDEX idx_categories_parent_id ON categories(parent_id);
CREATE INDEX idx_categories_sort_order ON categories(sort_order);
CREATE INDEX idx_books_category_id ON books(category_id);
CREATE INDEX idx_books_last_read_at ON books(last_read_at);
CREATE INDEX idx_book_chapters_book_id ON book_chapters(book_id);
CREATE INDEX idx_reading_progress_book_id ON reading_progress(book_id);
CREATE INDEX idx_reading_progress_user_id ON reading_progress(user_id);
CREATE INDEX idx_blog_posts_category_id ON blog_posts(category_id);
CREATE INDEX idx_blog_posts_status ON blog_posts(status);
CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_playlist_songs_playlist_id ON playlist_songs(playlist_id);
```

---

## 备份建议

1. **自动备份**: 数据库使用 WAL 模式，会自动生成 `-wal` 和 `-shm` 文件
2. **手动备份**: 定期复制 `app.db` 文件到安全位置
3. **导出备份**: 
   ```bash
   sqlite3 app.db ".backup 'backup/app_backup.db'"
   ```

---

## 注意事项

1. **时区处理**: 数据库存储 UTC 时间，前端显示时转换为 UTC+8
2. **文件存储**: 文件路径存储在 `file_path` 字段，实际文件在 `{DATA_PATH}/uploads/` 目录
3. **级联删除**: 
   - 删除分类时会级联删除子分类
   - 删除文档时会级联删除文档版本
   - 删除代码仓库时会级联删除代码版本
   - 删除书籍时会级联删除阅读进度和目录
4. **分类路径**: `categories.path` 和 `documents.subcategory` 格式为 "一级/二级/三级"
5. **多用户进度**: `reading_progress` 表使用 `user_id` 字段隔离不同用户的阅读进度，管理员和游客的进度独立保存
6. **迁移记录**: `schema_migrations` 表用于记录已执行的数据库迁移，确保迁移脚本的幂等性
