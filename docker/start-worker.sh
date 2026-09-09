#!/bin/sh
set -e

echo "Starting render worker..."
exec node dist/worker.js
