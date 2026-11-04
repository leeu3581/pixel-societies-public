"""Mubit memory layer — opt-in, fail-soft.

Set `MUBIT_ENABLED=1` in env to turn this on. With the flag off (default),
every helper here is a no-op that returns "" / None and the rest of the
app behaves exactly as before. With the flag on, every Mubit call is
wrapped in try/except so a Mubit outage never breaks chat / consult.

Two helpers used by chat.py / consult.py:

    recall_for(agent_id, query) -> str
        Returns a markdown block of recalled lessons that gets glued
        onto the persona prompt before the LLM runs. Empty string when
        nothing relevant or Mubit is unavailable.

    remember_round(agent_id, user_msg, agent_reply, *, session_id=None)
        Stores the round so the next call can recall it. Fire-and-forget.

Session policy: we use a stable session_id per agent (`chat::<agent_id>`)
so all chat threads with one colleague share their memory pool. The
LessonCache + retrieval is scoped to (project, session, agent) anyway —
a stable session per agent gives a simple "this colleague remembers
what we've talked about" model without needing to thread session_ids
through every WS frame.
"""

from __future__ import annotations

import os
from typing import Optional

ENABLED = bool(os.environ.get("MUBIT_ENABLED", "").strip())

_client = None  # lazily created so import-time failures don't kill the server


def _get_client():
    global _client
    if _client is not None:
        return _client
    try:
        from mubit import Client
        _client = Client()
    except Exception as exc:  # noqa: BLE001
        print(f"[mubit] client init failed: {exc}")
        _client = False  # sentinel — don't retry every call
    return _client


def _session_for(agent_id: str) -> str:
    return f"chat::{agent_id}"


def recall_for(agent_id: str, query: str, *, top_k: int = 3) -> str:
    """Pull relevant past lessons for this agent + query as a markdown
    block ready to splice into the system prompt. Returns "" on
    anything-goes-wrong (disabled, no client, no hits, error)."""
    if not ENABLED or not query.strip():
        return ""
    client = _get_client()
    if not client:
        return ""
    try:
        result = client.recall(
            session_id=_session_for(agent_id),
            agent_id=agent_id,
            query=query,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[mubit] recall failed for {agent_id!r}: {exc}")
        return ""

    evidence = (result or {}).get("evidence") or []
    if not evidence:
        return ""
    final = (result or {}).get("final_answer", "").strip()

    lines = ["# What you remember from past chats", ""]
    if final:
        lines.append(f"**Synthesis:** {final}")
        lines.append("")
    lines.append("**Source memories:**")
    for ev in evidence[:top_k]:
        content = (ev.get("content") or "").strip()
        if content:
            lines.append(f"- {content}")
    return "\n".join(lines).strip()


def remember_round(
    agent_id: str,
    user_msg: str,
    agent_reply: str,
    *,
    session_id: Optional[str] = None,
    intent: str = "conversation",
) -> None:
    """Persist one chat round so future recall() calls can surface it.
    Fire-and-forget — never raises. Pass an explicit session_id when
    you want to bucket memories per-thread (default is per-agent)."""
    if not ENABLED or not (user_msg.strip() or agent_reply.strip()):
        return
    client = _get_client()
    if not client:
        return
    content = f"User asked: {user_msg.strip()}\nI replied: {agent_reply.strip()}"
    try:
        client.remember(
            session_id=session_id or _session_for(agent_id),
            agent_id=agent_id,
            content=content,
            intent=intent,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[mubit] remember failed for {agent_id!r}: {exc}")


# ── Reflection ────────────────────────────────────────────────────
# After a remember_round, ask Mubit to re-read the recent traces in
# this session and distill them into typed `lesson` entries that
# recall() will surface in future rounds. Fire-and-forget — we eat
# any error so chat is never blocked on reflection.


def reflect_session(agent_id: str, *, session_id: Optional[str] = None) -> None:
    """Trigger Mubit's lesson-extraction pass over the recent activity
    in this agent's session. Empty + silent on disable / error."""
    if not ENABLED:
        return
    client = _get_client()
    if not client:
        return
    sid = session_id or _session_for(agent_id)
    try:
        client.reflect(session_id=sid)
    except Exception as exc:  # noqa: BLE001
        print(f"[mubit] reflect failed for {agent_id!r}: {exc}")
