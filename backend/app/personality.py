"""Deterministic personality → animation-parameter mapping.

Derives PersonalityAnimParams from an agent's persona_md text or
canonical_id. No LLM call — pure keyword matching + heuristics.
The output drives SpriteAnimator on the frontend so each agent
walks, idles, and fidgets distinctly.

Budget: $0 per agent. Runs at ingest/clone time and on-the-fly
as a fallback when personality_anim is NULL.
"""
from __future__ import annotations

import hashlib
import re
from typing import Literal

from pydantic import BaseModel, Field


class PersonalityAnimParams(BaseModel):
    energy: float = Field(ge=0.0, le=1.0, default=0.5)
    sociability: float = Field(ge=0.0, le=1.0, default=0.5)
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    quirk: Literal["none", "bounce", "sway", "fidget"] = "none"
    walk_style: Literal["strut", "shuffle", "bounce", "glide"] = "glide"


# ── Keyword sets ─────────────────────────────────────────────────────

_HIGH_ENERGY = {
    "enthusiastic", "energetic", "passionate", "excitable", "driven",
    "fast", "intense", "dynamic", "spontaneous", "restless",
    "caffeine", "hustle", "grind",
}
_LOW_ENERGY = {
    "calm", "quiet", "reserved", "thoughtful", "measured", "patient",
    "steady", "relaxed", "serene", "gentle", "contemplative",
    "methodical", "careful",
}
_HIGH_SOCIABILITY = {
    "social", "extrovert", "outgoing", "talkative", "charismatic",
    "networking", "community", "people", "collaborative", "team",
    "whole room", "connector", "party",
}
_LOW_SOCIABILITY = {
    "introvert", "solitary", "independent", "private", "lone",
    "deeply", "focused", "heads-down", "analytical", "detail",
}
_HIGH_CONFIDENCE = {
    "leader", "confident", "assertive", "decisive", "bold",
    "ambitious", "founder", "ceo", "director", "manager",
    "senior", "expert", "authority", "mentor",
}
_LOW_CONFIDENCE = {
    "junior", "learning", "curious", "student", "new",
    "uncertain", "exploring", "tentative", "humble",
}

# Canonical agent role → personality override (hand-tuned).
_CANONICAL_OVERRIDES: dict[str, PersonalityAnimParams] = {
    "support": PersonalityAnimParams(
        energy=0.6, sociability=0.9, confidence=0.7,
        quirk="bounce", walk_style="glide",
    ),
    "engineering": PersonalityAnimParams(
        energy=0.7, sociability=0.4, confidence=0.8,
        quirk="fidget", walk_style="strut",
    ),
    "design": PersonalityAnimParams(
        energy=0.5, sociability=0.6, confidence=0.7,
        quirk="sway", walk_style="glide",
    ),
    "sales": PersonalityAnimParams(
        energy=0.8, sociability=0.9, confidence=0.9,
        quirk="bounce", walk_style="strut",
    ),
    "marketing": PersonalityAnimParams(
        energy=0.7, sociability=0.8, confidence=0.8,
        quirk="bounce", walk_style="bounce",
    ),
    "product": PersonalityAnimParams(
        energy=0.6, sociability=0.7, confidence=0.8,
        quirk="sway", walk_style="glide",
    ),
    "data": PersonalityAnimParams(
        energy=0.4, sociability=0.3, confidence=0.7,
        quirk="fidget", walk_style="shuffle",
    ),
    "research": PersonalityAnimParams(
        energy=0.3, sociability=0.3, confidence=0.6,
        quirk="fidget", walk_style="shuffle",
    ),
}


def _score_keywords(text: str, positive: set[str], negative: set[str]) -> float:
    """Score 0..1 based on keyword hits. Default 0.5 if no signal."""
    words = set(re.findall(r"[a-z]+", text.lower()))
    pos = len(words & positive)
    neg = len(words & negative)
    total = pos + neg
    if total == 0:
        return 0.5
    return min(1.0, max(0.0, 0.5 + (pos - neg) * 0.15))


def _pick_quirk(energy: float, sociability: float) -> Literal["none", "bounce", "sway", "fidget"]:
    if energy > 0.7:
        return "bounce"
    if sociability < 0.35:
        return "fidget"
    if energy > 0.5:
        return "sway"
    return "none"


def _pick_walk_style(
    confidence: float, energy: float,
) -> Literal["strut", "shuffle", "bounce", "glide"]:
    if confidence > 0.75:
        return "strut"
    if energy > 0.7:
        return "bounce"
    if confidence < 0.35:
        return "shuffle"
    return "glide"


def _hash_seed(agent_id: str) -> float:
    """Deterministic float 0..1 from agent ID, for gentle randomization."""
    h = hashlib.md5(agent_id.encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def compute_personality_anim(
    *,
    agent_id: str,
    canonical_id: str | None = None,
    persona_md: str | None = None,
    social_style: str | None = None,
) -> PersonalityAnimParams:
    """Derive animation params from available agent data.

    Priority:
    1. Canonical override (hand-tuned per role)
    2. persona_md keyword analysis
    3. social_style from twin_profile
    4. Deterministic hash-based defaults (unique per agent)
    """
    # 1. Canonical agents — hand-tuned overrides.
    if canonical_id and canonical_id in _CANONICAL_OVERRIDES:
        return _CANONICAL_OVERRIDES[canonical_id]

    # 2. Build from text signals.
    text = ""
    if persona_md:
        text += persona_md + " "
    if social_style:
        text += social_style

    if text.strip():
        energy = _score_keywords(text, _HIGH_ENERGY, _LOW_ENERGY)
        sociability = _score_keywords(text, _HIGH_SOCIABILITY, _LOW_SOCIABILITY)
        confidence = _score_keywords(text, _HIGH_CONFIDENCE, _LOW_CONFIDENCE)
    else:
        # 3. Hash-based defaults — at least every agent is unique.
        seed = _hash_seed(agent_id)
        energy = 0.3 + seed * 0.4          # 0.3..0.7
        sociability = 0.3 + (1 - seed) * 0.4  # inverse correlation
        confidence = 0.4 + (seed * 0.3)

    quirk = _pick_quirk(energy, sociability)
    walk_style = _pick_walk_style(confidence, energy)

    return PersonalityAnimParams(
        energy=round(energy, 2),
        sociability=round(sociability, 2),
        confidence=round(confidence, 2),
        quirk=quirk,
        walk_style=walk_style,
    )
