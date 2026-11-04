"""Apply Pixel Societies SQL migrations against a Postgres URL.

Why this exists: `supabase db push --linked` is flaky for IPv6-only
projects + asyncpg + the Render runtime, and silently picks the wrong
target when CWD is wrong. This script:

  1. Reads `supabase/migrations/*.sql` in lexical order (the standard
     Supabase ordering — same as Supabase CLI uses).
  2. Skips any migration whose filename is already recorded in the
     `public._pixel_societies_migrations` ledger table on the target DB.
  3. Wraps each unapplied migration in a transaction; bombs on first
     failure so we don't half-apply.

Usage (called from `scripts/db-push.sh`, but you can invoke directly):

    python backend/scripts/db_push.py --db-url "$SUPABASE_DB_URL" --dry-run
    python backend/scripts/db_push.py --db-url "$SUPABASE_DB_URL"

Env-var equivalent:

    SUPABASE_DB_URL='postgresql://...' python backend/scripts/db_push.py
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"


LEDGER_DDL = """
create table if not exists public._pixel_societies_migrations (
    filename text primary key,
    applied_at timestamptz not null default now(),
    sha256 text
);
"""


async def main(db_url: str, dry_run: bool, mark_applied: bool) -> int:
    if not MIGRATIONS_DIR.is_dir():
        print(f"!! migrations dir missing: {MIGRATIONS_DIR}", file=sys.stderr)
        return 2

    files = sorted(p for p in MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        print("!! no .sql files found", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(db_url, statement_cache_size=0)
    try:
        await conn.execute(LEDGER_DDL)
        applied: set[str] = {
            r["filename"]
            for r in await conn.fetch(
                "select filename from public._pixel_societies_migrations"
            )
        }
        pending = [p for p in files if p.name not in applied]
        print(f"== migrations: {len(files)} on disk, {len(applied)} already "
              f"applied, {len(pending)} pending")
        for p in pending:
            print(f"  → {p.name}")
        if dry_run:
            print("\n[dry-run] no changes made")
            return 0
        if not pending:
            print("\nUp to date.")
            return 0
        if mark_applied:
            # One-time bootstrap for a DB that's already at HEAD but
            # whose ledger table is empty (e.g. local dev where you
            # applied via raw asyncpg before this script existed).
            print("\n[--mark-applied] recording all pending as applied "
                  "WITHOUT running them.")
            for p in pending:
                await conn.execute(
                    "insert into public._pixel_societies_migrations (filename) "
                    "values ($1) on conflict do nothing",
                    p.name,
                )
            print(f"   marked {len(pending)} migration(s) as applied.")
            return 0
        for p in pending:
            print(f"\n-- applying {p.name} --")
            sql = p.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "insert into public._pixel_societies_migrations (filename) "
                    "values ($1)",
                    p.name,
                )
            print(f"   applied OK")
        print(f"\nDone. {len(pending)} migration(s) applied.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db-url",
        default=os.environ.get("SUPABASE_DB_URL"),
        help="Postgres URL. Defaults to $SUPABASE_DB_URL.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--mark-applied",
        action="store_true",
        help="Record all pending migrations as applied WITHOUT running them. "
        "Use this once on a DB that's already at HEAD but missing the "
        "ledger table.",
    )
    args = parser.parse_args()
    if not args.db_url:
        sys.exit("!! --db-url not provided and SUPABASE_DB_URL not set")
    raise SystemExit(asyncio.run(main(args.db_url, args.dry_run, args.mark_applied)))
