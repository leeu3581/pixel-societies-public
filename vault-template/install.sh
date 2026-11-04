#!/bin/bash
# Copy this template into the live wiki dir so Obsidian opens with the
# graph view + per-agent colour groups configured.
#
# Run from repo root:
#   ./vault-template/install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$(cd "$HERE/.." && pwd)/backend/data/wikis"
mkdir -p "$TARGET/.obsidian"
cp -R "$HERE/.obsidian/." "$TARGET/.obsidian/"
cp "$HERE/README.md" "$TARGET/README.md"
echo "✓ vault config installed at: $TARGET"
echo "  open Obsidian → 'Open vault as folder' → $TARGET"
