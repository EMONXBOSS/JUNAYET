FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Always pull the newest yt-dlp at build time (server also self-updates every 6h)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
