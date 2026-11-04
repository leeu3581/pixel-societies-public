"""Concreteness evaluator — scores whether agents grounded their turns
in specific things they actually own (belief pages, real names, real
numbers) instead of inventing abstract metaphors.

Built on `pydantic-evals`. The evaluator is invoked at the end of an
audit pass, but can also be run standalone against any recording on
disk. The score is a single float in [0, 1] per agent, plus per-turn
detail for explainability in the dashboard.

Why this is the right eval:
- It's mechanical (regex over text), not LLM-judged → fast, reproducible.
- It maps directly to the user's stated complaint ("conversations feel
  abstract"). Higher score = more concrete = the bug is fixed.
- It runs against the real recording so it's a post-hoc measure of
  actual conversation behaviour, not a synthetic benchmark.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from ..wiki.store import WIKIS_ROOT


# ── Specifics extraction ────────────────────────────────────────────────

# Year — "Lisbon 2019", "1992 family album"
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
# Number with unit — "$500", "3 frames", "6 weeks"
_NUMBER_UNIT_RE = re.compile(
    r"\$?\b\d+(?:\.\d+)?\b\s?(?:frames?|tracks?|weeks?|months?|days?|hours?|"
    r"years?|times?|seats?|users?|customers?/[a-z]+|%|x|/seat|/month|/day)?",
    re.IGNORECASE,
)
# Italics title — *Illuminance*, *Slow Horses*
_ITALICS_RE = re.compile(r"\*([^*\n]{2,80}?)\*")
# Quoted thing — "demure", "specific gravity"
_QUOTED_RE = re.compile(r"['\"]([^'\"\n]{2,80}?)['\"]")
# Proper noun — capitalized word, not at sentence start. We approximate
# by finding any Capital-Letter-then-lowercase word that isn't preceded
# by `.`, `!`, `?`, or start-of-string.
_PROPER_NOUN_RE = re.compile(r"(?<![.!?]\s)(?<!^)(?<!\n)\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b")


_PROPER_NOUN_STOPLIST = {
    "i", "yes", "no", "ok", "okay", "even", "what", "this", "that", "but",
    "and", "the", "a", "an", "some", "how", "why", "when", "where", "who",
    "or", "if", "so", "though", "whether", "exactly", "actually", "really",
    "definitely", "honestly", "true", "right", "left", "good", "bad",
    "first", "next", "then", "now", "later", "also", "still", "always",
    "yeah", "mm", "huh", "well",
}


def extract_specifics(text: str) -> tuple[set[str], set[str]]:
    """Return (always_concrete, citation_candidates) for a turn.

    `always_concrete` — things that are inherently specific regardless of
    whether they appear in the agent's wiki: italicised titles, quoted
    phrases, years, numbers with units. Reading *Sound of Metal* in a
    turn IS concrete grounding even if Yuri's wiki never mentioned it.

    `citation_candidates` — proper nouns. These only count as concrete
    when they overlap the wiki ground truth (otherwise sentence-start
    capitalisation produces noise).
    """
    always: set[str] = set()
    citations: set[str] = set()
    for m in _YEAR_RE.findall(text):
        always.add(m.lower().strip())
    for m in _NUMBER_UNIT_RE.findall(text):
        s = m.lower().strip()
        if s and any(c.isalpha() or c == "%" or c == "$" for c in s):
            always.add(s)
    for m in _ITALICS_RE.findall(text):
        always.add(m.lower().strip())
    for m in _QUOTED_RE.findall(text):
        always.add(m.lower().strip())
    for m in _PROPER_NOUN_RE.findall(text):
        cand = m.lower().strip()
        if cand in _PROPER_NOUN_STOPLIST:
            continue
        if len(cand) < 3:
            continue
        citations.add(cand)
    return always, citations


# ── Belief specifics indexing ───────────────────────────────────────────


def specifics_for_agent(agent_id: str) -> set[str]:
    """Pull the set of proper nouns / specifics that appear on an
    agent's wiki pages. Used as the citation corpus."""
    agent_dir = WIKIS_ROOT / agent_id
    if not agent_dir.exists():
        return set()
    out: set[str] = set()
    for p in agent_dir.iterdir():
        if p.suffix != ".md":
            continue
        always, citations = extract_specifics(p.read_text(encoding="utf-8"))
        out.update(always)
        out.update(citations)
    return out


# ── Recording → per-turn texts ──────────────────────────────────────────


def turns_from_recording(path: Path) -> list[dict[str, Any]]:
    """Return [{turn, speaker, text}, ...] from a JSONL recording."""
    if not path.exists():
        return []
    texts: dict[int, str] = {}
    speakers: dict[int, str] = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") == "turn_start":
                speakers[e["turnIndex"]] = e["speaker"]
            elif e.get("type") == "turn_delta":
                texts.setdefault(e["turnIndex"], "")
                texts[e["turnIndex"]] += e.get("text", "")
    return [
        {"turn": k, "speaker": speakers.get(k, "?"), "text": texts[k].strip()}
        for k in sorted(texts)
    ]


# ── Score ───────────────────────────────────────────────────────────────


class ConcretenessReport(BaseModel):
    """Per-agent scoring of how often their turns referenced specifics."""

    agent_id: str
    turns_total: int
    turns_with_specific: int
    score: float          # turns_with_specific / turns_total
    specifics_pool: int   # how many distinct specifics that agent owns on disk
    specifics_used: list[str]   # which ones actually appeared in their turns
    abstract_metaphors_flagged: list[str]   # phrases like "specific gravity" we caught


# A short list of phrases that are tell-tale "agent invented a metaphor"
# moments — these are bad signal. Used to flag, not to score (yet).
_METAPHOR_FLAGS = [
    "specific gravity", "complexity as armor", "core feeling",
    "found its own weight", "venue mismatch tax", "space anxiety",
    "the texture of", "the somatic", "creative confidence",
]


def score_recording(
    *, recording_path: Path, agent_a: str, agent_b: str,
) -> dict[str, ConcretenessReport]:
    """Run the concreteness evaluator on a finished conversation.
    Returns one report per participant."""
    turns = turns_from_recording(recording_path)
    out: dict[str, ConcretenessReport] = {}
    for agent_id in (agent_a, agent_b):
        own_specifics = specifics_for_agent(agent_id)
        # The peer's specifics also count — if Yuri references something
        # from Ellis's beliefs (e.g. quoting "mk.gee"), that's still real
        # cross-pollination.
        peer_id = agent_b if agent_id == agent_a else agent_a
        peer_specifics = specifics_for_agent(peer_id)
        ground_truth = own_specifics | peer_specifics

        my_turns = [t for t in turns if t["speaker"] == agent_id]
        used: set[str] = set()
        turns_with_specific = 0
        for t in my_turns:
            always, citations = extract_specifics(t["text"])
            citation_overlap = citations & ground_truth
            # A turn counts as concrete if it has ANY always-concrete
            # specific (italicised title, year, number-with-unit, quoted
            # phrase) OR any proper-noun overlap with the wiki ground
            # truth. Both shapes of grounding count.
            if always or citation_overlap:
                turns_with_specific += 1
            used.update(always)
            used.update(citation_overlap)
        flagged = []
        full_text = " ".join(t["text"].lower() for t in my_turns)
        for m in _METAPHOR_FLAGS:
            if m in full_text:
                flagged.append(m)
        score = (turns_with_specific / len(my_turns)) if my_turns else 0.0
        out[agent_id] = ConcretenessReport(
            agent_id=agent_id,
            turns_total=len(my_turns),
            turns_with_specific=turns_with_specific,
            score=round(score, 2),
            specifics_pool=len(own_specifics),
            specifics_used=sorted(used)[:20],
            abstract_metaphors_flagged=flagged,
        )
    return out


# ── Pydantic-Evals integration ──────────────────────────────────────────


class ConvoCase(BaseModel):
    """A test case = one recorded conversation."""

    recording_filename: str
    agent_a: str
    agent_b: str


class ConvoOutput(BaseModel):
    """Computed output: the per-agent reports."""

    reports: dict[str, ConcretenessReport]


@dataclass
class ConcreteSpecificsEvaluator(Evaluator[ConvoCase, ConvoOutput]):
    """Pydantic-evals Evaluator that returns the average score across both
    agents in the conversation. Score in [0, 1] — higher is more concrete."""

    threshold: float = 0.6

    def evaluate(self, ctx: EvaluatorContext[ConvoCase, ConvoOutput]) -> dict[str, Any]:
        reports = ctx.output.reports
        if not reports:
            return {"concreteness_avg": 0.0, "passed": False}
        avg = sum(r.score for r in reports.values()) / len(reports)
        flagged = sum(len(r.abstract_metaphors_flagged) for r in reports.values())
        return {
            "concreteness_avg": round(avg, 2),
            "passed": avg >= self.threshold,
            "metaphors_flagged_total": flagged,
        }


def build_dataset_from_recordings(
    recordings_dir: Path,
) -> Dataset[ConvoCase, ConvoOutput]:
    """Build a pydantic-evals Dataset from every recording on disk."""
    cases: list[Case[ConvoCase, ConvoOutput]] = []
    if not recordings_dir.exists():
        return Dataset(cases=[], evaluators=[ConcreteSpecificsEvaluator()])
    for p in sorted(recordings_dir.glob("*.jsonl")):
        # Filename pattern: 2026-04-25T15-26-03Z-<agentA>-<agentB>.jsonl
        stem = p.stem
        parts = stem.rsplit("-", 2)
        if len(parts) >= 3:
            agent_a, agent_b = parts[-2], parts[-1]
            cases.append(
                Case(
                    name=stem,
                    inputs=ConvoCase(
                        recording_filename=p.name,
                        agent_a=agent_a,
                        agent_b=agent_b,
                    ),
                )
            )
    return Dataset(cases=cases, evaluators=[ConcreteSpecificsEvaluator()])
