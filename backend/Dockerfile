FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

# better-sqlite3 and other native dependencies are built only in this stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# 启用全局 Web API（File, FormData 等）
ENV NODE_ENV=production \
    NODE_OPTIONS=--experimental-global-webcrypto

# git is used by the code repository routes; ffmpeg also provides ffprobe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations

# 创建必要的目录
RUN mkdir -p data/database data/documents data/music data/code data/uploads data/logs

EXPOSE 3000

CMD ["npm", "start"]
