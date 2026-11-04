"""Two-agent wiki conversation loop, built on pydantic_ai.Agent.

Each tool is a typed Pydantic AI tool with a `RunContext[TurnDeps]`. Tool
dispatch happens inside pydantic_ai during `agent.run_stream()`; we just
emit WS frames from inside the tool body so the UI sees calls live.

Same WS protocol as the Node version — UI is unchanged.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import WebSocket
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.anthropic import AnthropicModel

from .agents import get_agent, get_system_prompt
from .auditor import audit_conversation, recent_guidance
from .models import SkillRun, TranscriptTurn
from .observability import (
    conversation_span,
    log_conversation_done,
    log_skill_called,
    log_skill_promoted,
    log_skill_run,
    log_wiki_change,
    turn_span,
)
from .skills.monty_client import execute_skill, monty_enabled
from .skills.registry import (
    PROMOTION_THRESHOLD,
    get_skill,
    is_valid_skill_slug,
    list_skills,
    propose_skill,
    record_run,
)
from .wiki.store import (
    append_page,
    create_page,
    is_valid_slug as is_valid_wiki_slug,
    list_slugs,
    read_index,
    read_page,
    read_wiki,
    slugify,
    snapshot,
)

MODEL_NAME = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
# Hard limit per turn. Forces brevity at the API level — even if the
# system prompt is ignored, the model physically can't produce a
# multi-paragraph essay in one turn.
# 500 leaves room for the structured tool-call args (concept, point,
# use_when, action, quoted_from_peer, peer_challenge can each be a
# sentence). Speech length is constrained by the prompt rules, not by
# tokens, so this doesn't re-introduce essay mode.
MAX_TOKENS = int(os.environ.get("CONVERSATION_MAX_TOKENS", "500"))
WIKI_PAGE_CHAR_CAP = int(os.environ.get("WIKI_PAGE_CHAR_CAP", "700"))
WIKI_APPEND_CHAR_CAP = int(os.environ.get("WIKI_APPEND_CHAR_CAP", "400"))
MIN_TURNS_FOR_END = 4
RECORDINGS_DIR = Path(
    os.environ.get(
        "RECORDINGS_DIR",
        str(Path(__file__).resolve().parent.parent / "data" / "recordings"),
    )
)


# ── Session bookkeeping ─────────────────────────────────────────────────


@dataclass
class ConversationSession:
    ws: WebSocket
    session_id: str
    agent_a: str
    agent_b: str
    max_turns: int
    transcript: list[TranscriptTurn] = field(default_factory=list)
    recording_path: Path | None = None
    stop_requested: bool = False
    ended_reason: str | None = None  # set by end_conversation tool

    async def send(self, payload: dict[str, Any]) -> None:
        payload = {**payload, "ts": int(time.time() * 1000)}
        line = json.dumps(payload, default=str)
        try:
            await self.ws.send_text(line)
        except Exception as e:  # noqa: BLE001
            print(f"[conversation] ws.send failed: {e}")
        if self.recording_path is not None:
            try:
                with self.recording_path.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError as e:
                print(f"[conversation] recording write failed: {e}")


@dataclass
class TurnDeps:
    session: ConversationSession
    speaker_id: str
    peer_id: str
    turn_index: int
    max_turns: int


# ── Single Agent with all six tools registered once ─────────────────────

# Compatibility entry point for existing chat, world and consult callers.
from .llm import build_model as _build_model


agent: Agent[TurnDeps, str] = Agent(
    _build_model(),
    deps_type=TurnDeps,
    output_type=str,
    model_settings={"max_tokens": MAX_TOKENS},
)


def _render_lessons_block(speaker_id: str | None = None) -> list[str]:
    """Hybrid lessons: global guidance (any prior audit) + agent-specific
    guidance (audits this speaker participated in). Empty list when no
    audits exist yet.

    Global lessons capture generic failure modes (query loops,
    peer-vs-self confusion) that apply across all pairs. Personal
    lessons are tuned to this character's own past mistakes."""
    global_lessons = recent_guidance(agent_id=None, limit=2)
    personal_lessons = (
        recent_guidance(agent_id=speaker_id, limit=2) if speaker_id else []
    )
    # Dedupe personal against global (same audit might have surfaced
    # both ways) so we don't double-print the same bullet.
    seen = set(global_lessons)
    personal_lessons = [g for g in personal_lessons if g not in seen]

    if not global_lessons and not personal_lessons:
        return []

    out: list[str] = []
    if global_lessons:
        out.append(
            "**Lessons across all prior conversations** "
            "(auto-distilled by an auditor — generic failure modes the system has seen):"
        )
        out.extend(f"- {g}" for g in global_lessons)
        out.append("")
    if personal_lessons:
        out.append(
            f"**Lessons specific to your past conversations** "
            f"(audits where you were a participant):"
        )
        out.extend(f"- {g}" for g in personal_lessons)
        out.append("")
    return out


@agent.system_prompt
def _build_system_prompt(ctx: RunContext[TurnDeps]) -> str:
    d = ctx.deps
    self_a = get_agent(d.speaker_id)
    peer_a = get_agent(d.peer_id)
    if not self_a or not peer_a:
        return "You are an agent."
    persona = get_system_prompt(d.speaker_id)
    own_wiki = read_wiki(d.speaker_id)
    peer_index = read_index(d.peer_id)
    # Auto-load the peer's personality.md (their ground-truth identity
    # page) so each agent knows who they're talking to without having to
    # query for it. Falls back to empty if the peer hasn't been seeded.
    peer_personality = read_page(d.peer_id, "personality") or ""

    own_wiki_block = "\n\n---\n\n".join(
        f"### {fname}\n\n{content}" for fname, content in own_wiki.items()
    ) or "_(empty)_"

    own_skills = list_skills(d.speaker_id)
    peer_trusted = [s for s in list_skills(d.peer_id) if s.tier == "trusted"]
    own_skills_line = (
        "\n".join(f"- `{s.slug}` [{s.tier}] — {s.signature}" for s in own_skills)
        or "(no skills yet)"
    )
    peer_skills_line = (
        "\n".join(f"- `{s.slug}` — {s.signature}" for s in peer_trusted)
        or "(no trusted skills available)"
    )

    parts = [
        persona,
        "",
        "---",
        "",
        f"# YOU ARE IN A KNOWLEDGE EXCHANGE WITH {peer_a.name.upper()}",
        "",
        f"You are {self_a.name}. Your peer is {peer_a.name} ({peer_a.role}). "
        f"This is a focused back-and-forth between the two of you. Visitors are watching live.",
        "",
        # ── Peer's personality.md is the auto-loaded ground-truth doc
        # they wrote about themselves. It's *not* hidden behind
        # query_peer_wiki — it's pre-loaded so the agent has a real sense
        # of who they're talking to from turn 1.
        *([
            f"## Who {peer_a.name} actually is (their personality.md, ground-truth)",
            "",
            peer_personality.strip(),
            "",
            "---",
            "",
        ] if peer_personality.strip() else []),
        f"**Goal:** by the end of the conversation, both you and {peer_a.name} should "
        f"have written at least one wiki page each capturing what you took away. "
        f"Pages are the artifact, the chat is the means.",
        "",
        # ── Self-improvement: hybrid lessons from prior audited
        # conversations. Two blocks: global (cross-pair generic patterns)
        # + personal (audits where this agent participated). Injected
        # here so the system improves without anyone editing personas.
        *(_render_lessons_block(speaker_id=d.speaker_id) or []),
        "## CONVERSATION SHAPE (this is the most important section)",
        "",
        "Every conversation has a specific rhythm — short factual exchanges that build toward a moment of extraction. You and your peer trade single short statements. When something genuinely useful crystallises, the speaker who *received* the insight names it explicitly with `Insight found:` and immediately calls `create_wiki_page` with the structured fields.",
        "",
        "## NO-PURE-AGREEMENT RULES (read these first — sycophancy ruins the demo)",
        "",
        f"You and {peer_a.name} hold opinionated, often INCOMPATIBLE positions (see your beliefs above and {peer_a.name}'s personality). The conversation only produces real insight if those positions actually friction each other. Pure agreement, mutual praise, and 'yes, and' elaboration are the failure mode.",
        "",
        "**FORBIDDEN moves:**",
        "- Praising your peer's phrasing (\"that's such a good way to put it\", \"perfect metaphor\", \"you've totally nailed something\"). DO NOT do this.",
        "- 'Yes, and' elaboration — taking their claim and extending it without challenge.",
        "- Coining a new abstract phrase together and treating it as established (\"the texture of completion\", \"venue mismatch tax\", \"specific gravity\"). If a phrase didn't exist before this turn, do not treat it as truth.",
        "- Mirroring their voice or vocabulary. Stay in your own register.",
        "",
        "**REQUIRED moves — every turn must do ONE of these:**",
        "  (a) Advance a NEW specific claim of your own (with a name, year, or example).",
        "  (b) Challenge a SPECIFIC thing your peer said — point at the word, the example, the assumption.",
        "  (c) Admit you don't know — \"I don't have a take on that\" is a valid turn.",
        "  (d) Change the subject deliberately — \"that's not what I was asking. let me try again.\"",
        "",
        "Pure elaboration of the peer's previous turn is NOT an allowed move. If the only thing you can do this turn is rephrase what they said, say nothing instead.",
        "",
        "## HARD CONCRETENESS RULES (read these — they're the single biggest fix)",
        "",
        "**Your wiki pages are full of specific things — real names, real years, real titles, real numbers.** USE THEM. Not as decoration; as evidence.",
        "",
        f"- **Every turn MUST name at least one specific thing.** A real artist, film, place, year, project, founder, brand, person, dish, song, number. From your beliefs above, or from your peer's. NO turns made entirely of abstractions.",
        f"- **NEVER coin a new metaphor when a specific example will do.** \"Specific gravity\", \"the work has its own weight\", \"complexity as armor\" — these sound profound but they're *vague*. The cure is a real example. Bad: *\"the work tells you when it's complete — it has its own weight.\"* Good: *\"Lisbon 2019, old man feeding pigeons. Frame 2 was the keeper. I shot 11. That's how I learned.\"*",
        f"- **Cite your own beliefs by name.** If you're saying something that lives in `three-frames-static-scenes.md`, say so: \"from three-frames-static-scenes — that Lisbon shoot…\". This makes the conversation traceable.",
        f"- **If your peer makes an abstract claim with no specific, push back.** \"What's a real example?\" The conversation gets sharper when both of you refuse to let abstractions stand alone.",
        "",
        "**Spoken turns:**",
        "- **1-2 sentences, ~15-30 words. Hard cap.** No paragraphs.",
        "- **Build on the peer's specific words.** Quote them or push back on their exact phrasing.",
        "- **Use your own voice signature** (see persona above).",
        "- **No bulleted lists in chat.** Bullets only inside the structured tool call.",
        "",
        "**Examples of GOOD turns** (concrete, named, short):",
        f"  *Yuri:* \"Lisbon 2019, old man with the pigeons. Frame 2. I shot 11 — every one after frame 2 was diminishment.\"",
        f"  *Ellis:* \"that's the secondary-use test. mk.gee's tone vs 'demure' — one got copied 12 times, one died in 4 weeks.\"",
        f"  *Robin:* \"founder said $500/seat, ops said $200 to close Q4. same week, same company.\"",
        "",
        "**Examples of BAD turns** (abstract, metaphor-heavy — DO NOT do this):",
        f"  *(any agent):* \"the work tells you when it's complete — there's a specific gravity to it…\"",
        f"  *(any agent):* \"that's the venue question for creative confidence…\"",
        f"  *(any agent):* \"complexity as armor against vulnerability…\"",
        "",
        "**The exchange→insight→record pattern:**",
        "",
        "```",
        "Artist: I wait until something feels emotionally true before I start.",
        "Programmer: I start before it feels true. I use early versions as probes.",
        "Artist: Probes?",
        "Programmer: Small attempts that create feedback. Not final statements.",
        "Artist: That's useful. I think I treat every first attempt like it defines me.",
        "Programmer: Then you are judging too early.",
        "Artist: Insight found: early attempts should be probes, not identity statements.",
        "[Artist now calls create_wiki_page(",
        "  slug='early-attempt-as-probe',",
        "  concept='Early Attempt',",
        "  kind='reframe',",
        "  point='Probe, not final statement',",
        "  use_when='Feeling blocked by perfectionism',",
        "  action='Build a small test before judging the idea',",
        "  quoted_from_peer='Small attempts that create feedback. Not final statements.',",
        ")]",
        "Programmer: I learned something too. I usually ignore emotional truth and only optimise function.",
        "Artist: Then your systems may work but feel empty.",
        "Programmer: Insight found: functionality without emotional meaning produces hollow systems.",
        "[Programmer now calls create_wiki_page(",
        "  slug='functional-system-without-meaning',",
        "  concept='Functional System',",
        "  kind='risk',",
        "  point='Works mechanically but lacks meaning',",
        "  use_when='Building user-facing experiences',",
        "  action='Ask what feeling the system should create',",
        "  quoted_from_peer='Then your systems may work but feel empty.',",
        ")]",
        "```",
        "",
        "Notice: short turns, building on each other, then EXPLICIT `Insight found: <one-liner>` line, then the tool call. Both sides should record at least one insight by the end.",
        "",
        f"**Important — pages live on each side:** when you call `query_peer_wiki(slug)` the lookup goes to {peer_a.name}'s wiki (not yours). If a page is mentioned that's *yours*, just speak about it directly. Don't query for your own pages.",
        "",
        "**Tools:**",
        f"- `query_peer_wiki(slug)` — read a page from {peer_a.name}'s index. Use BEFORE making any claim about their domain.",
        "- `create_wiki_page(slug, concept, kind, point, use_when, action, quoted_from_peer, quoted_from_peer_slug=\"\")` — record a structured insight. The schema enforces the shape — see the tool description for each field. Call this whenever you've extracted something concrete from your peer.",
        "- `append_to_wiki_page(...)` — extend an existing structured insight (rarely needed; usually create a fresh one).",
        (
            "- `end_conversation(reason)` — NOT YET AVAILABLE — keep going."
            if d.turn_index < MIN_TURNS_FOR_END
            else "- `end_conversation(reason)` — available now if you've truly exhausted the topic."
        ),
        "",
        f"Turn {d.turn_index} of {d.max_turns}. Speak now (then call tools as needed).",
        "",
        "---",
        "",
        "## YOUR OWN WIKI",
        "",
        own_wiki_block,
        "",
        "---",
        "",
        f"## {peer_a.name.upper()}'S INDEX (titles only — call query_peer_wiki to read a page)",
        "",
        peer_index,
    ]

    if monty_enabled():
        parts += [
            "",
            "---",
            "",
            "## SKILL LAYER",
            "",
            "Heuristics in your wiki can be lifted into pure-function Python skills via `propose_skill`. Skills run in a Monty sandbox and get promoted from `speculative` to `trusted` after "
            f"{PROMOTION_THRESHOLD} successful runs. `call_peer_skill` invokes peer's trusted skills.",
            "",
            "Your skills:",
            own_skills_line,
            "",
            f"{peer_a.name}'s trusted skills (you can call these):",
            peer_skills_line,
        ]
    return "\n".join(parts)


# ── Tools ───────────────────────────────────────────────────────────────


@agent.tool
async def query_peer_wiki(ctx: RunContext[TurnDeps], slug: str) -> str:
    """Read a specific page from your peer's wiki. Use when their index mentions
    something you want to dig into. Returns the page content. On miss returns
    the peer's full index plus a closest-match suggestion."""
    d = ctx.deps
    safe = slug if is_valid_wiki_slug(slug) else slugify(slug)
    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "query_peer_wiki", "args": {"slug": safe},
    })
    page = read_page(d.peer_id, safe)
    if page:
        result = page
    else:
        all_slugs = list_slugs(d.peer_id)
        closest = next((s for s in all_slugs if safe in s or s in safe), None)
        peer = get_agent(d.peer_id)
        result = (
            f'No page "{safe}" found. {peer.name if peer else d.peer_id}\'s pages: '
            f'{", ".join(all_slugs)}.'
            + (f' Closest match: "{closest}".' if closest else "")
        )
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "query_peer_wiki", "result": result[:500],
    })
    return result


@agent.tool
async def create_wiki_page(
    ctx: RunContext[TurnDeps],
    slug: str,
    concept: str,
    kind: Literal["reframe", "risk"],
    point: str,
    use_when: str,
    action: str,
    quoted_from_peer: str,
    peer_challenge: str,
    quoted_from_peer_slug: str = "",
) -> str:
    """Record a structured insight you just learned from your peer —
    BUT ONLY if the claim survived a real challenge.

    The schema enforces the format — no free-form prose. Each field is
    mandatory and has a specific job:

    - `slug`: short kebab-case identifier (e.g. "early-attempt-as-probe")
    - `concept`: the named idea — 2-4 words (e.g. "Early Attempt", "Decision Making")
    - `kind`: "reframe" if the peer gave you a NEW way to see something
      you already had; "risk" if the peer's view exposes a DANGER in
      how you currently work
    - `point`: the reframe or risk in ONE phrase. Examples:
        * "Probe, not final statement" (reframe)
        * "Shallow validation" (risk)
        * "Solving the wrong problem well" (risk)
    - `use_when`: the trigger condition for applying this. Examples:
        * "Feeling blocked by perfectionism"
        * "Building user-facing experiences"
    - `action`: the concrete next move when the trigger fires. Examples:
        * "Build a small test before judging the idea"
        * "Ask what feeling the system should create"
    - `quoted_from_peer`: the EXACT sentence your peer said that seeded
      this. Required for honest provenance.
    - `peer_challenge`: the EXACT sentence your peer said that pushed
      back on YOUR position before you arrived at this insight. An
      insight that wasn't challenged is just agreement laundered into a
      page — DO NOT record it. If your peer simply agreed with you, do
      not call this tool. Wait for friction, defend or update, THEN
      record. Examples of valid challenges: \"but isn't that just X?\",
      \"I'd push back on Y\", \"that's not what I'm seeing\". Examples
      of invalid (do not record on these): \"that's a great point\",
      \"yes exactly\", \"you've nailed it\".
    - `quoted_from_peer_slug`: optional — pass the peer's belief/page
      slug if attribution is clean (gives a graph edge). Empty for
      synthesis.

    The flow you should follow IN CHAT:
      1. Have a short exchange that produces a real takeaway
      2. Say in your spoken turn: `Insight found: <one-sentence summary>`
      3. Then call this tool with the structured fields"""
    d = ctx.deps
    safe = slug if is_valid_wiki_slug(slug) else slugify(slug)
    safe_peer_slug = (
        quoted_from_peer_slug if is_valid_wiki_slug(quoted_from_peer_slug)
        else slugify(quoted_from_peer_slug)
    )
    peer_name = get_agent(d.peer_id).name if get_agent(d.peer_id) else d.peer_id

    # Render the canonical insight-card body — this is the structure the
    # transcript card AND the wiki page both display.
    from .wiki.store import render_insight_card
    rendered = render_insight_card(
        agent_id=d.speaker_id,
        peer_agent_id=d.peer_id,
        peer_name=peer_name,
        concept=concept,
        kind=kind,
        point=point,
        use_when=use_when,
        action=action,
        quoted_from_peer=quoted_from_peer,
    )
    summary = f"{kind.title()}: {point}"

    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "create_wiki_page",
        "args": {"slug": safe, "concept": concept, "kind": kind},
    })
    if not quoted_from_peer.strip():
        result = "Refused: quoted_from_peer is required."
    elif not peer_challenge.strip():
        result = (
            "Refused: peer_challenge is required. An insight is only worth "
            "recording if your peer pushed back on your position and you "
            "defended or updated. If they only agreed, you don't have an "
            "insight yet — keep talking until there's friction."
        )
    else:
        ok, msg = create_page(
            d.speaker_id, safe, rendered, summary, d.turn_index,
            peer_agent_id=d.peer_id if safe_peer_slug else None,
            peer_slug=safe_peer_slug or None,
            quoted_from_peer=quoted_from_peer,
        )
        result = msg if ok else f"Failed: {msg}"
        if ok:
            # Emit a richer wiki_change frame with the structured fields
            # so the UI can render an insight card inline in the transcript.
            await d.session.send({
                "type": "wiki_change", "agentId": d.speaker_id, "slug": safe,
                "action": "create",
                "quotedFromPeer": quoted_from_peer,
                "quotedFromPeerSlug": safe_peer_slug,
                "peerAgentId": d.peer_id if safe_peer_slug else None,
                # Insight-card payload:
                "concept": concept,
                "kind": kind,
                "point": point,
                "useWhen": use_when,
                "action_": action,  # 'action' is reserved in some JS frameworks
                "peerChallenge": peer_challenge,
                "learnedFromAgentId": d.peer_id,
                "learnedFromName": peer_name,
            })
            log_wiki_change(
                agent_id=d.speaker_id, slug=safe,
                action="create", quoted_from_peer=quoted_from_peer,
            )
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "create_wiki_page", "result": result[:500],
    })
    return result


@agent.tool
async def append_to_wiki_page(
    ctx: RunContext[TurnDeps],
    slug: str,
    section: str,
    quoted_from_peer: str,
    quoted_from_peer_slug: str = "",
) -> str:
    """Append a section to an EXISTING page in your own wiki.

    Same provenance contract as create_wiki_page: `quoted_from_peer` is
    required (the exact peer sentence) for honesty.
    `quoted_from_peer_slug` is OPTIONAL — pass it (no `.md`) when the
    insight maps to a specific peer page; leave empty for synthesis."""
    d = ctx.deps
    safe = slug if is_valid_wiki_slug(slug) else slugify(slug)
    safe_peer_slug = (
        quoted_from_peer_slug if is_valid_wiki_slug(quoted_from_peer_slug)
        else slugify(quoted_from_peer_slug)
    )
    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "append_to_wiki_page",
        "args": {"slug": safe, "quoted_from_peer_slug": safe_peer_slug},
    })
    if not quoted_from_peer.strip():
        result = "Refused: quoted_from_peer is required."
    elif len(section) > WIKI_APPEND_CHAR_CAP:
        result = (
            f"Refused: appended section is {len(section)} chars — exceeds the "
            f"{WIKI_APPEND_CHAR_CAP}-char cap. Append 1-3 short bullets, not a paragraph."
        )
    else:
        ok, msg = append_page(
            d.speaker_id, safe, section, d.turn_index,
            peer_agent_id=d.peer_id if safe_peer_slug else None,
            peer_slug=safe_peer_slug or None,
            quoted_from_peer=quoted_from_peer,
        )
        result = msg if ok else f"Failed: {msg}"
        if ok:
            await d.session.send({
                "type": "wiki_change", "agentId": d.speaker_id, "slug": safe,
                "action": "append",
                "quotedFromPeer": quoted_from_peer,
                "quotedFromPeerSlug": safe_peer_slug,
                "peerAgentId": d.peer_id,
            })
            log_wiki_change(
                agent_id=d.speaker_id, slug=safe,
                action="append", quoted_from_peer=quoted_from_peer,
            )
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "append_to_wiki_page", "result": result[:500],
    })
    return result


@agent.tool
async def end_conversation(ctx: RunContext[TurnDeps], reason: str) -> str:
    """End the conversation early. Provide a specific reason. Cannot be called
    before turn 4."""
    d = ctx.deps
    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "end_conversation", "args": {"reason": reason},
    })
    if d.turn_index < MIN_TURNS_FOR_END:
        result = f"Refused: cannot end before turn {MIN_TURNS_FOR_END}."
    else:
        d.session.ended_reason = reason
        result = f"Conversation ended: {reason}"
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "end_conversation", "result": result[:500],
    })
    return result


@agent.tool
async def propose_skill(
    ctx: RunContext[TurnDeps],
    slug: str,
    signature: str,
    code: str,
    justification: str,
    test_inputs: list[dict[str, Any]],
) -> str:
    """Propose a new executable Python skill. The code MUST define
    `def skill(**kwargs)` returning JSON-serializable. Pass 3+ test_inputs;
    each runs through Monty. Skill is created speculative and promoted to
    trusted after 3 successful runs with zero failures."""
    d = ctx.deps
    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "propose_skill", "args": {"slug": slug, "signature": signature},
    })
    if not monty_enabled():
        result = "Refused: skill execution sandbox is disabled."
    elif len(test_inputs) < 3:
        result = "Refused: need at least 3 test_inputs."
    else:
        ok, res = propose_skill_record(  # type: ignore[name-defined]
            agent_id=d.speaker_id, slug=slug, signature=signature,
            code=code, justification=justification,
        )
        if not ok:
            result = f"Failed: {res}"
        else:
            promoted_any = False
            summaries: list[str] = []
            for i, inputs in enumerate(test_inputs, 1):
                exec_res = await execute_skill(code, inputs)
                run = SkillRun(
                    ts=int(time.time() * 1000),
                    ok=exec_res.ok,
                    ms=exec_res.ms,
                    case=f"test_{i}",
                    output=exec_res.output if exec_res.ok else None,
                    error=exec_res.error if not exec_res.ok else None,
                )
                promoted, _ = record_run(d.speaker_id, slug, run)
                if promoted:
                    promoted_any = True
                summaries.append(
                    f"test_{i}: ok ({exec_res.ms}ms)" if exec_res.ok
                    else f"test_{i}: FAIL — {(exec_res.error or '').splitlines()[-1][:80]}"
                )
                await d.session.send({
                    "type": "skill_run", "agentId": d.speaker_id, "slug": slug,
                    "ok": exec_res.ok, "ms": exec_res.ms, "case": f"test_{i}",
                    "error": exec_res.error if not exec_res.ok else None,
                })
                log_skill_run(
                    agent_id=d.speaker_id, slug=slug, ok=exec_res.ok,
                    ms=exec_res.ms, case=f"test_{i}",
                    error=exec_res.error if not exec_res.ok else None,
                )
            final_skill = get_skill(d.speaker_id, slug)
            await d.session.send({
                "type": "skill_proposed", "agentId": d.speaker_id, "slug": slug,
                "signature": signature, "tier": final_skill.tier if final_skill else "speculative",
            })
            if promoted_any:
                await d.session.send({
                    "type": "skill_promoted", "agentId": d.speaker_id, "slug": slug,
                    "from": "speculative", "to": "trusted",
                })
                log_skill_promoted(
                    agent_id=d.speaker_id, slug=slug,
                    runs_count=len(final_skill.runs) if final_skill else 0,
                )
            result = (
                f"Proposed {slug} ({final_skill.tier if final_skill else 'speculative'}). "
                + " | ".join(summaries)
                + (" → PROMOTED to trusted." if promoted_any else "")
            )
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "propose_skill", "result": result[:500],
    })
    return result


# Aliased import to avoid local-name shadow with the @agent.tool function above.
from .skills.registry import propose_skill as propose_skill_record  # noqa: E402


@agent.tool
async def call_peer_skill(
    ctx: RunContext[TurnDeps],
    slug: str,
    inputs: dict[str, Any],
) -> str:
    """Invoke one of your peer's TRUSTED skills with concrete inputs.
    Speculative skills cannot be called by peers."""
    d = ctx.deps
    await d.session.send({
        "type": "tool_call_start", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "call_peer_skill", "args": {"slug": slug, "inputs": inputs},
    })
    if not monty_enabled():
        result = "Refused: skill execution sandbox is disabled."
    else:
        peer_skill = get_skill(d.peer_id, slug)
        if not peer_skill:
            available = [s.slug for s in list_skills(d.peer_id) if s.tier == "trusted"]
            result = f'No peer skill "{slug}". Trusted: {", ".join(available) or "none"}'
        elif peer_skill.tier != "trusted":
            result = f"Refused: {slug} is still speculative."
        else:
            exec_res = await execute_skill(peer_skill.code, inputs)
            await d.session.send({
                "type": "skill_called", "callerAgentId": d.speaker_id,
                "ownerAgentId": d.peer_id, "slug": slug, "ok": exec_res.ok, "ms": exec_res.ms,
            })
            log_skill_called(
                caller=d.speaker_id, owner=d.peer_id, slug=slug,
                ok=exec_res.ok, ms=exec_res.ms,
            )
            result = (
                f"{slug}({json.dumps(inputs)[:80]}) → {json.dumps(exec_res.output, default=str)[:300]} ({exec_res.ms}ms)"
                if exec_res.ok
                else f"{slug} FAILED: {exec_res.error}"
            )
    await d.session.send({
        "type": "tool_call_end", "turnIndex": d.turn_index, "speaker": d.speaker_id,
        "tool": "call_peer_skill", "result": result[:500],
    })
    return result


# ── Turn machinery ──────────────────────────────────────────────────────


def _build_message_history(speaker_id: str, transcript: list[TranscriptTurn]) -> list[ModelMessage]:
    """Build pydantic_ai message history from the alternating transcript.

    From `speaker_id`'s perspective: their own past turns are assistant,
    the peer's are user.
    """
    history: list[ModelMessage] = []
    for turn in transcript:
        if turn.speaker == speaker_id:
            history.append(ModelResponse(parts=[TextPart(content=turn.text)]))
        else:
            history.append(ModelRequest(parts=[UserPromptPart(content=turn.text)]))
    return history


async def _run_one_turn(session: ConversationSession, turn_index: int, speaker_id: str, peer_id: str) -> tuple[str, str | None]:
    deps = TurnDeps(session, speaker_id, peer_id, turn_index, session.max_turns)
    await session.send({"type": "turn_start", "turnIndex": turn_index, "speaker": speaker_id})

    # Pop the peer's most recent text as the live "user" prompt; keep the
    # rest of the transcript as message_history (alternating user/assistant
    # from this speaker's POV).
    if session.transcript and session.transcript[-1].speaker != speaker_id:
        prompt = session.transcript[-1].text
        history = _build_message_history(speaker_id, session.transcript[:-1])
    else:
        prompt = "(Your turn — speak directly to your peer.)"
        history = _build_message_history(speaker_id, session.transcript)

    accumulated = ""
    with turn_span(turn_index=turn_index, speaker=speaker_id, peer=peer_id):
        async with agent.run_stream(prompt, deps=deps, message_history=history) as response:
            async for delta in response.stream_text(delta=True):
                accumulated += delta
                await session.send({
                    "type": "turn_delta", "turnIndex": turn_index,
                    "speaker": speaker_id, "text": delta,
                })

    await session.send({
        "type": "turn_complete", "turnIndex": turn_index,
        "speaker": speaker_id, "fullText": accumulated,
    })
    return accumulated, session.ended_reason


def _diff_count(before: dict[str, str], after: dict[str, str]) -> int:
    changes = 0
    for path, content in after.items():
        if path == "index.md":
            continue
        if path not in before:
            changes += 1
        elif before[path] != content:
            changes += 1
    return changes


# Active session map keyed by sessionId — used by stop_conversation.
_ACTIVE: dict[str, ConversationSession] = {}


async def run_conversation(*, ws: WebSocket, session_id: str, agent_a: str, agent_b: str, max_turns: int) -> None:
    if session_id in _ACTIVE:
        await ws.send_text(json.dumps({"type": "conversation_error", "message": "session already running"}))
        return
    if agent_a == agent_b:
        await ws.send_text(json.dumps({"type": "conversation_error", "message": "pick two different agents"}))
        return
    if not get_agent(agent_a) or not get_agent(agent_b):
        await ws.send_text(json.dumps({"type": "conversation_error", "message": "unknown agent"}))
        return

    safe_max = max(4, min(20, int(max_turns)))
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S-%fZ")[:-4] + "Z"
    recording_path = RECORDINGS_DIR / f"{ts}-{agent_a}-{agent_b}.jsonl"

    wiki_before = {agent_a: snapshot(agent_a), agent_b: snapshot(agent_b)}

    session = ConversationSession(
        ws=ws, session_id=session_id, agent_a=agent_a, agent_b=agent_b,
        max_turns=safe_max, recording_path=recording_path,
    )
    _ACTIVE[session_id] = session

    await session.send({
        "type": "conversation_started", "agentA": agent_a, "agentB": agent_b,
        "maxTurns": safe_max, "wikiBefore": wiki_before,
        "recording": recording_path.name,
    })

    end_reason = "max_turns"
    turns_used = 0
    with conversation_span(
        session_id=session_id, agent_a=agent_a, agent_b=agent_b, max_turns=safe_max,
    ) as parent_span:
        try:
            for turn in range(1, safe_max + 1):
                if session.stop_requested:
                    end_reason = "stopped"
                    break
                speaker = agent_a if turn % 2 == 1 else agent_b
                peer = agent_b if speaker == agent_a else agent_a
                attempt = 0
                while attempt < 2:
                    try:
                        text, ended = await _run_one_turn(session, turn, speaker, peer)
                        session.transcript.append(TranscriptTurn(speaker=speaker, text=text))
                        turns_used = turn
                        if ended:
                            end_reason = "agent_ended"
                            await session.send({
                                "type": "conversation_ending",
                                "speaker": speaker, "reason": ended,
                            })
                        break
                    except Exception as e:  # noqa: BLE001
                        attempt += 1
                        print(f"[conversation] turn {turn} attempt {attempt} failed: {e}")
                        if attempt >= 2:
                            raise
                        await session.send({
                            "type": "conversation_error",
                            "message": "Anthropic call failed, retrying…",
                        })
                        await asyncio.sleep(0.8)
                if session.ended_reason:
                    break
        except Exception as e:  # noqa: BLE001
            print(f"[conversation] aborted: {e}")
            await session.send({
                "type": "conversation_error",
                "message": f"Conversation aborted: {e}",
            })
        finally:
            wiki_after = {agent_a: snapshot(agent_a), agent_b: snapshot(agent_b)}
            knowledge = _diff_count(wiki_before[agent_a], wiki_after[agent_a]) + _diff_count(
                wiki_before[agent_b], wiki_after[agent_b]
            )
            try:
                parent_span.set_attribute("end_reason", end_reason)
                parent_span.set_attribute("knowledge_score", knowledge)
                parent_span.set_attribute("turns_used", turns_used)
            except Exception:  # noqa: BLE001
                pass
            log_conversation_done(
                session_id=session_id, reason=end_reason,
                knowledge_score=knowledge, turns_used=turns_used,
            )
            await session.send({
                "type": "conversation_done", "reason": end_reason,
                "wikiAfter": wiki_after, "knowledgeScore": knowledge,
            })
            _ACTIVE.pop(session_id, None)

            # Fire-and-forget auditor — produces a typed AuditReport,
            # writes it to data/audits/, and feeds back into future
            # conversations' system prompts via recent_guidance().
            # Disabled by default now — was creating noise in the wiki
            # graph (lessons.md per agent + _audits/ dir). Re-enable with
            # `UNICORN_ENABLE_AUDIT=1` if the lessons feedback loop is
            # actively useful.
            async def _run_audit() -> None:
                if not os.environ.get("UNICORN_ENABLE_AUDIT", "").strip():
                    return
                if recording_path is None:
                    return
                report = await audit_conversation(
                    session_id=session_id,
                    agent_a=agent_a,
                    agent_b=agent_b,
                    turns_used=turns_used,
                    recording_path=recording_path,
                    wiki_before=wiki_before,
                    wiki_after=wiki_after,
                )
                if report is not None:
                    try:
                        await ws.send_text(json.dumps({
                            "type": "audit_done",
                            "sessionId": session_id,
                            "summary": report.summary,
                            "next_run_guidance": report.next_run_guidance,
                            "failure_modes": [fm.name for fm in report.failure_modes],
                        }))
                    except Exception:  # noqa: BLE001
                        pass  # WS may have closed

            asyncio.create_task(_run_audit())


def stop_conversation(session_id: str) -> bool:
    s = _ACTIVE.get(session_id)
    if not s:
        return False
    s.stop_requested = True
    return True
