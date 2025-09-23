FROM node:20-alpine AS base

WORKDIR /app

# Copy only the voice-rt-svc into the image (monorepo-aware but single-service container)
COPY services/voice-rt-svc/package.json ./package.json
COPY services/voice-rt-svc/src ./src

RUN npm install --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]

