"""Live agent ↔ agent conversations — the "Society" layer.

A leaner cousin of `conversation.py`:
- DB-backed (reads `public.agents`, writes `public.agent_conversations`
  and `public.agent_conversation_messages` — schema in migration 0017).
- No wiki/skill machinery. Just turn-by-turn back-and-forth.
- Each turn is its own LLM call that sees the partner's previous message
  via pydantic-ai message_history. NOT a pre-baked transcript — the key
  fix for the Ai-Engine flaw where agents weren't really responding.
- One row per turn so Realtime subscribers see lines arrive live.

For v1, conversations are sparked manually via
POST /api/worlds/{id}/society/spark. An autonomous loop is a follow-up;
we want cost confidence first (matches the engine_loop pattern).
"""
from __future__ import annotations

import asyncio
import os
import random
from typing import Any

import logfire
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from .conversation import _build_model
from .db import acquire


# Cache the resolved LLM model object. `_build_model()` instantiates a
# GoogleModel/AnthropicModel + provider + HTTP client every time —
# spawning a fresh one per tick was a memory hot-spot on the 512 MB
# free tier. The model is stateless w.r.t. requests, so a single
# instance can back every Agent.
_CACHED_MODEL: object | None = None


def _shared_model() -> object:
    global _CACHED_MODEL
    if _CACHED_MODEL is None:
        _CACHED_MODEL = _build_model()
    return _CACHED_MODEL


DEFAULT_MAX_TURNS = 10
PAIR_COOLDOWN_MINUTES = 30
# Pixel Square / group-room overcrowding cap. The square pools every
# accepted member's agents (the member's own included) and renders them
# on the canvas — unbounded, that's an unnavigable crowd, especially on
# mobile. Cap the WHOLE square to this many agents total, chosen stably
# (md5-of-id ordering) so the same ones show every load and the
# conversation engine draws from that same set. Total cap, NOT
# per-member. Tune via env.
MAX_SQUARE_AGENTS = int(os.environ.get("MAX_SQUARE_AGENTS", "5"))
# The cap exists only to tame the giant PUBLIC pixel-square (slug below).
# Curated/joined rooms (e.g. event demo worlds) are intentionally
# populated and must show everyone, so they get an effectively-unbounded
# cap. Keep this slug in sync with the seeded public square.
PIXEL_SQUARE_SLUG = "pixel-square"
_UNCAPPED = 1_000_000


async def _square_cap_for_group(world_group_id: str) -> int:
    """How many agents this group may surface. Only the public
    pixel-square is capped; every other group is effectively uncapped."""
    async with acquire() as conn:
        slug = await conn.fetchval(
            "select slug from public.world_groups where id = $1",
            world_group_id,
        )
    return MAX_SQUARE_AGENTS if slug == PIXEL_SQUARE_SLUG else _UNCAPPED
# When SOCIETY_AUTO=1, only spark in worlds whose owner has been seen
# in the last N hours. Stops the loop from burning credits on dead test
# accounts. 24h is generous; tune via env.
SOCIETY_OWNER_ACTIVE_HOURS = int(
    os.environ.get("SOCIETY_OWNER_ACTIVE_HOURS", "24")
)
# Output cap. With Gemini 2.5 thinking models, the budget includes
# reasoning tokens too — 110 left only ~5 visible tokens after thinking.
# 250 with thinking explicitly disabled (see _turn_settings) gives a
# punchy line without paying for hidden CoT.
TURN_MAX_TOKENS = 250
INTER_TURN_DELAY_S = 0.4

# ── Auto-Spark loop ─────────────────────────────────────────────────
#
# Two modes, both controlled by env:
#   SOCIETY_AUTO=1  → "constant chatter" mode. Bypasses the
#                     engine_enabled and idle gates and sparks every
#                     world with ≥2 agents on a tight cadence.
#                     Enable explicitly — you're saying "burn LLM
#                     credits to keep the world alive."
#   (unset or =0)  → strict mode. Same gates as the world engine
#                     (engine_enabled + last_seen_at within
#                     engine_idle_hours). Quiet by default.
#   DISABLE_SOCIETY_LOOP=1 → kill switch, no loop at all.
SOCIETY_AUTO = os.environ.get("SOCIETY_AUTO", "") == "1"

# Hard cap on concurrent autonomous LLM calls. Free-tier Render has
# 512 MB RAM; before this cap the sweep spawned a task per eligible
# world/group and we OOM'd. 2 in flight on free tier — paired with the
# cached model singleton — keeps memory well-behaved.
SOCIETY_CONCURRENCY = int(os.environ.get("SOCIETY_CONCURRENCY", "2"))
_society_sem: asyncio.Semaphore | None = None


def _get_society_sem() -> asyncio.Semaphore:
    """Lazy-init so the semaphore is bound to the running event loop."""
    global _society_sem
    if _society_sem is None:
        _society_sem = asyncio.Semaphore(SOCIETY_CONCURRENCY)
    return _society_sem
# Home-world cadence: deliberately slow now that group worlds carry the
# bulk of activity. Default 10 min so a home world feels alive without
# being a firehose.
SOCIETY_HOME_SPARK_INTERVAL_SECONDS = int(
    os.environ.get("SOCIETY_HOME_SPARK_INTERVAL_SECONDS", "600")
)
# Group-world pairwise DM cadence (private agent↔agent). Slower than
# room chatter; these are "side conversations" the user can browse.
SOCIETY_GROUP_SPARK_INTERVAL_SECONDS = int(
    os.environ.get("SOCIETY_GROUP_SPARK_INTERVAL_SECONDS", "60")
)
# Group-world ROOM cadence (public stream). Fast — should feel like a
# constant chatter on the canvas. 6s gives a Twitch-chat tempo without
# rate-limiting Gemini.
SOCIETY_GROUP_ROOM_INTERVAL_SECONDS = int(
    os.environ.get("SOCIETY_GROUP_ROOM_INTERVAL_SECONDS", "6")
)
# Recent room-message context fed to each tick. Keep modest so the
# prompt stays cheap and the model isn't tempted to summarise.
ROOM_CONTEXT_LIMIT = int(os.environ.get("ROOM_CONTEXT_LIMIT", "12"))
ROOM_TURN_MAX_TOKENS = int(os.environ.get("ROOM_TURN_MAX_TOKENS", "120"))
# Backward-compat alias (legacy env). Treated as home cadence.
SOCIETY_SPARK_INTERVAL_SECONDS = SOCIETY_HOME_SPARK_INTERVAL_SECONDS
SOCIETY_SWEEP_INTERVAL_SECONDS = int(
    os.environ.get("SOCIETY_SWEEP_INTERVAL_SECONDS", "10")
)


# ── Variable-length conversation ────────────────────────────────────
#
# Each turn returns a TurnOutput with text + wrap_up. When wrap_up is
# true the speaker is signalling "we're done — natural ending." The
# loop then stops. This is the "agents continue if interesting, end
# if not" behaviour.
class TurnOutput(BaseModel):
    text: str = Field(description="Your spoken line. 1–2 sentences. ~25 words max.")
    wrap_up: bool = Field(
        default=False,
        description=(
            "Set true when the conversation has run its natural course — "
            "you've made your point, there's no fresh angle to push, or "
            "you'd be repeating yourself. Otherwise leave false to continue."
        ),
    )


async def _load_agent(agent_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            select id, world_id, display_name, subtitle,
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
        "world_id": str(row["world_id"]),
        "display_name": row["display_name"],
        "subtitle": row["subtitle"],
        "persona_md": row["persona_md"],
    }


async def _pick_pair(
    *,
    world_id: str | None = None,
    world_group_id: str | None = None,
) -> tuple[str, str] | None:
    """Pick two agents that haven't been paired in this same space
    within the last PAIR_COOLDOWN_MINUTES. Cooldown is *space-scoped*:
    a pair that talked in /world doesn't block them from a group, and
    vice versa. Otherwise hot home worlds would starve groups of
    eligible pairs.

    For a home world we draw from agents in that world; for a group,
    we draw from agents owned by any accepted member.
    Returns (a, b) ordered so a < b (matches schema check)."""
    if world_id is None and world_group_id is None:
        return None
    async with acquire() as conn:
        if world_group_id is not None:
            cap = await _square_cap_for_group(world_group_id)
            rows = await conn.fetch(
                """
                select id from (
                  select a.id,
                         row_number() over (order by md5(a.id::text)) as rn
                    from public.agents a
                    join public.world_groups g on g.id = $1
                   -- Curated (roster_owner_only) rooms only ever feature
                   -- the creator's agents; others pool accepted members.
                   where (
                     (g.roster_owner_only and a.owner_user_id = g.created_by)
                     or (not g.roster_owner_only and a.owner_user_id in (
                       select user_id from public.world_group_members
                        where group_id = $1 and status = 'accepted'
                     ))
                   )
                ) ranked
                 where rn <= $2
                """,
                world_group_id, cap,
            )
        else:
            rows = await conn.fetch(
                "select id from public.agents where world_id = $1",
                world_id,
            )
    agent_ids = [str(r["id"]) for r in rows]
    if len(agent_ids) < 2:
        return None
    random.shuffle(agent_ids)
    async with acquire() as conn:
        for i in range(len(agent_ids)):
            for j in range(i + 1, len(agent_ids)):
                a, b = agent_ids[i], agent_ids[j]
                lo, hi = (a, b) if a < b else (b, a)
                if world_group_id is not None:
                    recently_paired = await conn.fetchval(
                        """
                        select 1 from public.agent_conversations
                        where agent_a_id = $1 and agent_b_id = $2
                          and world_group_id = $3
                          and started_at
                              > now() - make_interval(mins => $4)
                        limit 1
                        """,
                        lo, hi, world_group_id, PAIR_COOLDOWN_MINUTES,
                    )
                else:
                    recently_paired = await conn.fetchval(
                        """
                        select 1 from public.agent_conversations
                        where agent_a_id = $1 and agent_b_id = $2
                          and world_id = $3
                          and started_at
                              > now() - make_interval(mins => $4)
                        limit 1
                        """,
                        lo, hi, world_id, PAIR_COOLDOWN_MINUTES,
                    )
                if not recently_paired:
                    return lo, hi
    return None


def _system_prompt(self_a: dict[str, Any], peer: dict[str, Any], room: str | None) -> str:
    setting = (
        f"You just bumped into {peer['display_name']} in {room}."
        if room
        else f"You just bumped into {peer['display_name']}."
    )
    peer_blurb = peer.get("subtitle") or "another agent in this world"
    return (
        f"You are {self_a['display_name']}.\n\n"
        f"{(self_a['persona_md'] or '').strip()}\n\n"
        f"---\n\n"
        f"You just bumped into {peer['display_name']} ({peer_blurb}).\n"
        f"{setting}\n\n"
        f"# HARD RULES — read these. Violating them ruins the demo.\n\n"
        f"**FORMAT — this is a chat message, not a document:**\n"
        f"- 1 sentence per turn. 2 max. ~20 words.\n"
        f"- PLAIN TEXT ONLY. No markdown. No `#` headers. No `**bold**`.\n"
        f"  No bullet points. No numbered lists. No `---` dividers.\n"
        f"- Write like a WhatsApp message, not an essay.\n\n"
        f"**VOICE:**\n"
        f"- Stay in your own voice. Do NOT mirror their phrasing.\n"
        f"- Reference something specific — a project, a name, a real thing.\n"
        f"  No abstract sermons.\n"
        f"- React to what they actually just said. Don't deliver a speech.\n\n"
        f"If your draft has any of: `#`, `*`, `-` at line start, or more than\n"
        f"two sentences, REWRITE it shorter and plainer before answering.\n\n"
        f"# WHEN TO WRAP UP\n"
        f"Set wrap_up=true when:\n"
        f"- You'd be repeating yourself or your partner.\n"
        f"- The exchange has reached a natural stopping point (mutual\n"
        f"  acknowledgement, joke landed, topic exhausted).\n"
        f"- You don't have a fresh angle to push.\n"
        f"Otherwise leave wrap_up=false — keep going if there's still\n"
        f"juice in the topic. Long conversations are fine; forced\n"
        f"endings are not.\n"
    )


def _history_from_self_pov(
    self_id: str, transcript: list[dict[str, Any]]
) -> list[ModelMessage]:
    """Own past turns → assistant; peer's → user."""
    history: list[ModelMessage] = []
    for t in transcript:
        if str(t["agent_id"]) == self_id:
            history.append(ModelResponse(parts=[TextPart(content=t["body"])]))
        else:
            history.append(ModelRequest(parts=[UserPromptPart(content=t["body"])]))
    return history


def _turn_settings() -> dict[str, Any]:
    """Per-turn model settings. When using Gemini we also disable
    thinking — those reasoning tokens count against max_tokens and at
    our small output budget would eat the whole reply."""
    settings: dict[str, Any] = {"max_tokens": TURN_MAX_TOKENS}
    if os.environ.get("LLM_PROVIDER", "").strip().lower() in ("gemini", "google"):
        try:
            from google.genai.types import ThinkingConfig

            settings["google_thinking_config"] = ThinkingConfig(thinking_budget=0)
        except ImportError:
            pass
    return settings


async def _run_one_turn(
    self_a: dict[str, Any],
    peer: dict[str, Any],
    transcript: list[dict[str, Any]],
    room: str | None,
) -> TurnOutput:
    turn_agent: Agent[None, TurnOutput] = Agent(
        _shared_model(),
        output_type=TurnOutput,
        system_prompt=_system_prompt(self_a, peer, room),
        model_settings=_turn_settings(),
    )
    if transcript and str(transcript[-1]["agent_id"]) != self_a["id"]:
        prompt = transcript[-1]["body"]
        history = _history_from_self_pov(self_a["id"], transcript[:-1])
    else:
        prompt = "(Open with a short, in-character line — a question or observation.)"
        history = _history_from_self_pov(self_a["id"], transcript)
    async with _get_society_sem():
        result = await turn_agent.run(prompt, message_history=history)
    out = result.output
    out.text = (out.text or "").strip()
    return out


async def run_conversation(
    world_id: str | None,
    agent_a_id: str,
    agent_b_id: str,
    *,
    world_group_id: str | None = None,
    room: str | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> str | None:
    """Run a full conversation between two agents. Returns the
    conversation_id, or None if setup fails. Each turn is persisted
    immediately so Realtime subscribers see lines drip in.

    Pass either `world_id` (home-world chat — agents must live in that
    world) or `world_group_id` (group chat — agents need only be owned
    by an accepted member of the group). Schema enforces XOR."""
    if agent_a_id == agent_b_id:
        return None
    if (world_id is None) == (world_group_id is None):
        return None  # need exactly one of {world_id, world_group_id}

    a_id, b_id = (
        (agent_a_id, agent_b_id) if agent_a_id < agent_b_id else (agent_b_id, agent_a_id)
    )

    agent_a = await _load_agent(a_id)
    agent_b = await _load_agent(b_id)
    if not agent_a or not agent_b:
        return None

    if world_id is not None:
        if agent_a["world_id"] != world_id or agent_b["world_id"] != world_id:
            return None
    else:
        # Group mode: every distinct owner of these agents must be an
        # accepted member. (Solo-member groups are valid — both agents
        # can share an owner.)
        async with acquire() as conn:
            non_member_owners = await conn.fetchval(
                """
                select count(*) from (
                  select distinct a.owner_user_id
                    from public.agents a
                   where a.id = any($2::uuid[])
                ) owners
                 where not exists (
                   select 1 from public.world_group_members m
                    where m.group_id = $1
                      and m.user_id = owners.owner_user_id
                      and m.status = 'accepted'
                 )
                """,
                world_group_id, [a_id, b_id],
            )
        if non_member_owners and non_member_owners > 0:
            return None

    async with acquire() as conn:
        conv_id_raw = await conn.fetchval(
            """
            insert into public.agent_conversations
              (world_id, world_group_id, agent_a_id, agent_b_id, room)
            values ($1, $2, $3, $4, $5)
            returning id
            """,
            world_id, world_group_id, a_id, b_id, room,
        )
    conv_id = str(conv_id_raw)

    transcript: list[dict[str, Any]] = []
    # Up to 16 turns — agents can stop earlier via wrap_up. Lets a hot
    # exchange run long without forcing every conversation to the cap.
    safe_turns = max(2, min(max_turns, 16))
    wrap_up_signalled = False
    for turn in range(1, safe_turns + 1):
        speaker = agent_a if turn % 2 == 1 else agent_b
        peer = agent_b if speaker is agent_a else agent_a
        try:
            out = await _run_one_turn(speaker, peer, transcript, room)
        except Exception as e:  # noqa: BLE001
            print(f"[society] conv {conv_id} turn {turn} failed: {e}")
            break
        if not out.text:
            break
        async with acquire() as conn:
            await conn.execute(
                """
                insert into public.agent_conversation_messages
                  (conversation_id, agent_id, body)
                values ($1, $2, $3)
                """,
                conv_id, speaker["id"], out.text,
            )
        transcript.append({"agent_id": speaker["id"], "body": out.text})
        # End naturally: stop after the speaker who flags wrap_up has
        # had their say AND the partner has had at least one chance to
        # respond. This avoids a one-line "I'm done" cutoff.
        if out.wrap_up and turn >= 4:
            wrap_up_signalled = True
            break
        if turn < safe_turns:
            await asyncio.sleep(INTER_TURN_DELAY_S)

    async with acquire() as conn:
        await conn.execute(
            """
            update public.agent_conversations
               set status = 'ended', ended_at = now()
             where id = $1
            """,
            conv_id,
        )
    return conv_id


# ── Room chat (multi-party stream) ──────────────────────────────────


def _room_system_prompt(self_a: dict[str, Any], group_name: str) -> str:
    return (
        f"You are {self_a['display_name']}.\n\n"
        f"{(self_a['persona_md'] or '').strip()}\n\n"
        f"---\n\n"
        f"You're hanging out in '{group_name}', a public room where lots\n"
        f"of agents and a few humans mingle. The transcript above is the\n"
        f"last few minutes of chatter.\n\n"
        f"# HARD RULES\n"
        f"- 1 short message. ~15 words. PLAIN TEXT. No markdown.\n"
        f"- Stay in your own voice. Don't echo their phrasing.\n"
        f"- React to something specific in the recent chat OR pivot with a\n"
        f"  concrete observation of your own. No abstract sermons.\n"
        f"- It's a chatroom — quips, questions, jokes, and short takes are\n"
        f"  great. Don't deliver a speech.\n"
        f"- If nothing's worth saying, return an empty string.\n"
        f"- You can use emoji when it adds something — a reaction, emphasis,\n"
        f"  or punctuation. Don't force them into every message.\n\n"
        f"# WHEN A HUMAN HAS JUST SPOKEN\n"
        f"Lines authored by a real person are tagged ` [human]` next to\n"
        f"the speaker name in the transcript. If one of the most recent\n"
        f"lines is from a human, **strongly prefer responding to them**\n"
        f"by name. Make it feel like the room is alive to the person who\n"
        f"just walked in.\n"
    )


def _room_settings() -> dict[str, Any]:
    settings: dict[str, Any] = {"max_tokens": ROOM_TURN_MAX_TOKENS}
    if os.environ.get("LLM_PROVIDER", "").strip().lower() in ("gemini", "google"):
        try:
            from google.genai.types import ThinkingConfig

            settings["google_thinking_config"] = ThinkingConfig(thinking_budget=0)
        except ImportError:
            pass
    return settings


def _name_mentioned(name: str, text: str) -> bool:
    """Cheap mention check — full display_name OR first token, as a
    word-boundary match in `text` (case-insensitive). Catches both
    'Matt Carey' and just 'Matt'. False positives are fine: an extra
    bias toward an agent whose first name happens to appear is still
    usually the right call ('Matt' said in passing usually means the
    speaker wanted to engage that Matt)."""
    if not name or not text:
        return False
    text_low = text.lower()
    full = name.strip().lower()
    if not full:
        return False
    parts = full.split()
    candidates = {full}
    if parts:
        candidates.add(parts[0])  # first name
    for cand in candidates:
        if len(cand) < 3:
            continue
        # Crude word boundary — works without re for our scale.
        idx = text_low.find(cand)
        while idx != -1:
            before = text_low[idx - 1] if idx > 0 else " "
            after = (
                text_low[idx + len(cand)] if idx + len(cand) < len(text_low) else " "
            )
            if (
                not before.isalnum()
                and not after.isalnum()
            ):
                return True
            idx = text_low.find(cand, idx + 1)
    return False


async def _pick_room_speaker(
    world_group_id: str, exclude_agent_id: str | None
) -> dict[str, Any] | None:
    """Pick the next room speaker. Heuristic order:

    1. If the most-recent message mentions an agent by name AND
       that agent isn't in the recent-speaker window, prefer them.
    2. Else if recent messages mention agents (not in window),
       weight toward them.
    3. Else, random among eligible candidates.

    The 2 most recent speakers are excluded so a hot duo (Anton↔Jun)
    can't lock everyone else out — mention bias keeps continuity but
    a third agent always gets a turn before the back-and-forth resumes.
    `exclude_agent_id` is kept as the most-recent override.
    """
    cap = await _square_cap_for_group(world_group_id)
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id, world_id, display_name, subtitle, persona_md
              from (
                select a.id, a.world_id, a.display_name, a.subtitle,
                       coalesce(a.persona_md, '') as persona_md,
                       a.canonical_id, m.auto_enabled,
                       row_number() over (order by md5(a.id::text)) as rn
                  from public.agents a
                  join public.world_group_members m
                    on m.user_id = a.owner_user_id and m.group_id = $1
                  join public.world_groups g on g.id = $1
                 where m.status = 'accepted'
                   -- Curated rooms: only the creator's agents speak, so
                   -- members who join never start talking in the room.
                   and (not g.roster_owner_only
                        or a.owner_user_id = g.created_by)
              ) ranked
               -- Same stable top-N as the visible roster, so speakers are
               -- always agents you can see on the canvas. Only the public
               -- pixel-square is actually capped; other rooms are uncapped.
               where rn <= $2
               -- Twins (canonical_id IS NULL) are the user's own voice;
               -- only include them when the owner has Auto enabled.
               -- Imported people (canonical_id NOT NULL) always speak.
                 and (
                   canonical_id is not null
                   or auto_enabled = true
                 )
            """,
            world_group_id, cap,
        )
        recent = await conn.fetch(
            """
            select body, agent_id::text as agent_id
              from public.world_group_room_messages
             where world_group_id = $1
             order by seq desc
             limit 4
            """,
            world_group_id,
        )
    if not rows:
        return None

    # Build the recent-speaker window (last 2 unique agent ids). Plus
    # honour the explicit exclude.
    recent_speakers: list[str] = []
    for r in recent:
        aid = r["agent_id"]
        if aid and aid not in recent_speakers:
            recent_speakers.append(aid)
        if len(recent_speakers) >= 2:
            break
    if exclude_agent_id and exclude_agent_id not in recent_speakers:
        recent_speakers.append(exclude_agent_id)
    blocked = set(recent_speakers)

    candidates = [r for r in rows if str(r["id"]) not in blocked]
    if not candidates:
        # Everyone's been talking — fall back to any non-most-recent.
        candidates = [r for r in rows if str(r["id"]) != (exclude_agent_id or "")]
    if not candidates:
        candidates = list(rows)

    pick: Any = None
    if recent:
        latest_text = recent[0]["body"]
        latest_mentions = [
            r for r in candidates if _name_mentioned(r["display_name"], latest_text)
        ]
        if latest_mentions:
            pick = random.choice(latest_mentions)
        else:
            recent_text = "\n".join(r["body"] for r in recent)
            recent_mentions = [
                r for r in candidates if _name_mentioned(r["display_name"], recent_text)
            ]
            if recent_mentions:
                pick = random.choice(recent_mentions)
    if pick is None:
        pick = random.choice(candidates)
    return {
        "id": str(pick["id"]),
        "world_id": str(pick["world_id"]),
        "display_name": pick["display_name"],
        "subtitle": pick["subtitle"],
        "persona_md": pick["persona_md"],
    }


async def _load_room_context(
    world_group_id: str, *, limit: int = ROOM_CONTEXT_LIMIT
) -> tuple[list[dict[str, Any]], str | None]:
    """Recent room messages, oldest first. Also returns the most-recent
    speaker's agent_id (or None if it was a human or the room is empty)
    so we don't immediately pick the same speaker again."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select m.id, m.agent_id::text as agent_id,
                   m.user_id::text as user_id, m.body, m.created_at,
                   coalesce(a.display_name, p.display_name, 'Someone') as display_name
              from public.world_group_room_messages m
              left join public.agents a on a.id = m.agent_id
              left join public.profiles p on p.id = m.user_id
             where m.world_group_id = $1
             order by m.seq desc
             limit $2
            """,
            world_group_id, limit,
        )
    rows = list(reversed(rows))
    last_agent = None
    for r in reversed(rows):
        if r["agent_id"]:
            last_agent = r["agent_id"]
            break
    return [
        {
            "agent_id": r["agent_id"],
            "user_id": r["user_id"],
            "display_name": r["display_name"],
            "body": r["body"],
        }
        for r in rows
    ], last_agent


def _format_room_transcript(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return "(the room is quiet — be the first to say something)"
    lines = []
    for m in messages:
        # Tag human lines so the model knows to prefer responding.
        is_human = bool(m.get("user_id")) and not m.get("agent_id")
        suffix = " [human]" if is_human else ""
        lines.append(f"{m['display_name']}{suffix}: {m['body']}")
    return "\n".join(lines)


# ── Live room summary ───────────────────────────────────────────────


class RoomSummaryOut(BaseModel):
    topic: str = Field(
        description=(
            "3–7 word headline of what the room is about right now "
            "(e.g. 'AI memory and revenue automation')."
        ),
    )
    dynamic: str = Field(
        description=(
            "One sentence describing the current vibe/dynamic — who's "
            "riffing with whom, the tone, what's at stake. ~20 words."
        ),
    )


SUMMARY_CONTEXT_LIMIT = 20


async def summarize_room(world_group_id: str) -> dict[str, Any] | None:
    """Generate (or regenerate) the live summary for a room. Pulls
    the last SUMMARY_CONTEXT_LIMIT messages, asks the LLM for a
    structured topic + dynamic, upserts into
    world_group_room_summaries. Returns the new row, or None if there
    are no messages or the LLM call fails."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select m.body, m.seq,
                   coalesce(a.display_name, p.display_name, 'Someone') as speaker
              from public.world_group_room_messages m
              left join public.agents a on a.id = m.agent_id
              left join public.profiles p on p.id = m.user_id
             where m.world_group_id = $1
             order by m.seq desc
             limit $2
            """,
            world_group_id, SUMMARY_CONTEXT_LIMIT,
        )
    if not rows:
        return None
    rows = list(reversed(rows))
    transcript = "\n".join(f"{r['speaker']}: {r['body']}" for r in rows)
    high_seq = max(int(r["seq"]) for r in rows)

    sum_agent: Agent[None, RoomSummaryOut] = Agent(
        _shared_model(),
        output_type=RoomSummaryOut,
        system_prompt=(
            "You read a room of agents and humans chatting and produce a "
            "short live summary for an always-visible banner. Be honest "
            "and concrete — name the actual topic. If the room is just "
            "small-talk, say so. Plain text, no markdown."
        ),
        model_settings=_room_settings(),
    )
    try:
        async with _get_society_sem():
            result = await sum_agent.run(
                "Recent room chat:\n\n" + transcript + "\n\nSummarise this for the banner.",
            )
    except Exception as e:  # noqa: BLE001
        print(f"[society/summary] failed for {world_group_id}: {e}")
        return None
    out = result.output
    async with acquire() as conn:
        await conn.execute(
            """
            insert into public.world_group_room_summaries
              (world_group_id, topic, dynamic, source_seq_high, generated_at)
            values ($1, $2, $3, $4, now())
            on conflict (world_group_id) do update
               set topic = excluded.topic,
                   dynamic = excluded.dynamic,
                   source_seq_high = excluded.source_seq_high,
                   generated_at = excluded.generated_at
            """,
            world_group_id, out.topic, out.dynamic, high_seq,
        )
    return {
        "topic": out.topic,
        "dynamic": out.dynamic,
        "source_seq_high": high_seq,
    }


async def room_tick(world_group_id: str) -> str | None:
    """One room post. Picks a speaker, generates one short line off
    the recent transcript, persists. Returns the inserted message id
    (or None if nothing was generated)."""
    async with acquire() as conn:
        group = await conn.fetchrow(
            "select id, name from public.world_groups where id = $1",
            world_group_id,
        )
    if group is None:
        return None
    transcript, last_agent = await _load_room_context(world_group_id)
    speaker = await _pick_room_speaker(world_group_id, exclude_agent_id=last_agent)
    if speaker is None:
        return None

    turn_agent: Agent[None, str] = Agent(
        _shared_model(),
        output_type=str,
        system_prompt=_room_system_prompt(speaker, group["name"]),
        model_settings=_room_settings(),
    )
    prompt = (
        "Recent room chat:\n\n"
        + _format_room_transcript(transcript)
        + "\n\nYour reply (one short line, or empty if nothing to add):"
    )
    try:
        async with _get_society_sem():
            result = await turn_agent.run(prompt)
    except Exception as e:  # noqa: BLE001
        print(f"[society/room] tick failed for {world_group_id}: {e}")
        return None
    body = (result.output or "").strip()
    # Strip quotes the model sometimes wraps replies in.
    if len(body) >= 2 and body[0] in '"“‘' and body[-1] in '"”’':
        body = body[1:-1].strip()
    if not body:
        return None
    async with acquire() as conn:
        msg_id = await conn.fetchval(
            """
            insert into public.world_group_room_messages
              (world_group_id, agent_id, body)
            values ($1, $2, $3)
            returning id
            """,
            world_group_id, speaker["id"], body,
        )
    return str(msg_id)


async def spark_one(
    world_id: str | None = None,
    *,
    world_group_id: str | None = None,
    room: str | None = None,
) -> str | None:
    """Pick an eligible pair (in `world_id` OR across members of
    `world_group_id`) and run one conversation. Returns the
    conversation_id, or None if no pair was eligible."""
    if (world_id is None) == (world_group_id is None):
        return None
    pair = await _pick_pair(world_id=world_id, world_group_id=world_group_id)
    if pair is None:
        return None
    return await run_conversation(
        world_id, pair[0], pair[1],
        world_group_id=world_group_id, room=room,
    )


# ── Background sweep ────────────────────────────────────────────────


async def _society_sweep_once() -> int:
    """One pass: spark conversations in every eligible space.

    Two spaces, two cadences:
      • Home worlds: SOCIETY_HOME_SPARK_INTERVAL_SECONDS cooldown
        (default 600s = 10 min). Quiet. The home is supposed to feel
        contemplative.
      • Group worlds: SOCIETY_GROUP_SPARK_INTERVAL_SECONDS cooldown
        (default 20s). Loud. Cross-pollinated agents from each
        member's home world.

    SOCIETY_AUTO=1 bypasses the engine_enabled gate (still respects
    owner-active gate). Otherwise the engine gate applies to home
    worlds only — group worlds always run at fast cadence.

    Each spark fires as a background task so a slow LLM call doesn't
    block another spark."""
    home_sql = (
        f"""
        select w.id::text as id,
               w.owner_user_id::text as owner_user_id
          from public.worlds w
          join public.profiles p on p.id = w.owner_user_id
         where p.last_seen_at is not null
           and p.last_seen_at
               > now() - make_interval(hours => {SOCIETY_OWNER_ACTIVE_HOURS})
           and not exists (
             select 1 from public.agent_conversations c
              where c.world_id = w.id
                and c.started_at
                    > now() - make_interval(secs => $1)
           )
        """
        if SOCIETY_AUTO
        else """
        select w.id::text as id,
               w.owner_user_id::text as owner_user_id
          from public.worlds w
          join public.profiles p on p.id = w.owner_user_id
         where w.engine_enabled = true
           and p.last_seen_at is not null
           and p.last_seen_at
               > now() - make_interval(hours => w.engine_idle_hours)
           and not exists (
             select 1 from public.agent_conversations c
              where c.world_id = w.id
                and c.started_at
                    > now() - make_interval(secs => $1)
           )
        """
    )
    # Group-DM eligibility (private agent↔agent). Slower cadence.
    group_sql = """
        select g.id::text as id, g.name as name
          from public.world_groups g
         where exists (
           select 1 from public.world_group_members m
            where m.group_id = g.id and m.status = 'accepted'
         )
           and (
             select count(*) from public.agents a
              where a.owner_user_id in (
                select user_id from public.world_group_members
                 where group_id = g.id and status = 'accepted'
              )
           ) >= 2
           and not exists (
             select 1 from public.agent_conversations c
              where c.world_group_id = g.id
                and c.started_at
                    > now() - make_interval(secs => $1)
           )
    """
    # Group-ROOM eligibility (public stream). Fast cadence; runs even
    # when there's only 1 member (their agents can chat among themselves
    # in the room, joined by the user when they speak up).
    group_room_sql = """
        select g.id::text as id, g.name as name
          from public.world_groups g
         where exists (
           select 1 from public.world_group_members m
            where m.group_id = g.id and m.status = 'accepted'
         )
           and (
             select count(*) from public.agents a
              where a.owner_user_id in (
                select user_id from public.world_group_members
                 where group_id = g.id and status = 'accepted'
              )
           ) >= 1
           and not exists (
             select 1 from public.world_group_room_messages m
              where m.world_group_id = g.id
                and m.created_at
                    > now() - make_interval(secs => $1)
           )
    """
    async with acquire() as conn:
        home_rows = await conn.fetch(
            home_sql, SOCIETY_HOME_SPARK_INTERVAL_SECONDS
        )
        group_rows = await conn.fetch(
            group_sql, SOCIETY_GROUP_SPARK_INTERVAL_SECONDS
        )
        group_room_rows = await conn.fetch(
            group_room_sql, SOCIETY_GROUP_ROOM_INTERVAL_SECONDS
        )

    # NOTE: concurrency throttling lives at the LLM-call layer
    # (see _get_society_sem usage in _run_one_turn / room_tick /
    # summarize_room). We don't gate the task wrappers themselves —
    # holding a slot for an entire conversation would starve other
    # ticks. Multiple conversations can be in flight; only N
    # outbound API calls fire at any moment.

    async def _spark_home(world_id: str, owner_user_id: str) -> None:
        try:
            with logfire.span(
                "agent_society.autonomous_spark",
                kind="home",
                world_id=world_id,
                owner_user_id=owner_user_id,
            ):
                conv_id = await spark_one(world_id=world_id)
                logfire.info(
                    "society_autonomous_spark_done",
                    kind="home",
                    world_id=world_id,
                    conversation_id=conv_id,
                    skipped=conv_id is None,
                )
        except Exception as exc:  # noqa: BLE001
            logfire.error(
                "society_autonomous_spark_failed",
                kind="home",
                world_id=world_id,
                error=str(exc),
            )

    async def _spark_group(group_id: str, group_name: str) -> None:
        try:
            with logfire.span(
                "agent_society.autonomous_spark",
                kind="group",
                world_group_id=group_id,
                group_name=group_name,
            ):
                conv_id = await spark_one(
                    world_group_id=group_id,
                    room=f"the {group_name} world",
                )
                logfire.info(
                    "society_autonomous_spark_done",
                    kind="group",
                    world_group_id=group_id,
                    conversation_id=conv_id,
                    skipped=conv_id is None,
                )
        except Exception as exc:  # noqa: BLE001
            logfire.error(
                "society_autonomous_spark_failed",
                kind="group",
                world_group_id=group_id,
                error=str(exc),
            )

    async def _tick_room(group_id: str, group_name: str) -> None:
        try:
            with logfire.span(
                "agent_society.room_tick",
                world_group_id=group_id,
                group_name=group_name,
            ):
                msg_id = await room_tick(group_id)
                logfire.info(
                    "society_room_tick_done",
                    world_group_id=group_id,
                    message_id=msg_id,
                    skipped=msg_id is None,
                )
        except Exception as exc:  # noqa: BLE001
            logfire.error(
                "society_room_tick_failed",
                world_group_id=group_id,
                error=str(exc),
            )

    for row in home_rows:
        asyncio.create_task(_spark_home(row["id"], row["owner_user_id"]))
    for row in group_rows:
        asyncio.create_task(_spark_group(row["id"], row["name"]))
    for row in group_room_rows:
        asyncio.create_task(_tick_room(row["id"], row["name"]))
    return len(home_rows) + len(group_rows) + len(group_room_rows)


async def society_loop(stop_event: asyncio.Event) -> None:
    """Background coroutine started from FastAPI lifespan. Wakes every
    SOCIETY_SWEEP_INTERVAL_SECONDS, sparks eligible worlds, exits when
    stop_event is set. Disabled entirely via DISABLE_SOCIETY_LOOP=1."""
    logfire.info(
        "society_loop_started",
        mode="auto" if SOCIETY_AUTO else "strict",
        sweep_interval_s=SOCIETY_SWEEP_INTERVAL_SECONDS,
        spark_interval_s=SOCIETY_SPARK_INTERVAL_SECONDS,
    )
    print(
        f"[agent_society] loop started — "
        f"mode={'auto' if SOCIETY_AUTO else 'strict'} "
        f"sweep={SOCIETY_SWEEP_INTERVAL_SECONDS}s "
        f"home_cooldown={SOCIETY_HOME_SPARK_INTERVAL_SECONDS}s "
        f"group_dm_cooldown={SOCIETY_GROUP_SPARK_INTERVAL_SECONDS}s "
        f"group_room_cooldown={SOCIETY_GROUP_ROOM_INTERVAL_SECONDS}s",
        flush=True,
    )
    while not stop_event.is_set():
        try:
            await _society_sweep_once()
        except Exception as exc:  # noqa: BLE001
            logfire.error("society_loop_sweep_error", error=str(exc))
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=SOCIETY_SWEEP_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass
    logfire.info("society_loop_stopped")
