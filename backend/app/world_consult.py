"""Worlds-layer consult — "Ask my world".

Sibling of `app/consult.py`. The legacy module orchestrates the
canonical agents loaded from `data/wikis/`; this one runs the same
Router → sequential Answers → Synthesizer Verdict loop against the
DB-backed agents in `public.agents` (the user-ingested colleagues +
the canonical starters provisioned by `handle_new_user`).

WS frame names are identical to consult.py (`consult_started`,
`routing`, `dossier`, `answer_start`, `answer`, `verdict`,
`consult_done`, `consult_error`, `answer_error`) so frontend
rendering can be shared with `frontend/app/consult/ConsultView.tsx`.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict, deque
from typing import Any, Awaitable, Callable

import logfire
from fastapi import WebSocket
from pydantic_ai import Agent

from .auth import CurrentUser
from .consult import (
    Answer,
    HistoryRound,
    Routing,
    Verdict,
    _router_agent,
    _synthesizer_agent,
)
from .conversation import _build_model
from .db import acquire
from .dossier import AskerDossier, build_dossier_db, dossier_block_for_agent

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


# ── Rate limiter (per-user, sliding window) ───────────────────────────
#
# Mirrors the chat rate limiter in `world_chat.py`. Consult is heavier
# (one router call + N profile calls + one synthesizer call), so we
# cap it tighter — 6 per hour per user — and apply it uniformly
# (owners included; this is their own world but each consult is still
# 4× the cost of a chat turn).


_RATE_LIMIT_WINDOW_S = 60 * 60
_RATE_LIMIT_MAX = 6
_rate_buckets: dict[str, deque[float]] = defaultdict(deque)


def _check_rate_limit(user_id: str) -> int | None:
    now = time.monotonic()
    bucket = _rate_buckets[user_id]
    cutoff = now - _RATE_LIMIT_WINDOW_S
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) < _RATE_LIMIT_MAX:
        return None
    oldest = bucket[0]
    return int(_RATE_LIMIT_WINDOW_S - (now - oldest)) + 1


def _record_consult(user_id: str) -> None:
    _rate_buckets[user_id].append(time.monotonic())


# ── DB-backed agent loaders ───────────────────────────────────────────


async def _agent_cards_db(world_id: str, owner_user_id: str) -> list[dict[str, Any]]:
    """Build router cards for every agent in the asker's home world.

    The card shape matches `consult._agent_cards` exactly (id, name,
    role, expertise) so `_router_agent`'s system prompt works unchanged.
    Expertise is no longer a curated list of tags — instead we pass a
    single-element list containing a short blurb derived from the
    agent's subtitle + the first ~250 chars of their persona. The
    Router is plenty capable of routing on free text.
    """
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id::text as id,
                   display_name,
                   coalesce(subtitle, 'colleague') as subtitle,
                   coalesce(persona_md, '') as persona_md
            from public.agents
            where world_id = $1
              and owner_user_id = $2
            order by created_at asc
            """,
            world_id,
            owner_user_id,
        )
    cards: list[dict[str, Any]] = []
    for r in rows:
        blurb = _persona_blurb(r["persona_md"], max_len=250)
        expertise = blurb if blurb else (r["subtitle"] or "")
        cards.append(
            {
                "id": r["id"],
                "name": r["display_name"],
                "role": r["subtitle"],
                "expertise": [expertise] if expertise else [],
                # Carry the full row through so we don't need a second
                # SELECT inside _profile_agent_db. Not seen by the LLM —
                # cards passed to Router are JSON-serialised but the
                # router only sees the four fields above.
                "_row": dict(r),
            }
        )
    return cards


def _persona_blurb(persona_md: str, *, max_len: int = 250) -> str:
    """Strip frontmatter + headings and take the first chunk of prose."""
    body = persona_md or ""
    while body.startswith("---\n"):
        end = body.find("\n---", 4)
        if end == -1:
            break
        body = body[end + 4 :].lstrip("\n")
    # Drop heading lines so we get prose.
    keep_lines: list[str] = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        keep_lines.append(s)
        if sum(len(x) for x in keep_lines) > max_len:
            break
    blurb = " ".join(keep_lines)
    if len(blurb) > max_len:
        blurb = blurb[: max_len - 1].rsplit(" ", 1)[0] + "…"
    return blurb


def _profile_agent_db(card: dict[str, Any], dossier: AskerDossier | None) -> Agent[None, Answer]:
    """DB-backed sibling of `consult._profile_agent`.

    The card carries `_row` from `_agent_cards_db` so we don't re-query.
    System prompt mirrors the legacy version's structure (you are X,
    here is your wiki, here is who's asking, hard rules for the Answer
    fields) — keeping the per-agent voice consistent with what the
    1-1 chat drawer uses, which also embeds `persona_md` as the wiki.
    """
    row = card["_row"]
    agent_id = card["id"]
    name = card["name"] or "an unnamed agent"
    role = card["role"] or "colleague"
    persona = row.get("persona_md") or ""

    dossier_section = ""
    if dossier:
        block = dossier_block_for_agent(agent_id, dossier)
        dossier_section = f"# About the person asking\n{block}\n\n"

    personal_note_rule = (
        "- `personal_note`: ONE sentence referencing something specific you\n"
        "  know about the asker from the context above. If you have no\n"
        "  personal knowledge of them yet, say 'I don't know you personally,\n"
        "  but based on what I see…' — do not invent specifics.\n"
    ) if dossier else ""

    return Agent(
        _build_model(),
        output_type=Answer,
        system_prompt=(
            f"You are {name}, {role}. Stay strictly in character — voice,\n"
            "opinions, the things you'd actually say.\n\n"
            "# Your wiki\n"
            f"{persona}\n\n"
            f"{dossier_section}"
            "# How to answer\n"
            "The user message contains:\n"
            "  QUESTION — what your world is being asked.\n"
            "  PRIOR_ANSWERS — typed Answer JSON from colleagues consulted\n"
            "                  before you (may be empty if you go first).\n\n"
            "Hard rules:\n"
            "- `position`: ONE sentence stance YOU would take from your seat.\n"
            "- `reasoning`: 2–4 sentences. Reference your domain specifics —\n"
            "  the projects, beliefs, or experiences your wiki mentions.\n"
            "- `angle`: ONE sentence naming the lens you bring that the\n"
            "  PRIOR_ANSWERS did not cover. If they fully covered it, set\n"
            "  confidence ≤ 0.5 and say so in caveats.\n"
            f"{personal_note_rule}"
            "- If PRIOR_DISCUSSION is present, treat it as context from the\n"
            "  same meeting. Reference prior conclusions when relevant but\n"
            "  focus your answer on the new QUESTION.\n"
            "- No 'it depends.' Pick the side you'd back in the meeting.\n"
            "- Do NOT give the generic best-practice answer. Your value is\n"
            "  the angle no one else has.\n"
            f"- Set profile_id to \"{agent_id}\".\n"
        ),
    )


# ── Orchestrator (own world only) ─────────────────────────────────────


async def _emit(on_event: EventCallback | None, frame: dict[str, Any]) -> None:
    if on_event is not None:
        await on_event(frame)


async def consult_world_db(
    *,
    question: str,
    world_id: str,
    owner_user_id: str,
    asker_display_name: str,
    history: list[HistoryRound] | None = None,
    on_event: EventCallback | None = None,
) -> None:
    """Run a full consult inside the user's home world.

    Mirrors `consult.consult_world` but reads agents + persona from
    Postgres and skips the multi-world expansion logic. Frame names
    are identical so frontend rendering is shared.
    """
    await _emit(on_event, {"type": "consult_started", "question": question})

    history_block = ""
    if history:
        rounds_json = []
        for h in history:
            rounds_json.append(
                {
                    "question": h.question,
                    "answers": [
                        {
                            "profile_id": a.profile_id,
                            "position": a.position,
                            "angle": a.angle,
                        }
                        for a in h.answers
                    ],
                    "verdict": h.verdict.model_dump() if h.verdict else None,
                }
            )
        history_block = "PRIOR_DISCUSSION:\n" + json.dumps(rounds_json, indent=2) + "\n\n"

    # 1. Routing
    cards = await _agent_cards_db(world_id, owner_user_id)
    if not cards:
        await _emit(on_event, {"type": "consult_error", "message": "no agents in your world"})
        return

    # The router only cares about the four LLM-facing fields; strip
    # the carry-through `_row` before rendering as JSON.
    router_cards = [{k: v for k, v in c.items() if not k.startswith("_")} for c in cards]

    try:
        routing_result = await _router_agent().run(
            f"{history_block}QUESTION: {question}\n\nAGENT_CARDS:\n{json.dumps(router_cards, indent=2)}"
        )
    except Exception as exc:  # noqa: BLE001
        await _emit(on_event, {"type": "consult_error", "message": f"router failed: {exc}"})
        return
    routing: Routing = routing_result.output

    valid_ids = {c["id"] for c in cards}
    chosen = [pid for pid in routing.chosen_ids if pid in valid_ids]
    if not chosen:
        await _emit(on_event, {"type": "consult_error", "message": "router picked no valid agents"})
        return

    await _emit(
        on_event,
        {"type": "routing", "chosen_ids": chosen, "reasoning": routing.reasoning},
    )

    # 1b. Asker dossier — what the world knows about the user.
    dossier = await build_dossier_db(
        asker_user_id=owner_user_id,
        asker_display_name=asker_display_name,
        world_id=world_id,
    )
    await _emit(
        on_event,
        {
            "type": "dossier",
            "asker_name": dossier.asker_name,
            "relationships": [r.model_dump() for r in dossier.relationships],
            "knowledge": [k.model_dump() for k in dossier.knowledge[:15]],
            "summary": dossier.summary,
        },
    )

    # 2. Sequential answers
    card_by_id = {c["id"]: c for c in cards}
    answers: list[Answer] = []
    for pid in chosen:
        await _emit(on_event, {"type": "answer_start", "profile_id": pid})

        if answers:
            prior_block = "PRIOR_ANSWERS:\n" + json.dumps(
                [a.model_dump() for a in answers], indent=2
            )
        else:
            prior_block = "PRIOR_ANSWERS: (you are the first to answer)"
        prompt = f"{history_block}QUESTION: {question}\n\n{prior_block}"

        try:
            answer_result = await _profile_agent_db(card_by_id[pid], dossier=dossier).run(prompt)
            answer = answer_result.output
        except Exception as exc:  # noqa: BLE001
            await _emit(
                on_event,
                {"type": "answer_error", "profile_id": pid, "message": str(exc)},
            )
            continue

        # Sonnet hallucinates ids — overwrite with the id we sent.
        answer = answer.model_copy(update={"profile_id": pid})
        answers.append(answer)
        await _emit(
            on_event,
            {
                "type": "answer",
                "profile_id": pid,
                "position": answer.position,
                "reasoning": answer.reasoning,
                "angle": answer.angle,
                "personal_note": answer.personal_note,
                "confidence": answer.confidence,
                "caveats": answer.caveats,
            },
        )

    if not answers:
        await _emit(on_event, {"type": "consult_error", "message": "no answers collected"})
        return

    # 3. Synthesize
    try:
        synth_result = await _synthesizer_agent(dossier=dossier).run(
            f"{history_block}QUESTION: {question}\n\nANSWERS:\n"
            + json.dumps([a.model_dump() for a in answers], indent=2)
        )
        verdict: Verdict = synth_result.output
    except Exception as exc:  # noqa: BLE001
        await _emit(on_event, {"type": "consult_error", "message": f"synthesizer failed: {exc}"})
        return

    verdict = verdict.model_copy(update={"contributing_ids": [a.profile_id for a in answers]})
    await _emit(
        on_event,
        {
            "type": "verdict",
            "headline": verdict.headline,
            "confidence": verdict.confidence,
            "summary": verdict.summary,
            "personal_context": verdict.personal_context,
            "personal_facts": verdict.personal_facts,
            "consensus": verdict.consensus,
            "mode": verdict.mode,
            "contributing_ids": verdict.contributing_ids,
            "disagreements": verdict.disagreements,
            "takeaways": [t.model_dump() for t in verdict.takeaways],
        },
    )
    await _emit(on_event, {"type": "consult_done"})


# ── WS adapter ────────────────────────────────────────────────────────


async def run_world_consult(
    *,
    ws: WebSocket,
    user: CurrentUser,
    world_id: str,
    asker_display_name: str,
    question: str,
    history: list[HistoryRound] | None = None,
) -> None:
    """WS-streaming wrapper. Forwards each frame to the socket."""

    async def emit(frame: dict[str, Any]) -> None:
        await ws.send_text(json.dumps(frame))

    retry = _check_rate_limit(user.id)
    if retry is not None:
        await emit(
            {
                "type": "consult_rate_limited",
                "retry_after_seconds": retry,
            }
        )
        return
    _record_consult(user.id)

    with logfire.span(
        "world_consult",
        user_id=user.id,
        world_id=world_id,
        question=question,
    ):
        await consult_world_db(
            question=question,
            world_id=world_id,
            owner_user_id=user.id,
            asker_display_name=asker_display_name,
            history=history,
            on_event=emit,
        )


# Hold a reference so the asyncio import isn't dropped by the linter when
# main.py spawns this via create_task.
_ = asyncio
