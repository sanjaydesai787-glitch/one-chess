FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/players.json ./players.json
COPY --from=builder /app/results.json ./results.json
COPY --from=builder /app/connections.json ./connections.json

EXPOSE 4000
ENV PORT=4000
CMD ["node", "server.js"]
