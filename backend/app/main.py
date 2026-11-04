"""FastAPI entry — HTTP routes + WebSocket. Identical contract to the Node version."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

load_dotenv()

# Configure observability BEFORE importing pydantic_ai-using modules so the
# auto-instrumentation hooks land on the right Agent class.
from .observability import (  # noqa: E402
    configure as configure_observability,
    instrument_fastapi,
    log_friend_accepted,
    log_friend_removed,
    log_friend_requested,
    log_sprite_request,
    log_world_loaded,
    log_world_visit_blocked,
)

configure_observability()

from .agents import (  # noqa: E402
    COMPANY,
    get_agent,
    get_agents,
    get_ingested_expertise,
    list_all_agents,
    list_worlds,
)
from .auth import CurrentUser, get_current_user, user_from_query_token  # noqa: E402
from .db import acquire, close_pool, init_pool  # noqa: E402
from .mcp_server import mcp as mcp_server  # noqa: E402
from .models import (  # noqa: E402
    AgentProfileResponse,
    AgentProfileStats,
    CanonicalAgent,
    CanonicalAgentsResponse,
    FriendItem,
    FriendRequestIn,
    FriendshipRef,
    FriendsResponse,
    HomeWorldRef,
    MeResponse,
    PendingFriendItem,
    PendingFriendsResponse,
    EngineStatusResponse,
    EngineToggleRequest,
    NetworkAgentRow,
    MatchesResponse,
    MatchEvidence,
    MatchPeer,
    MatchRow,
    NetworkAgentsResponse,
    PixelAgentPostRow,
    ProfileSummary,
    RecentVisitor,
    RecentVisitorsResponse,
    ReflectionRow,
    ReflectionsResponse,
    SinceFeedResponse,
    SocietySparkRequest,
    SocietySparkResponse,
    SpriteEditRequest,
    RoomMessageRow,
    RoomMessagesResponse,
    RoomPostRequest,
    RoomPostResponse,
    RoomSummaryResponse,
    WorldGroupCreateRequest,
    WorldGroupDetailResponse,
    WorldGroupJoinResponse,
    WorldGroupMemberRow,
    WorldGroupSummary,
    WorldGroupsResponse,
    SpriteEditResponse,
    SpriteGenerateResponse,
    SpriteStatusResponse,
    TickResponse,
    TwinProfileIn,
    TwinProfileResponse,
    VoiceConfigResponse,
    UserIdentity,
    UserSearchResponse,
    UserSearchResult,
    WorldAgentRow,
    WorldAgentsResponse,
    WorldByUsername,
    WorldSummary,
)
from .personality import compute_personality_anim  # noqa: E402
from .sprites import (  # noqa: E402
    _upload_versioned,
    clear_sprite_failure,
    generate_and_persist_sprite,
    get_sprite_failure,
    regenerate_portrait_with_edits,
    set_sprite_failure,
    upload_profile_photo,
    upload_storage_object,
)
from .agent_society import (  # noqa: E402
    DEFAULT_MAX_TURNS as SOCIETY_DEFAULT_MAX_TURNS,
    MAX_SQUARE_AGENTS,
    room_tick as society_room_tick,
    run_conversation as run_society_conversation,
    society_loop,
    spark_one as spark_society,
    summarize_room as society_summarize_room,
)
from . import world_groups as world_groups_mod  # noqa: E402
from .world_chat import handle_chat_start, handle_chat_user_msg  # noqa: E402
from .world_consult import run_world_consult  # noqa: E402
from .world_engine import (  # noqa: E402
    ENGINE_TICK_INTERVAL_MINUTES,
    engine_loop,
    run_tick,
)
from .chat import run_chat  # noqa: E402
from .consult import EXPERTISE, HistoryRound, run_consult  # noqa: E402
from .conversation import RECORDINGS_DIR, run_conversation, stop_conversation  # noqa: E402
from .devin_client import (  # noqa: E402
    DevinClientError,
    DevinConfigError,
    create_session as devin_create_session,
    devin_enabled,
    get_session as devin_get_session,
    list_messages as devin_list_messages,
    list_sessions as devin_list_sessions,
    send_message as devin_send_message,
)
from .ingest.runner import (  # noqa: E402
    UPLOADS_DIR,
    get_job as get_ingest_job,
    register_text_paste as register_ingest_paste,
    register_upload as register_ingest_upload,
    run_ingest,
)
from .skills.monty_client import monty_enabled  # noqa: E402
from .skills.registry import list_all_skills, list_skills  # noqa: E402
from .skills.seed import seed_all_skills  # noqa: E402
from .evals.concreteness import score_recording  # noqa: E402
from .wiki.seed import seed_all_wikis  # noqa: E402
from .wiki.store import read_wiki  # noqa: E402

ALLOWED_ORIGINS = [
    s.strip() for s in os.environ.get("ALLOWED_ORIGINS", "").split(",") if s.strip()
]


# Build the MCP HTTP app once, up here, so we can wire its lifespan into
# FastAPI's. Streamable-HTTP is the modern default (single endpoint that
# multiplexes request/response and server-sent events).
mcp_http_app = mcp_server.http_app(path="/", transport="streamable-http")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    seed_all_wikis()
    if monty_enabled():
        try:
            await seed_all_skills()
        except Exception as e:  # noqa: BLE001
            print(f"[skills/seed] error: {e}")
    # asyncpg pool for the new worlds/agents/friendships layer. If
    # SUPABASE_DB_URL isn't set we skip — legacy routes still work.
    db_pool_started = False
    if os.environ.get("SUPABASE_DB_URL"):
        try:
            await init_pool()
            db_pool_started = True
        except Exception as e:  # noqa: BLE001
            print(f"[db] pool init failed: {e}")

    # World-engine background loop. Only starts if the DB pool is up
    # (it queries public.worlds). Disable via DISABLE_ENGINE_LOOP=1.
    engine_stop_event: asyncio.Event | None = None
    engine_task: asyncio.Task[None] | None = None
    if db_pool_started and os.environ.get("DISABLE_ENGINE_LOOP", "") != "1":
        engine_stop_event = asyncio.Event()
        engine_task = asyncio.create_task(engine_loop(engine_stop_event))

    # Society auto-Spark loop — pairs agents and runs live conversations
    # in eligible worlds. Same idle gate as the engine. Off by default;
    # enable by NOT setting DISABLE_SOCIETY_LOOP=1 in the env.
    society_stop_event: asyncio.Event | None = None
    society_task: asyncio.Task[None] | None = None
    if db_pool_started and os.environ.get("DISABLE_SOCIETY_LOOP", "") != "1":
        society_stop_event = asyncio.Event()
        society_task = asyncio.create_task(society_loop(society_stop_event))

    try:
        # Run the MCP server's lifespan inside ours so its session manager
        # is initialized before any /mcp request lands.
        async with mcp_http_app.lifespan(app):
            yield
    finally:
        if engine_stop_event is not None and engine_task is not None:
            engine_stop_event.set()
            try:
                await asyncio.wait_for(engine_task, timeout=5)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                engine_task.cancel()
        if society_stop_event is not None and society_task is not None:
            society_stop_event.set()
            try:
                await asyncio.wait_for(society_task, timeout=5)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                society_task.cancel()
        if db_pool_started:
            await close_pool()


app = FastAPI(title="unicorn-intelligence-server", lifespan=lifespan)
from .ingest.onboarding import router as builder_onboarding_router
app.include_router(builder_onboarding_router)
from .twin_memory.routes import router as memory_router
from .twin_memory.discovery import router as discovery_router
app.include_router(memory_router)
app.include_router(discovery_router)
from .integrations.gmail import router as gmail_router
app.include_router(gmail_router)
instrument_fastapi(app)

# Self-hosted auth (replaces Supabase Auth): /api/auth/signup|login|session.
from .auth_service import router as auth_router  # noqa: E402

app.include_router(auth_router)
# Mount the MCP server at /mcp. Peers consult_world via this endpoint.
app.mount("/mcp", mcp_http_app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
)


# ── HTTP routes ────────────────────────────────────────────────────────


@app.get("/")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "unicorn-intelligence-server"}


@app.post("/api/sprites/generate", status_code=202, response_model=SpriteGenerateResponse)
async def sprites_generate(
    background: BackgroundTasks,
    photo: UploadFile = File(...),
    agent_id: str | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> SpriteGenerateResponse:
    """Accept a photo, return 202 immediately, run the real Gemini call
    in a background task. The agent the sprite belongs to is the user's
    "self" agent — we look it up by (owner_user_id, canonical_id IS NULL,
    display_name = profile display_name) and create it lazily on first
    upload at a fixed tile in the home world.

    Frontend flow:
      1. POST multipart photo
      2. Receive 202 {status:'queued', agent_id, placeholder_sprite_url}
      3. Poll /api/sprites/{agent_id}/status until sprite_url is ready.
      4. Redirect to /world with the generated sheet already available.
    """
    photo_bytes = await photo.read()
    await photo.close()

    # Find or create the user's "self" agent in their home world.
    self_agent_id, placeholder_sprite_url = await _ensure_self_agent(user.id)
    final_agent_id = agent_id or self_agent_id
    photo_url = await upload_profile_photo(user.id, final_agent_id, photo_bytes)
    clear_sprite_failure(final_agent_id)
    async with acquire() as conn:
        await conn.execute(
            """
            update public.agents
               set sprite_url = null,
                   portrait_url = null,
                   sprite_sheet_url = null,
                   updated_at = now()
             where id = $1
               and owner_user_id = $2
            """,
            final_agent_id,
            user.id,
        )

    log_sprite_request(
        user_id=user.id,
        agent_id=final_agent_id,
        photo_bytes=len(photo_bytes),
        mode="real",
    )

    # Schedule the heavy lifting after the response goes out.
    background.add_task(
        generate_and_persist_sprite,
        user_id=user.id,
        agent_id=final_agent_id,
        photo_bytes=photo_bytes,
    )

    return SpriteGenerateResponse(
        status="queued",
        agent_id=final_agent_id,
        placeholder_sprite_url=placeholder_sprite_url,
        photo_url=photo_url,
        photo_bytes=len(photo_bytes),
    )


@app.get("/api/sprites/{agent_id}/status", response_model=SpriteStatusResponse)
async def sprite_status(
    agent_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> SpriteStatusResponse:
    """Pollable status for onboarding. Only the owner can observe their
    generated self-sprite URL."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select a.id::text as id,
                   a.sprite_url,
                   a.portrait_url,
                   a.sprite_sheet_url,
                   p.photo_url
              from public.agents a
              join public.profiles p on p.id = a.owner_user_id
             where a.id = $1
               and a.owner_user_id = $2
            """,
            agent_id,
            user.id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="no such sprite")
    sprite_url = row["sprite_url"]
    portrait_url = row["portrait_url"]
    sprite_sheet_url = row["sprite_sheet_url"]
    failure = get_sprite_failure(agent_id)
    # Onboarding gates on portrait_url — the user proceeds as soon as the
    # fast portrait pass lands. Sheet generation continues in the
    # background; when it completes, sprite_sheet_url is populated and
    # the world page upgrades on its next refetch.
    ready = bool(portrait_url or sprite_url)
    return SpriteStatusResponse(
        status="ready" if ready else "failed" if failure else "queued",
        agent_id=row["id"],
        sprite_url=sprite_url,
        portrait_url=portrait_url,
        sprite_sheet_url=sprite_sheet_url,
        photo_url=row["photo_url"],
        error=failure,
    )


@app.post(
    "/api/sprites/{agent_id}/edit",
    status_code=202,
    response_model=SpriteEditResponse,
)
async def sprite_edit(
    agent_id: str,
    body: SpriteEditRequest,
    background: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> SpriteEditResponse:
    """Re-generate a portrait with modifications (add glasses, change hair,
    etc.). Requires the agent already has a portrait_url to modify.
    Cost: ~$0.02 per edit. Runs as a background task."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select portrait_url
            from public.agents
            where id = $1 and owner_user_id = $2
            """,
            agent_id,
            user.id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="agent not found")
    if not row["portrait_url"]:
        raise HTTPException(status_code=400, detail="no portrait to edit — generate one first")

    async def _run_edit() -> None:
        import httpx as _httpx

        # Fetch the current portrait.
        async with _httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(row["portrait_url"])
        if resp.status_code != 200:
            set_sprite_failure(agent_id, "Failed to fetch current portrait.")
            return
        original_png = resp.content

        try:
            new_png = await regenerate_portrait_with_edits(original_png, body.edits)
        except Exception as e:  # noqa: BLE001
            set_sprite_failure(agent_id, f"Edit failed: {str(e)[:200]}")
            return

        try:
            new_url = await _upload_versioned(user.id, agent_id, "portrait", new_png)
            async with acquire() as conn:
                await conn.execute(
                    "update public.agents set portrait_url = $1, updated_at = now() where id = $2",
                    new_url,
                    agent_id,
                )
        except Exception as e:  # noqa: BLE001
            set_sprite_failure(agent_id, f"Save failed: {str(e)[:200]}")
            return

        clear_sprite_failure(agent_id)

    clear_sprite_failure(agent_id)
    background.add_task(_run_edit)
    return SpriteEditResponse(status="queued", agent_id=agent_id)


@app.post("/api/sprites/{agent_id}/retry-sheet", status_code=202)
async def sprite_retry_sheet(
    agent_id: str,
    background: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
):
    """Re-run Step 2 (spritesheet) from the existing portrait.
    Use when portrait generation succeeded but the sheet failed."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select portrait_url from public.agents "
            "where id = $1 and owner_user_id = $2 and canonical_id is null",
            agent_id, user.id,
        )
    if not row or not row["portrait_url"]:
        raise HTTPException(404, "No portrait found — regenerate your sprite first")

    portrait_url = row["portrait_url"]

    async def _run_retry():
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(portrait_url)
            resp.raise_for_status()
            portrait_bytes = resp.content
        from .sprites import (
            generate_spritesheet, _upload_versioned, normalize_grid,
            log_sprite_done, log_sprite_failed,
            set_sprite_failure, clear_sprite_failure,
        )
        import time
        clear_sprite_failure(agent_id)
        step_started = time.monotonic()
        try:
            sheet_png = await generate_spritesheet(portrait_bytes)
        except Exception as e:
            log_sprite_failed(user_id=user.id, agent_id=agent_id, stage="sheet", error=str(e))
            set_sprite_failure(agent_id, f"Sheet retry failed: {e}")
            return
        try:
            sheet_url = await _upload_versioned(user.id, agent_id, "sheet", sheet_png)
            async with acquire() as conn:
                await conn.execute(
                    "update public.agents set sprite_sheet_url = $1, updated_at = now() where id = $2",
                    sheet_url, agent_id,
                )
        except Exception as e:
            log_sprite_failed(user_id=user.id, agent_id=agent_id, stage="sheet_persist", error=str(e))
            set_sprite_failure(agent_id, f"Sheet save failed: {e}")
            return
        log_sprite_done(user_id=user.id, agent_id=agent_id, storage_url=sheet_url, source="sheet",
                        duration_ms=int((time.monotonic() - step_started) * 1000))
        clear_sprite_failure(agent_id)

    background.add_task(_run_retry)
    return {"status": "queued", "agent_id": agent_id}


@app.post("/api/sprites/{agent_id}/upload")
async def sprite_upload(
    agent_id: str,
    sprite: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, str]:
    """Upload a pre-made sprite sheet PNG directly, skipping Gemini.
    Stores as sprite_sheet_url on the agent row."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select id from public.agents where id = $1 and owner_user_id = $2",
            agent_id,
            user.id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="agent not found or not yours")

    sprite_bytes = await sprite.read()
    await sprite.close()
    version = int(time.time() * 1000)
    public_url = await upload_storage_object(
        f"{user.id}/{agent_id}/sheet-{version}.png",
        sprite_bytes,
        "image/png",
    )
    async with acquire() as conn:
        await conn.execute(
            """update public.agents
               set sprite_sheet_url = $1, sprite_url = $1, updated_at = now()
             where id = $2""",
            public_url,
            agent_id,
        )
    clear_sprite_failure(agent_id)
    return {"status": "ok", "sprite_url": public_url}


@app.get("/api/voice/config", response_model=VoiceConfigResponse)
async def voice_config(
    user: CurrentUser = Depends(get_current_user),
) -> VoiceConfigResponse:
    """Return Gemini API key + model for the voice onboarding interview.
    Authenticated — only logged-in users can request this.

    Production note: replace with ephemeral tokens via
    generativelanguage.googleapis.com/.../generateEphemeralToken."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not configured")
    # Only gemini-3.1-flash-live-preview supports bidiGenerateContent
    model = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
    return VoiceConfigResponse(api_key=api_key, model=model)


@app.post("/api/twin/profile", response_model=TwinProfileResponse)
async def save_twin_profile(
    body: TwinProfileIn,
    user: CurrentUser = Depends(get_current_user),
) -> TwinProfileResponse:
    """Save structured twin profile from the voice onboarding interview.
    Writes to profiles.twin_profile JSONB column and updates the self-agent's
    persona_md with a synthesised personality."""
    profile_data = body.model_dump()
    async with acquire() as conn:
        # Save raw profile as JSONB
        await conn.execute(
            """
            update public.profiles
               set twin_profile = $1::jsonb,
                   updated_at = now()
             where id = $2
            """,
            json.dumps(profile_data),
            user.id,
        )
        # Find the self-agent and update persona_md
        agent_id = await conn.fetchval(
            """
            select id::text from public.agents
             where owner_user_id = $1
               and canonical_id is null
             order by created_at asc limit 1
            """,
            user.id,
        )
        if agent_id:
            persona = (
                f"You are {body.name}'s digital twin in Pixel Societies.\n\n"
                f"## Identity\n"
                f"- **Role:** {body.role}\n"
                f"- **Currently working on:** {body.current_work}\n\n"
                f"## Networking Goals\n"
                f"- **Looking for:** {body.looking_for}\n\n"
                f"## What Makes You Interesting\n"
                f"- {body.unique_knowledge}\n\n"
                f"## Social Style\n"
                f"- {body.social_style}\n"
            )
            await conn.execute(
                """
                update public.agents
                   set persona_md = $1,
                       updated_at = now()
                 where id = $2
                """,
                persona,
                agent_id,
            )
    return TwinProfileResponse(status="saved", agent_id=agent_id or "pending")


async def _ensure_self_agent(user_id: str) -> tuple[str, str]:
    """Return (agent_id, placeholder_sprite_url) for the user's
    "self" agent (the one whose sprite the photo upload generates).
    Creates the row on first upload, scattered onto a fixed tile in
    the home world (we picked tile (16, 14) — middle of the office,
    away from the four canonical starters at tiles 8,16,20,24)."""
    palette = abs(hash(user_id)) % 6
    placeholder_url = f"/team-office/characters/char_{palette}.png"

    async with acquire() as conn:
        # Look up profile display_name + home world id in one round-trip.
        row = await conn.fetchrow(
            """
            select p.display_name as display_name,
                   w.id as world_id
            from public.profiles p
            left join public.worlds w
                on w.owner_user_id = p.id and w.slug = 'home'
            where p.id = $1
            """,
            user_id,
        )
        if row is None or row["world_id"] is None:
            raise HTTPException(
                status_code=400,
                detail="profile or home world missing — finish onboarding first",
            )
        display_name = row["display_name"] or "You"
        world_id = row["world_id"]

        existing = await conn.fetchval(
            """
            select id from public.agents
            where owner_user_id = $1
              and world_id = $2
              and canonical_id is null
            order by created_at asc
            limit 1
            """,
            user_id,
            world_id,
        )
        if existing:
            return str(existing), placeholder_url

        new_id = await conn.fetchval(
            """
            insert into public.agents
                (world_id, owner_user_id, canonical_id,
                 display_name, subtitle, persona_md,
                 tile_x, tile_y, tint)
            values ($1, $2, null, $3, 'You', null, 16, 14, null)
            returning id
            """,
            world_id,
            user_id,
            display_name,
        )
        return str(new_id), placeholder_url


@app.get("/api/canonical-agents", response_model=CanonicalAgentsResponse)
async def canonical_agents() -> CanonicalAgentsResponse:
    """Read-only catalogue of agent templates seeded by seed_canonical.py.
    Public — no auth required (the table itself is RLS-public). Used by
    the (stretch) custom-agent UI to let users clone a template."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id, display_name, subtitle, default_sprite_url
            from public.canonical_agents
            order by display_name
            """
        )
    return CanonicalAgentsResponse(
        canonical_agents=[
            CanonicalAgent(
                id=r["id"],
                display_name=r["display_name"],
                subtitle=r["subtitle"],
                default_sprite_url=r["default_sprite_url"],
            )
            for r in rows
        ],
    )


@app.get("/api/users/search", response_model=UserSearchResponse)
async def users_search(
    q: str,
    user: CurrentUser = Depends(get_current_user),
) -> UserSearchResponse:
    """Find profiles to send friend requests to. Case-insensitive
    contains-match on display_name, excludes the caller, capped at 20.
    Each result also includes the current friendship status with the
    caller so the UI can disable already-friends or already-requested
    rows without a second round-trip."""
    needle = (q or "").strip()
    if not needle:
        return UserSearchResponse(users=[])
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select
                p.id,
                p.display_name,
                f.id as friendship_id,
                f.status as friendship_status,
                case when f.id is null then null
                     when f.requester_id = $2 then 'outgoing'
                     else 'incoming'
                end as friendship_direction
            from public.profiles p
            left join public.friendships f
                on (least(f.requester_id, f.addressee_id) = least(p.id, $2)
                    and greatest(f.requester_id, f.addressee_id) = greatest(p.id, $2))
            where p.display_name ilike '%' || $1 || '%'
              and p.id <> $2
            order by p.display_name asc
            limit 20
            """,
            needle,
            user.id,
        )
    return UserSearchResponse(
        users=[
            UserSearchResult(
                id=str(r["id"]),
                display_name=r["display_name"],
                friendship_id=str(r["friendship_id"]) if r["friendship_id"] else None,
                friendship_status=r["friendship_status"],
                friendship_direction=r["friendship_direction"],
            )
            for r in rows
        ]
    )


# ── /api/friends/* ─────────────────────────────────────────────────────


@app.get("/api/friends", response_model=FriendsResponse)
async def friends_list(user: CurrentUser = Depends(get_current_user)) -> FriendsResponse:
    """All accepted friendships involving the caller, plus the other
    user's display_name so the UI doesn't need a second lookup."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select
                f.id,
                f.created_at,
                case when f.requester_id = $1 then f.addressee_id else f.requester_id end as friend_id,
                p.display_name as friend_display_name
            from public.friendships f
            join public.profiles p on p.id =
                case when f.requester_id = $1 then f.addressee_id else f.requester_id end
            where f.status = 'accepted'
              and (f.requester_id = $1 or f.addressee_id = $1)
            order by f.created_at desc
            """,
            user.id,
        )
    return FriendsResponse(
        friends=[
            FriendItem(
                friendship_id=str(r["id"]),
                friend_id=str(r["friend_id"]),
                friend_display_name=r["friend_display_name"],
                since=r["created_at"].isoformat(),
            )
            for r in rows
        ]
    )


@app.get("/api/friends/pending", response_model=PendingFriendsResponse)
async def friends_pending(user: CurrentUser = Depends(get_current_user)) -> PendingFriendsResponse:
    """Pending requests, split into incoming (decide) and outgoing (cancel)."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select
                f.id,
                f.created_at,
                f.requester_id,
                f.addressee_id,
                pr.display_name as requester_display_name,
                pa.display_name as addressee_display_name
            from public.friendships f
            join public.profiles pr on pr.id = f.requester_id
            join public.profiles pa on pa.id = f.addressee_id
            where f.status = 'pending'
              and (f.requester_id = $1 or f.addressee_id = $1)
            order by f.created_at desc
            """,
            user.id,
        )
    incoming: list[PendingFriendItem] = []
    outgoing: list[PendingFriendItem] = []
    for r in rows:
        item = PendingFriendItem(
            friendship_id=str(r["id"]),
            requester_id=str(r["requester_id"]),
            requester_display_name=r["requester_display_name"],
            addressee_id=str(r["addressee_id"]),
            addressee_display_name=r["addressee_display_name"],
            created_at=r["created_at"].isoformat(),
        )
        if str(r["addressee_id"]) == user.id:
            incoming.append(item)
        else:
            outgoing.append(item)
    return PendingFriendsResponse(incoming=incoming, outgoing=outgoing)


@app.post("/api/friends/request", status_code=201, response_model=FriendshipRef)
async def friends_request(
    body: FriendRequestIn,
    user: CurrentUser = Depends(get_current_user),
) -> FriendshipRef:
    """Send a friend request to addressee_id. 400 if self-request,
    409 if a friendship already exists in either direction."""
    addressee_id = body.addressee_id
    if addressee_id == user.id:
        raise HTTPException(status_code=400, detail="cannot friend yourself")

    async with acquire() as conn:
        # Make sure the addressee exists.
        addressee_exists = await conn.fetchval(
            "select 1 from public.profiles where id = $1", addressee_id
        )
        if not addressee_exists:
            raise HTTPException(status_code=404, detail="addressee not found")

        # Check for an existing relationship in either direction.
        existing = await conn.fetchrow(
            """
            select id, status, requester_id
            from public.friendships
            where (requester_id = $1 and addressee_id = $2)
               or (requester_id = $2 and addressee_id = $1)
            """,
            user.id,
            addressee_id,
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"friendship already exists ({existing['status']})",
            )

        new_id = await conn.fetchval(
            """
            insert into public.friendships (requester_id, addressee_id, status)
            values ($1, $2, 'pending')
            returning id
            """,
            user.id,
            addressee_id,
        )
    log_friend_requested(
        requester_id=user.id, addressee_id=addressee_id, friendship_id=str(new_id)
    )
    return FriendshipRef(friendship_id=str(new_id), status="pending")


@app.post("/api/friends/{friendship_id}/accept", response_model=FriendshipRef)
async def friends_accept(
    friendship_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> FriendshipRef:
    """Only the addressee can flip a pending request to accepted."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select requester_id, addressee_id, status
            from public.friendships
            where id = $1
            """,
            friendship_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="no such friendship")
        if str(row["addressee_id"]) != user.id:
            raise HTTPException(
                status_code=403, detail="only the addressee can accept this request"
            )
        if row["status"] != "pending":
            raise HTTPException(
                status_code=409, detail=f"request is already {row['status']}"
            )
        await conn.execute(
            "update public.friendships set status = 'accepted', updated_at = now() where id = $1",
            friendship_id,
        )
    log_friend_accepted(
        requester_id=str(row["requester_id"]),
        addressee_id=user.id,
        friendship_id=friendship_id,
    )
    return FriendshipRef(friendship_id=friendship_id, status="accepted")


@app.delete("/api/friends/{friendship_id}", status_code=204)
async def friends_remove(
    friendship_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Cancel a pending request (either side) or unfriend (either side).
    Either participant can do it; non-participants get a 403."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select requester_id, addressee_id, status
            from public.friendships
            where id = $1
            """,
            friendship_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="no such friendship")
        if user.id not in (str(row["requester_id"]), str(row["addressee_id"])):
            raise HTTPException(status_code=403, detail="not a participant")
        await conn.execute(
            "delete from public.friendships where id = $1", friendship_id
        )
    other_id = (
        str(row["requester_id"])
        if str(row["addressee_id"]) == user.id
        else str(row["addressee_id"])
    )
    log_friend_removed(
        actor_id=user.id,
        other_id=other_id,
        friendship_id=friendship_id,
        status_was=row["status"],
    )


@app.get("/api/worlds/me", response_model=WorldSummary)
async def worlds_me(user: CurrentUser = Depends(get_current_user)) -> WorldSummary:
    """The caller's home world. Slug='home' is auto-created on signup
    by handle_new_user(). Visit-mode (/world/[username]) uses
    /api/worlds/by-username/{username} instead."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select id, slug, display_name, tile_w, tile_h, bg_palette, owner_user_id
            from public.worlds
            where owner_user_id = $1 and slug = 'home'
            """,
            user.id,
        )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="no home world — signup trigger may not have run",
        )
    return WorldSummary(
        id=str(row["id"]),
        slug=row["slug"],
        display_name=row["display_name"],
        tile_w=row["tile_w"],
        tile_h=row["tile_h"],
        bg_palette=row["bg_palette"],
        owner_user_id=str(row["owner_user_id"]),
    )


@app.get("/api/worlds/by-username/{username}", response_model=WorldByUsername)
async def world_by_username(
    username: str,
    user: CurrentUser = Depends(get_current_user),
) -> WorldByUsername:
    """Look up another user's home world by their profile.display_name.
    RLS makes the second SELECT return zero rows for users that the
    caller isn't friends with — surface that as 403, not 404, so the UI
    can show an explicit "you need to be friends" message.

    Note: display_name isn't unique. v0 returns the oldest profile that
    matches; once we add a real `username` column we'll switch this."""
    async with acquire() as conn:
        owner = await conn.fetchrow(
            """
            select id, display_name
            from public.profiles
            where lower(display_name) = lower($1)
            order by created_at asc
            limit 1
            """,
            username,
        )
        if owner is None:
            raise HTTPException(status_code=404, detail="no such profile")

        # Self-lookup short-circuits the friend RLS check.
        if str(owner["id"]) == user.id:
            world = await conn.fetchrow(
                """
                select id, slug, display_name, tile_w, tile_h, bg_palette, owner_user_id
                from public.worlds
                where owner_user_id = $1 and slug = 'home'
                """,
                owner["id"],
            )
        else:
            # Use the friendship helper to gate access. RLS would also do
            # this when the world is read via the `authenticated` role,
            # but since we connect as `postgres` (service-role) we have
            # to enforce it explicitly here.
            is_friend = await conn.fetchval(
                "select public.are_friends($1, $2)", owner["id"], user.id
            )
            if not is_friend:
                log_world_visit_blocked(
                    user_id=user.id,
                    owner_user_id=str(owner["id"]),
                    world_id=None,
                    reason="not_friends",
                )
                raise HTTPException(
                    status_code=403,
                    detail="not friends — request a friendship to visit this world",
                )
            world = await conn.fetchrow(
                """
                select id, slug, display_name, tile_w, tile_h, bg_palette, owner_user_id
                from public.worlds
                where owner_user_id = $1 and slug = 'home'
                """,
                owner["id"],
            )

    if world is None:
        raise HTTPException(status_code=404, detail="profile has no home world")
    return WorldByUsername(
        id=str(world["id"]),
        slug=world["slug"],
        display_name=world["display_name"],
        tile_w=world["tile_w"],
        tile_h=world["tile_h"],
        bg_palette=world["bg_palette"],
        owner_user_id=str(world["owner_user_id"]),
        owner_display_name=owner["display_name"],
    )


@app.get("/api/worlds/{world_id}/agents", response_model=WorldAgentsResponse)
async def world_agents(
    world_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> WorldAgentsResponse:
    """All agents in a world, in canonical_id order. We connect as the
    postgres role for the asyncpg pool, which bypasses RLS, so we
    enforce the same rule here: caller must own the world or be friends
    with the owner. Mode in the response tells the frontend whether to
    let the user drag/move agents or not."""
    async with acquire() as conn:
        world = await conn.fetchrow(
            "select owner_user_id from public.worlds where id = $1",
            world_id,
        )
        if world is None:
            raise HTTPException(status_code=404, detail="no such world")
        owner_id = str(world["owner_user_id"])
        if owner_id == user.id:
            mode = "own"
        else:
            is_friend = await conn.fetchval(
                "select public.are_friends($1, $2)", world["owner_user_id"], user.id
            )
            if not is_friend:
                log_world_visit_blocked(
                    user_id=user.id,
                    owner_user_id=owner_id,
                    world_id=world_id,
                    reason="not_friends",
                )
                raise HTTPException(
                    status_code=403, detail="not friends with the world owner"
                )
            mode = "visit"

        rows = await conn.fetch(
            """
            select id, display_name, subtitle, canonical_id,
                   sprite_url, portrait_url, sprite_sheet_url,
                   tile_x, tile_y, facing, tint
            from public.agents
            where world_id = $1
            order by canonical_id nulls last, created_at asc
            """,
            world_id,
        )

    log_world_loaded(
        user_id=user.id,
        world_id=world_id,
        owner_user_id=owner_id,
        mode=mode,
        agent_count=len(rows),
    )

    def _agent_row(r: Any) -> WorldAgentRow:
        agent_id = str(r["id"])
        # Compute personality on-the-fly from canonical_id + agent_id.
        # Pure Python keyword matching — microseconds, no DB column needed.
        pa = compute_personality_anim(
            agent_id=agent_id,
            canonical_id=r["canonical_id"],
        ).model_dump()
        return WorldAgentRow(
            id=agent_id,
            display_name=r["display_name"],
            subtitle=r["subtitle"],
            canonical_id=r["canonical_id"],
            sprite_url=r["sprite_url"],
            portrait_url=r["portrait_url"],
            sprite_sheet_url=r["sprite_sheet_url"],
            tile_x=r["tile_x"],
            tile_y=r["tile_y"],
            facing=r["facing"],
            tint=r["tint"],
            personality_anim=pa,
        )

    return WorldAgentsResponse(
        world_id=world_id,
        owner_user_id=owner_id,
        mode=mode,
        agents=[_agent_row(r) for r in rows],
    )


def _engine_status_payload(world_id: str, row: Any) -> EngineStatusResponse:
    """Shared payload builder for both the GET and the PATCH endpoints —
    keeps the derived `effective_state` calculation in one place."""
    from datetime import datetime, timedelta, timezone

    enabled = bool(row["engine_enabled"])
    idle_hours = int(row["engine_idle_hours"])
    last_seen = row["last_seen_at"]
    if not enabled:
        state: Literal["off", "on", "sleeping"] = "off"
    elif last_seen is None:
        state = "sleeping"
    elif last_seen < datetime.now(timezone.utc) - timedelta(hours=idle_hours):
        state = "sleeping"
    else:
        state = "on"
    return EngineStatusResponse(
        world_id=world_id,
        engine_enabled=enabled,
        engine_last_tick_at=(
            row["engine_last_tick_at"].isoformat()
            if row["engine_last_tick_at"]
            else None
        ),
        tick_interval_minutes=ENGINE_TICK_INTERVAL_MINUTES,
        effective_state=state,
        idle_hours=idle_hours,
        owner_last_seen_at=last_seen.isoformat() if last_seen else None,
    )


async def _resolve_home_world_by_username(
    conn, username: str, *, caller_user_id: str
) -> tuple[str, str]:
    """Resolve a profile.display_name → (owner_user_id, world_id).

    Mirrors the gating in `world_by_username`: 404 on no profile, 404 on
    no home world, 403 if caller isn't the owner and isn't friends with
    the owner. Returns (owner_user_id, world_id).
    """
    owner = await conn.fetchrow(
        """
        select id
        from public.profiles
        where lower(display_name) = lower($1)
        order by created_at asc
        limit 1
        """,
        username,
    )
    if owner is None:
        raise HTTPException(status_code=404, detail="no such profile")
    owner_user_id = str(owner["id"])
    if owner_user_id != caller_user_id:
        is_friend = await conn.fetchval(
            "select public.are_friends($1, $2)", owner["id"], caller_user_id
        )
        if not is_friend:
            log_world_visit_blocked(
                user_id=caller_user_id,
                owner_user_id=owner_user_id,
                world_id=None,
                reason="not_friends",
            )
            raise HTTPException(
                status_code=403,
                detail="not friends with the world owner",
            )
    world = await conn.fetchrow(
        """
        select id from public.worlds where owner_user_id = $1 and slug = 'home'
        """,
        owner["id"],
    )
    if world is None:
        raise HTTPException(status_code=404, detail="profile has no home world")
    return owner_user_id, str(world["id"])


@app.post(
    "/api/worlds/by-username/{username}/tick",
    response_model=TickResponse,
)
async def world_tick(
    username: str,
    user: CurrentUser = Depends(get_current_user),
) -> TickResponse:
    """Run one engine tick across the named user's home world. Owner-only:
    visitors get 403. Each pixel agent in the world is given the
    `[post, do_nothing]` action menu and chooses; results are persisted
    to `pixel_agent_posts` + `pixel_agent_memories`.

    Synchronous for now — short worlds (4 starter agents) finish in
    ~10-20s. If world size grows we'll wrap in `asyncio.create_task`
    and return 202."""
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
    if owner_user_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="only the world's owner can run a tick",
        )
    result = await run_tick(world_id=world_id, owner_user_id=owner_user_id)
    return TickResponse(**result.model_dump())


@app.post(
    "/api/worlds/by-username/{username}/society/spark",
    response_model=SocietySparkResponse,
)
async def world_society_spark(
    username: str,
    payload: SocietySparkRequest | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> SocietySparkResponse:
    """Spark one live agent ↔ agent conversation in this world.

    Owner-only for v1 (mirrors /tick — manual triggers are scoped to the
    owner; passive observers come in through the Realtime feed once
    conversations exist). When `payload` includes both agent_a_id and
    agent_b_id, runs that specific pair; otherwise the picker scores
    eligible pairs by recency cooldown and picks one at random.

    Each turn is persisted as it happens so subscribers to the
    `agent_conversation_messages` table see lines arrive live."""
    body = payload or SocietySparkRequest()
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
    if owner_user_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="only the world's owner can spark society conversations",
        )

    max_turns = body.max_turns or SOCIETY_DEFAULT_MAX_TURNS
    if body.agent_a_id and body.agent_b_id:
        conv_id = await run_society_conversation(
            world_id,
            body.agent_a_id,
            body.agent_b_id,
            room=body.room,
            max_turns=max_turns,
        )
        if conv_id is None:
            return SocietySparkResponse(
                conversation_id=None,
                started=False,
                reason="pair could not be set up (unknown agent or wrong world)",
            )
        return SocietySparkResponse(conversation_id=conv_id, started=True)

    conv_id = await spark_society(world_id=world_id, room=body.room)
    if conv_id is None:
        return SocietySparkResponse(
            conversation_id=None,
            started=False,
            reason="no eligible pair (need ≥2 agents, none recently paired)",
        )
    return SocietySparkResponse(conversation_id=conv_id, started=True)


# ── World groups (joinable shared spaces) ────────────────────────────


@app.post("/api/world-groups", response_model=WorldGroupSummary)
async def world_group_create(
    payload: WorldGroupCreateRequest,
    user: CurrentUser = Depends(get_current_user),
) -> WorldGroupSummary:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if payload.visibility not in ("invite_only", "public"):
        raise HTTPException(status_code=400, detail="bad visibility")
    group = await world_groups_mod.create_group(
        name=name,
        description=(payload.description or "").strip() or None,
        visibility=payload.visibility,
        created_by=user.id,
    )
    return WorldGroupSummary(**group, my_status="accepted")


@app.get("/api/world-groups", response_model=WorldGroupsResponse)
async def world_groups_list(
    scope: str = "mine",  # 'mine' | 'public'
    user: CurrentUser = Depends(get_current_user),
) -> WorldGroupsResponse:
    if scope == "public":
        groups = await world_groups_mod.list_public_groups(exclude_user_id=user.id)
    else:
        groups = await world_groups_mod.list_my_groups(user.id)
    return WorldGroupsResponse(
        groups=[WorldGroupSummary(**g) for g in groups]
    )


@app.get("/api/world-groups/by-slug/{slug}", response_model=WorldGroupDetailResponse)
async def world_group_by_slug(
    slug: str,
    user: CurrentUser = Depends(get_current_user),
) -> WorldGroupDetailResponse:
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select id from public.world_groups where slug = $1", slug
        )
    if row is None:
        raise HTTPException(status_code=404, detail="group not found")
    group_id = str(row["id"])
    group = await world_groups_mod.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="group not found")
    members = await world_groups_mod.list_members(group_id)
    return WorldGroupDetailResponse(
        group=WorldGroupSummary(**group),
        members=[WorldGroupMemberRow(**m) for m in members],
    )


@app.get(
    "/api/world-groups/by-slug/{slug}/agents",
    response_model=NetworkAgentsResponse,
)
async def world_group_agents_by_slug(
    slug: str,
    user: CurrentUser = Depends(get_current_user),
) -> NetworkAgentsResponse:
    """The square's capped roster: a stable top-N (MAX_SQUARE_AGENTS)
    pooled across ALL accepted members (the viewing member's own agents
    included) — NOT every member's full roster. Bounds the canvas so it
    never overcrowds (the mobile app renders this directly), no matter
    how many members join. md5(id) ordering is stable, so the same
    agents show every load and match the speaker pool the conversation
    engine uses. Same shape as /api/me/network-agents."""
    async with acquire() as conn:
        group_row = await conn.fetchrow(
            "select id, created_by, roster_owner_only"
            "  from public.world_groups where slug = $1", slug
        )
        if group_row is None:
            raise HTTPException(status_code=404, detail="group not found")
        rows = await conn.fetch(
            """
            select a.id::text          as agent_id,
                   a.display_name,
                   a.subtitle,
                   a.canonical_id,
                   a.sprite_url,
                   a.portrait_url,
                   a.sprite_sheet_url,
                   a.owner_user_id::text as owner_user_id,
                   p.display_name      as owner_display_name,
                   a.world_id::text    as world_id,
                   (a.owner_user_id = $2) as is_own
              from public.agents a
              join public.profiles p on p.id = a.owner_user_id
             -- roster_owner_only ($4): curated rooms (event demos) show
             -- ONLY the creator's agents, so members who join never drag
             -- their own agents in. Otherwise pool all accepted members.
             where (
               ($5 and a.owner_user_id = $4)
               or (not $5 and a.owner_user_id in (
                 select user_id from public.world_group_members
                  where group_id = $1 and status = 'accepted'
               ))
             )
             -- Stable cap, applied ONLY to the public pixel-square (the
             -- 335-agent one). Curated rooms are intentionally populated.
             order by md5(a.id::text)
             limit $3
            """,
            group_row["id"], user.id,
            MAX_SQUARE_AGENTS if slug == "pixel-square" else 1_000_000,
            group_row["created_by"], group_row["roster_owner_only"],
        )
    return NetworkAgentsResponse(
        agents=[
            NetworkAgentRow(
                agent_id=r["agent_id"],
                display_name=r["display_name"],
                subtitle=r["subtitle"],
                canonical_id=r["canonical_id"],
                sprite_url=r["sprite_url"],
                portrait_url=r["portrait_url"],
                sprite_sheet_url=r["sprite_sheet_url"],
                owner_user_id=r["owner_user_id"],
                owner_display_name=r["owner_display_name"],
                world_id=r["world_id"],
                is_own=r["is_own"],
            )
            for r in rows
        ]
    )


@app.get("/api/world-groups/{group_id}", response_model=WorldGroupDetailResponse)
async def world_group_detail(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> WorldGroupDetailResponse:
    group = await world_groups_mod.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="group not found")
    members = await world_groups_mod.list_members(group_id)
    return WorldGroupDetailResponse(
        group=WorldGroupSummary(**group),
        members=[WorldGroupMemberRow(**m) for m in members],
    )


@app.post("/api/world-groups/{group_id}/join", response_model=WorldGroupJoinResponse)
async def world_group_join(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> WorldGroupJoinResponse:
    try:
        result = await world_groups_mod.join_group(group_id, user.id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return WorldGroupJoinResponse(status=result["status"])


class _AutoToggleRequest(BaseModel):
    enabled: bool


@app.patch("/api/world-groups/{group_id}/auto")
async def world_group_auto_toggle(
    group_id: str,
    payload: _AutoToggleRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, bool]:
    """Per-user toggle: when off, the caller's twin agent stops
    autospeaking in this group's room. Other imported agents
    (Aleksei, Anil, etc.) continue autonomously regardless."""
    await _ensure_group_member(group_id, user.id)
    async with acquire() as conn:
        await conn.execute(
            """
            update public.world_group_members
               set auto_enabled = $3
             where group_id = $1 and user_id = $2
            """,
            group_id, user.id, payload.enabled,
        )
    return {"auto_enabled": payload.enabled}


@app.get("/api/world-groups/{group_id}/auto")
async def world_group_auto_get(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, bool]:
    await _ensure_group_member(group_id, user.id)
    async with acquire() as conn:
        val = await conn.fetchval(
            """
            select auto_enabled from public.world_group_members
             where group_id = $1 and user_id = $2
            """,
            group_id, user.id,
        )
    return {"auto_enabled": bool(val) if val is not None else True}


# Need _AutoToggleRequest imported via local class — BaseModel inherits
# already imported above; nothing else to register.

@app.post("/api/world-groups/{group_id}/leave")
async def world_group_leave(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, str]:
    await world_groups_mod.leave_group(group_id, user.id)
    return {"status": "left"}


# ── Group room chat: live summary banner ────────────────────────────


@app.get(
    "/api/world-groups/{group_id}/room/summary",
    response_model=RoomSummaryResponse,
)
async def world_group_room_summary_get(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> RoomSummaryResponse:
    await _ensure_group_member(group_id, user.id)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select topic, dynamic, generated_at, source_seq_high
              from public.world_group_room_summaries
             where world_group_id = $1
            """,
            group_id,
        )
    if not row:
        return RoomSummaryResponse()
    return RoomSummaryResponse(
        topic=row["topic"],
        dynamic=row["dynamic"],
        generated_at=row["generated_at"].isoformat()
        if row["generated_at"]
        else None,
        source_seq_high=int(row["source_seq_high"])
        if row["source_seq_high"]
        else None,
    )


@app.post(
    "/api/world-groups/{group_id}/room/summary/refresh",
    response_model=RoomSummaryResponse,
)
async def world_group_room_summary_refresh(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> RoomSummaryResponse:
    await _ensure_group_member(group_id, user.id)
    out = await society_summarize_room(group_id)
    if out is None:
        return RoomSummaryResponse()
    return RoomSummaryResponse(
        topic=out["topic"],
        dynamic=out["dynamic"],
        source_seq_high=out["source_seq_high"],
    )


# ── Group room chat (public stream + speech bubbles) ────────────────


async def _ensure_group_member(group_id: str, user_id: str) -> None:
    async with acquire() as conn:
        ok = await conn.fetchval(
            """
            select 1 from public.world_group_members
             where group_id = $1 and user_id = $2 and status = 'accepted'
             limit 1
            """,
            group_id, user_id,
        )
    if not ok:
        raise HTTPException(
            status_code=403, detail="only accepted members can act here"
        )


def _row_to_room_message(r: Any) -> RoomMessageRow:
    return RoomMessageRow(
        id=str(r["id"]),
        world_group_id=str(r["world_group_id"]),
        agent_id=str(r["agent_id"]) if r["agent_id"] else None,
        user_id=str(r["user_id"]) if r["user_id"] else None,
        body=r["body"],
        created_at=r["created_at"].isoformat(),
        seq=int(r["seq"]),
        speaker_name=r.get("speaker_name") if isinstance(r, dict) else r["speaker_name"],
    )


@app.get(
    "/api/world-groups/{group_id}/room",
    response_model=RoomMessagesResponse,
)
async def world_group_room_load(
    group_id: str,
    limit: int = 60,
    user: CurrentUser = Depends(get_current_user),
) -> RoomMessagesResponse:
    """Initial load of recent room messages, oldest-first so the UI
    can render them in chronological order. Member-only."""
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be 1-200")
    await _ensure_group_member(group_id, user.id)
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select m.id, m.world_group_id, m.agent_id, m.user_id,
                   m.body, m.created_at, m.seq,
                   coalesce(a.display_name, p.display_name) as speaker_name
              from public.world_group_room_messages m
              left join public.agents a on a.id = m.agent_id
              left join public.profiles p on p.id = m.user_id
             where m.world_group_id = $1
             order by m.seq desc
             limit $2
            """,
            group_id, limit,
        )
    return RoomMessagesResponse(
        messages=[_row_to_room_message(r) for r in reversed(rows)],
    )


@app.post(
    "/api/world-groups/{group_id}/room/post",
    response_model=RoomPostResponse,
)
async def world_group_room_post(
    group_id: str,
    payload: RoomPostRequest,
    user: CurrentUser = Depends(get_current_user),
) -> RoomPostResponse:
    """User posts into the room. With agent_id, posts via that agent
    (substitute mode) — must be one of the caller's own agents."""
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="body is required")
    await _ensure_group_member(group_id, user.id)
    if payload.agent_id is not None:
        async with acquire() as conn:
            owned = await conn.fetchval(
                """
                select 1 from public.agents
                 where id = $1 and owner_user_id = $2 limit 1
                """,
                payload.agent_id, user.id,
            )
        if not owned:
            raise HTTPException(
                status_code=403,
                detail="agent_id must be one of your own agents",
            )
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            insert into public.world_group_room_messages
              (world_group_id, agent_id, user_id, body)
            values ($1, $2, $3, $4)
            returning id, world_group_id, agent_id, user_id, body,
                      created_at, seq
            """,
            group_id, payload.agent_id, user.id, body,
        )
        speaker_name = await conn.fetchval(
            """
            select coalesce(
              (select display_name from public.agents where id = $1),
              (select display_name from public.profiles where id = $2)
            )
            """,
            payload.agent_id, user.id,
        )
    # Reactive tick — when a human speaks, fire one extra room_tick
    # right away (don't wait for the autonomous cooldown). The next
    # picked agent will see the user's message in recent context and
    # respond. Cap at 2 follow-up ticks so a chatty user doesn't
    # cascade burn budget.
    async def _react() -> None:
        try:
            for _ in range(2):
                await society_room_tick(group_id)
                await asyncio.sleep(0.6)
        except Exception:  # noqa: BLE001
            pass

    asyncio.create_task(_react())

    return RoomPostResponse(
        message=RoomMessageRow(
            id=str(row["id"]),
            world_group_id=str(row["world_group_id"]),
            agent_id=str(row["agent_id"]) if row["agent_id"] else None,
            user_id=str(row["user_id"]) if row["user_id"] else None,
            body=row["body"],
            created_at=row["created_at"].isoformat(),
            seq=int(row["seq"]),
            speaker_name=speaker_name,
        )
    )


@app.post(
    "/api/world-groups/{group_id}/society/spark",
    response_model=SocietySparkResponse,
)
async def world_group_society_spark(
    group_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> SocietySparkResponse:
    """Manually spark a conversation in a group. Member-only."""
    async with acquire() as conn:
        is_member = await conn.fetchval(
            """
            select 1 from public.world_group_members
             where group_id = $1 and user_id = $2 and status = 'accepted'
             limit 1
            """,
            group_id, user.id,
        )
    if not is_member:
        raise HTTPException(
            status_code=403, detail="only accepted members can spark"
        )
    group = await world_groups_mod.get_group(group_id)
    room = f"the {group['name']} world" if group else None
    conv_id = await spark_society(world_group_id=group_id, room=room)
    if conv_id is None:
        return SocietySparkResponse(
            conversation_id=None,
            started=False,
            reason="no eligible pair (need ≥2 agents across members, none recently paired)",
        )
    return SocietySparkResponse(conversation_id=conv_id, started=True)


@app.get(
    "/api/worlds/by-username/{username}/since",
    response_model=SinceFeedResponse,
)
async def world_since(
    username: str,
    ts: str | None = None,
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
) -> SinceFeedResponse:
    """Return pixel agent posts in this world created since `ts` (ISO 8601).

    If `ts` is omitted, defaults to the last 7 days. Friend-gated, same
    as `world_by_username`. Used by the "since you were away" strip on
    the frontend.
    """
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be 1-200")
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
        if ts:
            rows = await conn.fetch(
                """
                select p.id, p.body, p.importance, p.parent_post_id,
                       p.topic, p.created_at,
                       a.id as agent_id, a.display_name
                from public.pixel_agent_posts p
                join public.agents a on a.id = p.agent_id
                where p.world_id = $1 and p.created_at > $2::timestamptz
                order by p.created_at desc
                limit $3
                """,
                world_id,
                ts,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                select p.id, p.body, p.importance, p.parent_post_id,
                       p.topic, p.created_at,
                       a.id as agent_id, a.display_name
                from public.pixel_agent_posts p
                join public.agents a on a.id = p.agent_id
                where p.world_id = $1
                  and p.created_at > now() - interval '7 days'
                order by p.created_at desc
                limit $2
                """,
                world_id,
                limit,
            )
    return SinceFeedResponse(
        world_id=world_id,
        posts=[
            PixelAgentPostRow(
                id=str(r["id"]),
                agent_id=str(r["agent_id"]),
                agent_display_name=r["display_name"],
                body=r["body"],
                importance=r["importance"],
                parent_post_id=str(r["parent_post_id"]) if r["parent_post_id"] is not None else None,
                topic=r["topic"],
                created_at=r["created_at"].isoformat(),
            )
            for r in rows
        ],
    )


@app.get(
    "/api/worlds/by-username/{username}/engine",
    response_model=EngineStatusResponse,
)
async def world_engine_status(
    username: str,
    user: CurrentUser = Depends(get_current_user),
) -> EngineStatusResponse:
    """Read the autonomous engine state for the named user's world.
    Owner-only — only the world's owner can see (or change) whether
    autonomous ticks are running on their world."""
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
        if owner_user_id != user.id:
            raise HTTPException(
                status_code=403,
                detail="engine state is private to the world's owner",
            )
        row = await conn.fetchrow(
            """
            select w.engine_enabled, w.engine_last_tick_at,
                   w.engine_idle_hours, p.last_seen_at
            from public.worlds w
            join public.profiles p on p.id = w.owner_user_id
            where w.id = $1
            """,
            world_id,
        )
    return _engine_status_payload(world_id, row)


@app.patch(
    "/api/worlds/by-username/{username}/engine",
    response_model=EngineStatusResponse,
)
async def world_engine_toggle(
    username: str,
    payload: EngineToggleRequest,
    user: CurrentUser = Depends(get_current_user),
) -> EngineStatusResponse:
    """Toggle the autonomous engine on or off for this world. Owner-only.

    When enabled, the background engine loop in main.py's lifespan will
    pick this world up on its next sweep (within ENGINE_SWEEP_INTERVAL_S)
    and tick it every ENGINE_TICK_INTERVAL_MINUTES. Manual /tick still
    works regardless of this flag — it's the explicit user-initiated
    button on the UI.
    """
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
        if owner_user_id != user.id:
            raise HTTPException(
                status_code=403,
                detail="only the world's owner can toggle the engine",
            )
        # Resetting last_tick_at to NULL when ENABLING means the next
        # sweep fires immediately (otherwise an old timestamp could
        # delay the first autonomous tick by up to interval).
        if payload.enabled:
            await conn.execute(
                """
                update public.worlds
                set engine_enabled = true,
                    engine_last_tick_at = null
                where id = $1
                """,
                world_id,
            )
        else:
            await conn.execute(
                "update public.worlds set engine_enabled = false where id = $1",
                world_id,
            )
        # Re-read with the profile join so the returned status carries
        # the derived effective_state.
        row = await conn.fetchrow(
            """
            select w.engine_enabled, w.engine_last_tick_at,
                   w.engine_idle_hours, p.last_seen_at
            from public.worlds w
            join public.profiles p on p.id = w.owner_user_id
            where w.id = $1
            """,
            world_id,
        )
    return _engine_status_payload(world_id, row)


@app.get(
    "/api/worlds/by-username/{username}/reflections",
    response_model=ReflectionsResponse,
)
async def world_reflections(
    username: str,
    limit: int = 30,
    user: CurrentUser = Depends(get_current_user),
) -> ReflectionsResponse:
    """Recent reflections for the named user's home world. Owner-only:
    visitors get 403. Reflections are agents' inner thoughts — higher-
    level abstractions they've drawn from their own posts. By design
    they're private to the owner (Smallville keeps them internal too)."""
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be 1-200")
    async with acquire() as conn:
        owner_user_id, world_id = await _resolve_home_world_by_username(
            conn, username, caller_user_id=user.id
        )
        if owner_user_id != user.id:
            raise HTTPException(
                status_code=403,
                detail="reflections are private to the world's owner",
            )
        rows = await conn.fetch(
            """
            select m.id, m.content, m.importance, m.created_at,
                   a.id as agent_id, a.display_name
            from public.pixel_agent_memories m
            join public.agents a on a.id = m.agent_id
            where a.world_id = $1
              and m.kind = 'reflection'
            order by m.created_at desc
            limit $2
            """,
            world_id,
            limit,
        )
    return ReflectionsResponse(
        world_id=world_id,
        reflections=[
            ReflectionRow(
                id=str(r["id"]),
                agent_id=str(r["agent_id"]),
                agent_display_name=r["display_name"],
                content=r["content"],
                importance=r["importance"],
                created_at=r["created_at"].isoformat(),
            )
            for r in rows
        ],
    )


@app.get("/api/agents/{agent_id}/profile", response_model=AgentProfileResponse)
async def agent_profile(
    agent_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> AgentProfileResponse:
    """Rich profile for an agent — sprite, persona, message stats. Used
    by AgentProfilePanel. Gated like /api/worlds/{id}/agents: caller
    must own the agent or be friends with the owner."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select
                a.id,
                a.world_id,
                a.owner_user_id,
                a.canonical_id,
                a.display_name,
                a.subtitle,
                a.persona_md,
                a.sprite_url,
                a.portrait_url,
                a.sprite_sheet_url,
                a.tile_x,
                a.tile_y,
                a.tint,
                a.created_at,
                p.display_name as owner_display_name
            from public.agents a
            join public.profiles p on p.id = a.owner_user_id
            where a.id = $1
            """,
            agent_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="no such agent")

        owner_id = str(row["owner_user_id"])
        is_friend = True
        if owner_id != user.id:
            is_friend = bool(await conn.fetchval(
                "select public.are_friends($1, $2)",
                row["owner_user_id"],
                user.id,
            ))

        if is_friend or owner_id == user.id:
            # Full profile — own or friend's agent.
            stats = await conn.fetchrow(
                """
                select
                    count(*) filter (where role = 'user')  as your_msgs,
                    count(*) filter (where role = 'agent') as agent_msgs,
                    min(created_at) as first_chat_at,
                    max(created_at) as last_chat_at
                from public.messages
                where agent_id = $1 and user_id = $2
                """,
                agent_id,
                user.id,
            )
            persona = row["persona_md"] or ""
        else:
            # Redacted public profile — not friends. Show name, subtitle,
            # sprite/portrait, and persona (grayed out on frontend). Redact stats.
            stats = {"your_msgs": 0, "agent_msgs": 0, "first_chat_at": None, "last_chat_at": None}
            persona = row["persona_md"] or ""

    # Derive photo URL from sprite storage path convention.
    _photo_url: str | None = None
    _sprite = row["sprite_url"] or ""
    if "/storage/v1/object/public/sprites/" in _sprite:
        _base = _sprite.split("/storage/v1/object/public/sprites/")[0]
        _photo_url = f"{_base}/storage/v1/object/public/sprites/{owner_id}/{row['id']}/photo.jpg"

    return AgentProfileResponse(
        id=str(row["id"]),
        world_id=str(row["world_id"]),
        owner_user_id=owner_id,
        owner_display_name=row["owner_display_name"],
        canonical_id=row["canonical_id"],
        display_name=row["display_name"],
        subtitle=row["subtitle"],
        persona_md=persona,
        sprite_url=row["sprite_url"],
        portrait_url=row["portrait_url"],
        sprite_sheet_url=row["sprite_sheet_url"],
        photo_url=_photo_url,
        tile_x=row["tile_x"],
        tile_y=row["tile_y"],
        tint=row["tint"],
        created_at=row["created_at"].isoformat(),
        is_own=owner_id == user.id,
        is_friend=is_friend if owner_id != user.id else True,
        stats=AgentProfileStats(
            your_msgs=int(stats["your_msgs"] or 0),
            agent_msgs=int(stats["agent_msgs"] or 0),
            first_chat_at=stats["first_chat_at"].isoformat() if stats["first_chat_at"] else None,
            last_chat_at=stats["last_chat_at"].isoformat() if stats["last_chat_at"] else None,
        ),
    )


@app.get("/api/visitors/recent", response_model=RecentVisitorsResponse)
async def visitors_recent(
    user: CurrentUser = Depends(get_current_user),
) -> RecentVisitorsResponse:
    """List people who've messaged the caller's agents recently. Reads
    the public.recent_visitors view (defined in 0004_messages.sql) and
    joins profiles for display names. Used by the home-world HUD panel.

    Cap: last 7 days, max 20 visitors. Most recent first."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select
                rv.visitor_user_id,
                rv.last_visit,
                p.display_name as visitor_display_name
            from public.recent_visitors rv
            join public.profiles p on p.id = rv.visitor_user_id
            where rv.owner_user_id = $1
              and rv.last_visit > now() - interval '7 days'
            order by rv.last_visit desc
            limit 20
            """,
            user.id,
        )
    return RecentVisitorsResponse(
        visitors=[
            RecentVisitor(
                visitor_user_id=str(r["visitor_user_id"]),
                visitor_display_name=r["visitor_display_name"],
                last_visit=r["last_visit"].isoformat(),
            )
            for r in rows
        ]
    )


@app.get("/api/me", response_model=MeResponse)
async def me(user: CurrentUser = Depends(get_current_user)) -> MeResponse:
    """Identify the caller via their Supabase JWT and join their profile +
    home world from Postgres. Returns 401 if the bearer token is missing
    or invalid."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select
                p.id,
                p.display_name,
                p.bio,
                p.photo_url,
                p.palette_index,
                p.social_links,
                p.created_at,
                w.id   as home_world_id,
                w.slug as home_world_slug
            from public.profiles p
            left join public.worlds w on w.owner_user_id = p.id and w.slug = 'home'
            where p.id = $1
            """,
            user.id,
        )
    user_obj = UserIdentity(id=user.id, email=user.email, role=user.role)
    if row is None:
        # Profile trigger didn't fire (e.g. user existed before 0001).
        return MeResponse(user=user_obj, profile=None, home_world=None)
    return MeResponse(
        user=user_obj,
        profile=ProfileSummary(
            id=str(row["id"]),
            display_name=row["display_name"],
            bio=row["bio"],
            photo_url=row["photo_url"],
            palette_index=row["palette_index"],
            created_at=row["created_at"].isoformat() if row["created_at"] else None,
            social_links=_json_or_none(row["social_links"]),
        ),
        home_world=(
            HomeWorldRef(
                id=str(row["home_world_id"]),
                slug=row["home_world_slug"],
            )
            if row["home_world_id"]
            else None
        ),
    )


def _json_or_none(v: Any) -> dict | None:
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return None


class ProfileUpdateIn(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    palette_index: int | None = None
    social_links: dict | None = None


@app.patch("/api/me/profile", response_model=MeResponse)
async def update_my_profile(
    body: ProfileUpdateIn, user: CurrentUser = Depends(get_current_user)
) -> MeResponse:
    """Update the caller's own profile (display_name/bio/palette/social_links).
    Replaces the old direct supabase.from('profiles').upsert() writes."""
    # Only touch fields the caller actually sent (so an explicit null clears,
    # but an omitted field is left unchanged).
    provided = body.model_dump(exclude_unset=True)
    sets: list[str] = []
    args: list[Any] = []
    i = 1
    if "display_name" in provided:
        sets.append(f"display_name = ${i}"); args.append(provided["display_name"]); i += 1
    if "bio" in provided:
        sets.append(f"bio = ${i}"); args.append(provided["bio"]); i += 1
    if "palette_index" in provided:
        sets.append(f"palette_index = ${i}"); args.append(provided["palette_index"]); i += 1
    if "social_links" in provided:
        sl = provided["social_links"]
        sets.append(f"social_links = ${i}::jsonb")
        args.append(json.dumps(sl) if sl is not None else None); i += 1
    if sets:
        async with acquire() as conn:
            args.append(user.id)
            await conn.execute(
                f"update public.profiles set {', '.join(sets)}, updated_at = now() where id = ${i}",
                *args,
            )
    return await me(user)


@app.get("/api/me/self-agent")
async def my_self_agent(user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
    """The caller's own 'self' agent (canonical_id is null). Replaces the
    direct supabase.from('agents') self-agent lookup in onboarding."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select id, display_name, sprite_url, portrait_url
            from public.agents
            where owner_user_id = $1 and canonical_id is null
            order by created_at asc limit 1
            """,
            user.id,
        )
    if row is None:
        return {"agent": None}
    return {
        "agent": {
            "id": str(row["id"]),
            "display_name": row["display_name"],
            "sprite_url": row["sprite_url"],
            "portrait_url": row["portrait_url"],
        }
    }


# Access predicate for the society feed: a conversation is visible if the
# caller is a member of its group, or owns / is friends with its world's owner.
_SOCIETY_ACCESS = """
  (
    (c.world_group_id is not null and public.is_world_group_member(c.world_group_id, $1))
    or
    (c.world_id is not null and exists (
        select 1 from public.worlds w where w.id = c.world_id
          and (w.owner_user_id = $1 or public.are_friends(w.owner_user_id, $1))
    ))
  )
"""


def _conv_row(r: Any) -> dict[str, Any]:
    return {
        "id": str(r["id"]),
        "world_id": str(r["world_id"]) if r["world_id"] else None,
        "world_group_id": str(r["world_group_id"]) if r["world_group_id"] else None,
        "agent_a_id": str(r["agent_a_id"]),
        "agent_b_id": str(r["agent_b_id"]),
        "room": r["room"],
        "status": r["status"],
        "started_at": r["started_at"].isoformat() if r["started_at"] else None,
        "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
        "message_count": r["message_count"],
        "last_message_at": r["last_message_at"].isoformat() if r["last_message_at"] else None,
    }


@app.get("/api/society/conversations")
async def society_conversations(
    user: CurrentUser = Depends(get_current_user),
    world_id: str | None = None,
    world_group_id: str | None = None,
    limit: int = 12,
) -> dict[str, Any]:
    """Recent agent↔agent conversations the caller can see. Replaces the
    direct supabase.from('agent_conversations') read in SocietyFeed."""
    limit = max(1, min(limit, 50))
    clauses = [_SOCIETY_ACCESS]
    args: list[Any] = [user.id]
    i = 2
    if world_group_id:
        clauses.append(f"c.world_group_id = ${i}::uuid"); args.append(world_group_id); i += 1
    elif world_id:
        clauses.append(f"c.world_id = ${i}::uuid"); args.append(world_id); i += 1
    sql = f"""
        select c.id, c.world_id, c.world_group_id, c.agent_a_id, c.agent_b_id,
               c.room, c.status, c.started_at, c.ended_at, c.message_count, c.last_message_at
        from public.agent_conversations c
        where {" and ".join(clauses)}
        order by c.last_message_at desc nulls last
        limit {limit}
    """
    async with acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return {"conversations": [_conv_row(r) for r in rows]}


@app.get("/api/society/messages")
async def society_messages(
    user: CurrentUser = Depends(get_current_user),
    conversation_ids: str = "",
    after_seq: int = 0,
) -> dict[str, Any]:
    """Messages for the given conversation ids (access-checked), seq > after_seq.
    Replaces the direct supabase.from('agent_conversation_messages') reads +
    realtime subscription in SocietyFeed (frontend polls this)."""
    ids = [x.strip() for x in conversation_ids.split(",") if x.strip()]
    if not ids:
        return {"messages": []}
    sql = f"""
        select m.conversation_id, m.seq, m.agent_id, m.body, m.created_at
        from public.agent_conversation_messages m
        join public.agent_conversations c on c.id = m.conversation_id
        where m.conversation_id = any($2::uuid[]) and m.seq > $3 and {_SOCIETY_ACCESS}
        order by m.conversation_id, m.seq asc
    """
    async with acquire() as conn:
        rows = await conn.fetch(sql, user.id, ids, after_seq)
    return {
        "messages": [
            {
                "conversation_id": str(r["conversation_id"]),
                "seq": r["seq"],
                "agent_id": str(r["agent_id"]),
                "body": r["body"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    }


@app.get("/api/agents")
def agents_route(world: str | None = None) -> dict[str, Any]:
    """Live scan of `data/wikis/` (each subdir with personality.md is
    one agent), optionally filtered to a single world. Role agents get
    the curated EXPERTISE tags; ingested colleagues get their topic-page
    slugs as expertise so the Router can route to them too.
    """
    role_ids = set(EXPERTISE.keys())
    out: list[dict[str, Any]] = []
    for a in get_agents(world):
        is_role = a.id in role_ids
        out.append({
            **a.to_dict(),
            "expertise": EXPERTISE.get(a.id, []) if is_role else get_ingested_expertise(a.id),
            "ingested": not is_role,
        })
    return {"company": COMPANY, "worlds": list_worlds(), "agents": out}


_WIKILINK_RE = re.compile(r"\[\[([^\]]+?)\]\]")
_WIKIS_PATH = Path(__file__).resolve().parent.parent / "data" / "wikis"


@app.get("/api/me/world-graph")
async def me_world_graph(user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
    """World-scoped Obsidian-style knowledge graph for the caller's
    home world. Same node-level detail as `/api/graph` (one node per
    markdown file: hub / personality / topic, with [[wikilink]]-driven
    edges and grey ghost nodes for unresolved references), but
    restricted to the canonical agents that actually live in the
    caller's `public.agents` rows. Ingested non-canonical agents
    surface as a single hub node from their `persona_md`.
    """
    # 1) Find which agents are in this user's home world.
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select a.id::text as id, a.canonical_id, a.display_name,
                   a.persona_md, a.tint, a.sprite_url,
                   a.owner_user_id::text as owner_user_id
            from public.agents a
            join public.worlds w on w.id = a.world_id
            where w.owner_user_id = $1 and w.slug = 'home'
            order by a.created_at asc
            """,
            user.id,
        )

    palette = ["#a855f7", "#ec4899", "#f97316", "#eab308", "#22c55e",
               "#06b6d4", "#3b82f6", "#8b5cf6", "#f43f5e", "#10b981",
               "#0ea5e9", "#d946ef", "#fb923c", "#facc15", "#84cc16"]

    def colour_for(seed: str) -> str:
        return palette[sum(ord(c) for c in (seed or "")) % len(palette)]

    canonical_in_world: dict[str, dict[str, str]] = {}
    custom_agents: list[dict[str, Any]] = []
    for r in rows:
        canon = r["canonical_id"]
        if canon:
            canonical_in_world[canon] = {
                "name": r["display_name"],
                "color": r["tint"] or colour_for(canon),
            }
        else:
            custom_agents.append(dict(r))

    # 2) Pass 1: enumerate every committed wiki file for canonical
    # agents that live in this world. Build a stem→node-id index for
    # bare wikilink resolution.
    files: list[tuple[str, Path]] = []
    file_index: dict[str, str] = {}
    if _WIKIS_PATH.exists():
        for canon_id, meta in canonical_in_world.items():
            agent_dir = _WIKIS_PATH / canon_id
            if not agent_dir.is_dir():
                continue
            for f in sorted(agent_dir.glob("*.md")):
                files.append((canon_id, f))
                file_index[f.stem.lower()] = f"{canon_id}/{f.stem}"

    nodes_by_id: dict[str, dict[str, Any]] = {}
    links: list[dict[str, str]] = []

    def _add_node(node_id: str, **fields: Any) -> None:
        if node_id not in nodes_by_id:
            nodes_by_id[node_id] = {"id": node_id, **fields}

    def _resolve(target: str, current_agent_id: str) -> str | None:
        t = target.strip().split("|", 1)[0].strip()
        if not t:
            return None
        cleaned = t.lstrip("./")
        if "/" in cleaned:
            parts = [p for p in cleaned.split("/") if p and p != ".."]
            if len(parts) >= 2 and parts[-2] in canonical_in_world:
                cand = f"{parts[-2]}/{parts[-1]}"
                if cand in nodes_by_id or any(
                    p.stem == parts[-1] and ad == parts[-2] for ad, p in files
                ):
                    return cand
            t = parts[-1] if parts else t
        same = f"{current_agent_id}/{t}"
        if any(p.stem == t and ad == current_agent_id for ad, p in files):
            return same
        return file_index.get(t.lower())

    # 3) Build canonical-agent nodes + edges (the rich, file-level graph).
    for canon_id, f in files:
        meta = canonical_in_world[canon_id]
        agent_color = meta["color"]
        agent_name = meta["name"]

        node_id = f"{canon_id}/{f.stem}"
        is_hub = f.stem == agent_name
        is_persona = f.stem == "personality"
        if is_hub:
            group, size = "hub", 14
        elif is_persona:
            group, size = "personality", 9
        else:
            group, size = "topic", 6

        _add_node(
            node_id,
            label=f.stem if is_hub else f.stem.replace("-", " "),
            group=group,
            color=agent_color,
            agentId=canon_id,
            agentName=agent_name,
            size=size,
        )

        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            continue
        for m in _WIKILINK_RE.finditer(text):
            target_id = _resolve(m.group(1), canon_id)
            if target_id is None:
                bare = m.group(1).strip().split("|", 1)[0].strip().lstrip("./").split("/")[-1]
                if not bare or bare.lower() == "readme":
                    continue
                ghost_id = f"_ext/{bare}"
                _add_node(
                    ghost_id,
                    label=bare,
                    group="external",
                    color="#9ca3af",
                    size=3,
                )
                target_id = ghost_id
            if target_id != node_id:
                links.append({"source": node_id, "target": target_id})

    # 4) Custom (non-canonical / ingested) agents — they don't have a
    # filesystem dir, so just emit a single hub node from their
    # persona_md and parse wikilinks for cross-world edges.
    for c in custom_agents:
        canon_seed = c["id"]
        node_id = f"_custom/{c['id']}"
        _add_node(
            node_id,
            label=c["display_name"],
            group="hub",
            color=c["tint"] or colour_for(canon_seed),
            agentId=c["id"],
            agentName=c["display_name"],
            size=12,
        )
        persona = c["persona_md"] or ""
        for m in _WIKILINK_RE.finditer(persona):
            target_raw = m.group(1).strip().split("|", 1)[0].strip()
            if not target_raw or target_raw.lower() == "readme":
                continue
            target_id = file_index.get(target_raw.lower())
            if target_id is None:
                ghost_id = f"_ext/{target_raw}"
                _add_node(
                    ghost_id,
                    label=target_raw,
                    group="external",
                    color="#9ca3af",
                    size=3,
                )
                target_id = ghost_id
            if target_id != node_id:
                links.append({"source": node_id, "target": target_id})

    # 5) Dedup symmetric / repeated edges.
    seen_edges: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for e in links:
        key = (e["source"], e["target"])
        rev = (e["target"], e["source"])
        if key in seen_edges or rev in seen_edges:
            continue
        seen_edges.add(key)
        deduped.append(e)

    # 6) Build photo map: agentId → photo.jpg URL in Supabase storage.
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    photos: dict[str, str] = {}
    for r in rows:
        if r["sprite_url"] and "/storage/v1/object/public/sprites/" in (r["sprite_url"] or ""):
            photos[r["id"]] = (
                f"{base_url}/storage/v1/object/public/sprites/"
                f"{r['owner_user_id']}/{r['id']}/photo.jpg"
            )

    from .twin_memory.graph import enrich_graph
    from .twin_memory.service import view as memory_view
    from .ingest.onboarding import _self_agent
    async with acquire() as conn:
        self_agent = await _self_agent(conn, user.id)
        friends = await conn.fetch("""select p.id::text as id,p.display_name,p.photo_url
            from public.friendships f join public.profiles p on p.id =
            case when f.requester_id=$1 then f.addressee_id else f.requester_id end
            where (f.requester_id=$1 or f.addressee_id=$1) and f.status='accepted'""",user.id)
    result = enrich_graph(
        {"nodes": list(nodes_by_id.values()), "links": deduped, "photos": photos},
        await memory_view(user.id), str(self_agent['id']) if self_agent else None,
    )
    root = f"_custom/{self_agent['id']}" if self_agent else '_memory/person'
    for friend in friends:
        friend_id = '_friend/'+friend['id']
        result['nodes'].append(dict(id=friend_id,label=friend['display_name'] or 'Friend',group='hub',
            color='#22c55e',size=12,photoUrl=friend['photo_url'],privateMemory=True,
            markdown='An accepted connection in your network. Their private wiki is not shared through this connection.'))
        result['links'].append(dict(source=root,target=friend_id,relation='accepted friendship'))
    return result


@app.get("/api/me/network-agents", response_model=NetworkAgentsResponse)
async def me_network_agents(
    user: CurrentUser = Depends(get_current_user),
) -> NetworkAgentsResponse:
    """Every agent in every home world across the platform — the data
    behind the All Worlds gallery. Demo-grade: surfaces everyone who
    has signed up, not just accepted friends. Each row carries the
    owner's display_name so the UI can tag cards with whose world
    they live in."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select a.id::text          as agent_id,
                   a.display_name,
                   a.subtitle,
                   a.canonical_id,
                   a.sprite_url,
                   a.portrait_url,
                   a.sprite_sheet_url,
                   a.owner_user_id::text as owner_user_id,
                   p.display_name      as owner_display_name,
                   a.world_id::text    as world_id,
                   (a.owner_user_id = $1) as is_own
              from public.agents a
              join public.worlds w on w.id = a.world_id
              join public.profiles p on p.id = a.owner_user_id
             where w.slug = 'home'
             order by (a.owner_user_id = $1) desc,
                      p.display_name asc,
                      a.display_name asc
            """,
            user.id,
        )
    return NetworkAgentsResponse(
        agents=[
            NetworkAgentRow(
                agent_id=r["agent_id"],
                display_name=r["display_name"],
                subtitle=r["subtitle"],
                canonical_id=r["canonical_id"],
                sprite_url=r["sprite_url"],
                portrait_url=r["portrait_url"],
                sprite_sheet_url=r["sprite_sheet_url"],
                owner_user_id=r["owner_user_id"],
                owner_display_name=r["owner_display_name"],
                world_id=r["world_id"],
                is_own=r["is_own"],
            )
            for r in rows
        ]
    )


@app.get("/api/network-agents", response_model=NetworkAgentsResponse)
async def public_network_agents() -> NetworkAgentsResponse:
    """Public preview data for anonymous visitors browsing All Worlds."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select a.id::text          as agent_id,
                   a.display_name,
                   a.subtitle,
                   a.canonical_id,
                   a.sprite_url,
                   a.portrait_url,
                   a.sprite_sheet_url,
                   a.owner_user_id::text as owner_user_id,
                   p.display_name      as owner_display_name,
                   a.world_id::text    as world_id
              from public.agents a
              join public.worlds w on w.id = a.world_id
              join public.profiles p on p.id = a.owner_user_id
             where w.slug = 'home'
             order by p.display_name asc,
                      a.display_name asc
            """
        )
    return NetworkAgentsResponse(
        agents=[
            NetworkAgentRow(
                agent_id=r["agent_id"],
                display_name=r["display_name"],
                subtitle=r["subtitle"],
                canonical_id=r["canonical_id"],
                sprite_url=r["sprite_url"],
                portrait_url=r["portrait_url"],
                sprite_sheet_url=r["sprite_sheet_url"],
                owner_user_id=r["owner_user_id"],
                owner_display_name=r["owner_display_name"],
                world_id=r["world_id"],
                is_own=False,
            )
            for r in rows
        ]
    )


@app.get("/api/graph")
def graph_route() -> dict[str, Any]:
    """Build the Obsidian-style knowledge graph from data/wikis/.

    Each markdown file is one node (id = "<agent_slug>/<file_stem>").
    Edges come from `[[wikilinks]]` parsed out of each file's body.
    Unresolvable wikilinks become small grey "external" ghost nodes
    so the graph still shows what entities are referenced.
    """
    if not _WIKIS_PATH.exists():
        return {"nodes": [], "links": []}

    # Pass 1: enumerate every file, build a stem→node-id index for
    # bare wikilink resolution.
    files: list[tuple[str, Path]] = []
    file_index: dict[str, str] = {}  # last-write wins (rare collisions)
    for agent_dir in sorted(_WIKIS_PATH.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("_"):
            continue
        for f in sorted(agent_dir.glob("*.md")):
            files.append((agent_dir.name, f))
            file_index[f.stem.lower()] = f"{agent_dir.name}/{f.stem}"

    # Pre-compute agent metadata (name + colour) for hub detection +
    # consistent node colours.
    agent_meta: dict[str, dict[str, str]] = {}
    for a in list_all_agents():
        agent_meta[a.id] = {"name": a.name, "color": a.color}

    nodes_by_id: dict[str, dict[str, Any]] = {}
    links: list[dict[str, str]] = []

    def _add_node(node_id: str, **fields: Any) -> None:
        if node_id not in nodes_by_id:
            nodes_by_id[node_id] = {"id": node_id, **fields}

    def _resolve(target: str, current_agent_id: str) -> str | None:
        t = target.strip().split("|", 1)[0].strip()
        if not t:
            return None
        # Strip any leading ../ and look at the last two parts.
        cleaned = t.lstrip("./")
        if "/" in cleaned:
            parts = [p for p in cleaned.split("/") if p and p != ".."]
            if len(parts) >= 2 and parts[-2] in agent_meta:
                cand = f"{parts[-2]}/{parts[-1]}"
                if cand in nodes_by_id or any(
                    p.stem == parts[-1] and ad == parts[-2] for ad, p in files
                ):
                    return cand
            # Fall through to bare-name lookup on the basename.
            t = parts[-1] if parts else t
        # Same-agent-first preference for bare names.
        same = f"{current_agent_id}/{t}"
        if any(p.stem == t and ad == current_agent_id for ad, p in files):
            return same
        idx = file_index.get(t.lower())
        return idx

    for agent_id, f in files:
        meta = agent_meta.get(agent_id, {"name": agent_id, "color": "#9ca3af"})
        agent_color = meta["color"]
        agent_name = meta["name"]

        node_id = f"{agent_id}/{f.stem}"
        is_hub = f.stem == agent_name
        is_persona = f.stem == "personality"
        if is_hub:
            group, size = "hub", 14
        elif is_persona:
            group, size = "personality", 9
        else:
            group, size = "topic", 6

        _add_node(
            node_id,
            label=f.stem if is_hub else f.stem.replace("-", " "),
            group=group,
            color=agent_color,
            agentId=agent_id,
            agentName=agent_name,
            size=size,
        )

        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            continue
        for m in _WIKILINK_RE.finditer(text):
            target_id = _resolve(m.group(1), agent_id)
            if target_id is None:
                bare = m.group(1).strip().split("|", 1)[0].strip().lstrip("./").split("/")[-1]
                if not bare or bare.lower() == "readme":
                    continue
                ghost_id = f"_ext/{bare}"
                _add_node(
                    ghost_id,
                    label=bare,
                    group="external",
                    color="#9ca3af",
                    size=3,
                )
                target_id = ghost_id
            if target_id != node_id:
                links.append({"source": node_id, "target": target_id})

    # De-duplicate symmetric / repeated edges.
    seen_edges: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for e in links:
        key = (e["source"], e["target"])
        rev = (e["target"], e["source"])
        if key in seen_edges or rev in seen_edges:
            continue
        seen_edges.add(key)
        deduped.append(e)

    return {"nodes": list(nodes_by_id.values()), "links": deduped}


@app.get("/api/wiki_page")
def wiki_page_route(id: str) -> dict[str, Any]:
    """Single-file fetch for the graph preview.

    `id` is `<agent_slug>/<file_stem>` (matches GraphNode.id). The stem
    can contain spaces — e.g. `marketing/Ellis` or `zoe-qin/Zoe Qin`.
    Path traversal is blocked by resolving + checking the path stays
    inside data/wikis/<agent_slug>/.
    """
    if not id or ".." in id or "\x00" in id:
        raise HTTPException(400, "Invalid id")
    agent_part, _, stem = id.partition("/")
    if not agent_part or not stem:
        raise HTTPException(400, "Invalid id (need <agent>/<stem>)")
    folder = _WIKIS_PATH / agent_part
    if not folder.is_dir():
        return {"id": id, "exists": False, "markdown": "", "agent_id": agent_part, "stem": stem}
    candidate = folder / f"{stem}.md"
    try:
        resolved = candidate.resolve()
        folder_resolved = folder.resolve()
    except OSError:
        raise HTTPException(400, "Invalid path") from None
    if not str(resolved).startswith(str(folder_resolved) + os.sep) and resolved != folder_resolved:
        raise HTTPException(400, "Path escapes wiki dir")
    if not candidate.exists():
        return {"id": id, "exists": False, "markdown": "", "agent_id": agent_part, "stem": stem}
    return {
        "id": id,
        "exists": True,
        "markdown": candidate.read_text(encoding="utf-8"),
        "agent_id": agent_part,
        "stem": stem,
    }


@app.post("/api/graph/search")
async def graph_semantic_search(payload: dict[str, Any]) -> dict[str, Any]:
    """LLM-powered semantic search over the knowledge graph.

    Body: {"query": "what interesting technologies...", "nodes": [{"id":..., "label":...}, ...]}
    Returns: {"results": [{"id": "...", "score": 0.9, "reason": "..."}, ...]}
    """
    query = str(payload.get("query", "")).strip()
    nodes = payload.get("nodes", [])
    if not query:
        raise HTTPException(400, "Missing query")
    if not nodes:
        raise HTTPException(400, "Missing nodes")

    # Build a compact index for the LLM — just id + label + group
    node_index = "\n".join(
        f"- {n['id']} | {n.get('label', '')} | {n.get('group', '')}"
        for n in nodes[:200]  # cap to avoid token overflow
    )

    from .conversation import _build_model
    from pydantic_ai import Agent as PydanticAgent
    from pydantic import BaseModel, Field

    class SearchResult(BaseModel):
        results: list[dict[str, Any]] = Field(
            description="Top matches. Each has 'id' (node id), 'score' (0-1), 'reason' (1 sentence why)."
        )

    agent = PydanticAgent(
        _build_model(),
        output_type=SearchResult,
        retries=2,
        system_prompt=(
            "You are a knowledge graph search engine. The user asks a natural language question.\n"
            "You have a list of graph nodes (id | label | group). Pick the 3-8 most relevant nodes\n"
            "that answer or relate to the query. Score each 0-1 and give a one-sentence reason.\n"
            "Return ONLY nodes from the provided list. If nothing is relevant, return an empty list.\n"
            "Prefer topic and hub nodes over external references."
        ),
    )

    result = await agent.run(
        f"QUERY: {query}\n\nNODE INDEX:\n{node_index}"
    )
    return {"results": result.output.results}


@app.get("/api/wiki")
def wiki_route(agentId: str) -> dict[str, Any]:
    if not get_agent(agentId):
        raise HTTPException(404, "Unknown agent")
    return {"agentId": agentId, "files": read_wiki(agentId)}


_SECTION_RE = re.compile(r"^## (?P<heading>.+?)$\n(?P<body>.*?)(?=^## |\Z)", re.DOTALL | re.MULTILINE)
_BLURB_SKIP_PREFIXES = ("#", "*", ">", "-")


def _parse_persona_sections(md: str) -> list[dict[str, str]]:
    """Split a personality.md into named sections by `## Heading`."""
    sections: list[dict[str, str]] = []
    for m in _SECTION_RE.finditer(md):
        heading = m.group("heading").strip()
        body = m.group("body").strip()
        if body:
            sections.append({"heading": heading, "body": body})
    return sections


def _topic_blurb(md: str) -> str:
    """First non-header prose paragraph of a topic page, truncated."""
    body_after_h1 = re.split(r"^# .+\n", md, maxsplit=1, flags=re.MULTILINE)
    if len(body_after_h1) < 2:
        return ""
    for raw in body_after_h1[1].split("\n\n"):
        para = raw.strip()
        if not para or para.startswith(_BLURB_SKIP_PREFIXES):
            continue
        sentence = re.split(r"(?<=[.!?])\s+", para, maxsplit=1)[0]
        sentence = re.sub(r"\s+", " ", sentence).strip()
        if len(sentence) > 160:
            sentence = sentence[:157].rsplit(" ", 1)[0] + "…"
        return sentence
    return ""


def _topic_title(md: str) -> str:
    for line in md.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


_HEADING_ALIASES: dict[str, list[str]] = {
    # Map "logical field" → list of personality.md heading variants we accept.
    "shape":     ["the shape of my life", "what i do", "background"],
    "tensions":  ["recurring tensions", "recurring themes"],
    "voice":     ["how i talk", "how i speak", "voice signature"],
    "askabout":  ["what you can ask me about", "good for", "ask me about"],
    "goals":     ["my goals", "goals"],
}

_MBTI_HEADING_RE = re.compile(r"mbti\s*[·•:\-—]\s*(?P<type>[A-Z]{4})\s*[—\-]\s*(?P<label>.+)", re.IGNORECASE)


def _section_by_alias(sections: list[dict[str, str]], aliases: list[str]) -> str:
    for s in sections:
        if s["heading"].strip().lower() in aliases:
            return s["body"]
    return ""


def _bullets(body: str) -> list[str]:
    """Pull `- bullet` lines (or `* bullet`) out of a markdown body."""
    out: list[str] = []
    for line in body.splitlines():
        m = re.match(r"^\s*[-*]\s+(?P<text>.+?)\s*$", line)
        if m:
            out.append(m.group("text"))
    return out


def _extract_mbti(sections: list[dict[str, str]]) -> dict[str, str] | None:
    """Find a `## MBTI · ENTP — The Debater` heading and parse its body."""
    for s in sections:
        m = _MBTI_HEADING_RE.search(s["heading"])
        if not m:
            continue
        body = s["body"]
        # Body usually has *Strength:* X. **Blind spot:** Y.
        strength = ""
        blindspot = ""
        st = re.search(r"\*\*Strength:\*\*\s*(?P<txt>.+?)(?=\*\*|$)", body, re.DOTALL)
        if st:
            strength = re.sub(r"\s+", " ", st.group("txt")).strip(" .*")
        bl = re.search(r"\*\*Blind spot:\*\*\s*(?P<txt>.+?)(?=\*\*|$)", body, re.DOTALL)
        if bl:
            blindspot = re.sub(r"\s+", " ", bl.group("txt")).strip(" .*")
        return {
            "type": m.group("type").upper(),
            "label": m.group("label").strip(" .*—-"),
            "strength": strength or "(no strength noted)",
            "blindspot": blindspot or "(no blind spot noted)",
        }
    return None


_KNOWLEDGE_CATEGORIES: dict[str, list[str]] = {
    "Tech & AI": [
        "ai", "tech", "system-design", "web-development", "engineering",
        "code", "infrastructure", "3d", "gaussian", "video-understanding",
        "knowledge-graph", "knowledge-management", "agentic", "claude",
        "full-stack", "platform", "pipeline",
    ],
    "Business": [
        "venture", "funding", "startup", "product-validation", "business",
        "hiring", "fundraising", "distribution", "strategy", "execution",
        "founding", "team-building", "monetiz",
    ],
    "Social": [
        "social", "networking", "meetup", "community", "event", "hackathon",
        "coordination", "friendship", "dating", "relationship", "team-dynamic",
    ],
    "Creative": [
        "film", "music", "documentary", "media", "art", "culture",
        "content", "design", "world-building", "interface", "creative",
    ],
    "Lifestyle": [
        "fitness", "travel", "food", "dining", "coffee", "restaurant",
        "martial-art", "sport", "mobility", "urban", "london",
    ],
    "Domain": [
        "policy", "law", "compliance", "r-d", "property", "energy",
        "sovereign", "terra-carta", "renovation", "interviewing",
    ],
}


def _classify_topics(topics: list[dict[str, str]]) -> list[dict[str, float]]:
    """Score each knowledge category 0..1 based on how many topics match."""
    counts: dict[str, int] = {cat: 0 for cat in _KNOWLEDGE_CATEGORIES}
    for t in topics:
        slug = t["slug"].lower()
        title = t.get("title", "").lower()
        combined = f"{slug} {title}"
        for cat, keywords in _KNOWLEDGE_CATEGORIES.items():
            if any(kw in combined for kw in keywords):
                counts[cat] += 1
    # Normalise: 1 match = 0.35, 2 = 0.55, 3 = 0.7, 4+ = 0.85.
    # Zero stays at 0.08 so the shape is still visible.
    tier_map = {0: 0.08, 1: 0.35, 2: 0.55, 3: 0.7}
    return [
        {"label": cat, "value": tier_map.get(min(c, 3), 0.7) if c < 4 else 0.85}
        for cat, c in counts.items()
    ]


_RADAR_AXES = list(_KNOWLEDGE_CATEGORIES.keys())


def _parse_hub_relationships(folder: Path, agent_name: str) -> list[dict[str, str]]:
    """Parse 'Key relationships' from the hub page (<Name>.md) in a wiki folder."""
    hub = folder / f"{agent_name}.md"
    if not hub.exists():
        return []
    text = hub.read_text(encoding="utf-8")
    # Find the "## Key relationships" section
    m = re.search(r"^## Key relationships\s*\n((?:.*\n)*?)(?=^## |\Z)", text, re.MULTILINE)
    if not m:
        return []
    rels: list[dict[str, str]] = []
    for line in m.group(1).splitlines():
        rm = re.match(r"^\s*-\s+\[\[([^\]]+)\]\]\s*—\s*(.+)$", line)
        if rm:
            rels.append({"name": rm.group(1).strip(), "context": rm.group(2).strip()})
    return rels


def _topic_to_memory(topic: dict[str, str], color: str) -> dict[str, Any]:
    """Generate a memory card from a topic page — title is the topic, the
    blurb becomes the visible body."""
    return {
        "title": topic["title"],
        "emotion": "engaged",
        "tags": [t for t in topic["slug"].split("-") if t][:3],
        "gradient": [color + "55", color + "11"],
        "blurb": topic.get("blurb", ""),
    }


@app.get("/api/agent_bio")
def agent_bio_route(id: str) -> dict[str, Any]:
    """Live biography for the profile drawer — derived from
    `data/wikis/<id>/personality.md` plus topic pages. Returns the full
    shape the frontend's AgentProfileDrawer expects so role agents AND
    ingested colleagues both render with the rich UI.
    """
    a = get_agent(id)
    if not a:
        raise HTTPException(404, "Unknown agent")
    role_ids = set(EXPERTISE.keys())

    persona_path = Path(__file__).resolve().parent.parent / "data" / "wikis" / id / "personality.md"
    one_line = ""
    sections: list[dict[str, str]] = []
    if persona_path.exists():
        text = persona_path.read_text(encoding="utf-8")
        body_text = text
        while body_text.startswith("---\n"):
            end = body_text.find("\n---", 4)
            if end == -1:
                break
            body_text = body_text[end + 4:].lstrip("\n")
        sections = _parse_persona_sections(body_text)
        for s in sections:
            if s["heading"].lower() == "in one line":
                one_line = s["body"].split("\n")[0].strip()
                break

    folder = persona_path.parent
    topics: list[dict[str, str]] = []
    if folder.exists():
        skip = {"personality", "lessons", "README", a.name}
        for p in sorted(folder.glob("*.md")):
            if p.stem in skip:
                continue
            topic_md = p.read_text(encoding="utf-8")
            topics.append({
                "slug": p.stem,
                "title": _topic_title(topic_md) or p.stem.replace("-", " ").title(),
                "blurb": _topic_blurb(topic_md),
            })

    # Extract structured fields.
    shape = _bullets(_section_by_alias(sections, _HEADING_ALIASES["shape"]))
    tensions = _bullets(_section_by_alias(sections, _HEADING_ALIASES["tensions"]))
    voice = _bullets(_section_by_alias(sections, _HEADING_ALIASES["voice"]))
    askabout = _bullets(_section_by_alias(sections, _HEADING_ALIASES["askabout"]))
    goals = _bullets(_section_by_alias(sections, _HEADING_ALIASES["goals"]))
    mbti = _extract_mbti(sections)

    # Backfills if a section gave us prose paragraphs instead of bullets.
    def _paras(body: str) -> list[str]:
        return [re.sub(r"\s+", " ", p).strip() for p in body.split("\n\n") if p.strip() and not p.strip().startswith(("#", ">"))]

    if not shape:
        shape = _paras(_section_by_alias(sections, _HEADING_ALIASES["shape"]))[:6]
    if not tensions:
        tensions = _paras(_section_by_alias(sections, _HEADING_ALIASES["tensions"]))[:5]
    if not voice:
        voice = _paras(_section_by_alias(sections, _HEADING_ALIASES["voice"]))[:5]

    # Sample line: try to pull a quoted sentence from the voice bullets.
    sample_line = ""
    for v in voice:
        m = re.search(r'"([^"]+)"', v)
        if m and len(m.group(1)) > 20:
            sample_line = m.group(1)
            break
    if not sample_line and voice:
        sample_line = voice[0][:140]

    expertise = EXPERTISE.get(id, []) if id in role_ids else [t["slug"] for t in topics]

    memories = [_topic_to_memory(t, a.color) for t in topics[:6]]
    dimensions = _classify_topics(topics)
    relationships = _parse_hub_relationships(folder, a.name)

    return {
        **a.to_dict(),
        "ingested": id not in role_ids,
        "one_line": one_line,
        "tags": expertise[:8],
        "mbti": mbti,
        "shape": shape,
        "tensions": tensions,
        "voice": voice,
        "ask_about": askabout,
        "goals": goals,
        "sample_line": sample_line,
        "memories": memories,
        "dimensions": dimensions,
        "relationships": relationships,
        "sections": sections,
        "topics": topics,
    }


class DevinCreateSessionIn(BaseModel):
    prompt: str = Field(min_length=1, description="Initial task prompt for Devin.")
    title: str | None = Field(default=None, description="Optional session title.")
    create_as_user_id: str | None = Field(default=None, description="Optional user impersonation id.")
    tags: list[str] | None = Field(default=None, description="Optional session tags.")


class DevinSendMessageIn(BaseModel):
    message: str = Field(min_length=1, description="Message to send to a running session.")
    message_as_user_id: str | None = Field(default=None, description="Optional user id to attribute the message.")


def _raise_devin(exc: Exception) -> None:
    if isinstance(exc, DevinConfigError):
        raise HTTPException(503, str(exc)) from exc
    if isinstance(exc, DevinClientError):
        detail = exc.detail
        if exc.payload is not None:
            detail = {"message": exc.detail, "upstream": exc.payload}
        raise HTTPException(exc.status_code, detail) from exc
    raise exc


@app.get("/api/devin/status")
def devin_status_route() -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "enabled": devin_enabled(),
        "orgConfigured": bool(os.environ.get("DEVIN_ORG_ID", "").strip()),
        "keyConfigured": bool(
            os.environ.get("DEVIN_SERVICE_API_KEY", "").strip()
        ),
    }


@app.get("/api/devin/sessions")
async def devin_sessions_route(first: int = 20, after: str | None = None) -> dict[str, Any]:
    try:
        return await devin_list_sessions(first=first, after=after)
    except Exception as exc:  # noqa: BLE001
        _raise_devin(exc)


@app.post("/api/devin/sessions")
async def devin_create_session_route(payload: DevinCreateSessionIn) -> dict[str, Any]:
    try:
        return await devin_create_session(
            prompt=payload.prompt,
            title=payload.title,
            create_as_user_id=payload.create_as_user_id,
            tags=payload.tags,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_devin(exc)


@app.get("/api/devin/sessions/{devin_id}")
async def devin_session_route(devin_id: str) -> dict[str, Any]:
    try:
        return await devin_get_session(devin_id)
    except Exception as exc:  # noqa: BLE001
        _raise_devin(exc)


@app.get("/api/devin/sessions/{devin_id}/messages")
async def devin_messages_route(devin_id: str, first: int = 100, after: str | None = None) -> dict[str, Any]:
    try:
        return await devin_list_messages(devin_id, first=first, after=after)
    except Exception as exc:  # noqa: BLE001
        _raise_devin(exc)


@app.post("/api/devin/sessions/{devin_id}/messages")
async def devin_send_message_route(devin_id: str, payload: DevinSendMessageIn) -> dict[str, Any]:
    try:
        return await devin_send_message(
            devin_id,
            message=payload.message,
            message_as_user_id=payload.message_as_user_id,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_devin(exc)


@app.get("/api/skills")
def skills_route(agentId: str | None = None) -> dict[str, Any]:
    if agentId:
        if not get_agent(agentId):
            raise HTTPException(404, "Unknown agent")
        return {
            "agentId": agentId,
            "skills": [s.model_dump(mode="json") for s in list_skills(agentId)],
            "montyEnabled": monty_enabled(),
        }
    return {
        "all": {k: [s.model_dump(mode="json") for s in v] for k, v in list_all_skills().items()},
        "montyEnabled": monty_enabled(),
    }


@app.get("/api/recordings")
def recordings_route() -> dict[str, list[str]]:
    if not RECORDINGS_DIR.exists():
        return {"recordings": []}
    files = sorted(
        (f.name for f in RECORDINGS_DIR.iterdir() if f.suffix == ".jsonl"),
        reverse=True,
    )
    return {"recordings": files}


@app.get("/api/recording/{name}")
def recording_route(name: str):
    if not name.endswith(".jsonl") or "/" in name or ".." in name:
        raise HTTPException(400, "Invalid recording name")
    p = RECORDINGS_DIR / name
    if not p.exists():
        raise HTTPException(404, "Recording not found")
    return Response(content=p.read_bytes(), media_type="application/x-ndjson")


@app.get("/api/evals/concreteness")
def concreteness_route(recording: str, agentA: str, agentB: str) -> dict[str, Any]:
    """Score how often each agent's turns referenced concrete specifics
    (real names, years, numbers, italicised titles) vs invented abstract
    metaphors. Returns one report per agent + an overall pass/fail."""
    if not recording.endswith(".jsonl") or "/" in recording or ".." in recording:
        raise HTTPException(400, "Invalid recording name")
    if not get_agent(agentA) or not get_agent(agentB):
        raise HTTPException(400, "Unknown agent")
    p = RECORDINGS_DIR / recording
    if not p.exists():
        raise HTTPException(404, "Recording not found")
    reports = score_recording(recording_path=p, agent_a=agentA, agent_b=agentB)
    avg = (
        sum(r.score for r in reports.values()) / len(reports)
        if reports else 0.0
    )
    return {
        "recording": recording,
        "concreteness_avg": round(avg, 2),
        "threshold": 0.6,
        "passed": avg >= 0.6,
        "reports": {
            agent_id: r.model_dump(mode="json") for agent_id, r in reports.items()
        },
    }


# ── Worlds-layer ingest (writes to public.agents) ─────────────────────


async def _resolve_home_world_id(user_id: str) -> str:
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select id from public.worlds where owner_user_id = $1 and slug = 'home'",
            user_id,
        )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="no home world — finish onboarding first",
        )
    return str(row["id"])


@app.post("/api/worlds/me/ingest/upload")
async def world_ingest_upload_route(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Auth-required sibling of /api/ingest/upload. Stamps the resulting
    job with the caller's home world id + user id so `run_ingest` writes
    the synthesised profile into public.agents instead of data/wikis/.

    Same response shape as the legacy endpoint so the frontend can
    reuse the existing IngestView state machine."""
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    world_id = await _resolve_home_world_id(user.id)
    safe_name = Path(file.filename).name
    target = UPLOADS_DIR / f"{int(asyncio.get_event_loop().time()*1000)}-{safe_name}"
    content = await file.read()
    target.write_bytes(content)
    job = register_ingest_upload(
        file_path=target,
        file_name=safe_name,
        owner_user_id=user.id,
        world_id=world_id,
    )
    return {
        "job_id": job.job_id,
        "file_name": job.file_name,
        "detected_format": job.detected_format,
        "detected_senders": job.detected_senders,
        "target_sender": job.target_sender,
        "self_sender": job.self_sender,
        "world_id": world_id,
    }


@app.post("/api/worlds/me/ingest/paste")
async def world_ingest_paste_route(
    payload: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Auth-required sibling of /api/ingest/paste."""
    text = str(payload.get("text") or "").strip()
    subject = str(payload.get("subject_name") or "").strip()
    source_label = str(payload.get("source_label") or "paste")
    if not text:
        raise HTTPException(400, "text is required")
    if not subject:
        raise HTTPException(400, "subject_name is required")
    if len(text) > 500_000:
        raise HTTPException(413, "text too large (max 500k chars)")
    world_id = await _resolve_home_world_id(user.id)
    job = register_ingest_paste(
        text=text,
        subject_name=subject,
        source_label=source_label,
        owner_user_id=user.id,
        world_id=world_id,
    )
    return {
        "job_id": job.job_id,
        "file_name": job.file_name,
        "detected_format": job.detected_format,
        "detected_senders": [subject],
        "target_sender": subject,
        "self_sender": "",
        "world_id": world_id,
    }


# ── Legacy filesystem ingest (writes to data/wikis/) ──────────────────
#
# Kept for the `/ask` flow that reads the canonical agents off disk. New
# flows should use the /api/worlds/me/ingest/* endpoints above.


@app.post("/api/ingest/paste")
async def ingest_paste_route(payload: dict[str, Any]) -> dict[str, Any]:
    """Register a pasted text block as an ingest job.

    Body: {"text": "...", "subject_name": "Zoe Qin", "source_label": "linkedin-bio"}
    """
    text = str(payload.get("text") or "").strip()
    subject = str(payload.get("subject_name") or "").strip()
    source_label = str(payload.get("source_label") or "paste")
    if not text:
        raise HTTPException(400, "text is required")
    if not subject:
        raise HTTPException(400, "subject_name is required")
    if len(text) > 500_000:
        raise HTTPException(413, "text too large (max 500k chars)")
    job = register_ingest_paste(text=text, subject_name=subject, source_label=source_label)
    return {
        "job_id": job.job_id,
        "file_name": job.file_name,
        "detected_format": job.detected_format,
        "detected_senders": [subject],
        "target_sender": subject,
        "self_sender": "",
    }


@app.post("/api/ingest/upload")
async def ingest_upload_route(file: UploadFile = File(...)) -> dict[str, Any]:
    """Receive a file (today: WhatsApp .zip), stash it under data/uploads,
    and return a job_id + the senders detected so the client can pick
    the target before starting the LLM pipeline."""
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    safe_name = Path(file.filename).name  # strip any path components
    target = UPLOADS_DIR / f"{int(asyncio.get_event_loop().time()*1000)}-{safe_name}"
    content = await file.read()
    target.write_bytes(content)
    job = register_ingest_upload(file_path=target, file_name=safe_name)
    return {
        "job_id": job.job_id,
        "file_name": job.file_name,
        "detected_format": job.detected_format,
        "detected_senders": job.detected_senders,
        "target_sender": job.target_sender,
        "self_sender": job.self_sender,
    }



# ── Inventory / pebbles / shops ────────────────────────────────────

from .inventory import (  # noqa: E402
    buy_from_shop,
    get_inventory,
    get_item_catalog,
    get_shop,
    get_wallet,
    transfer_pebbles,
    validate_agent_inventory,
    validate_world_inventories,
)
from .models import (  # noqa: E402
    AgentInventoryResponse,
    AgentShopResponse,
    AgentWalletResponse,
    BuyRequest,
    BuyResponse,
    ItemCatalogResponse,
    TransferPebblesRequest,
    TransferPebblesResponse,
    WorldInventoryValidationResponse,
)


@app.get("/api/items/catalog", response_model=ItemCatalogResponse)
async def items_catalog(user: CurrentUser = Depends(get_current_user)):
    items = await get_item_catalog()
    return ItemCatalogResponse(items=items)


@app.get("/api/agents/{agent_id}/inventory", response_model=AgentInventoryResponse)
async def agent_inventory(agent_id: str, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        agent = await conn.fetchrow(
            """select a.id, a.owner_user_id from public.agents a
               where a.id = $1
                 and (a.owner_user_id = $2 or public.are_friends(a.owner_user_id, $2))""",
            agent_id, user.id,
        )
    if not agent:
        raise HTTPException(404, "Agent not found or not accessible")
    wallet = await get_wallet(agent_id)
    slots = await get_inventory(agent_id)
    return AgentInventoryResponse(
        agent_id=agent_id,
        pebbles=wallet["pebbles"],
        slots=slots,
    )


@app.get("/api/agents/{agent_id}/shop", response_model=AgentShopResponse)
async def agent_shop(agent_id: str, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        agent = await conn.fetchrow(
            """select a.id, a.display_name, a.owner_user_id from public.agents a
               where a.id = $1
                 and (a.owner_user_id = $2 or public.are_friends(a.owner_user_id, $2))""",
            agent_id, user.id,
        )
    if not agent:
        raise HTTPException(404, "Agent not found or not accessible")
    listings = await get_shop(agent_id)
    return AgentShopResponse(
        agent_id=agent_id,
        agent_display_name=agent["display_name"],
        listings=listings,
    )


@app.post("/api/agents/{seller_agent_id}/shop/buy", response_model=BuyResponse)
async def shop_buy(
    seller_agent_id: str,
    body: BuyRequest,
    user: CurrentUser = Depends(get_current_user),
):
    result = await buy_from_shop(
        buyer_agent_id=body.buyer_agent_id,
        seller_agent_id=seller_agent_id,
        item_id=body.item_id,
        owner_user_id=user.id,
    )
    return BuyResponse(**result)


@app.post("/api/inventory/transfer-pebbles", response_model=TransferPebblesResponse)
async def inventory_transfer_pebbles(
    body: TransferPebblesRequest,
    user: CurrentUser = Depends(get_current_user),
):
    result = await transfer_pebbles(
        from_agent_id=body.from_agent_id,
        to_agent_id=body.to_agent_id,
        amount=body.amount,
        owner_user_id=user.id,
    )
    return TransferPebblesResponse(**result)


@app.get("/api/worlds/{world_id}/inventory/validate", response_model=WorldInventoryValidationResponse)
async def world_inventory_validate(
    world_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    async with acquire() as conn:
        world = await conn.fetchrow(
            "select id from public.worlds where id = $1 and owner_user_id = $2",
            world_id, user.id,
        )
    if not world:
        raise HTTPException(404, "World not found or not owned by you")
    result = await validate_world_inventories(world_id)
    return WorldInventoryValidationResponse(**result)



# ── WebSocket ──────────────────────────────────────────────────────────


@app.websocket("/")
async def ws_root(ws: WebSocket):
    await _handle_ws(ws)


async def _handle_ws(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if ALLOWED_ORIGINS and (not origin or origin not in ALLOWED_ORIGINS):
        await ws.close(code=4403)
        return

    # Optional auth via ?token= query string. Browsers can't set custom
    # WS headers; this is the standard pattern. If the token is present
    # but invalid we close. If absent, we accept anyway and only the
    # legacy un-authed envelopes work — chat.* requires `user` to be set.
    user: CurrentUser | None = user_from_query_token(
        ws.query_params.get("token") if hasattr(ws, "query_params") else None
    )

    await ws.accept()

    active_session_id: str | None = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            mtype = data.get("type")

            # ── New worlds-layer chat envelope ─────────────────────────
            if mtype in ("chat.start", "chat.user_msg"):
                if user is None:
                    await ws.send_text(json.dumps({
                        "type": "chat.error",
                        "message": "auth required — pass ?token=<jwt> on the WS URL",
                    }))
                    continue
                agent_id = str(data.get("agent_id") or "").strip()
                if not agent_id:
                    await ws.send_text(json.dumps({
                        "type": "chat.error", "message": "agent_id required",
                    }))
                    continue
                if mtype == "chat.start":
                    asyncio.create_task(
                        handle_chat_start(ws=ws, user=user, agent_id=agent_id)
                    )
                else:
                    body = str(data.get("body") or "")
                    asyncio.create_task(
                        handle_chat_user_msg(
                            ws=ws, user=user, agent_id=agent_id, body=body,
                        )
                    )
                continue

            if mtype == "start_conversation":
                agent_a = str(data.get("agentA") or "")
                agent_b = str(data.get("agentB") or "")
                session_id = "".join(
                    c for c in str(data.get("sessionId") or f"conv-{id(ws)}") if c.isalnum() or c in "-_"
                )[:64]
                max_turns = int(data.get("maxTurns") or 6)
                a_obj = get_agent(agent_a)
                b_obj = get_agent(agent_b)
                if not a_obj or not b_obj:
                    await ws.send_text(json.dumps({"type": "conversation_error", "message": "Unknown agent"}))
                    continue
                if agent_a == agent_b:
                    await ws.send_text(json.dumps({"type": "conversation_error", "message": "Pick two different agents"}))
                    continue
                if a_obj.world != b_obj.world:
                    # Cross-world conversations need an explicit MCP bridge —
                    # don't let the regular flow run them.
                    await ws.send_text(json.dumps({
                        "type": "conversation_error",
                        "message": (
                            f"agents are in different worlds "
                            f"({a_obj.world!r} vs {b_obj.world!r}); "
                            "cross-world calls go through the MCP bridge"
                        ),
                    }))
                    continue
                if not (4 <= max_turns <= 20):
                    await ws.send_text(json.dumps({"type": "conversation_error", "message": "maxTurns must be 4..20"}))
                    continue
                active_session_id = session_id
                print(
                    f"[ws] start_conversation {agent_a} ↔ {agent_b} "
                    f"({max_turns} turns) world={a_obj.world} session={session_id[:8]}"
                )
                # Spawn the loop as a task so the WS keeps reading messages
                asyncio.create_task(
                    run_conversation(
                        ws=ws, session_id=session_id,
                        agent_a=agent_a, agent_b=agent_b, max_turns=max_turns,
                    )
                )
                continue

            if mtype == "start_ingest":
                job_id = str(data.get("jobId") or data.get("job_id") or "").strip()
                job_obj = get_ingest_job(job_id) if job_id else None
                if not job_obj:
                    await ws.send_text(json.dumps({
                        "type": "ingest_error",
                        "message": f"unknown job_id {job_id!r}",
                    }))
                    continue
                # Worlds-layer jobs require the same caller that registered
                # them. Legacy filesystem jobs (no owner_user_id) accept any
                # caller — they're dev-only.
                if job_obj.owner_user_id is not None:
                    if user is None or user.id != job_obj.owner_user_id:
                        await ws.send_text(json.dumps({
                            "type": "ingest_error",
                            "message": "auth required to run this ingest",
                        }))
                        continue
                target = data.get("targetSender") or data.get("target_sender")
                self_s = data.get("selfSender") or data.get("self_sender")
                assign_slug = (data.get("assignToSlug") or data.get("assign_to_slug") or "").strip() or None
                assign_name = (data.get("assignToName") or data.get("assign_to_name") or "").strip() or None
                print(f"[ws] start_ingest job={job_id} target={target!r} assign={assign_slug!r} world={job_obj.world_id}")
                asyncio.create_task(run_ingest(
                    ws=ws,
                    job_id=job_id,
                    target_sender=target,
                    self_sender=self_s,
                    override_slug=assign_slug,
                    override_name=assign_name,
                ))
                continue

            if mtype == "start_chat":
                agent_id = str(data.get("agentId") or data.get("agent_id") or "").strip()
                history = data.get("history") or []
                message = str(data.get("message") or "")
                if not isinstance(history, list):
                    await ws.send_text(json.dumps({
                        "type": "chat_error",
                        "message": "history must be a list of {role, text}",
                    }))
                    continue
                print(f"[ws] start_chat agent={agent_id} hist={len(history)} msg={message[:60]!r}")
                asyncio.create_task(
                    run_chat(ws=ws, agent_id=agent_id, history=history, message=message)
                )
                continue

            # ── Worlds-layer consult ("Ask my world") ──────────────────
            if mtype == "start_world_consult":
                if user is None:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "auth required — pass ?token=<jwt> on the WS URL",
                    }))
                    continue
                question = str(data.get("question") or "").strip()
                if not question:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "Missing question",
                    }))
                    continue
                if len(question) > 1000:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "Question too long (max 1000 chars)",
                    }))
                    continue

                # Resolve home world + asker display_name in one round-trip.
                async with acquire() as conn:
                    home = await conn.fetchrow(
                        """
                        select w.id as world_id,
                               coalesce(p.display_name, '') as display_name
                        from public.worlds w
                        join public.profiles p on p.id = w.owner_user_id
                        where w.owner_user_id = $1 and w.slug = 'home'
                        """,
                        user.id,
                    )
                if home is None:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "no home world — finish onboarding first",
                    }))
                    continue

                raw_history = data.get("history") or []
                history: list[HistoryRound] = []
                if isinstance(raw_history, list):
                    for h in raw_history:
                        try:
                            history.append(HistoryRound.model_validate(h))
                        except Exception as exc:
                            print(f"[ws] world_consult history parse failed: {exc}")

                print(
                    f"[ws] start_world_consult user={user.id[:8]} "
                    f"world={str(home['world_id'])[:8]} q={question[:60]!r}"
                )
                asyncio.create_task(
                    run_world_consult(
                        ws=ws,
                        user=user,
                        world_id=str(home["world_id"]),
                        asker_display_name=home["display_name"] or "You",
                        question=question,
                        history=history or None,
                    )
                )
                continue

            if mtype == "start_consult":
                question = str(data.get("question") or "").strip()
                world = str(data.get("world") or "").strip() or "primary"
                if not question:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "Missing question",
                    }))
                    continue
                if len(question) > 1000:
                    await ws.send_text(json.dumps({
                        "type": "consult_error",
                        "message": "Question too long (max 1000 chars)",
                    }))
                    continue
                # Parse optional history for follow-up questions.
                raw_history = data.get("history") or []
                history: list[HistoryRound] = []
                if isinstance(raw_history, list):
                    for h in raw_history:
                        try:
                            history.append(HistoryRound.model_validate(h))
                        except Exception as exc:
                            print(f"[ws] history round parse failed: {exc}")
                print(f"[ws] start_consult: world={world} rounds={len(history)} q={question[:80]}")
                asyncio.create_task(
                    run_consult(ws=ws, question=question, world=world, history=history or None)
                )
                continue

            if mtype == "stop_conversation":
                session_id = str(data.get("sessionId") or "")
                ok = stop_conversation(session_id)
                await ws.send_text(json.dumps({
                    "type": "conversation_stopping" if ok else "conversation_error",
                    "message": "stopping" if ok else "no active conversation for session",
                }))
                continue

            # Unknown frame → silent (legacy connect/message types belong to
            # the old single-agent chat which isn't ported)
    except WebSocketDisconnect:
        pass
    finally:
        if active_session_id:
            print(f"[ws] closed session={active_session_id[:8]}")


# ── Co-founder matching (pixel/instinct) ────────────────────────────
@app.get("/api/world-groups/by-slug/{slug}/matches", response_model=MatchesResponse)
async def world_group_matches(
    slug: str,
    limit: int = 20,
    agent_id: str | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> MatchesResponse:
    """Ranked co-founder pairs for a group, best first.

    Stage 1 only: deterministic complementarity over `builder_profiles`
    (see app/matching.py). No LLM in this path, so it is O(1) in model
    calls regardless of group size. `agent_id` filters to pairs
    involving that twin — what the "your matches" panel uses.
    """
    # Retire the unsupported numerical scorer without leaking old private profiles.
    # Older clients get an honest empty result; new clients use /introductions.
    from .twin_memory.discovery import group_access
    async with acquire() as conn:
        async with conn.transaction():
            await group_access(conn, slug, user.id)
    return MatchesResponse(group_slug=slug, total_pairs=0, matches=[])



def main() -> None:
    """Entry point for `python -m app.main` style runs."""
    import uvicorn
    port = int(os.environ.get("PORT", "4000"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    main()
