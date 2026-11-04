"""Joinable group worlds — like friendships but for shared spaces.

A world_group is a space multiple users join. When a user joins, all
of their agents (from their home world) become reachable in that
group's society conversations. Agents stay in their home world; the
group is a logical scope.

Schema in migration 0018:
    public.world_groups          — the space
    public.world_group_members   — who's joined (pending/accepted/left)
    agent_conversations.world_group_id — society conv tied to a group

This module owns DB helpers + slug generation. HTTP endpoints live in
main.py and call these.
"""
from __future__ import annotations

import re
import secrets
from typing import Any

from .db import acquire


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:30] or "world"


async def _slug_exists(slug: str) -> bool:
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select 1 from public.world_groups where slug = $1", slug
        )
    return row is not None


async def generate_unique_slug(name: str) -> str:
    """Slugify name, append a 4-char random suffix until unique. Slug
    is the shareable identifier for join links."""
    base = _slugify(name)
    for _ in range(20):
        suffix = secrets.token_urlsafe(3).lower().replace("_", "").replace("-", "")[:4]
        slug = f"{base}-{suffix}"
        if not await _slug_exists(slug):
            return slug
    # Extremely unlikely fallback.
    return f"{base}-{secrets.token_urlsafe(6)}"


async def create_group(
    *,
    name: str,
    description: str | None,
    visibility: str,
    created_by: str,
) -> dict[str, Any]:
    """Create a group and add the creator as the first accepted member."""
    if visibility not in ("invite_only", "public"):
        raise ValueError("visibility must be 'invite_only' or 'public'")
    slug = await generate_unique_slug(name)
    async with acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                insert into public.world_groups
                  (name, description, slug, visibility, created_by)
                values ($1, $2, $3, $4, $5)
                returning id, name, description, slug, visibility, created_by, created_at
                """,
                name, description, slug, visibility, created_by,
            )
            # Creator is auto-accepted. invited_by stays NULL — no one
            # invited them; they made the world.
            await conn.execute(
                """
                insert into public.world_group_members
                  (group_id, user_id, status, invited_by, joined_at)
                values ($1, $2, 'accepted', null, now())
                """,
                row["id"], created_by,
            )
    return _group_row(row)


async def list_my_groups(user_id: str) -> list[dict[str, Any]]:
    """All groups the user has joined (accepted)."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select g.id, g.name, g.description, g.slug, g.visibility,
                   g.created_by, g.created_at,
                   m.status as my_status,
                   (select count(*) from public.world_group_members
                     where group_id = g.id and status = 'accepted') as member_count
              from public.world_groups g
              join public.world_group_members m on m.group_id = g.id
             where m.user_id = $1
             order by g.created_at desc
            """,
            user_id,
        )
    return [_group_row(r) for r in rows]


async def list_public_groups(
    *, viewer_user_id: str | None = None, limit: int = 50,
    # Legacy alias — older callers passed exclude_user_id meaning
    # "hide ones I've joined". We no longer hide; we just annotate
    # `my_status` so the UI can swap "Join" for "Open". The default
    # public Pixel Square needs to stay discoverable.
    exclude_user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Public groups, ordered by recency (Pixel Square pinned first).
    When viewer_user_id is supplied, every row gets a `my_status`
    annotation so the UI shows the right CTA."""
    viewer = viewer_user_id or exclude_user_id
    async with acquire() as conn:
        if viewer is not None:
            rows = await conn.fetch(
                """
                select g.id, g.name, g.description, g.slug, g.visibility,
                       g.created_by, g.created_at,
                       (select count(*) from public.world_group_members
                         where group_id = g.id and status = 'accepted') as member_count,
                       (select status from public.world_group_members
                         where group_id = g.id and user_id = $1
                         limit 1) as my_status
                  from public.world_groups g
                 where g.visibility = 'public'
                 order by (g.slug = 'pixel-square') desc,
                          g.created_at desc
                 limit $2
                """,
                viewer, limit,
            )
        else:
            rows = await conn.fetch(
                """
                select g.id, g.name, g.description, g.slug, g.visibility,
                       g.created_by, g.created_at,
                       (select count(*) from public.world_group_members
                         where group_id = g.id and status = 'accepted') as member_count
                  from public.world_groups g
                 where g.visibility = 'public'
                 order by (g.slug = 'pixel-square') desc,
                          g.created_at desc
                 limit $1
                """,
                limit,
            )
    return [_group_row(r) for r in rows]


async def get_group(group_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select g.id, g.name, g.description, g.slug, g.visibility,
                   g.created_by, g.created_at,
                   (select count(*) from public.world_group_members
                     where group_id = g.id and status = 'accepted') as member_count
              from public.world_groups g
             where g.id = $1
            """,
            group_id,
        )
    return _group_row(row) if row else None


async def list_members(group_id: str) -> list[dict[str, Any]]:
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select m.user_id, m.status, m.joined_at, m.invited_at,
                   p.display_name, p.photo_url
              from public.world_group_members m
              left join public.profiles p on p.id = m.user_id
             where m.group_id = $1
             order by m.status, m.joined_at nulls last
            """,
            group_id,
        )
    return [
        {
            "user_id": str(r["user_id"]),
            "status": r["status"],
            "display_name": r["display_name"],
            "photo_url": r["photo_url"],
            "joined_at": r["joined_at"].isoformat() if r["joined_at"] else None,
            "invited_at": r["invited_at"].isoformat() if r["invited_at"] else None,
        }
        for r in rows
    ]


async def join_group(group_id: str, user_id: str) -> dict[str, Any]:
    """Self-join. For public groups: status='accepted' immediately.
    For invite_only: status='pending' until creator promotes."""
    async with acquire() as conn:
        group = await conn.fetchrow(
            "select visibility from public.world_groups where id = $1",
            group_id,
        )
        if group is None:
            raise ValueError("group not found")
        existing = await conn.fetchrow(
            """
            select status from public.world_group_members
             where group_id = $1 and user_id = $2
            """,
            group_id, user_id,
        )
        if existing and existing["status"] == "accepted":
            return {"status": "accepted"}
        new_status = "accepted" if group["visibility"] == "public" else "pending"
        joined_at = "now()" if new_status == "accepted" else "null"
        if existing:
            await conn.execute(
                f"""
                update public.world_group_members
                   set status = $3, joined_at = {joined_at}
                 where group_id = $1 and user_id = $2
                """,
                group_id, user_id, new_status,
            )
        else:
            await conn.execute(
                f"""
                insert into public.world_group_members
                  (group_id, user_id, status, invited_at, joined_at)
                values ($1, $2, $3, now(), {joined_at})
                """,
                group_id, user_id, new_status,
            )
    return {"status": new_status}


async def leave_group(group_id: str, user_id: str) -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            update public.world_group_members
               set status = 'left'
             where group_id = $1 and user_id = $2
            """,
            group_id, user_id,
        )


def _group_row(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    keys = set(row.keys())
    out = {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"] if "description" in keys else None,
        "slug": row["slug"],
        "visibility": row["visibility"],
        "created_by": str(row["created_by"]),
        "created_at": row["created_at"].isoformat(),
    }
    if "member_count" in keys:
        out["member_count"] = row["member_count"]
    if "my_status" in keys:
        out["my_status"] = row["my_status"]
    return out
