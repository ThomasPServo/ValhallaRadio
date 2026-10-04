FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI: the station's AI runs on your Claude subscription (pass CLAUDE_CODE_OAUTH_TOKEN)
ARG INSTALL_CLAUDE_CODE=1
RUN if [ "$INSTALL_CLAUDE_CODE" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi
# Codex CLI: ChatGPT as the station's AI (sign in with `codex login --device-auth`, or mount ~/.codex)
ARG INSTALL_CODEX=0
RUN if [ "$INSTALL_CODEX" = "1" ]; then npm install -g @openai/codex && npm cache clean --force; fi
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production VALHALLA_DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
