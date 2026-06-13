# Shared Notes — Express + WebSocket collaborative board (yjs). Pure-JS deps, so it
# builds cleanly on arm64. The board persists to data/board.bin via in-place writes,
# kept on a bind-mounted ./data so existing notes survive and persist across rebuilds.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3002 HOST=0.0.0.0
EXPOSE 3002
CMD ["node", "server.js"]
