FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production API_PORT=3001
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "server/index.ts"]
