#!/usr/bin/env bash
# Start a throwaway PostgreSQL 16 cluster for tests and print the env vars to use.
# Usage: eval "$(scripts/test-db.sh)"
set -euo pipefail
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
DIR=${BAATS_TEST_PGDIR:-/tmp/baats-pg}
PORT=${BAATS_TEST_PGPORT:-5433}
if [ ! -d "$DIR/data" ]; then
  mkdir -p "$DIR"
  "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
fi
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-k $DIR -p $PORT" -l "$DIR/log" status >/dev/null 2>&1 \
  || "$PGBIN/pg_ctl" -D "$DIR/data" -o "-k $DIR -p $PORT" -l "$DIR/log" -w start >/dev/null
echo "export TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:$PORT/postgres"
