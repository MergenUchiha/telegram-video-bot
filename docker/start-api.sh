#!/bin/sh
set -eu

echo "Applying Prisma migrations..."
until npx prisma migrate deploy --schema prisma/schemas; do
  echo "Prisma migrate deploy failed, retrying in 3s..."
  sleep 3
done

exec node dist/src/main.js
