"""Consult flow — ask the synthetic team a question.

Sequential rebuttal: each chosen agent sees the prior answers and is
told to find the angle they missed. This breaks the "everyone defaults
to the consultant median" failure mode that pure parallel queries hit.

Frames streamed to the WS client:

    consult_started   { question }
    routing           { chosen_ids, reasoning }
    answer_start      { profile_id }
    answer            { profile_id, position, reasoning, angle,
                        confidence, caveats }
    verdict           { summary, consensus, contributing_ids,
                        disagreements }
    consult_done      {}
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Awaitable, Callable, Literal

from fastapi import WebSocket
from pydantic import BaseModel, Field
from pydantic_ai import Agent

from .agents import DEFAULT_WORLD, get_agent, get_agents, get_ingested_expertise
from .conversation import _build_model
from .dossier import AskerDossier, build_dossier, dossier_block_for_agent

EventCallback = Callable[[dict], Awaitable[None]]

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "wikis"

# Curated expertise tags. Hand-rolled rather than scraped from
# personality.md so the Router gets a clean signal.
EXPERTISE: dict[str, list[str]] = {
    "marketing":   ["positioning", "growth", "content", "launches", "brand"],
    "engineering": ["architecture", "performance", "rate-limits", "api-design", "infrastructure"],
    "product":     ["design", "user-research", "prototyping", "copy", "flows"],
    "sales":       ["pricing", "enterprise-deals", "contracts", "objections", "procurement"],
    "support":     ["escalations", "onboarding", "documentation", "bug-triage", "user-empathy"],
    "success":     ["retention", "expansion", "account-management", "qbrs", "health-scores"],
}


# ── Output models ─────────────────────────────────────────────────────


class Routing(BaseModel):
    chosen_ids: list[str] = Field(min_length=2, max_length=10)
    reasoning: str
    confidence: float = Field(
        default=0.5, ge=0.0, le=1.0,
        description="How well the roster matches the question. 0.9+ = strong domain experts, 0.5-0.7 = tangential, <0.5 = no real expert.",
    )


class Answer(BaseModel):
    profile_id: str = ""
    position: str = Field(description="ONE sentence stance.")
    reasoning: str = Field(description="2–4 sentences grounded in your domain.")
    angle: str = Field(description="ONE sentence on the lens prior answers missed.")
    personal_note: str = Field(
        default="",
        description="ONE sentence on how you personalized this for the asker, referencing specific knowledge about them. E.g. 'Since you gym near Canary Wharf with Jun...'",
    )
    confidence: float = Field(ge=0.0, le=1.0)
    caveats: list[str] = Field(default_factory=list)


class Takeaway(BaseModel):
    """One contributor's distilled advice."""
    profile_id: str = Field(description="Agent id of the contributor.")
    keyword: str = Field(description="One or two word theme, e.g. 'Focus first' or 'Validate demand'.")
    summary: str = Field(description="One sentence distilling this person's advice.")


class Verdict(BaseModel):
    headline: str = Field(
        description="The direct answer in 3-8 words. Not 'Aligned' or 'Split' — the actual recommendation. E.g. 'Austin, Texas' or 'Stay in London, move to Hackney' or 'Yes, but wait until September'.",
    )
    confidence: float = Field(
        ge=0.0, le=1.0,
        description="How confident the team is in this recommendation, 0-1.",
    )
    summary: str = Field(description="Two sentences: decision then biggest caveat.")
    personal_context: str = Field(
        default="",
        description="ONE sentence on how this verdict specifically accounts for the asker's personal situation, referencing concrete facts.",
    )
    personal_facts: list[str] = Field(
        default_factory=list,
        description="2-4 specific facts about the asker that shaped this verdict. E.g. 'Your social circle is in East London', 'You gym with Jun near Canary Wharf'. Short, concrete, no fluff.",
    )
    consensus: Literal["aligned", "split", "contested"]
    mode: Literal["digest", "debate"] = Field(
        description="'digest' when answers are complementary advice to distill; 'debate' when there's genuine disagreement or ambiguity to explore."
    )
    contributing_ids: list[str] = Field(default_factory=list)
    disagreements: list[str] = Field(default_factory=list)
    takeaways: list[Takeaway] = Field(
        default_factory=list,
        description="Per-contributor keyword + one-liner. Always populated; especially useful in digest mode.",
    )


class HistoryRound(BaseModel):
    """One prior Q&A round — sent by the frontend for follow-ups."""
    question: str
    answers: list[Answer] = Field(default_factory=list)
    verdict: Verdict | None = None


class ConsultResult(BaseModel):
    """Final structured output of a consult — what callers (MCP, HTTP, in-process) see."""

    question: str
    world: str
    chosen_ids: list[str] = Field(default_factory=list)
    routing_reasoning: str = ""
    answers: list[Answer] = Field(default_factory=list)
    verdict: Verdict | None = None
    error: str | None = None


# ── Agent factories ───────────────────────────────────────────────────


def _agent_cards(world: str = DEFAULT_WORLD) -> list[dict]:
    """Cards for the router. Restricted to a single world — cross-world
    consults must go through the MCP bridge, not the router. Role
    agents get curated EXPERTISE; ingested colleagues get their
    topic-page slugs as expertise tags so the Router can route to
    them too."""
    cards = []
    for a in get_agents(world):
        cards.append({
            "id": a.id,
            "name": a.name,
            "role": a.role,
            "expertise": EXPERTISE.get(a.id) or get_ingested_expertise(a.id),
        })
    return cards


def _load_persona(agent_id: str) -> str:
    """Bundle personality.md + belief pages so the agent answers in voice."""
    base = DATA_DIR / agent_id
    if not base.exists():
        return ""
    skip = {"lessons.md", f"{get_agent(agent_id).name if get_agent(agent_id) else ''}.md"}
    parts: list[str] = []
    persona = base / "personality.md"
    if persona.exists():
        parts.append(persona.read_text(encoding="utf-8"))
    for p in sorted(base.glob("*.md")):
        if p.name == "personality.md" or p.name in skip:
            continue
        parts.append(p.read_text(encoding="utf-8"))
    return "\n\n---\n\n".join(parts)


def _router_agent() -> Agent[None, Routing]:
    return Agent(
        _build_model(),
        output_type=Routing,
        system_prompt=(
            "You are the Router for a team of synthetic colleagues.\n\n"
            "The user message contains a QUESTION and an AGENT_CARDS list.\n"
            "Pick the 2–4 colleagues whose role and expertise best match.\n\n"
            "Rules:\n"
            "- Smallest set that genuinely covers the question.\n"
            "- Include agents whose life experience or social context is\n"
            "  relevant, not just domain experts.\n"
            "- Order by relevance — most relevant first.\n"
            "- chosen_ids must be ids that actually appear in AGENT_CARDS.\n"
            "- reasoning: one short paragraph naming each pick and why.\n"
            "- confidence: How well THIS roster matches the question.\n"
            "  0.9+ = you have domain experts for this topic.\n"
            "  0.5-0.7 = tangential matches, no direct expert.\n"
            "  <0.5 = nobody in this roster is a good fit.\n"
            "  Be HONEST — if the roster doesn't have the right people,\n"
            "  say so with low confidence. Don't pretend bad matches are good.\n"
            "- If PRIOR_DISCUSSION is present, the user is asking a follow-up.\n"
            "  You may pick different experts if the follow-up shifts domains,\n"
            "  or the same ones if continuity matters.\n"
        ),
    )


def _profile_agent(agent_id: str, dossier: AskerDossier | None = None) -> Agent[None, Answer]:
    a = get_agent(agent_id)
    name = a.name if a else agent_id
    role = a.role if a else "expert"
    persona = _load_persona(agent_id)

    dossier_section = ""
    if dossier:
        block = dossier_block_for_agent(agent_id, dossier)
        dossier_section = (
            "# About the person asking\n"
            f"{block}\n\n"
        )

    personal_note_rule = (
        "- `personal_note`: ONE sentence referencing something specific you\n"
        "  know about the asker from the context above. Draw on your\n"
        "  relationship, shared experiences, or what you know about their\n"
        "  situation. E.g. 'Since you live near Whitechapel and your social\n"
        "  circle is in East London...' If you have no personal knowledge,\n"
        "  say 'I don't know you personally, but based on your profile...'\n"
    ) if dossier else ""

    return Agent(
        _build_model(),
        output_type=Answer,
        system_prompt=(
            f"You are {name}, {role}.\n\n"
            "# Your wiki (personality + beliefs)\n"
            f"{persona}\n\n"
            f"{dossier_section}"
            "# How to answer\n"
            "The user message contains:\n"
            "  QUESTION — what the team is being asked.\n"
            "  PRIOR_ANSWERS — typed Answer JSON from colleagues consulted\n"
            "                  before you (may be empty if you go first).\n\n"
            "Hard rules:\n"
            "- `position`: ONE sentence stance YOU would take from your seat.\n"
            "- `reasoning`: 2–4 sentences. Reference at least one of your\n"
            "  beliefs by title; name a specific from your domain (metric,\n"
            "  tool, workflow).\n"
            "- `angle`: ONE sentence naming the lens you bring that the\n"
            "  PRIOR_ANSWERS did not cover. If they fully covered it,\n"
            "  set confidence ≤ 0.5 and say so in caveats.\n"
            f"{personal_note_rule}"
            "- If PRIOR_DISCUSSION is present, treat it as context from the\n"
            "  same meeting. Reference prior conclusions when relevant but\n"
            "  focus your answer on the new QUESTION.\n"
            "- No 'it depends.' Pick the side you'd back in the meeting.\n"
            "- Do NOT give the generic best-practice answer. Your value is\n"
            "  the angle no one else has. PERSONALIZE your answer for the\n"
            "  person asking — use what you know about them.\n"
            f"- Set profile_id to \"{agent_id}\".\n"
        ),
    )


def _synthesizer_agent(dossier: AskerDossier | None = None) -> Agent[None, Verdict]:
    dossier_section = ""
    if dossier:
        dossier_section = (
            f"\n# Personal context about the asker\n"
            f"The asker is {dossier.asker_name}. {dossier.summary}\n\n"
        )
    return Agent(
        _build_model(),
        output_type=Verdict,
        system_prompt=(
            "You are the Synthesizer for a synthetic team of experts.\n"
            "The user message contains the QUESTION and a typed ANSWERS list.\n\n"
            f"{dossier_section}"
            "Produce a Verdict:\n"
            "- headline: The DIRECT ANSWER in 3-8 words. NOT 'Aligned' or\n"
            "  'Split' — the actual recommendation the asker needs.\n"
            "  E.g. 'Austin, Texas', 'Stay — move to Hackney',\n"
            "  'Yes, but wait until September'. Be specific and decisive.\n"
            "- confidence: 0-1 how confident the team is. 0.9+ = strong\n"
            "  agreement, 0.5-0.7 = real trade-offs, <0.5 = genuinely unsure.\n"
            "- summary: TWO sentences. First: the decision. Second: the\n"
            "  biggest caveat or live disagreement. Take a side.\n"
            "- personal_context: ONE sentence on how this verdict specifically\n"
            "  accounts for the asker's personal situation. Reference concrete\n"
            "  facts (their location, relationships, projects, interests).\n"
            "- personal_facts: 2-4 SHORT bullet facts about the asker that\n"
            "  shaped this verdict. E.g. 'Social circle in East London',\n"
            "  'Gym with Jun near Canary Wharf', 'Building a social virtual world with\n"
            "  Sage'. These must be REAL facts from the context, not generic.\n"
            "- consensus: 'aligned' (all back compatible positions),\n"
            "  'split' (different emphases, no direct contradiction),\n"
            "  or 'contested' (at least one direct opposition).\n"
            "- mode: choose based on the nature of the answers:\n"
            "  'digest' — answers are complementary advice, tips, or information\n"
            "    that should be distilled into takeaways (e.g. 'how should I…',\n"
            "    'what do you recommend…', factual questions). Most aligned\n"
            "    answers are digest.\n"
            "  'debate' — answers contain genuine disagreement, tension, or\n"
            "    ambiguity worth exploring (e.g. 'should we X or Y?',\n"
            "    contested topics). Split/contested answers are usually debate.\n"
            "- takeaways: one per contributor. keyword = 1-2 word theme,\n"
            "  summary = one sentence distilling their unique angle.\n"
            "  ALWAYS populate this.\n"
            "- disagreements: one short bullet per genuine contradiction.\n"
            "  Empty if aligned. Only relevant in debate mode.\n\n"
            "Rules:\n"
            "- Don't average. Pick the strongest argument and lead with it.\n"
            "- Confidence-weight: a 0.9 expert beats a 0.4 expert on conflict.\n"
            "- If PRIOR_DISCUSSION is present, build on prior verdicts rather\n"
            "  than repeating them. Note when the follow-up changes the picture.\n"
        ),
    )


# ── Orchestrator ──────────────────────────────────────────────────────


async def _emit(on_event: EventCallback | None, frame: dict) -> None:
    if on_event is not None:
        await on_event(frame)


async def consult_world(
    question: str,
    world: str = DEFAULT_WORLD,
    *,
    history: list[HistoryRound] | None = None,
    on_event: EventCallback | None = None,
) -> ConsultResult:
    """Run a full consult inside a single world and return the structured result.

    Pure orchestration — does not know about WebSockets. If `on_event` is
    provided, the same per-step frames the WS handler used to send go to
    that callback (router pick, each answer, verdict, etc). The MCP bridge
    calls this with no callback; the WS handler wraps it with a callback
    that forwards each frame to the socket. That's how an orchestrator in
    another world consults this one "as if it were its own world."
    """
    result = ConsultResult(question=question, world=world)
    await _emit(on_event, {"type": "consult_started", "question": question, "world": world})

    # Build a context block from prior rounds so agents see the full discussion.
    history_block = ""
    if history:
        # Keep it compact: questions + verdicts + condensed answers.
        rounds_json = []
        for h in history:
            rounds_json.append({
                "question": h.question,
                "answers": [{"profile_id": a.profile_id, "position": a.position, "angle": a.angle}
                            for a in h.answers],
                "verdict": h.verdict.model_dump() if h.verdict else None,
            })
        history_block = "PRIOR_DISCUSSION:\n" + json.dumps(rounds_json, indent=2) + "\n\n"

    # 1. Routing
    cards = _agent_cards(world)
    if not cards:
        result.error = f"no agents in world '{world}'"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    try:
        routing_result = await _router_agent().run(
            f"{history_block}QUESTION: {question}\n\nAGENT_CARDS:\n{json.dumps(cards, indent=2)}"
        )
    except Exception as exc:  # noqa: BLE001
        result.error = f"router failed: {exc}"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result
    routing = routing_result.output

    valid_ids = {c["id"] for c in cards}
    chosen = [pid for pid in routing.chosen_ids if pid in valid_ids]
    if not chosen:
        result.error = "router picked no valid agents"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result
    result.chosen_ids = chosen
    result.routing_reasoning = routing.reasoning
    await _emit(on_event, {
        "type": "routing",
        "chosen_ids": chosen,
        "reasoning": routing.reasoning,
    })

    # 1b. Build asker dossier — what the network knows about who's asking
    dossier = build_dossier()  # hardcoded to "support" (Joon) for hackathon
    await _emit(on_event, {
        "type": "dossier",
        "asker_name": dossier.asker_name,
        "relationships": [r.model_dump() for r in dossier.relationships],
        "knowledge": [k.model_dump() for k in dossier.knowledge[:15]],
        "summary": dossier.summary,
    })

    # 2. Sequential answers — each agent sees prior answers + asker dossier
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
            answer_result = await _profile_agent(pid, dossier=dossier).run(prompt)
            answer = answer_result.output
        except Exception as exc:  # noqa: BLE001
            await _emit(on_event, {
                "type": "answer_error",
                "profile_id": pid,
                "message": str(exc),
            })
            continue

        answer = answer.model_copy(update={"profile_id": pid})
        answers.append(answer)
        await _emit(on_event, {
            "type": "answer",
            "profile_id": pid,
            "position": answer.position,
            "reasoning": answer.reasoning,
            "angle": answer.angle,
            "personal_note": answer.personal_note,
            "confidence": answer.confidence,
            "caveats": answer.caveats,
        })
    result.answers = answers

    if not answers:
        result.error = "no answers collected"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    # 3. Synthesize
    try:
        synth_result = await _synthesizer_agent(dossier=dossier).run(
            f"{history_block}QUESTION: {question}\n\nANSWERS:\n"
            + json.dumps([a.model_dump() for a in answers], indent=2)
        )
        verdict = synth_result.output
    except Exception as exc:  # noqa: BLE001
        result.error = f"synthesizer failed: {exc}"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    verdict = verdict.model_copy(
        update={"contributing_ids": [a.profile_id for a in answers]}
    )
    result.verdict = verdict
    await _emit(on_event, {
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
    })
    await _emit(on_event, {"type": "consult_done"})
    return result


WORLD_LABELS: dict[str, str] = {
    "joon": "your network",
    "sage": "Sage's network",
    "yuri": "Yuri's network",
}

WORLD_ORDER = ["joon", "sage", "yuri"]


async def multi_world_consult(
    question: str,
    *,
    home_world: str = "joon",
    history: list[HistoryRound] | None = None,
    on_event: EventCallback | None = None,
    confidence_threshold: float = 0.6,
) -> ConsultResult:
    """Progressive multi-world search: start in home_world, expand if needed."""
    from .introductions import find_introduction_path

    result = ConsultResult(question=question, world=home_world)
    await _emit(on_event, {"type": "consult_started", "question": question, "world": home_world})

    # Build history block
    history_block = ""
    if history:
        rounds_json = []
        for h in history:
            rounds_json.append({
                "question": h.question,
                "answers": [{"profile_id": a.profile_id, "position": a.position, "angle": a.angle}
                            for a in h.answers],
                "verdict": h.verdict.model_dump() if h.verdict else None,
            })
        history_block = "PRIOR_DISCUSSION:\n" + json.dumps(rounds_json, indent=2) + "\n\n"

    # Build asker dossier
    dossier = build_dossier()
    await _emit(on_event, {
        "type": "dossier",
        "asker_name": dossier.asker_name,
        "relationships": [r.model_dump() for r in dossier.relationships],
        "knowledge": [k.model_dump() for k in dossier.knowledge[:15]],
        "summary": dossier.summary,
    })

    # Determine world search order: home first, then others
    worlds_to_search = [home_world] + [w for w in WORLD_ORDER if w != home_world]

    best_world: str | None = None
    best_routing: Routing | None = None
    best_confidence = 0.0
    searched_worlds: list[str] = []

    for world in worlds_to_search:
        cards = _agent_cards(world)
        if not cards:
            continue

        agent_ids = [c["id"] for c in cards]
        await _emit(on_event, {
            "type": "search_phase",
            "world": world,
            "world_label": WORLD_LABELS.get(world, world),
            "agent_ids": agent_ids,
        })

        try:
            routing_result = await _router_agent().run(
                f"{history_block}QUESTION: {question}\n\nAGENT_CARDS:\n{json.dumps(cards, indent=2)}"
            )
            routing = routing_result.output
        except Exception as exc:  # noqa: BLE001
            await _emit(on_event, {
                "type": "search_routing",
                "world": world,
                "confidence": 0,
                "reasoning": f"Router failed: {exc}",
                "chosen_ids": [],
            })
            continue

        valid_ids = {c["id"] for c in cards}
        chosen = [pid for pid in routing.chosen_ids if pid in valid_ids]
        conf = routing.confidence

        await _emit(on_event, {
            "type": "search_routing",
            "world": world,
            "confidence": conf,
            "reasoning": routing.reasoning,
            "chosen_ids": chosen,
        })
        searched_worlds.append(world)

        if conf > best_confidence:
            best_confidence = conf
            best_world = world
            best_routing = routing

        if conf >= confidence_threshold and chosen:
            break  # good enough, stop searching

        # Emit expanding frame if we'll continue
        next_idx = worlds_to_search.index(world) + 1
        if next_idx < len(worlds_to_search):
            await _emit(on_event, {
                "type": "search_expanding",
                "from_world": world,
                "to_world": worlds_to_search[next_idx],
                "reason": routing.reasoning,
            })

    if not best_world or not best_routing:
        result.error = "no suitable agents found in any world"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    # Use the best world's routing
    valid_ids = {c["id"] for c in _agent_cards(best_world)}
    chosen = [pid for pid in best_routing.chosen_ids if pid in valid_ids]
    if not chosen:
        result.error = "router picked no valid agents"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    result.chosen_ids = chosen
    result.routing_reasoning = best_routing.reasoning
    result.world = best_world

    # Emit search_found
    await _emit(on_event, {
        "type": "search_found",
        "world": best_world,
        "agent_ids": chosen,
        "expertise_match": best_routing.reasoning[:120],
    })

    # If the matched world isn't home, compute introduction path and activate
    if best_world != home_world:
        for pid in chosen[:2]:  # intro path for top 2 picks
            path = find_introduction_path("support", pid)
            if path:
                await _emit(on_event, {
                    "type": "introduction",
                    "path": path,
                    "from_world": home_world,
                    "to_world": best_world,
                })

        await _emit(on_event, {
            "type": "world_activated",
            "world": best_world,
            "world_label": WORLD_LABELS.get(best_world, best_world),
        })

    # Standard routing frame for downstream UI
    await _emit(on_event, {
        "type": "routing",
        "chosen_ids": chosen,
        "reasoning": best_routing.reasoning,
    })

    # Sequential answers
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
            answer_result = await _profile_agent(pid, dossier=dossier).run(prompt)
            answer = answer_result.output
        except Exception as exc:  # noqa: BLE001
            await _emit(on_event, {
                "type": "answer_error",
                "profile_id": pid,
                "message": str(exc),
            })
            continue

        answer = answer.model_copy(update={"profile_id": pid})
        answers.append(answer)
        await _emit(on_event, {
            "type": "answer",
            "profile_id": pid,
            "position": answer.position,
            "reasoning": answer.reasoning,
            "angle": answer.angle,
            "personal_note": answer.personal_note,
            "confidence": answer.confidence,
            "caveats": answer.caveats,
        })
    result.answers = answers

    if not answers:
        result.error = "no answers collected"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    # Synthesize
    try:
        synth_result = await _synthesizer_agent(dossier=dossier).run(
            f"{history_block}QUESTION: {question}\n\nANSWERS:\n"
            + json.dumps([a.model_dump() for a in answers], indent=2)
        )
        verdict = synth_result.output
    except Exception as exc:  # noqa: BLE001
        result.error = f"synthesizer failed: {exc}"
        await _emit(on_event, {"type": "consult_error", "message": result.error})
        return result

    verdict = verdict.model_copy(
        update={"contributing_ids": [a.profile_id for a in answers]}
    )
    result.verdict = verdict
    await _emit(on_event, {
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
        "worlds_searched": searched_worlds,
    })
    await _emit(on_event, {"type": "consult_done"})
    return result


async def run_consult(
    *, ws: WebSocket, question: str, world: str = DEFAULT_WORLD,
    history: list[HistoryRound] | None = None,
) -> None:
    """WS-streaming wrapper — forwards each consult event over the socket."""

    async def emit(frame: dict) -> None:
        await ws.send_text(json.dumps(frame))

    await multi_world_consult(question, home_world=world, history=history, on_event=emit)
