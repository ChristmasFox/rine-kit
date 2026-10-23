#!/usr/bin/env bash
# Runs a command with MEMORY_TEST_DATABASE_URL pointing at a throwaway pgvector PostgreSQL container
# (never a real database), then removes the container.
#   scripts/with-pgvector.sh <command> [args...]
set -euo pipefail
NAME="rine-kit-memtest-pg-$$"
IMAGE="${MEMORY_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=memtest -e POSTGRES_DB=memtest \
  -p "127.0.0.1::5432" "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d memtest >/dev/null 2>&1 && break
  sleep 1
done
sleep 1
MEMORY_TEST_DATABASE_URL="postgres://postgres:memtest@127.0.0.1:${PORT}/memtest" "$@"
