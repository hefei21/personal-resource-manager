# 极空间 NAS 挂载目录配置指南

## 你的 NAS 目录结构

根据你创建的目录：
```
data/     ← 主目录
├── db/          ← 数据库
├── docs/        ← 文档文件
├── music/       ← 音乐文件
├── uploads/     ← 上传文件
└── logs/        ← 日志文件
```

## 图形界面配置

### 后端容器挂载配置

在极空间 Docker 界面配置后端容器的「存储卷挂载」：

| NAS 主机路径           | 容器路径              | 说明     |
| -------------------- | --------------------- | -------- |
| `/你的NAS路径/data/db`    | /app/data/database     | 数据库   |
| `/你的NAS路径/data/docs`  | /app/data/documents    | 文档     |
| `/你的NAS路径/data/music` | /app/data/music       | 音乐     |
| `/你的NAS路径/data/uploads`| /app/data/uploads     | 上传     |
| `/你的NAS路径/data/logs`  | /app/data/logs        | 日志     |

**注意**：将 `/你的NAS路径/data` 替换为你实际的 NAS 挂载路径，例如：
- `/data/PersonalResourceManager/data`
- 或者在极空间界面显示的完整路径

## 环境变量（无需修改）

保持现有环境变量不变：

| 变量名          | 值                           |
| --------------- | ---------------------------- |
| DATA_PATH       | /app/data                     |
| DB_PATH         | /app/data/database/app.db     |
| DOCUMENTS_PATH  | /app/data/documents          |
| MUSIC_PATH      | /app/data/music             |
| UPLOADS_PATH    | /app/data/uploads           |
| LOGS_PATH       | /app/data/logs              |

## 完整配置示例

如果您的 NAS 路径是 `/data/PersonalResourceManager`，则挂载配置为：

```
/data/PersonalResourceManager/data/db     → /app/data/database
/data/PersonalResourceManager/data/docs   → /app/data/documents
/data/PersonalResourceManager/data/music  → /app/data/music
/data/PersonalResourceManager/data/uploads → /app/data/uploads
/data/PersonalResourceManager/data/logs  → /app/data/logs
```

## 验证配置

### 1. 检查容器启动

启动后端容器后，查看日志确认：
```
✓ 数据库初始化完成
✓ 服务器运行在 http://localhost:3000
✓ 数据路径: /app/data
✓ 数据库路径: /app/data/database/app.db
```

### 2. 测试写入

上传一个文档或音乐文件，检查 NAS 目录中是否出现文件：
- `/你的NAS路径/data/docs/` 应该有上传的文档
- `/你的NAS路径/data/music/` 应该有上传的音乐

### 3. 检查数据库

查看 `/你的NAS路径/data/db/` 目录，应该有 `app.db` 和 `app.db-shm`、`app.db-wal` 文件。

## 常见问题

### Q: 容器启动失败？

检查：
1. 挂载路径是否正确
2. NAS 路径是否存在
3. 容器是否有读写权限

### Q: 上传文件不显示？

检查：
1. 挂载路径是否正确（容器路径必须是 `/app/data/uploads`）
2. NAS 路径权限是否正确
3. 磁盘空间是否充足

### Q: 数据库不保存？

检查：
1. `db` 挂载是否正确
2. 容器内 `/app/data/database` 目录是否可写

## 权限检查

如果遇到权限问题，可能需要：

1. 在极空间文件管理器中，右键点击 `data` 文件夹
2. 设置权限为「读写」
3. 或者在 Docker 容器设置中，勾选「提升权限」

## 数据备份

现在数据直接存储在 NAS 目录，备份非常简单：

### 方法一：通过极空间文件管理器
1. 进入 `data` 文件夹
2. 全选所有子文件夹
3. 右键选择「压缩」或「备份」

### 方法二：通过复制粘贴
1. 将 `data` 文件夹复制到另一个位置（如备份盘）
2. 定期执行此操作

## 恢复数据

1. 停止容器
2. 将备份的 `data` 文件夹替换现有的 `data` 文件夹
3. 重新启动容器

## 代码修改

**无需修改代码！** 

我们的配置已经完美适配：
- 代码中使用环境变量路径（`/app/data/...`）
- Docker 将 NAS 路径映射到容器内路径
- 数据库、文件上传等都会正确保存到 NAS

## 与 Docker Volume 方案对比

| 特性              | NAS 挂载方案（当前）        | Docker Volume 方案          |
| ----------------- | ----------------------- | --------------------- |
| 数据可见性          | ✅ 可以在 NAS 文件管理器直接查看  | ❌ 需要 Docker 命令行访问   |
| 备份便利性          | ✅ 直接复制文件夹             | ⚠️ 需要 docker run 导出     |
| 权限配置           | ⚠️ 可能需要手动设置           | ✅ 容器内自动管理           |
| 性能              | ✅ 原生文件系统             | ⚠️ 额外一层抽象           |

**你当前的 NAS 挂载方案更方便数据管理和备份！**
