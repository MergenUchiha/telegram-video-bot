# Telegram Video Bot

## Project Summary

This project is a Telegram-based video production bot for short-form vertical content.

Its main job is to take either:

- a user-uploaded video and enhance it with TTS, subtitles, and overlay text
- or a fully automated "Spanish Jokes Auto" workflow that assembles a video from a joke, a background clip, and music

From a product perspective, this is an internal content automation tool for a creator or content operator. The user interacts only through Telegram, while the backend handles asset storage, job queuing, rendering, and delivery.

## What The Product Does

The bot currently supports two content modes:

### 1. Standard Render Mode

The user:

- creates a session with `/new`
- uploads a source video
- configures rendering options
- starts rendering

The system can then:

- generate TTS from user text through Kokoro
- burn hard subtitles into the video
- add a bottom text/comment overlay
- manage the original audio with `REPLACE`, `DUCK`, `MUTE`, or `KEEP`
- return the rendered MP4 back to Telegram

### 2. Spanish Jokes Auto Mode

The user:

- starts a session with `/auto`
- optionally chooses a fixed background video, fixed music track, and text-card preset
- optionally enables future YouTube auto-publish
- starts rendering

The system then:

- loads a Spanish joke from a cached pool
- refreshes the joke pool from external joke websites when exhausted
- picks a background video from the media library
- picks a music track from the media library
- generates a text-card overlay with the joke
- renders a vertical video automatically
- sends the result back to Telegram

## Who Uses It

There are two user roles in the current implementation:

- regular Telegram users who create render sessions
- admin users who manage the media library through `/library`

Admin access is controlled by `ADMIN_TELEGRAM_USER_IDS`.

## Main User Commands

The Telegram bot currently exposes these commands:

- `/start` - help and product usage summary
- `/new` - create a new standard render session
- `/auto` - create a new Spanish Jokes Auto session
- `/settings` - open the current session settings panel
- `/status` - show render state, progress, and last error
- `/library` - admin-only media library management

Note: the bot interface text is currently written in Russian.

## How The System Works

### Standard Flow

1. The user starts a new session with `/new`.
2. The user uploads a video in Telegram.
3. The bot stores the input asset in S3-compatible storage under `inputs/...`.
4. Session settings are stored in PostgreSQL through Prisma.
5. When the user confirms rendering, the app enqueues a BullMQ job using the session ID as the job ID.
6. The worker acquires a Redis lock so one user cannot run overlapping renders.
7. The worker downloads the source video, probes it with `ffprobe`, and prepares optional TTS/subtitles.
8. `ffmpeg` builds the final vertical video.
9. The output is uploaded to storage under `outputs/...`.
10. The bot sends the video back to the Telegram chat.
11. Metrics and progress are recorded in Redis.

### Spanish Jokes Auto Flow

1. The user starts `/auto`.
2. The app creates a ready-to-render session without requiring a user video.
3. The worker takes a joke from the Redis joke pool.
4. If the joke pool is exhausted, it refreshes the pool by scraping configured Spanish joke sources.
5. The worker selects background media from the admin-managed library.
6. The app generates an ASS text card for the joke.
7. `ffmpeg` combines looped background video, optional music, and the text card.
8. The output is uploaded and sent back to Telegram.

## High-Level Architecture

### User Interaction Layer

- `grammy` Telegram bot
- inline keyboards for settings and approvals
- admin-only library controls

### Application Layer

- NestJS application modules
- session management in PostgreSQL
- queue producer in BullMQ
- render worker processor

### Media Pipeline

- `Kokoro` for TTS generation
- `ffprobe` for media inspection
- `ffmpeg` for final rendering
- ASS/SRT generation for subtitles and joke cards

### Storage And State

- PostgreSQL for users, sessions, and future YouTube entities
- Redis for locks, progress, metrics, and joke caching
- S3-compatible storage or MinIO for inputs, outputs, and library assets

## Core Modules

- `src/modules/bot` - Telegram commands, settings UI, rate limiting, admin library actions
- `src/modules/sessions` - render session lifecycle and persistence
- `src/modules/queues` - BullMQ queue registration and job enqueueing
- `src/worker/render.processor.ts` - main rendering pipeline
- `src/modules/storage` - S3/MinIO upload, download, presigned URLs, lifecycle rules
- `src/modules/tts` - Kokoro TTS integration
- `src/modules/subtitles` - SRT and ASS subtitle generation
- `src/modules/library` - background video and music libraries
- `src/modules/jokes` - joke scraping, caching, and per-user usage tracking
- `src/modules/metrics` - render performance and failure metrics

## Data Model

The main persistent entity is `RenderSession`.

It stores:

- the active content mode
- source and output storage keys
- TTS settings
- subtitle mode
- overlay comment settings
- audio policy
- auto-mode media choices
- joke text
- render progress and last error

Other important entities:

- `User` - Telegram user/chat mapping
- `RenderJob` - render job tracking
- `YoutubeChannel` - future YouTube channel connection
- `YoutubeUpload` - future YouTube upload record

## External Dependencies

The project depends on these runtime services:

- PostgreSQL
- Redis
- S3-compatible object storage such as MinIO
- Kokoro TTS API
- `ffmpeg`
- `ffprobe`

`docker-compose.yml` currently starts:

- Redis
- MinIO
- Kokoro

The checked-in `docker-compose.yml` now contains the full runnable stack.

## Docker Deployment

The repository is now prepared for a single-command server bootstrap:

```bash
docker compose up -d --build
```

What this starts:

- PostgreSQL
- Redis
- MinIO
- MinIO bucket bootstrap
- Kokoro TTS
- NestJS API
- dedicated worker

Deployment behavior:

- the API container runs `prisma migrate deploy` on startup
- the worker waits until the database schema is available
- MinIO bucket creation is automatic
- the API health endpoint is `GET /ops/health`
- if `TELEGRAM_BOT_TOKEN` is missing or still equals `your_token_here`, the API starts without the Telegram bot instead of crashing

Important runtime note:

- `docker compose up -d --build` will boot the stack from a fresh clone using the checked-in `.env.example`
- to actually receive Telegram renders, set at least `TELEGRAM_BOT_TOKEN` and `AUTONOMY_OPS_CHAT_ID`
- to enable autonomous YouTube publishing, also set the `YOUTUBE_*` env vars

## Local Run Notes

Install dependencies:

```bash
npm install
```

Generate Prisma client:

```bash
npm run prisma:generate
```

Run the API/bot process:

```bash
npm run start:dev
```

Run the dedicated worker process:

```bash
npm run start:worker:dev
```

Build for production:

```bash
npm run build
```

## Required Configuration

At minimum, this project needs:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `REDIS_HOST`
- `REDIS_PORT`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_BUCKET`
- `KOKORO_BASE_URL`

Commonly needed optional settings:

- `ADMIN_TELEGRAM_USER_IDS`
- `TELEGRAM_API_BASE_URL`
- `TELEGRAM_BOT_MODE`
- `PORT`
- `FFMPEG_PATH`
- `FFPROBE_PATH`
- `RENDER_TMP_DIR`
- `OUTPUT_WIDTH`
- `OUTPUT_HEIGHT`
- `DEFAULT_DUCK_DB`
- `MUSIC_VOLUME_DB`
- `METRICS_TOKEN`
- `OPS_API_TOKEN`
- `BULLMQ_PREFIX`

There are additional tuning variables for joke fetching, rate limits, Redis TLS, storage presign expiry, cleanup windows, and lifecycle retention.

## Test Render Request

You can now trigger a manual quality-check video without using the Telegram UI.

Create a test render:

```bash
curl -X POST http://YOUR_SERVER:3000/ops/test-video \
  -H "Authorization: Bearer YOUR_OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "preset": "default",
    "deliveryChatId": "YOUR_TELEGRAM_CHAT_ID"
  }'
```

Optional fields:

- `preset` - `default`, `dark`, `light`, or `minimal`
- `deliveryChatId` - Telegram chat ID for final delivery
- `fixedBackgroundVideoKey` - specific MinIO key instead of random library selection
- `fixedBackgroundMusicKey` - specific MinIO key instead of random library selection
- `jokeText` - force a specific joke instead of random web selection
- `jokeSourceUrl` - optional source URL stored with the session

Check render status and get the video URL:

```bash
curl http://YOUR_SERVER:3000/ops/test-video/SESSION_ID \
  -H "Authorization: Bearer YOUR_OPS_API_TOKEN"
```

When rendering is complete, the response includes `outputVideoUrl`.

## Monitoring And Operations

### Available Today

- `GET /metrics` returns job success/failure counts and duration summaries
- `GET /ops/health` is the container healthcheck endpoint
- `POST /ops/test-video` creates a manual Spanish-joke quality-check render
- `GET /ops/test-video/:sessionId` returns render state and the output URL
- Redis stores per-session progress and last error for `/status`
- worker cleanup removes stale temp directories on startup
- storage lifecycle rules can expire `inputs/` and `outputs/`

## Current Content Logic

- Jokes are found automatically. The worker loads them from a Redis cache, refreshes that cache from external Spanish joke websites when the pool is exhausted, and falls back to built-in jokes if scraping fails.
- Background videos are not downloaded automatically from the internet. The normal path uses your admin-managed library in MinIO. If that library is empty, the worker now generates a simple built-in fallback background so smoke tests can still render.
- The joke card is centered. The default visual preset is white text on a dark semi-transparent box. It is not a white background by default. If you want a white card, use the `light` preset.
- Video duration is currently driven by the chosen background clip length. If the worker uses the generated fallback background, or if duration metadata is missing, it falls back to `AUTO_VIDEO_DURATION_SEC` from env, which defaults to `45` seconds in `.env.example`.

### Partially Implemented Or Planned

- YouTube auto-publish is not implemented yet
- the queue dashboard module exists in code (`/admin/queues`) but is not currently imported into `AppModule`

## Current Product Status

This project is beyond scaffold stage and already implements the core rendering workflow, but it is still an MVP with some unfinished areas.

Current strengths:

- end-to-end Telegram render flow exists
- automated content mode exists
- media library management exists
- queueing, locking, storage, and metrics are present

Current gaps:

- YouTube publishing is only a placeholder
- the existing e2e test file is still the default Nest starter test and does not validate real behavior
- subtitle support is effectively hard subtitles only in the current render flow

## Short Business Summary

In simple terms, this project is a Telegram-operated short-video factory.

It lets an operator either enhance uploaded videos or generate Spanish-joke videos automatically, using a backend stack made of NestJS, BullMQ, Redis, PostgreSQL, MinIO/S3, Kokoro TTS, and FFmpeg.
