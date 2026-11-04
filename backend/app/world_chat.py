"""1-1 chat with a single agent in the worlds layer.

Distinct from `app/chat.py`, which speaks to the legacy file-based
agents in `data/wikis/`. This module reads `agents.persona_md` from
Postgres so chat works for both canonical agents AND any per-user
custom agents (the personal twins in step 5).

Flow inside one WS connection:
    inbound  chat.start    {agent_id}
    outbound chat.history  {agent_id, messages: [{id, role, body, created_at}]}
    inbound  chat.user_msg {agent_id, body}
    outbound chat.agent_chunk {agent_id, delta}        (streamed)
    outbound chat.agent_done  {agent_id, message_id, full_text}
    outbound chat.rate_limited {agent_id, retry_after_seconds}  (when capped)
    outbound chat.error    {agent_id?, message}

Rate limit: 20 user messages per 60 minutes per (visitor_user_id,
agent_id), enforced ONLY when the visitor is not the agent's owner.
Owners are unlimited on their own agents — this is their lab.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict, deque
from typing import Any

import logfire
from fastapi import WebSocket
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from .auth import CurrentUser
from .conversation import _build_model
from .db import acquire
from .observability import (
    log_chat_agent_done,
    log_chat_rate_limited,
    log_chat_started,
    log_chat_user_msg,
)


# ── Rate limiter (in-memory, sliding window) ──────────────────────────


_RATE_LIMIT_WINDOW_S = 60 * 60  # 1 hour
_RATE_LIMIT_MAX = 20            # messages per window
# Keyed by (visitor_user_id, agent_id) → deque of timestamps.
_rate_buckets: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def _check_rate_limit(visitor_user_id: str, agent_id: str) -> int | None:
    """Returns None if the visitor may send another message, or the
    seconds-until-retry int if they're capped."""
    now = time.monotonic()
    bucket = _rate_buckets[(visitor_user_id, agent_id)]
    cutoff = now - _RATE_LIMIT_WINDOW_S
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) < _RATE_LIMIT_MAX:
        return None
    oldest = bucket[0]
    return int(_RATE_LIMIT_WINDOW_S - (now - oldest)) + 1


def _record_message(visitor_user_id: str, agent_id: str) -> None:
    _rate_buckets[(visitor_user_id, agent_id)].append(time.monotonic())


# ── Agent + history helpers ───────────────────────────────────────────


_HISTORY_LIMIT = 40  # last N messages of context


async def _load_agent_row(agent_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select id, owner_user_id, display_name, subtitle,
                   coalesce(persona_md, '') as persona_md
            from public.agents
            where id = $1
            """,
            agent_id,
        )
    if row is None:
        return None
    return {
        "id": str(row["id"]),
        "owner_user_id": str(row["owner_user_id"]),
        "display_name": row["display_name"],
        "subtitle": row["subtitle"],
        "persona_md": row["persona_md"],
    }


async def _load_history(agent_id: str, user_id: str) -> list[dict[str, Any]]:
    """Last N messages between this human and this agent, oldest first."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id, role, body, created_at
            from public.messages
            where agent_id = $1 and user_id = $2
            order by created_at desc
            limit $3
            """,
            agent_id,
            user_id,
            _HISTORY_LIMIT,
        )
    items = [
        {
            "id": int(r["id"]),
            "role": r["role"],
            "body": r["body"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]
    items.reverse()
    return items


async def _persist_message(
    *, agent_id: str, user_id: str, role: str, body: str
) -> int:
    async with acquire() as conn:
        row_id = await conn.fetchval(
            """
            insert into public.messages (agent_id, user_id, role, body)
            values ($1, $2, $3, $4)
            returning id
            """,
            agent_id,
            user_id,
            role,
            body,
        )
    return int(row_id)


def _build_agent(persona_md: str, display_name: str, subtitle: str | None) -> Agent[None, str]:
    role = subtitle or "colleague"
    # Copied verbatim from app/chat.py (the a social virtual world chat that the
    # user has confirmed keeps personas consistent). The key line is
    # the last bullet — `No 'as an AI' or 'I cannot help' boilerplate`.
    # That mention paradoxically gives the model a name for the pattern
    # it shouldn't reach for; without it Sonnet/Haiku both drift.
    system = (
        f"You are {display_name}, {role}. Stay strictly in character — voice,\n"
        "opinions, the things you'd actually say. The user is texting\n"
        "you directly, like a WhatsApp DM.\n\n"
        f"# Your wiki\n{persona_md}\n\n"
        "# How to talk like yourself\n"
        "- Match your wiki's voice signature exactly. If your sample\n"
        "  line has lowercase, abbreviations, em-dashes, or specific\n"
        "  tics — use them. If it's clipped and dry, be clipped and dry.\n"
        "- Use emoji where natural to YOUR voice. Some people sprinkle\n"
        "  them; some never do. Don't force it.\n"
        "- WhatsApp register: short messages, contractions, internet\n"
        "  slang where natural (ngl, tbh, lol, fr, omg, etc. — but\n"
        "  only if your wiki shows you'd use them).\n"
        "- Concise: 2–4 sentences unless they ask for depth. It's a\n"
        "  text thread, not a memo.\n"
        "- Reference your domain specifics (tools, projects, beliefs)\n"
        "  when relevant — that's why they came to you.\n"
        "- It's fine to ask one clarifying question if the ask is\n"
        "  underspecified. Otherwise just answer.\n"
        "- No 'as an AI' or 'I cannot help with that' boilerplate.\n"
    )
    return Agent(_build_model(), output_type=str, system_prompt=system)


def _history_to_pydantic(history: list[dict[str, Any]]) -> list[ModelMessage]:
    """Pack DB rows into pydantic-ai's ModelMessage format so the agent
    sees them as prior turns, not the current prompt."""
    out: list[ModelMessage] = []
    for h in history:
        body = (h.get("body") or "").strip()
        if not body:
            continue
        if h.get("role") == "user":
            out.append(ModelRequest(parts=[UserPromptPart(content=body)]))
        else:
            out.append(ModelResponse(parts=[TextPart(content=body)]))
    return out


# ── Per-WS chat session ───────────────────────────────────────────────


async def _send(ws: WebSocket, frame: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(frame))


async def handle_chat_start(
    *, ws: WebSocket, user: CurrentUser, agent_id: str
) -> None:
    """Validate the agent + access, send history. Open a Logfire span
    so subsequent user_msg events nest under it."""
    a = await _load_agent_row(agent_id)
    if a is None:
        await _send(ws, {"type": "chat.error", "agent_id": agent_id, "message": "no such agent"})
        return

    # Access check: own or accepted-friend.
    if a["owner_user_id"] != user.id:
        async with acquire() as conn:
            ok = await conn.fetchval(
                "select public.are_friends($1, $2)", a["owner_user_id"], user.id
            )
        if not ok:
            await _send(
                ws,
                {
                    "type": "chat.error",
                    "agent_id": agent_id,
                    "message": "not friends with the agent's owner",
                },
            )
            return

    mode = "own" if a["owner_user_id"] == user.id else "visit"
    log_chat_started(
        user_id=user.id, agent_id=agent_id, owner_user_id=a["owner_user_id"], mode=mode
    )

    history = await _load_history(agent_id, user.id)
    await _send(
        ws,
        {
            "type": "chat.history",
            "agent_id": agent_id,
            "agent_display_name": a["display_name"],
            "agent_subtitle": a["subtitle"],
            "mode": mode,
            "messages": history,
        },
    )


async def handle_chat_user_msg(
    *,
    ws: WebSocket,
    user: CurrentUser,
    agent_id: str,
    body: str,
) -> None:
    """Validate, persist user message, run pydantic-ai loop, stream
    deltas, persist agent reply. Wrapped in a logfire.span so the
    httpx + asyncpg sub-spans nest under one parent."""
    body = (body or "").strip()
    if not body:
        await _send(ws, {"type": "chat.error", "agent_id": agent_id, "message": "empty message"})
        return
    if len(body) > 4000:
        await _send(
            ws,
            {"type": "chat.error", "agent_id": agent_id, "message": "message too long (4000 chars max)"},
        )
        return

    a = await _load_agent_row(agent_id)
    if a is None:
        await _send(ws, {"type": "chat.error", "agent_id": agent_id, "message": "no such agent"})
        return

    is_owner = a["owner_user_id"] == user.id

    # Access check (re-checked per message; cheap).
    if not is_owner:
        async with acquire() as conn:
            ok = await conn.fetchval(
                "select public.are_friends($1, $2)", a["owner_user_id"], user.id
            )
        if not ok:
            await _send(
                ws,
                {
                    "type": "chat.error",
                    "agent_id": agent_id,
                    "message": "not friends with the agent's owner",
                },
            )
            return

    # Rate limit only when the visitor is not the owner.
    if not is_owner:
        retry = _check_rate_limit(user.id, agent_id)
        if retry is not None:
            log_chat_rate_limited(
                visitor_user_id=user.id,
                agent_id=agent_id,
                owner_user_id=a["owner_user_id"],
                in_window=_RATE_LIMIT_MAX,
                retry_after_seconds=retry,
            )
            await _send(
                ws,
                {
                    "type": "chat.rate_limited",
                    "agent_id": agent_id,
                    "retry_after_seconds": retry,
                },
            )
            return

    log_chat_user_msg(user_id=user.id, agent_id=agent_id, body=body)

    with logfire.span(
        "chat_turn",
        user_id=user.id,
        agent_id=agent_id,
        owner_user_id=a["owner_user_id"],
        mode="own" if is_owner else "visit",
    ):
        # Persist the user's turn first so it shows up in history if
        # the LLM call later fails.
        await _persist_message(agent_id=agent_id, user_id=user.id, role="user", body=body)
        if not is_owner:
            _record_message(user.id, agent_id)

        history = await _load_history(agent_id, user.id)
        # Drop the just-inserted user message off the prior context — it's
        # the prompt we're about to pass.
        prior = _history_to_pydantic(history[:-1])

        from .integrations.gmail_context import private_context_for_chat
        current_persona = await private_context_for_chat(agent_id, a["owner_user_id"], user.id, a["persona_md"])
        from .twin_memory.service import private_chat_context
        current_persona = await private_chat_context(a["owner_user_id"], user.id, current_persona)
        agent = _build_agent(current_persona, a["display_name"], a["subtitle"])

        full = ""
        started_at = time.monotonic()
        try:
            async with agent.run_stream(body, message_history=prior) as result:
                async for delta in result.stream_text(delta=True):
                    full += delta
                    await _send(
                        ws,
                        {"type": "chat.agent_chunk", "agent_id": agent_id, "delta": delta},
                    )
        except Exception as exc:  # noqa: BLE001
            await _send(
                ws,
                {"type": "chat.error", "agent_id": agent_id, "message": f"llm: {exc}"},
            )
            return

        message_id = await _persist_message(
            agent_id=agent_id, user_id=user.id, role="agent", body=full
        )
        duration_ms = int((time.monotonic() - started_at) * 1000)
        log_chat_agent_done(
            user_id=user.id,
            agent_id=agent_id,
            reply=full,
            duration_ms=duration_ms,
        )
        await _send(
            ws,
            {
                "type": "chat.agent_done",
                "agent_id": agent_id,
                "message_id": message_id,
                "full_text": full,
            },
        )


# Asyncio import only used implicitly; keep for future when we add
# server-pushed chunks beyond the streaming loop.
_ = asyncio
