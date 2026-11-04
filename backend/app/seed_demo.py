"""Seed a populated demo world for pixel/instinct.

Creates N demo builders, each a real `auth.users` row so the existing
signup trigger provisions profile + home world + twin agent exactly as a
real signup would. Then attaches a `builder_profiles` row (the L1
structured signal that normally comes from a Claude Code export) and
joins everyone to one shared demo group.

The demo group is deliberately NOT `pixel-square`: the square is capped
at MAX_SQUARE_AGENTS (5) and that same capped top-N feeds the canvas,
`_pick_pair` AND `_pick_room_speaker`. Every other group is uncapped, so
a non-square slug sidesteps the cap entirely.

Idempotent — re-running updates in place rather than duplicating.

    cd backend && ./venv/bin/python -m app.seed_demo
    cd backend && ./venv/bin/python -m app.seed_demo --reset
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

import httpx

from .db import acquire, close_pool, init_pool

DEMO_GROUP_SLUG = "cofounder-cafe"
DEMO_GROUP_NAME = "Co-Founder Cafe"
DEMO_EMAIL_DOMAIN = "demo.pixel.local"
DEMO_PASSWORD = os.environ.get("SEED_DEMO_PASSWORD", "")

# ── Demo builders ───────────────────────────────────────────────────
# Shaped so the matcher has something interesting to find: several pairs
# share a domain but lean opposite roles (the high-scoring case), and a
# few are near-duplicates of each other (the low-scoring control).
BUILDERS: list[dict[str, Any]] = [
    {
        "handle": "mira",
        "name": "Mira Okonkwo",
        "headline": "Builds streaming ingestion pipelines for LLM eval data",
        "role_lean": "infra",
        "stacks": ["python", "rust", "postgres", "kafka"],
        "domains": ["devtools", "evals", "data-infra"],
        "projects": ["eval-harness", "trace-collector", "replay-buffer"],
    },
    {
        "handle": "tomas",
        "name": "Tomás Ferreira",
        "headline": "Designs eval dashboards people actually read",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "d3"],
        "domains": ["devtools", "evals", "dataviz"],
        "projects": ["eval-dashboard", "trace-viewer"],
    },
    {
        "handle": "anya",
        "name": "Anya Raman",
        "headline": "Vector-free retrieval over markdown knowledge bases",
        "role_lean": "research",
        "stacks": ["python", "sqlite"],
        "domains": ["memory", "retrieval", "agents"],
        "projects": ["grep-memory", "alias-index"],
    },
    {
        "handle": "dmitri",
        "name": "Dmitri Hale",
        "headline": "Ships agent UIs with streaming tool-call traces",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "websockets"],
        "domains": ["agents", "memory", "devtools"],
        "projects": ["agent-console", "stream-inspector"],
    },
    {
        "handle": "priya",
        "name": "Priya Venkatesh",
        "headline": "Payment rails and ledger correctness for marketplaces",
        "role_lean": "infra",
        "stacks": ["go", "postgres", "kafka"],
        "domains": ["fintech", "payments", "data-infra"],
        "projects": ["ledger-core", "settlement-engine"],
    },
    {
        "handle": "callum",
        "name": "Callum Byrne",
        "headline": "Merchant-facing checkout flows and onboarding",
        "role_lean": "product",
        "stacks": ["typescript", "nextjs", "stripe"],
        "domains": ["fintech", "payments", "growth"],
        "projects": ["checkout-kit", "merchant-portal"],
    },
    {
        "handle": "sora",
        "name": "Sora Nakamura",
        "headline": "Local-first sync engines with CRDT conflict resolution",
        "role_lean": "infra",
        "stacks": ["rust", "typescript", "sqlite"],
        "domains": ["local-first", "sync", "devtools"],
        "projects": ["crdt-sync", "offline-store"],
    },
    {
        "handle": "elena",
        "name": "Elena Fischer",
        "headline": "Collaborative editors that feel instant offline",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "wasm"],
        "domains": ["local-first", "sync", "editors"],
        "projects": ["doc-editor", "presence-layer"],
    },
    {
        "handle": "kofi",
        "name": "Kofi Mensah",
        "headline": "Simulation engines for multi-agent economies",
        "role_lean": "research",
        "stacks": ["python", "jax"],
        "domains": ["agents", "simulation", "economics"],
        "projects": ["agent-sim", "market-model"],
    },
    {
        "handle": "beatriz",
        "name": "Beatriz Lima",
        "headline": "Turns simulations into things you can watch and poke",
        "role_lean": "interface",
        "stacks": ["typescript", "phaser", "webgl"],
        "domains": ["simulation", "games", "dataviz"],
        "projects": ["sim-canvas", "timeline-scrubber"],
    },
    {
        "handle": "jonas",
        "name": "Jonas Wexler",
        "headline": "Compiler tooling and incremental build graphs",
        "role_lean": "infra",
        "stacks": ["rust", "cpp"],
        "domains": ["compilers", "build-systems", "devtools"],
        "projects": ["incr-build", "dep-graph"],
    },
    {
        "handle": "nadia",
        "name": "Nadia Christensen",
        "headline": "Developer onboarding — docs, examples, first-run UX",
        "role_lean": "product",
        "stacks": ["typescript", "mdx"],
        "domains": ["devtools", "docs", "growth"],
        "projects": ["docs-site", "quickstart-kit"],
    },
    {
        "handle": "arjun",
        "name": "Arjun Malhotra",
        "headline": "Voice agents with sub-300ms turn-taking",
        "role_lean": "infra",
        "stacks": ["python", "rust", "webrtc"],
        "domains": ["voice", "agents", "realtime"],
        "projects": ["turn-detector", "audio-pipeline"],
    },
    {
        "handle": "lena",
        "name": "Lena Thorpe",
        "headline": "Conversation design for voice-first products",
        "role_lean": "product",
        "stacks": ["typescript", "python"],
        "domains": ["voice", "conversation-design", "agents"],
        "projects": ["dialog-kit", "prompt-studio"],
    },
    {
        "handle": "yusuf",
        "name": "Yusuf Demir",
        "headline": "Observability for LLM apps — traces, cost, regressions",
        "role_lean": "infra",
        "stacks": ["go", "clickhouse", "opentelemetry"],
        "domains": ["observability", "evals", "devtools"],
        "projects": ["llm-tracer", "cost-attributor"],
    },
    {
        "handle": "hana",
        "name": "Hana Oyelaran",
        "headline": "Makes observability data legible to non-engineers",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "d3"],
        "domains": ["observability", "dataviz", "product-analytics"],
        "projects": ["trace-ui", "cost-explorer"],
    },
    # Near-duplicate control pair — same domain AND same role lean.
    # The matcher should rank these LOW despite high surface overlap.
    {
        "handle": "felix",
        "name": "Felix Andersson",
        "headline": "React component libraries and design systems",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "css"],
        "domains": ["design-systems", "frontend"],
        "projects": ["ui-kit", "token-pipeline"],
    },
    {
        "handle": "gabi",
        "name": "Gabi Rossi",
        "headline": "Design systems and accessible component primitives",
        "role_lean": "interface",
        "stacks": ["typescript", "react", "css"],
        "domains": ["design-systems", "frontend"],
        "projects": ["a11y-primitives", "theme-engine"],
    },
    {
        "handle": "omar",
        "name": "Omar Haddad",
        "headline": "Scheduling and constraint solvers for logistics",
        "role_lean": "research",
        "stacks": ["python", "cpp"],
        "domains": ["optimization", "logistics"],
        "projects": ["route-solver", "slot-allocator"],
    },
    {
        "handle": "wren",
        "name": "Wren Castellanos",
        "headline": "Ops dashboards for fleet and dispatch teams",
        "role_lean": "product",
        "stacks": ["typescript", "nextjs", "postgres"],
        "domains": ["logistics", "ops-tooling", "dataviz"],
        "projects": ["dispatch-board", "fleet-monitor"],
    },
]


def _cadence(i: int) -> dict[str, Any]:
    """Deterministic, plausible-looking activity shape."""
    base_hour = 9 + (i % 10)
    return {
        "active_days": 40 + (i * 7) % 120,
        "sessions_per_week": round(3 + (i % 9) * 0.7, 1),
        "hour_histogram": {
            str((base_hour + d) % 24): 12 - abs(d) for d in range(-3, 4)
        },
        "longest_streak_days": 4 + (i % 17),
    }


def _projects(b: dict[str, Any], i: int) -> list[dict[str, Any]]:
    import hashlib

    out = []
    for j, name in enumerate(b["projects"]):
        fp = hashlib.sha256(f"{b['handle']}/{name}".encode()).hexdigest()[:12]
        out.append(
            {
                "name": name,
                "fingerprint": fp,
                "sessions": 8 + (i * 3 + j * 5) % 40,
                "branches": ["main"] + (["feat/wip"] if j % 2 == 0 else []),
            }
        )
    return out


# ── Supabase admin helpers ──────────────────────────────────────────
def _admin_env() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
                 "(they are in backend/.env).")
    return url, key


async def _ensure_user(client: httpx.AsyncClient, url: str, key: str,
                       email: str, name: str) -> str | None:
    """Create the auth user if absent; return its id."""
    h = {"apikey": key, "Authorization": f"Bearer {key}",
         "Content-Type": "application/json"}
    r = await client.post(
        f"{url}/auth/v1/admin/users",
        headers=h,
        json={"email": email, "password": DEMO_PASSWORD,
              "email_confirm": True, "user_metadata": {"display_name": name}},
    )
    if r.status_code in (200, 201):
        return r.json().get("id")
    # Already exists — look it up.
    lookup = await client.get(
        f"{url}/auth/v1/admin/users", headers=h, params={"page": 1, "per_page": 200}
    )
    if lookup.status_code == 200:
        for u in lookup.json().get("users", []):
            if u.get("email") == email:
                return u.get("id")
    print(f"  ! could not create or find {email}: {r.status_code} {r.text[:120]}")
    return None


async def seed(reset: bool = False) -> None:
    if not DEMO_PASSWORD:
        raise RuntimeError("Set SEED_DEMO_PASSWORD before creating sample accounts.")
    url, key = _admin_env()
    await init_pool()

    async with httpx.AsyncClient(timeout=30) as client:
        async with acquire() as conn:
            if reset:
                await conn.execute(
                    "delete from public.world_groups where slug = $1", DEMO_GROUP_SLUG
                )
                print("reset: dropped demo group")

            created: list[tuple[str, str, dict]] = []  # (user_id, agent_id, builder)

            for i, b in enumerate(BUILDERS):
                email = f"{b['handle']}@{DEMO_EMAIL_DOMAIN}"
                uid = await _ensure_user(client, url, key, email, b["name"])
                if not uid:
                    continue

                # The signup trigger provisions profile + home world + twin.
                # Give it a moment on first creation, then locate the twin.
                agent = await conn.fetchrow(
                    """select a.id from public.agents a
                        where a.owner_user_id = $1 and a.canonical_id is null
                        order by a.created_at asc limit 1""",
                    uid,
                )
                if agent is None:
                    await asyncio.sleep(0.4)
                    agent = await conn.fetchrow(
                        """select a.id from public.agents a
                            where a.owner_user_id = $1 and a.canonical_id is null
                            order by a.created_at asc limit 1""",
                        uid,
                    )
                if agent is None:
                    print(f"  ! no twin agent provisioned for {b['handle']}")
                    continue

                agent_id = agent["id"]

                await conn.execute(
                    """update public.agents
                          set display_name = $2, subtitle = $3, updated_at = now()
                        where id = $1""",
                    agent_id, b["name"], b["headline"],
                )
                await conn.execute(
                    """update public.profiles
                          set display_name = $2 where id = $1""",
                    uid, b["name"],
                )

                await conn.execute(
                    """
                    insert into public.builder_profiles
                      (agent_id, owner_user_id, projects, stacks, domains,
                       tools, cadence, role_lean, headline, total_sessions,
                       span_days)
                    values ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
                    on conflict (agent_id) do update set
                      projects   = excluded.projects,
                      stacks     = excluded.stacks,
                      domains    = excluded.domains,
                      tools      = excluded.tools,
                      cadence    = excluded.cadence,
                      role_lean  = excluded.role_lean,
                      headline   = excluded.headline,
                      updated_at = now()
                    """,
                    agent_id, uid,
                    json.dumps(_projects(b, i)),
                    b["stacks"], b["domains"],
                    ["Read", "Edit", "Bash", "Grep"],
                    json.dumps(_cadence(i)),
                    b["role_lean"], b["headline"],
                    sum(p["sessions"] for p in _projects(b, i)),
                    90 + (i * 11) % 200,
                )
                created.append((uid, str(agent_id), b))
                print(f"  ✓ {b['name']:<22} {b['role_lean']:<10} "
                      f"{','.join(b['domains'][:2])}")

            if not created:
                print("nothing seeded")
                return

            # ── Shared demo group (NOT pixel-square → uncapped roster) ──
            owner = created[0][0]
            group = await conn.fetchrow(
                """
                insert into public.world_groups
                  (name, slug, description, visibility, created_by,
                   simulation_program, roster_owner_only)
                values ($1,$2,$3,'public',$4,'coworking',false)
                on conflict (slug) do update set
                  name = excluded.name, description = excluded.description
                returning id
                """,
                DEMO_GROUP_NAME, DEMO_GROUP_SLUG,
                "Builders matched by what they actually ship. "
                "Twins here are modelled from real Claude Code history.",
                owner,
            )
            gid = group["id"]

            for uid, _agent_id, _b in created:
                await conn.execute(
                    """
                    insert into public.world_group_members
                      (group_id, user_id, status, joined_at, auto_enabled)
                    values ($1,$2,'accepted',now(),true)
                    on conflict (group_id, user_id) do update set
                      status = 'accepted', joined_at = coalesce(
                        public.world_group_members.joined_at, now())
                    """,
                    gid, uid,
                )

            roster = await conn.fetchval(
                """select count(*) from public.agents a
                    where a.owner_user_id in (
                      select user_id from public.world_group_members
                       where group_id = $1 and status = 'accepted')""",
                gid,
            )
            print(f"\nseeded {len(created)} builders into "
                  f"'{DEMO_GROUP_SLUG}' — roster now {roster} agents")
            print(f"open: http://localhost:3000/worlds/{DEMO_GROUP_SLUG}")

    await close_pool()


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed the pixel/instinct demo world")
    ap.add_argument("--reset", action="store_true",
                    help="drop the demo group before seeding")
    args = ap.parse_args()
    asyncio.run(seed(reset=args.reset))


if __name__ == "__main__":
    main()
