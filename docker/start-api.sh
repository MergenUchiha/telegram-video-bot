#!/bin/sh
set -e

echo "Applying Prisma migrations..."
npx prisma migrate deploy --schema prisma/schemas

echo "Starting API server..."
exec node dist/main.js
