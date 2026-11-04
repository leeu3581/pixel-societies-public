#!/usr/bin/env bash
# Regenerate the local dev seed from a source Postgres (Azure or Supabase).
#   SRC_DSN='postgresql://user:pass@host:5432/db?sslmode=require' ./make-seed.sh
set -euo pipefail
: "${SRC_DSN:?set SRC_DSN to the source Postgres connection string}"
DIR="$(cd "$(dirname "$0")" && pwd)"
pg_dump "$SRC_DSN" --schema=auth --schema=public \
  --no-owner --no-privileges --format=plain \
  --file="$DIR/init/02_seed.sql"
echo "wrote $DIR/init/02_seed.sql ($(du -h "$DIR/init/02_seed.sql" | cut -f1))"
