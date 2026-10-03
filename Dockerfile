FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production VALHALLA_DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
