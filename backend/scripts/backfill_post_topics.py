"""Backfill `topic` for `pixel_agent_posts` rows that predate migration 0011.

Posts written before the topic column existed have `topic IS NULL` and
collapse into a single "untagged" group in the UI. This script:

  1. Selects every NULL-topic post from a target DB.
  2. Asks Gemini for a 1-3 word lowercase topic per body (one call each).
  3. Writes the topic back. Idempotent — re-runs skip already-tagged rows.

Usage:
    SUPABASE_DB_URL='postgresql://...' \
        GEMINI_API_KEY='...' \
        python backend/scripts/backfill_post_topics.py

The Gemini call uses pydantic-ai's GoogleModel through the same dispatch
that production uses (`conversation._build_model()`), so the topics
match the style of new ticks. Concurrency is capped at 5 to stay well
under Gemini's free-tier RPM.
"""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

import asyncpg
from pydantic import BaseModel, Field
from pydantic_ai import Agent

# Reuse the production model dispatch so backfill topics share style
# with live-tick topics.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.conversation import _build_model  # noqa: E402

CONCURRENCY = 5


class TopicTag(BaseModel):
    topic: str = Field(
        min_length=1,
        max_length=40,
        description="1-3 word lowercase topic capturing the SUBJECT of the "
        "post (not the mood). Examples: 'ai safety', 'enterprise gtm', "
        "'team dynamics', 'fundraising', 'hardware', 'product validation'. "
        "Avoid generic tags like 'thought' or 'reflection'.",
    )


def _build_tagger() -> Agent[None, TopicTag]:
    return Agent(
        model=_build_model(),
        output_type=TopicTag,
        system_prompt=(
            "You assign a short topic tag to a single short social post. "
            "Pick the SUBJECT being discussed in 1-3 lowercase words. "
            "Be specific (e.g. 'ai safety', 'enterprise gtm') not generic "
            "('thoughts', 'work'). If multiple topics, pick the dominant one."
        ),
    )


async def _tag(agent: Agent[None, TopicTag], body: str) -> str:
    result = await agent.run(body)
    return (result.output.topic or "").strip().lower()[:40] or "untagged"


async def main() -> int:
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("!! SUPABASE_DB_URL not set")
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        sys.exit("!! GEMINI_API_KEY (or GOOGLE_API_KEY) not set")

    conn = await asyncpg.connect(db_url, statement_cache_size=0)
    try:
        rows: list[dict[str, Any]] = [
            dict(r) for r in await conn.fetch(
                """
                select id, body
                  from public.pixel_agent_posts
                 where topic is null
                 order by id asc
                """
            )
        ]
        if not rows:
            print("nothing to backfill — every post already has a topic.")
            return 0
        print(f"backfilling {len(rows)} post(s)…")

        agent = _build_tagger()
        sem = asyncio.Semaphore(CONCURRENCY)
        ok = 0
        fail = 0

        async def worker(row: dict[str, Any]) -> None:
            nonlocal ok, fail
            async with sem:
                try:
                    topic = await _tag(agent, row["body"])
                    await conn.execute(
                        "update public.pixel_agent_posts set topic = $1 where id = $2",
                        topic,
                        row["id"],
                    )
                    ok += 1
                    print(f"  [{row['id']:>5}] {topic:<24} :: {row['body'][:60]}")
                except Exception as exc:  # noqa: BLE001
                    fail += 1
                    print(f"  [{row['id']:>5}] FAILED: {exc}")

        await asyncio.gather(*(worker(r) for r in rows))
        print(f"\nDone. tagged={ok} failed={fail}")

        # Quick distribution summary so we can eyeball topic shape.
        dist = await conn.fetch(
            """
            select coalesce(topic, '<null>') as topic, count(*) as n
              from public.pixel_agent_posts
             group by 1
             order by 2 desc
             limit 20
            """
        )
        print("\nTop topics in prod after backfill:")
        for r in dist:
            print(f"  {r['n']:>4}  {r['topic']}")
        return 0 if fail == 0 else 1
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
