"""Seed public.canonical_agents from data/wikis/*/.

Run once after `supabase db reset`, or any time you want to refresh the
canonical agent templates from the markdown source of truth.

Reads SUPABASE_DB_URL from .env (the local supabase Postgres). Connects
as the postgres role so RLS doesn't block the upsert.

Each wiki directory contributes one canonical_agent row:
    id            = directory name (e.g. "support")
    display_name  = name after the em-dash in personality.md's H1
    subtitle      = the first italic line after the H1, sans markers
    persona_md    = personality.md + every topic/belief page concatenated
                    with `---` separators. Mirrors `_load_persona` in
                    backend/app/consult.py:149 so DB-backed consult
                    flows have the same persona surface area as the
                    legacy filesystem-backed flow.
"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

# Configure observability first so the seed run shows up in Logfire too.
load_dotenv(Path(__file__).parent / ".env")
from app.observability import configure as configure_observability, log_canonical_seed  # noqa: E402

configure_observability()

ROOT = Path(__file__).parent
WIKIS_DIR = ROOT / "data" / "wikis"

H1_RE = re.compile(r"^#\s+(?:Who I Am\s*[—–-]\s*)?(.+?)\s*$", re.MULTILINE)
ITALIC_LINE_RE = re.compile(r"^\*([^\n]+?)\.?\*\s*$", re.MULTILINE)


def build_full_persona_md(wiki_dir: Path) -> str:
    """Bundle personality.md + every topic/belief page into one persona blob.

    Mirrors `_load_persona` in app/consult.py: personality.md first, then
    every other `*.md` in sorted order, joined by `---`. The hub page
    (`<Name>.md`) and `lessons.md` are skipped — the hub is meta, lessons
    accrue at runtime and aren't part of the deterministic seed.
    """
    personality = wiki_dir / "personality.md"
    if not personality.is_file():
        return ""

    parts: list[str] = [personality.read_text(encoding="utf-8")]
    skip = {"personality.md", "lessons.md", "README.md"}
    for p in sorted(wiki_dir.glob("*.md")):
        if p.name in skip:
            continue
        # Skip the hub page (named after the agent's display name). We
        # don't have the parsed display_name here yet, but the hub is
        # always the only file that's not personality/lessons/README and
        # whose H1 matches a person's name without the "Who I Am —"
        # prefix; treat any single-word stem starting with an uppercase
        # letter as a hub candidate. Rather than fragile heuristics,
        # rely on the convention used elsewhere: hub stems start with
        # an uppercase letter. Topic pages are always lowercase-kebab.
        if p.stem and p.stem[0].isupper():
            continue
        parts.append(p.read_text(encoding="utf-8"))
    return "\n\n---\n\n".join(parts)


def parse_personality(md: str, agent_id: str) -> tuple[str, str | None]:
    """Pull display_name and subtitle out of a personality.md."""
    body = md
    if md.startswith("---"):
        end = md.find("---", 3)
        if end != -1:
            body = md[end + 3 :].lstrip()

    name = agent_id.title()
    m = H1_RE.search(body)
    if m:
        candidate = m.group(1).strip()
        if "—" in candidate:
            candidate = candidate.split("—", 1)[1].strip()
        elif "-" in candidate and candidate.lower().startswith("who i am"):
            candidate = candidate.split("-", 1)[1].strip()
        if candidate:
            name = candidate

    subtitle: str | None = None
    if m:
        after_h1 = body[m.end() :]
        sm = ITALIC_LINE_RE.search(after_h1)
        if sm:
            subtitle = sm.group(1).strip()

    return name, subtitle


async def main() -> None:
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL not set in .env")

    if not WIKIS_DIR.is_dir():
        raise SystemExit(f"wikis dir not found: {WIKIS_DIR}")

    rows: list[tuple[str, str, str | None, str]] = []
    for entry in sorted(WIKIS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        personality = entry / "personality.md"
        if not personality.is_file():
            continue
        text = personality.read_text(encoding="utf-8")
        display, subtitle = parse_personality(text, entry.name)
        full_persona = build_full_persona_md(entry)
        rows.append((entry.name, display, subtitle, full_persona))

    if not rows:
        raise SystemExit("no personality.md files found")

    conn = await asyncpg.connect(db_url)
    try:
        await conn.executemany(
            """
            insert into public.canonical_agents
                (id, display_name, subtitle, persona_md)
            values ($1, $2, $3, $4)
            on conflict (id) do update set
                display_name = excluded.display_name,
                subtitle     = excluded.subtitle,
                persona_md   = excluded.persona_md
            """,
            rows,
        )
        count = await conn.fetchval("select count(*) from public.canonical_agents")
        # Backfill existing user-owned agent rows so they pick up the
        # fattened persona blob too. Idempotent — the canonical_agents
        # row hasn't changed if you re-run without editing the wikis.
        backfilled = await conn.fetchval(
            """
            with updated as (
                update public.agents a
                   set persona_md = ca.persona_md,
                       updated_at = now()
                  from public.canonical_agents ca
                 where a.canonical_id = ca.id
                   and a.canonical_id is not null
                   and (a.persona_md is distinct from ca.persona_md)
                returning 1
            )
            select count(*) from updated
            """
        )
        sizes = await conn.fetch(
            "select id, length(coalesce(persona_md, '')) as n from public.canonical_agents order by n desc limit 5"
        )
        print(f"seeded {len(rows)} canonical_agents (table now has {count} rows)")
        print(f"backfilled {backfilled} public.agents rows from canonical_agents")
        print("largest personas:")
        for r in sizes:
            print(f"  {r['id']:20} {r['n']:>7} chars")
        log_canonical_seed(count=len(rows), source_dir=str(WIKIS_DIR))
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
