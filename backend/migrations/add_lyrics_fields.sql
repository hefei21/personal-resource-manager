-- 添加歌词相关字段到 music 表
-- 执行时间: 2026-03-30

-- 1. 添加歌词文本字段
ALTER TABLE music ADD COLUMN lyrics TEXT;

-- 2. 添加歌词来源字段
ALTER TABLE music ADD COLUMN lyrics_source TEXT;

-- 3. 添加歌词存在标志（用于快速查询）
ALTER TABLE music ADD COLUMN has_lyrics INTEGER DEFAULT 0;

-- 4. 添加歌词更新时间
ALTER TABLE music ADD COLUMN lyrics_updated_at DATETIME;

-- 创建索引以加速查询
CREATE INDEX IF NOT EXISTS idx_music_has_lyrics ON music(has_lyrics);
