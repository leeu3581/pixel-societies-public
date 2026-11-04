"""ElevenLabs Conversational AI — agent + tool provisioning for the
voice onboarding interview.

Creates two client tools (advance_beat, save_twin_profile) and one
agent on first use, caches the IDs in memory. Set ELEVENLABS_AGENT_ID
in .env to skip re-creation across restarts.
"""
from __future__ import annotations

import json
import os

import httpx

API_BASE = "https://api.elevenlabs.io/v1"

# In-memory cache (survives for the lifetime of the process)
_cached_agent_id: str | None = None
_cached_tool_ids: list[str] | None = None


def _headers() -> dict[str, str]:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    return {"xi-api-key": key, "Content-Type": "application/json"}


INTERVIEW_PROMPT = """\
You are a Guide in Pixel Societies — a friendly pixel character who helps \
new users set up their digital twin. You are NOT the user's twin; you're \
the one building it for them. You're conducting a ~60 second voice \
interview to gather what you need.

Be casual, warm, slightly cheeky — like a friend at a bar, not a \
corporate form.

IMPORTANT: After you finish asking each beat's question and the user has \
answered, call advance_beat with the beat number you just completed \
BEFORE moving to the next question. This tracks progress in the UI.

BEAT 1 — Hook (5 seconds):
Greet the user. Say something like: "Hey! I'm your Pixel Societies \
guide. I'm going to learn enough about you in the next minute to build \
a digital twin that can go out and network on your behalf. Ready?"
Wait for their response. Then call advance_beat with beat 1.

BEAT 2 — Who are you (10 seconds):
Say: "Cool. What's your name, and what do you do? Like, if someone at \
a party asked you what you're working on right now, what would you say?"
Listen, acknowledge briefly. Then call advance_beat with beat 2.

BEAT 3 — What are you looking for (10 seconds):
Say: "Nice. So if your twin is out there meeting people for you tonight, \
who should it be looking for? What kind of person would make you say \
'I wish I'd met them sooner'?"
Listen, acknowledge briefly. Then call advance_beat with beat 3.

BEAT 4 — What makes you interesting (10 seconds):
Say: "What's something you've done or know about that most people in \
this room probably don't? Like, maybe you built something weird, lived \
somewhere unexpected, or have a niche obsession. The thing that makes \
conversations actually good."
Listen, acknowledge briefly. Then call advance_beat with beat 4.

BEAT 5 — Vibe check (10 seconds):
Say: "Last one. When you're at an event, are you more of a 'talk to \
three people deeply' person or a 'work the whole room' person?"
Listen, acknowledge briefly. Then call advance_beat with beat 5.

BEAT 6 — Close (5 seconds):
Say: "That's everything I need. Your twin is spinning up now — I've \
given it everything you told me. It'll be out there meeting people for \
you. Check back in a bit to see who it found."
Then call advance_beat with beat 6, and IMMEDIATELY call \
save_twin_profile with all gathered data.

RULES:
- You are the Guide, not the twin. Say "your twin" or "it" when \
  referring to the digital twin you're building.
- Keep your spoken responses SHORT between beats. 1-2 sentences max.
- If someone gives a one-word answer, probe ONCE then move on.
- ALWAYS call advance_beat after each beat completes.
- ALWAYS call save_twin_profile after beat 6."""


# ── Tool creation ────────────────────────────────────────────────────


TOOL_DEFS = [
    {
        "name": "advance_beat",
        "description": (
            "Call this after each interview beat completes (user has answered). "
            "Advances the progress indicator in the UI."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "beat": {
                    "type": "integer",
                    "description": "The beat number just completed (1-6)",
                },
            },
            "required": ["beat"],
        },
        "expects_response": False,
    },
    {
        "name": "save_twin_profile",
        "description": (
            "Save the extracted profile data after completing all interview "
            "beats. Call this after beat 6 with all gathered data."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "User's name as they stated it",
                },
                "role": {
                    "type": "string",
                    "description": "What they do — their role, job, or primary identity",
                },
                "current_work": {
                    "type": "string",
                    "description": "What they're working on right now",
                },
                "looking_for": {
                    "type": "string",
                    "description": "Who/what they want to meet",
                },
                "unique_knowledge": {
                    "type": "string",
                    "description": "Their unique skill, niche expertise, or conversation hook",
                },
                "social_style": {
                    "type": "string",
                    "description": "Their networking style — depth vs breadth",
                },
            },
            "required": [
                "name", "role", "current_work",
                "looking_for", "unique_knowledge", "social_style",
            ],
        },
        "expects_response": True,
    },
]


async def _create_tools() -> list[str]:
    """Create client tools via ElevenLabs API, return tool IDs."""
    tool_ids: list[str] = []
    async with httpx.AsyncClient(timeout=15) as client:
        for defn in TOOL_DEFS:
            body = {
                "tool_config": {
                    "type": "client",
                    **defn,
                },
            }
            resp = await client.post(
                f"{API_BASE}/convai/tools",
                headers=_headers(),
                json=body,
            )
            if resp.status_code not in (200, 201):
                print(f"[elevenlabs] tool create failed: {resp.status_code} {resp.text[:200]}")
                raise RuntimeError(f"ElevenLabs tool creation failed: {resp.text[:200]}")
            data = resp.json()
            tool_id = data.get("tool_id") or data.get("id")
            print(f"[elevenlabs] created tool {defn['name']} → {tool_id}")
            tool_ids.append(tool_id)
    return tool_ids


# ── Agent creation ───────────────────────────────────────────────────

# George — warm British storyteller
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")


async def _create_agent(tool_ids: list[str]) -> str:
    """Create the interview agent, return agent_id."""
    body = {
        "name": "Pixel Societies — Twin Interview Guide",
        "conversation_config": {
            "agent": {
                "first_message": (
                    "Hey! I'm your Pixel Societies guide. I'm going to learn enough "
                    "about you in the next minute to build a digital twin that can "
                    "go out and network on your behalf. Ready?"
                ),
                "language": "en",
                "prompt": {
                    "prompt": INTERVIEW_PROMPT,
                    "tool_ids": tool_ids,
                    "temperature": 0.7,
                    "max_tokens": 200,
                },
            },
            "tts": {
                "voice_id": VOICE_ID,
            },
            "turn": {
                "mode": "turn_based",
            },
        },
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            f"{API_BASE}/convai/agents/create",
            headers=_headers(),
            json=body,
        )
    if resp.status_code not in (200, 201):
        print(f"[elevenlabs] agent create failed: {resp.status_code} {resp.text[:300]}")
        raise RuntimeError(f"ElevenLabs agent creation failed: {resp.text[:200]}")
    data = resp.json()
    agent_id = data.get("agent_id") or data.get("id")
    print(f"[elevenlabs] created agent → {agent_id}")
    print(f"[elevenlabs] Save this to .env: ELEVENLABS_AGENT_ID={agent_id}")
    return agent_id


# ── Public API ───────────────────────────────────────────────────────


async def get_or_create_agent() -> str:
    """Return the agent_id, creating tools + agent on first call."""
    global _cached_agent_id, _cached_tool_ids

    # 1. Env var takes precedence (persists across restarts)
    env_id = os.environ.get("ELEVENLABS_AGENT_ID", "").strip()
    if env_id:
        _cached_agent_id = env_id
        return env_id

    # 2. In-memory cache
    if _cached_agent_id:
        return _cached_agent_id

    # 3. Create from scratch
    print("[elevenlabs] no ELEVENLABS_AGENT_ID set — creating agent...")
    _cached_tool_ids = await _create_tools()
    _cached_agent_id = await _create_agent(_cached_tool_ids)
    return _cached_agent_id


async def get_signed_url() -> str:
    """Get a short-lived signed URL for starting a conversation."""
    agent_id = await get_or_create_agent()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{API_BASE}/convai/conversation/get-signed-url",
            params={"agent_id": agent_id},
            headers=_headers(),
        )
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs signed URL failed: {resp.text[:200]}")
    data = resp.json()
    return data["signed_url"]
