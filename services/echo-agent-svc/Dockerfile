# syntax=docker/dockerfile:1

FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY infra ./infra

RUN npm install --omit=dev

CMD ["node", "services/echo-agent-svc/src/index.js"]
