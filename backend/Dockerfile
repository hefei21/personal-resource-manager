FROM node:18-slim

WORKDIR /app

# 启用全局 Web API（File, FormData 等）
ENV NODE_OPTIONS=--experimental-global-webcrypto

# 安装编译工具、Python、Git、SVN、FFmpeg、wget（用于编译 better-sqlite3 和音频元数据解析）
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    git \
    subversion \
    ffmpeg \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安装依赖（优先复制 package 文件以利用缓存）
COPY package.json ./
RUN npm install --omit=dev

# 复制源代码
COPY . .

# 创建必要的目录
RUN mkdir -p data/database data/documents data/music data/code data/uploads data/logs

EXPOSE 3000

CMD ["npm", "start"]
