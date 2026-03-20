FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      curl \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY dist ./dist

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
