# syntax=docker/dockerfile:1

FROM node:20-alpine
WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

RUN npm install --omit=dev

CMD ["node", "services/orchestrator-svc/src/index.js"]
