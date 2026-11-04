"""1:1 chat with a single agent — streams the reply over WS.

The user picks one colleague on `/chat` and exchanges messages directly.
No router, no synth — just `pydantic-ai.Agent` with the colleague's
persona prompt and the running conversation history.

The agent has one tool: `send_gif(query)`. It hits Giphy, returns the
mp4 URL, and the bridge below also emits a `chat_gif` WS frame so the
frontend can drop the gif inline in the message thread.

WS frames:
    client → { type: "start_chat", agentId, history: [{role, text, gifUrl?}], message }
    server → { type: "chat_started", agentId }
    server → { type: "chat_token",  text }
    server → { type: "chat_gif",    url, query, caption }
    server → { type: "chat_done",   text }
    server → { type: "chat_error",  message }
"""

from __future__ import annotations

import json
import os
from contextvars import ContextVar
from typing import Any

import httpx
from fastapi import WebSocket
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from .agents import get_agent, get_system_prompt
from .conversation import _build_model
from .mubit_client import recall_for, reflect_session, remember_round

# The GIF tool needs to push a frame onto the active WS. We thread the
# WS through a contextvar so the tool body (which can't take extra
# args from the agent loop) can find it.
_active_ws: ContextVar[WebSocket | None] = ContextVar("_active_ws", default=None)


async def _giphy_search(query: str) -> str | None:
    """Resolve a Giphy search query to its top mp4 URL. Returns None
    if the key is missing or no results."""
    key = os.environ.get("GIPHY_API_KEY", "").strip()
    if not key or not query.strip():
        return None
    url = "https://api.giphy.com/v1/gifs/search"
    params = {"api_key": key, "q": query, "limit": 1, "rating": "pg-13"}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            data = r.json()
        first = (data.get("data") or [None])[0]
        if not first:
            return None
        images = first.get("images") or {}
        # Prefer mp4 (smaller, plays inline as <video>); fall back to gif.
        return (
            images.get("original_mp4", {}).get("mp4")
            or images.get("original", {}).get("mp4")
            or images.get("downsized_medium", {}).get("url")
            or images.get("original", {}).get("url")
        )
    except Exception:  # noqa: BLE001
        return None


def _build_chat_agent(agent_id: str, mubit_lessons: str = "") -> Agent[None, str]:
    a = get_agent(agent_id)
    persona = get_system_prompt(agent_id)
    name = a.name if a else agent_id
    role = a.role if a else "colleague"
    # Splice in any Mubit-recalled lessons just before the wiki content
    # so the model treats them as live persistent memory rather than
    # static persona text.
    memory_block = f"{mubit_lessons}\n\n" if mubit_lessons else ""
    agent: Agent[None, str] = Agent(
        _build_model(),
        output_type=str,
        system_prompt=(
            f"You are {name}, {role}. Stay strictly in character — voice,\n"
            "opinions, the things you'd actually say. The user is texting\n"
            "you directly, like a WhatsApp DM.\n\n"
            f"{memory_block}"
            f"# Your wiki\n{persona}\n\n"
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
            "- No 'as an AI' or 'I cannot help with that' boilerplate.\n\n"
            "# Tools\n"
            "- `send_gif(query, caption)` — drop a GIF reaction inline.\n"
            "  Use it sparingly, when a visual reaction beats words: a\n"
            "  shrug, an eye-roll, a celebration, a 'this you?'. Always\n"
            "  follow up with at least one sentence; never gif-only.\n"
            "  Skip it if you're not the kind of person who'd send GIFs.\n"
        ),
    )

    @agent.tool
    async def send_gif(
        ctx: RunContext[None],  # noqa: ARG001
        query: str,
        caption: str = "",
    ) -> str:
        """Search Giphy and emit a chat_gif WS frame so the frontend
        renders it inline. Returns a confirmation string the model can
        keep talking around (e.g. "[gif sent: shrug]")."""
        url = await _giphy_search(query)
        if not url:
            return "[gif lookup failed — keep chatting in text]"
        ws = _active_ws.get()
        if ws is not None:
            await ws.send_text(json.dumps({
                "type": "chat_gif",
                "url": url,
                "query": query,
                "caption": caption,
            }))
        return f"[gif sent: {query}]"

    return agent


def _history_to_messages(history: list[dict[str, Any]]) -> list[ModelMessage]:
    """Convert client history of {role, text} into pydantic-ai messages."""
    out: list[ModelMessage] = []
    for h in history:
        role = h.get("role")
        text = str(h.get("text") or "").strip()
        if not text:
            continue
        if role == "user":
            out.append(ModelRequest(parts=[UserPromptPart(content=text)]))
        elif role == "assistant":
            out.append(ModelResponse(parts=[TextPart(content=text)]))
    return out


async def run_chat(
    *,
    ws: WebSocket,
    agent_id: str,
    history: list[dict[str, Any]],
    message: str,
) -> None:
    if not get_agent(agent_id):
        await ws.send_text(json.dumps({
            "type": "chat_error",
            "message": f"unknown agent {agent_id!r}",
        }))
        return
    if not message.strip():
        await ws.send_text(json.dumps({
            "type": "chat_error",
            "message": "empty message",
        }))
        return

    await ws.send_text(json.dumps({"type": "chat_started", "agentId": agent_id}))

    # Pull persistent lessons from Mubit (no-op when MUBIT_ENABLED is
    # unset). Failures fall through silently — chat keeps working.
    mubit_lessons = recall_for(agent_id, message)
    if mubit_lessons:
        print(f"[chat] mubit recall hit for {agent_id!r}: "
              f"{len(mubit_lessons)} chars of context")

    agent = _build_chat_agent(agent_id, mubit_lessons=mubit_lessons)
    prior = _history_to_messages(history)

    # Make the WS available to send_gif via contextvar.
    token = _active_ws.set(ws)
    full = ""
    try:
        async with agent.run_stream(message, message_history=prior) as result:
            async for delta in result.stream_text(delta=True):
                full += delta
                await ws.send_text(json.dumps({
                    "type": "chat_token",
                    "text": delta,
                }))
    except Exception as exc:  # noqa: BLE001
        await ws.send_text(json.dumps({
            "type": "chat_error",
            "message": str(exc),
        }))
        return
    finally:
        _active_ws.reset(token)

    await ws.send_text(json.dumps({"type": "chat_done", "text": full}))

    # Store this round so the next chat with this agent can recall it.
    # Fire-and-forget — never blocks the user's experience.
    remember_round(agent_id, message, full)

    # Trigger Mubit's reflection pass so the round gets distilled into
    # typed lessons that recall() will surface in future chats. Silent
    # no-op when MUBIT_ENABLED is unset.
    reflect_session(agent_id)
