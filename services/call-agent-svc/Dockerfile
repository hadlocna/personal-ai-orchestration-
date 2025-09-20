# syntax=docker/dockerfile:1

FROM node:20-alpine
WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY infra ./infra

RUN npm install --omit=dev

EXPOSE 4020
CMD ["node", "services/call-agent-svc/src/index.js"]


