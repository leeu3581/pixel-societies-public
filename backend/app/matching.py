"""Co-founder matching — stage 1: deterministic complementarity scoring.

Design note (see docs/handoff/AGENT-A-WORLD-MATCHING.md): matching is
two-stage. This module is stage 1 — cheap, deterministic, explainable,
and LLM-free. It ranks every pair in a group and produces human-readable
evidence. Stage 2 (later) lets the two twins actually converse in the
Cafe and writes an LLM `rationale` onto the high scorers.

Keeping stage 1 LLM-free matters for three reasons:
  - cost is O(1) in LLM calls regardless of group size (pairs are O(n²))
  - every suggestion can show its working, which is the whole product
  - it is testable without a model in the loop

What we score for is **complementarity, not similarity**. Two people who
build the identical thing in the identical way are a weak co-founder
pair; two people deep in the same problem space from opposite ends are a
strong one. Similarity-only matching (what a naive embedding approach
gives you) ranks the first case highest, which is exactly backwards.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

# ── Weights ─────────────────────────────────────────────────────────
# Domain overlap and role complement are MULTIPLICATIVE, not additive.
#
# This is the whole trick, and getting it wrong is subtle. With additive
# weights, two people who build the identical thing in the identical way
# score near the top: their domain overlap is 1.0, which swamps the
# same-role penalty. That is precisely the pair you must not suggest —
# two founders with one skillset between them. Making the two terms gate
# each other means a pair needs BOTH a shared problem space AND
# different ends of it to rank at all.
#
# (Caught by the Felix/Gabi control pair in the seed data, which ranked
# 3rd of 190 under additive weights.)
W_CORE = 0.75      # sqrt(domain overlap) × role complement
W_STACK = 0.15     # bridge signal, not a goal
W_CADENCE = 0.10   # tiebreak

# How well two role leanings complement each other. Symmetric.
# High = different ends of the same build. Low = same job twice.
_ROLE_FIT: dict[frozenset[str], float] = {
    frozenset({"infra", "interface"}): 1.00,
    frozenset({"infra", "product"}): 0.95,
    frozenset({"research", "interface"}): 0.90,
    frozenset({"research", "product"}): 0.85,
    frozenset({"infra", "research"}): 0.65,
    frozenset({"interface", "product"}): 0.60,
    frozenset({"generalist", "infra"}): 0.55,
    frozenset({"generalist", "interface"}): 0.55,
    frozenset({"generalist", "product"}): 0.55,
    frozenset({"generalist", "research"}): 0.55,
}
_SAME_ROLE_FIT = 0.15  # same lean — weak pairing, but not zero


@dataclass
class Evidence:
    kind: str
    text: str

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "text": self.text}


@dataclass
class PairScore:
    agent_a: str
    agent_b: str
    score: float
    evidence: list[Evidence] = field(default_factory=list)

    def evidence_dicts(self) -> list[dict[str, str]]:
        return [e.as_dict() for e in self.evidence]


def _jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _role_fit(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.4  # unknown lean — neutral, don't reward or punish
    if a == b:
        return _SAME_ROLE_FIT
    return _ROLE_FIT.get(frozenset({a, b}), 0.5)


def _cadence_fit(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Similar working intensity → easier to actually collaborate.

    Compares sessions/week. Returns 1.0 for identical, decaying to 0 as
    the ratio diverges. Missing data is neutral (0.5), never punitive.
    """
    try:
        sa = float(a.get("sessions_per_week") or 0)
        sb = float(b.get("sessions_per_week") or 0)
    except (TypeError, ValueError):
        return 0.5
    if sa <= 0 or sb <= 0:
        return 0.5
    lo, hi = min(sa, sb), max(sa, sb)
    return lo / hi


def _stack_bridge(a: Iterable[str], b: Iterable[str]) -> float:
    """Some shared tooling is good (they can read each other's code);
    total overlap adds nothing on top of the role signal.

    Peaks around a third overlap and falls off at both extremes.
    """
    j = _jaccard(a, b)
    if j <= 0.34:
        return j / 0.34
    return max(0.0, 1.0 - (j - 0.34) / 0.66 * 0.55)


def score_pair(pa: dict[str, Any], pb: dict[str, Any]) -> PairScore:
    """Score one pair of builder_profiles rows. Pure function."""
    da, db = pa.get("domains") or [], pb.get("domains") or []
    sa, sb = pa.get("stacks") or [], pb.get("stacks") or []
    ca = pa.get("cadence") or {}
    cb = pb.get("cadence") or {}

    domain = _jaccard(da, db)
    role = _role_fit(pa.get("role_lean"), pb.get("role_lean"))
    stack = _stack_bridge(sa, sb)
    cadence = _cadence_fit(ca, cb)

    # sqrt softens the domain requirement so partial overlap still counts,
    # while the product keeps same-role pairs down regardless of overlap.
    core = (domain ** 0.5) * role
    raw = W_CORE * core + W_STACK * stack + W_CADENCE * cadence
    score = round(raw * 100, 3)

    ev: list[Evidence] = []

    shared_domains = sorted(set(da) & set(db))
    if shared_domains:
        ev.append(Evidence(
            "shared_domain",
            f"Both work in {_human_list(shared_domains)}.",
        ))

    ra, rb = pa.get("role_lean"), pb.get("role_lean")
    if ra and rb and ra != rb:
        ev.append(Evidence(
            "role_complement",
            f"Opposite ends of the same build — {pa.get('headline') or ra} "
            f"vs {pb.get('headline') or rb}.",
        ))
    elif ra and rb and ra == rb:
        ev.append(Evidence(
            "role_overlap",
            f"Both lean {ra} — likely to duplicate each other.",
        ))

    shared_stack = sorted(set(sa) & set(sb))
    if shared_stack:
        ev.append(Evidence(
            "shared_stack",
            f"Common ground in {_human_list(shared_stack)}.",
        ))

    only_a = sorted(set(sa) - set(sb))
    only_b = sorted(set(sb) - set(sa))
    if only_a and only_b:
        ev.append(Evidence(
            "stack_complement",
            f"{_human_list(only_a)} meets {_human_list(only_b)}.",
        ))

    if cadence >= 0.75:
        ev.append(Evidence(
            "cadence",
            "Similar build cadence — comparable weekly session counts.",
        ))

    return PairScore(
        agent_a=str(pa["agent_id"]),
        agent_b=str(pb["agent_id"]),
        score=score,
        evidence=ev,
    )


def _human_list(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])} and {items[-1]}"


def rank_group(profiles: list[dict[str, Any]]) -> list[PairScore]:
    """Score every unordered pair, best first.

    `agent_a` < `agent_b` on every result so pairs are canonical and
    match the `matches_pair_order` CHECK constraint.
    """
    out: list[PairScore] = []
    for i in range(len(profiles)):
        for j in range(i + 1, len(profiles)):
            pa, pb = profiles[i], profiles[j]
            # Canonical ordering by agent id, matching the DB constraint.
            if str(pa["agent_id"]) > str(pb["agent_id"]):
                pa, pb = pb, pa
            out.append(score_pair(pa, pb))
    out.sort(key=lambda p: p.score, reverse=True)
    return out
