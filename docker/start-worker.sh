#!/bin/sh
set -e

echo "Starting worker..."
exec node dist/src/worker.js
