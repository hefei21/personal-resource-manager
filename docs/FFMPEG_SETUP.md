# 音频元数据解析说明

## 概述

本项目采用 **三层降级策略** 来解析音频文件的元数据，确保在各种环境下都能正常工作：

### 解析策略

1. **第一层：FFprobe（推荐）**
   - 使用 FFprobe 解析所有格式
   - 支持封面图片提取
   - 需要安装 FFmpeg

2. **第二层：轻量级纯 JS 解析（降级）**
   - 无需任何外部依赖
   - 支持 FLAC Vorbis Comments
   - 支持 MP3 ID3v2 标签
   - 至少能获取标题、艺术家、专辑

3. **第三层：文件名推断（兜底）**
   - 使用文件名作为标题
   - 确保总能返回有效数据

## 优势

### 混合方案的优势

| 特性 | FFprobe | 轻量级 JS | 文件名推断 |
|------|---------|-----------|-----------|
| **需要安装** | ✅ 是 | ❌ 否 | ❌ 否 |
| **支持格式** | ✅ 所有格式 | FLAC, MP3 | 所有格式 |
| **封面提取** | ✅ 支持 | ❌ 不支持 | ❌ 不支持 |
| **准确性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| **容错性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

### 对比 music-metadata 库

| 特性 | 本方案 | music-metadata |
|------|--------|----------------|
| **外部依赖** | FFprobe（可选） | 无 |
| **降级方案** | ✅ 三层降级 | ❌ 单一方案 |
| **FLAC 支持** | ✅ 完美 | ⚠️ 有兼容性问题 |
| **封面提取** | ✅ 稳定 | ⚠️ 不稳定 |
| **文件大小** | 无额外依赖 | ~1MB |

## 安装 FFmpeg（推荐）

### 为什么推荐安装 FFmpeg？

虽然不安装 FFmpeg 也能获取基本的元数据（标题、艺术家、专辑），但安装 FFmpeg 后可以：

- ✅ 获取音频时长
- ✅ 提取嵌入的封面图片
- ✅ 支持更多音频格式（APE, M4A, OGG 等）
- ✅ 获得更准确的元数据

### 安装方法

## 安装 FFmpeg

### Windows

#### 方法 1：使用包管理器（推荐）

**使用 Chocolatey：**
```bash
# 安装 Chocolatey（如果未安装）
# 以管理员身份运行 PowerShell
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# 安装 FFmpeg
choco install ffmpeg
```

**使用 Scoop：**
```bash
# 安装 Scoop（如果未安装）
irm get.scoop.sh | iex

# 安装 FFmpeg
scoop install ffmpeg
```

#### 方法 2：手动安装

1. 下载 FFmpeg：https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
2. 解压到 `C:\ffmpeg`
3. 添加到系统 PATH：
   - 右键"此电脑" → 属性 → 高级系统设置 → 环境变量
   - 在"系统变量"中找到 `Path`，点击编辑
   - 添加 `C:\ffmpeg\bin`
4. 重启终端，验证安装：
   ```bash
   ffmpeg -version
   ffprobe -version
   ```

### macOS

```bash
# 使用 Homebrew
brew install ffmpeg

# 验证安装
ffmpeg -version
ffprobe -version
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install ffmpeg

# 验证安装
ffmpeg -version
ffprobe -version
```

### Linux (CentOS/RHEL)

```bash
sudo yum install epel-release
sudo yum install ffmpeg ffmpeg-devel

# 验证安装
ffmpeg -version
ffprobe -version
```

## Docker 环境

Docker 镜像已自动安装 FFmpeg，无需额外配置。

查看 `backend/Dockerfile` 中的安装配置：
```dockerfile
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    git \
    subversion \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

## 验证安装

运行以下命令验证 FFprobe 是否正确安装：

```bash
# 检查版本
ffprobe -version

# 测试解析音频文件
ffprobe -v quiet -print_format json -show_format -show_streams "test.mp3"
```

## 故障排除

### 问题：找不到 ffprobe 命令

**原因**：FFmpeg 未安装或未添加到 PATH

**解决方案**：
1. 确认 FFmpeg 已安装
2. 确认 `ffmpeg` 和 `ffprobe` 在 PATH 中
3. 重启终端或 IDE

### 问题：解析失败

**原因**：音频文件格式不支持或文件损坏

**解决方案**：
1. 使用其他播放器验证文件是否有效
2. 查看后端日志中的 `[FFprobe]` 错误信息
3. 尝试手动运行 ffprobe 命令调试

### 问题：封面提取失败

**原因**：音频文件未嵌入封面或封面格式不标准

**解决方案**：
1. 使用音乐标签编辑器（如 Mp3tag）检查封面
2. FFprobe 会自动跳过封面提取，其他元数据仍可正常解析

## 与 music-metadata 对比

| 特性 | FFprobe | music-metadata |
|------|---------|----------------|
| 格式支持 | ✅ 所有格式 | ⚠️ 部分格式有兼容性问题 |
| 封面提取 | ✅ 稳定可靠 | ⚠️ 某些 FLAC 文件失败 |
| 性能 | ⭐⭐⭐⭐⭐ 快速 | ⭐⭐⭐ 中等 |
| 容错性 | ⭐⭐⭐⭐⭐ 极强 | ⭐⭐⭐ 一般 |
| 依赖 | 需要安装 FFmpeg | 纯 JS，无需外部依赖 |
| 行业认可 | ✅ Netflix/Spotify 使用 | 社区库 |

## 技术细节

### 元数据解析流程

1. **调用 FFprobe**：
   ```bash
   ffprobe -v quiet -print_format json -show_format -show_streams "audio.flac"
   ```

2. **解析 JSON 输出**：
   ```json
   {
     "format": {
       "duration": 234.5,
       "tags": {
         "title": "歌曲名",
         "artist": "艺术家",
         "album": "专辑"
       }
     },
     "streams": [
       {
         "codec_type": "video",
         "disposition": { "attached_pic": 1 }
       }
     ]
   }
   ```

3. **提取封面**（如果存在）：
   ```bash
   ffmpeg -v quiet -i "audio.flac" -an -vcodec copy -f image2pipe -
   ```

### 支持的元数据字段

- `title` / `TITLE`：标题
- `artist` / `ARTIST`：艺术家
- `album` / `ALBUM`：专辑
- `album_artist` / `ALBUM_ARTIST`：专辑艺术家
- `date` / `DATE`：年份
- `genre` / `GENRE`：流派
- `track` / `TRACK`：音轨号
- `disc` / `DISC`：碟片号

## 参考链接

- [FFmpeg 官网](https://ffmpeg.org/)
- [FFprobe 文档](https://ffmpeg.org/ffprobe.html)
- [音频元数据标准](https://en.wikipedia.org/wiki/ID3)
