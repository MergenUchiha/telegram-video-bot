# Shared image for both entry points. The API runs `node dist/main.js` and the
# worker `node dist/worker.js`; docker-compose.yml picks the command.
# ffmpeg is only needed by the worker, but keeping one image avoids a second
# build and the drift that comes with it.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Installed with bun: bun.lock is this project's lock file, and npm resolves
# the same tree into an ERESOLVE peer conflict.
RUN npm install -g bun@1

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate --schema prisma/schemas

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that gets copied into the runtime stage
RUN bun install --frozen-lockfile --production

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# ffmpeg/ffprobe do the rendering; fonts-dejavu backs the default FONT_PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json prisma.config.ts ./

# Renders write here; mount a volume if the files should outlive the container
RUN mkdir -p /tmp/renderer && chown -R node:node /tmp/renderer
USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
