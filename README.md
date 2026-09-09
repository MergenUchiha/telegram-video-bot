# Telegram Video Bot

A Telegram bot that turns a source clip into a vertical 1080×1920 short:
re-frames the video, adds narration, subtitles and an overlay caption, mixes the
audio, and sends the result back — optionally publishing it to YouTube.

Rendering runs in a separate worker process, so the bot stays responsive while
ffmpeg works, and workers scale independently of the API.

## Two modes

**Standard.** You send a video, then choose what happens to it: text-to-speech
narration from a message you type, subtitles (burned in or a separate track), an
overlay caption card, and how the original audio behaves — replaced, ducked,
muted or kept.

**Spanish Jokes Auto.** The bot pulls a short joke from a set of Spanish humour
sites, picks a background clip and a music bed from the library, renders a text
card and narrates it. Used jokes are remembered, so the same one is not
published twice.

## How a render flows

```
Telegram ──▶ bot (grammY) ──▶ session in Postgres
                                  │
                          BullMQ "render" queue (Redis)
                                  │
                              worker process
                    download → ffmpeg → upload to S3
                                  │
              back to Telegram  ─┴─▶  optional "youtube" queue
```

- Sessions are a state machine (`WAIT_VIDEO → WAIT_TEXT_OR_SETTINGS →
  READY_TO_RENDER → RENDER_QUEUED → RENDERING → RENDER_DONE / RENDER_FAILED`).
- Jobs are idempotent: the BullMQ job id is the session id, so a retry or a
  double tap cannot start two renders of the same session.
- A Redis lock per user prevents one person from occupying several workers.
- Progress is written to Redis and reflected in the bot message.

## Stack

NestJS 11 · grammY · BullMQ on Redis · Prisma 7 on PostgreSQL · S3/MinIO ·
ffmpeg · [Kokoro](https://github.com/remsky/Kokoro-FastAPI) for text-to-speech ·
YouTube Data API.

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on PATH (or point `FFMPEG_PATH` / `FFPROBE_PATH` at them)
- PostgreSQL
- Docker, for Redis, MinIO and Kokoro

## Setup

### Everything in containers

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and the passwords
docker compose up -d --build
```

That brings up all seven services: Postgres, Redis, MinIO (plus a one-shot job
that creates the bucket), Kokoro, the API and the worker. The API container
applies migrations before it starts, and the worker waits for it to report
healthy, so a fresh checkout needs no manual step.

### Running the application locally

```bash
bun install            # or npm install
cp .env.example .env

docker compose up -d postgres redis minio minio-init kokoro
npm run prisma:generate
npm run prisma:migrate
```

Then start the two processes — both are needed, the bot alone renders nothing:

```bash
npm run start:dev            # API + bot
npm run start:worker:dev     # render worker
```

`npm run prisma:generate` is not optional after a fresh install: the build reads
its types and fails with ~50 errors without it.

`MINIO_ROOT_PASSWORD` and `POSTGRES_PASSWORD` have no defaults — compose refuses
to start without them, and MinIO refuses to start with a blank one.
`S3_ACCESS_KEY`/`S3_SECRET_KEY` have to match the MinIO root credentials.

## Configuration

Every variable is validated at boot by `src/common/config/env.validation.ts`,
so a missing or malformed value stops the process with a message naming it.
`.env.example` lists all of them; the ones worth knowing:

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_BOT_MODE` | `polling` or `webhook` |
| `DATABASE_URL` | PostgreSQL connection string |
| `S3_*` | object storage — endpoint, keys, bucket |
| `KOKORO_*` | text-to-speech service and voice |
| `ENCRYPTION_KEY` | 64 hex chars; encrypts stored YouTube refresh tokens |
| `ADMIN_TELEGRAM_USER_IDS` | who may manage the background/music library |
| `YOUTUBE_CLIENT_ID` / `_SECRET` | Google OAuth credentials |
| `RATE_LIMIT_*` | per-user limits on messages, uploads and renders |
| `METRICS_TOKEN` / `BULL_BOARD_TOKEN` | bearer tokens for `/metrics` and the queue dashboard |

## Bot commands

| Command | What it does |
| --- | --- |
| `/start` | opens the main menu — Standard or Spanish Jokes Auto |
| `/status` | current session state and render progress |
| `/library` | manage background clips and music (admins only) |
| `/channels` | connect and switch YouTube channels |

## HTTP endpoints

| Path | Purpose |
| --- | --- |
| `GET /health`, `/health/live`, `/health/ready` | liveness and dependency checks |
| `GET /metrics` | queue and render counters, bearer `METRICS_TOKEN` |
| `GET /youtube/callback` | OAuth redirect target |
| `/admin/queues` | Bull Board dashboard, bearer `BULL_BOARD_TOKEN` |

> Both tokens are required for their endpoint to answer at all: while
> `METRICS_TOKEN` is unset `/metrics` returns 401, and while `BULL_BOARD_TOKEN`
> is unset the dashboard returns 503.

## Storage layout

| Prefix | Contents |
| --- | --- |
| `library/backgrounds/` | background clips for the jokes mode |
| `library/music/` | music beds |
| `inputs/<session>/` | uploaded source videos, swept after `INPUT_LIFECYCLE_DAYS` |
| `outputs/<session>/` | rendered videos, swept after `OUTPUT_LIFECYCLE_DAYS` |

Temporary render files live under `RENDER_TMP_DIR` and are swept by the
worker's cleanup service after `TMP_CLEANUP_AGE_HOURS`.

## YouTube

`/channels` starts an OAuth flow; the refresh token comes back through
`GET /youtube/callback` and is stored encrypted with `ENCRYPTION_KEY`. A session
with auto-publish enabled queues an upload job once its render finishes.

## Scaling

The API and the worker are separate entry points (`dist/main.js` and
`dist/worker.js`), so workers scale on their own:

```bash
docker compose up --scale worker=3 -d
```

## Known limits

- Uploaded videos are held in memory when sent back to Telegram, so a 50MB
  result costs 50MB of worker heap.
- The jokes parser scrapes four public sites; a layout change there breaks that
  mode until the selectors are updated.
- Tests cover the health endpoints only.
