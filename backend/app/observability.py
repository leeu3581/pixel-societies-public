"""Logfire wiring — one place for all observability config.

What this gives us in the Logfire dashboard:
- Every pydantic_ai.Agent call traced as a span (auto), including the
  prompt, the system prompt, tool calls, and token usage.
- Every FastAPI request traced (HTTP routes + WebSocket upgrades).
- Every httpx call to the Monty sidecar traced.
- Custom spans wrapping the conversation lifecycle (one span per
  conversation, nested spans per turn, nested per tool call) with custom
  attributes that make the "auditable self-improvement" story queryable
  — eval deltas, sandbox runtime, promotion events, knowledge score.

Set LOGFIRE_TOKEN in .env to ship to the cloud dashboard. Without a token
Logfire still runs (no-op send) so dev works fine.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

import logfire

_CONFIGURED = False


def configure() -> None:
    """Idempotent. Safe to call from app startup."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    token = os.environ.get("LOGFIRE_TOKEN")
    service_name = os.environ.get("LOGFIRE_SERVICE_NAME", "unicorn-intelligence-backend")
    environment = os.environ.get("LOGFIRE_ENVIRONMENT", "local")

    logfire.configure(
        token=token,  # None → console-only / local mode
        service_name=service_name,
        environment=environment,
        send_to_logfire="if-token-present",
        # Always show console output — gives us a live tail in dev whether
        # or not we have a cloud token. Filters out the noisiest auto-spans
        # but keeps everything info+ (custom logfire.info calls show up).
        console=logfire.ConsoleOptions(
            min_log_level="debug",
            # verbose=True so the console shows every span attribute in
            # the file log — chat bodies, persona inputs, agent replies,
            # the lot. Useful for auditing persona drift / disclosure
            # breaks during dev. Cloud dashboard always shows everything
            # regardless of this flag.
            verbose=True,
            include_tags=True,
            include_timestamps=True,
        ),
    )

    # Auto-instrument the libraries we actually use.
    try:
        logfire.instrument_pydantic_ai(include_content=False, include_binary_content=False)
    except Exception as e:  # noqa: BLE001
        print(f"[observability] pydantic_ai instrumentation failed: {e}")

    try:
        logfire.instrument_httpx()
    except Exception as e:  # noqa: BLE001
        print(f"[observability] httpx instrumentation failed: {e}")

    # asyncpg: gives us a span per query with SQL text, args, and duration.
    # Safe to skip if the OTel asyncpg wheel isn't present.
    try:
        logfire.instrument_asyncpg()
    except Exception as e:  # noqa: BLE001
        print(f"[observability] asyncpg instrumentation failed: {e}")

    print(
        f"[observability] logfire configured — service={service_name} env={environment} "
        f"cloud={'yes' if token else 'no (set LOGFIRE_TOKEN to ship)'}"
    )


def instrument_fastapi(app: Any) -> None:
    """Wrap a FastAPI app instance. Call after app construction."""
    try:
        logfire.instrument_fastapi(app, capture_headers=False, excluded_urls="/api/integrations/gmail.*,/api/me/memory.*,/api/ingest/claude-code.*,/api/.*introductions.*")
    except Exception as e:  # noqa: BLE001
        print(f"[observability] fastapi instrumentation failed: {e}")


# ── Custom spans for the conversation lifecycle ────────────────────────


@contextmanager
def conversation_span(
    *, session_id: str, agent_a: str, agent_b: str, max_turns: int
) -> Iterator[Any]:
    """One span per top-level conversation. Wrap with `with`."""
    with logfire.span(
        "conversation",
        session_id=session_id,
        agent_a=agent_a,
        agent_b=agent_b,
        max_turns=max_turns,
    ) as span:
        yield span


@contextmanager
def turn_span(*, turn_index: int, speaker: str, peer: str) -> Iterator[Any]:
    """One span per agent turn within a conversation."""
    with logfire.span(
        "turn",
        turn_index=turn_index,
        speaker=speaker,
        peer=peer,
    ) as span:
        yield span


def log_skill_promoted(*, agent_id: str, slug: str, runs_count: int) -> None:
    """A discrete event — a skill flipped speculative → trusted."""
    logfire.info(
        "skill_promoted",
        agent_id=agent_id,
        slug=slug,
        runs_count=runs_count,
        from_tier="speculative",
        to_tier="trusted",
    )


def log_skill_run(
    *, agent_id: str, slug: str, ok: bool, ms: int, case: str, error: str | None = None
) -> None:
    logfire.info(
        "skill_run",
        agent_id=agent_id,
        slug=slug,
        ok=ok,
        ms=ms,
        case=case,
        error=error,
    )


def log_skill_called(
    *, caller: str, owner: str, slug: str, ok: bool, ms: int
) -> None:
    logfire.info(
        "skill_called",
        caller_agent_id=caller,
        owner_agent_id=owner,
        slug=slug,
        ok=ok,
        ms=ms,
    )


def log_wiki_change(
    *, agent_id: str, slug: str, action: str, quoted_from_peer: str | None
) -> None:
    logfire.info(
        "wiki_change",
        agent_id=agent_id,
        slug=slug,
        action=action,
        has_quote=bool(quoted_from_peer),
    )


def log_conversation_done(
    *,
    session_id: str,
    reason: str,
    knowledge_score: int,
    turns_used: int,
) -> None:
    logfire.info(
        "conversation_done",
        session_id=session_id,
        reason=reason,
        knowledge_score=knowledge_score,
        turns_used=turns_used,
    )


# ── Worlds / agents / auth — events emitted by the new layer ───────────


def log_db_pool_ready(*, dsn_host: str, max_size: int) -> None:
    """Pool initialised. Useful breadcrumb at startup."""
    logfire.info("db_pool_ready", dsn_host=dsn_host, max_size=max_size)


def log_auth_failed(*, reason: str, has_token: bool) -> None:
    """JWT decode rejected. Helps diagnose 401s during integration."""
    logfire.warn("auth_failed", reason=reason, has_token=has_token)


def log_auth_ok(*, user_id: str, role: str) -> None:
    """JWT verified — user identified."""
    logfire.info("auth_ok", user_id=user_id, role=role)


def log_user_signup_seeded(*, user_id: str, world_id: str, agents_count: int) -> None:
    """Trigger fired and seeded a new user's world. Verified end-to-end."""
    logfire.info(
        "user_signup_seeded",
        user_id=user_id,
        world_id=world_id,
        agents_count=agents_count,
    )


def log_canonical_seed(*, count: int, source_dir: str) -> None:
    """Seeder ran. Useful for diffing what's in the wikis vs the DB."""
    logfire.info("canonical_seed", count=count, source_dir=source_dir)


def log_sprite_request(
    *, user_id: str, agent_id: str | None, photo_bytes: int, mode: str
) -> None:
    """A sprite generation request landed. mode='stub' until step 5 wires Gemini."""
    logfire.info(
        "sprite_request",
        user_id=user_id,
        agent_id=agent_id,
        photo_bytes=photo_bytes,
        mode=mode,
    )


def log_world_loaded(
    *,
    user_id: str,
    world_id: str,
    owner_user_id: str,
    mode: str,
    agent_count: int,
) -> None:
    """Caller successfully loaded a world's agents. mode='own' or 'visit'.
    Useful for spotting who's looking at whose worlds in the trace."""
    logfire.info(
        "world_loaded",
        user_id=user_id,
        world_id=world_id,
        owner_user_id=owner_user_id,
        mode=mode,
        agent_count=agent_count,
    )


def log_world_visit_blocked(
    *, user_id: str, owner_user_id: str, world_id: str | None, reason: str
) -> None:
    """A visit was rejected — friendship missing, world missing, etc.
    Helps diagnose 403/404 patterns when a friend can't open a world."""
    logfire.warn(
        "world_visit_blocked",
        user_id=user_id,
        owner_user_id=owner_user_id,
        world_id=world_id,
        reason=reason,
    )


def log_sprite_gemini_call(
    *, user_id: str, agent_id: str, photo_bytes: int
) -> None:
    """Background task is about to hit the Gemini image API."""
    logfire.info(
        "sprite_gemini_call",
        user_id=user_id,
        agent_id=agent_id,
        photo_bytes=photo_bytes,
    )


def log_sprite_done(
    *,
    user_id: str,
    agent_id: str,
    storage_url: str,
    source: str,
    duration_ms: int,
) -> None:
    """Sprite written to storage and DB updated. source is normally 'gemini'."""
    logfire.info(
        "sprite_done",
        user_id=user_id,
        agent_id=agent_id,
        storage_url=storage_url,
        source=source,
        duration_ms=duration_ms,
    )


def log_sprite_failed(
    *, user_id: str, agent_id: str, stage: str, error: str
) -> None:
    """Sprite generation failed at a particular stage."""
    logfire.warn(
        "sprite_failed",
        user_id=user_id,
        agent_id=agent_id,
        stage=stage,
        error=error,
    )


def log_friend_requested(
    *, requester_id: str, addressee_id: str, friendship_id: str
) -> None:
    logfire.info(
        "friend_requested",
        requester_id=requester_id,
        addressee_id=addressee_id,
        friendship_id=friendship_id,
    )


def log_friend_accepted(
    *, requester_id: str, addressee_id: str, friendship_id: str
) -> None:
    logfire.info(
        "friend_accepted",
        requester_id=requester_id,
        addressee_id=addressee_id,
        friendship_id=friendship_id,
    )


def log_friend_removed(
    *, actor_id: str, other_id: str, friendship_id: str, status_was: str
) -> None:
    """Either a request cancellation (status='pending') or a friend
    removal (status='accepted'). status_was disambiguates."""
    logfire.info(
        "friend_removed",
        actor_id=actor_id,
        other_id=other_id,
        friendship_id=friendship_id,
        status_was=status_was,
    )


def log_chat_started(
    *, user_id: str, agent_id: str, owner_user_id: str, mode: str
) -> None:
    """A chat session opened. mode = 'own' (you chatting with your own
    agent) or 'visit' (you chatting with a friend's agent)."""
    logfire.info(
        "chat_started",
        user_id=user_id,
        agent_id=agent_id,
        owner_user_id=owner_user_id,
        mode=mode,
    )


def log_chat_user_msg(
    *, user_id: str, agent_id: str, body: str
) -> None:
    """User pressed send. We log the full body in dev so the trace shows
    the actual conversation. For prod, drop body and keep body_chars."""
    logfire.info(
        "chat_user_msg",
        user_id=user_id,
        agent_id=agent_id,
        body=body,
        body_chars=len(body),
    )


def log_chat_agent_done(
    *,
    user_id: str,
    agent_id: str,
    reply: str,
    duration_ms: int,
) -> None:
    """Agent finished streaming a reply. Full reply text logged in dev so
    you can audit persona drift / disclosure breaks. Token usage from
    pydantic-ai's auto-instrumentation is on the parent Agent.run span."""
    logfire.info(
        "chat_agent_done",
        user_id=user_id,
        agent_id=agent_id,
        reply=reply,
        reply_chars=len(reply),
        duration_ms=duration_ms,
    )


def log_chat_rate_limited(
    *,
    visitor_user_id: str,
    agent_id: str,
    owner_user_id: str,
    in_window: int,
    retry_after_seconds: int,
) -> None:
    """A visitor hit the per-(visitor, agent) sliding-window cap. Owner
    is excluded from the limit; this only fires for non-owner traffic."""
    logfire.warn(
        "chat_rate_limited",
        visitor_user_id=visitor_user_id,
        agent_id=agent_id,
        owner_user_id=owner_user_id,
        in_window=in_window,
        retry_after_seconds=retry_after_seconds,
    )
