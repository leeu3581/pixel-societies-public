#!/bin/sh
set -eu
# Azure Files mounted here persists across container replacement.
mkdir -p /home/pixel-data/wikis
cp -Rn /opt/seed-wikis/. /home/pixel-data/wikis/
# One process: engine state, WebSocket sessions and task registries are local.
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --no-access-log
