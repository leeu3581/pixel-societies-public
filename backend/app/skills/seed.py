"""Boot-time seed of trusted skills. Runs all test_inputs through Monty
so the trusted tier is earned, not pretended. Idempotent."""

from __future__ import annotations

import time

from ..models import SkillRun
from .monty_client import execute_skill
from .registry import SKILLS_ROOT, propose_skill, record_run

SEEDS = [
    {
        "agent_id": "engineering",
        "slug": "score_playlist_shape",
        "signature": "score_playlist_shape(track_seconds: list[float], artists: list[str]) -> dict",
        "justification": "Lifts the 3-4-2 arc + max-one-repeat-artist heuristic from playlist-shapes.md into a callable scorer.",
        "code": "\n".join([
            "def skill(track_seconds, artists):",
            "    n = len(track_seconds)",
            "    issues = []",
            "    score = 100",
            "    if n < 6 or n > 12:",
            "        issues.append(f'length {n} outside the 6-12 sweet spot')",
            "        score -= 20",
            "    seen = {}",
            "    for a in artists:",
            "        seen[a] = seen.get(a, 0) + 1",
            "    repeats = sum(1 for c in seen.values() if c > 1)",
            "    if repeats > 1:",
            "        issues.append(f'{repeats} artists repeat — breaks the spell')",
            "        score -= 25",
            "    if n > 0:",
            "        sorted_s = sorted(track_seconds)",
            "        median = sorted_s[n // 2]",
            "        if track_seconds[-1] < median:",
            "            issues.append('closer is shorter than median — playlist trails off')",
            "            score -= 15",
            "    return {'score': max(0, score), 'issues': issues, 'tracks': n}",
        ]),
        "test_inputs": [
            {"track_seconds": [180, 200, 220, 240, 260, 230, 280], "artists": ["a", "b", "c", "d", "e", "f", "g"]},
            {"track_seconds": [120, 140, 200], "artists": ["a", "a", "b"]},
            {"track_seconds": [180, 200, 220, 240, 260, 230, 280, 300, 250], "artists": ["a", "b", "c", "a", "d", "b", "e", "f", "g"]},
        ],
    },
    {
        "agent_id": "marketing",
        "slug": "score_trend_durability",
        "signature": "score_trend_durability(weekly_post_counts: list[int], has_secondary_use: bool) -> dict",
        "justification": "Encodes the secondary-use heuristic + the 6-10 week 'having a moment' window.",
        "code": "\n".join([
            "def skill(weekly_post_counts, has_secondary_use):",
            "    weeks = len(weekly_post_counts)",
            "    if weeks < 4:",
            "        return {'verdict': 'too early', 'durability': 0.0, 'window_weeks': weeks}",
            "    peak = max(weekly_post_counts) or 1",
            "    last = weekly_post_counts[-1]",
            "    decay = last / peak",
            "    base = 0.4 + 0.5 * decay",
            "    if has_secondary_use:",
            "        base += 0.15",
            "    base = max(0.0, min(1.0, base))",
            "    if 6 <= weeks <= 10 and base >= 0.5:",
            "        verdict = 'having a moment'",
            "    elif weeks > 10 and base >= 0.5:",
            "        verdict = 'reference, not trend'",
            "    elif decay < 0.3:",
            "        verdict = 'already over'",
            "    else:",
            "        verdict = 'still rising'",
            "    return {'verdict': verdict, 'durability': round(base, 2), 'window_weeks': weeks}",
        ]),
        "test_inputs": [
            {"weekly_post_counts": [10, 30, 80, 120, 100, 70], "has_secondary_use": True},
            {"weekly_post_counts": [50, 40, 30, 10, 5], "has_secondary_use": False},
            {"weekly_post_counts": [10, 25, 60, 100, 90, 85, 80, 70], "has_secondary_use": True},
        ],
    },
]


async def seed_all_skills() -> None:
    for seed in SEEDS:
        agent_dir = SKILLS_ROOT / seed["agent_id"]
        if agent_dir.exists() and any(p.suffix == ".json" for p in agent_dir.iterdir()):
            continue  # already seeded
        ok, result = propose_skill(
            agent_id=seed["agent_id"],
            slug=seed["slug"],
            signature=seed["signature"],
            code=seed["code"],
            justification=seed["justification"],
        )
        if not ok:
            print(f"[skills/seed] {seed['agent_id']}/{seed['slug']} failed: {result}")
            continue
        for i, inputs in enumerate(seed["test_inputs"], 1):
            r = await execute_skill(seed["code"], inputs)
            run = SkillRun(
                ts=int(time.time() * 1000),
                ok=r.ok,
                ms=r.ms,
                case=f"seed_{i}",
                output=r.output if r.ok else None,
                error=r.error if not r.ok else None,
            )
            record_run(seed["agent_id"], seed["slug"], run)
        print(f"[skills/seed] seeded {seed['agent_id']}/{seed['slug']} ({len(seed['test_inputs'])} runs)")
