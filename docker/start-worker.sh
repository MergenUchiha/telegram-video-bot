#!/bin/sh
set -eu

echo "Waiting for Prisma schema to become available..."
until npx prisma migrate status --schema prisma/schemas >/dev/null 2>&1; do
  echo "Database not ready for worker, retrying in 3s..."
  sleep 3
done

exec node dist/worker.js
