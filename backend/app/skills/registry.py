"""Skill registry — speculative/trusted tiers, JSON on disk, promotion rule."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from ..models import Skill, SkillRun

SKILLS_ROOT = Path(
    os.environ.get(
        "SKILLS_DIR", str(Path(__file__).resolve().parent.parent.parent / "data" / "skills")
    )
)
PROMOTION_THRESHOLD = int(os.environ.get("SKILL_PROMOTION_THRESHOLD", "3"))
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")


def is_valid_skill_slug(slug: str) -> bool:
    return bool(SLUG_RE.match(slug))


def _agent_dir(agent_id: str) -> Path:
    return SKILLS_ROOT / agent_id


def _registry_file(agent_id: str) -> Path:
    return _agent_dir(agent_id) / "registry.json"


def _ensure_dir(agent_id: str) -> None:
    _agent_dir(agent_id).mkdir(parents=True, exist_ok=True)


def _read(agent_id: str) -> dict[str, Skill]:
    _ensure_dir(agent_id)
    f = _registry_file(agent_id)
    if not f.exists():
        return {}
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
        return {slug: Skill(**data) for slug, data in raw.items()}
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        print(f"[skills/registry] parse failed for {agent_id}: {e}")
        return {}


def _write(agent_id: str, reg: dict[str, Skill]) -> None:
    _ensure_dir(agent_id)
    serialised = {slug: skill.model_dump(mode="json") for slug, skill in reg.items()}
    _registry_file(agent_id).write_text(
        json.dumps(serialised, indent=2, default=str), encoding="utf-8"
    )


def get_skill(agent_id: str, slug: str) -> Skill | None:
    return _read(agent_id).get(slug)


def list_skills(agent_id: str) -> list[Skill]:
    return list(_read(agent_id).values())


def list_all_skills() -> dict[str, list[Skill]]:
    out: dict[str, list[Skill]] = {}
    if not SKILLS_ROOT.exists():
        return out
    for d in SKILLS_ROOT.iterdir():
        if d.is_dir():
            out[d.name] = list_skills(d.name)
    return out


def propose_skill(
    *, agent_id: str, slug: str, signature: str, code: str, justification: str
) -> tuple[bool, Skill | str]:
    if not is_valid_skill_slug(slug):
        return False, f'Invalid skill slug "{slug}". Lowercase a-z 0-9 and underscores only.'
    if len(code) > 4096:
        return False, "Skill code exceeds 4096 byte cap."
    if not re.search(r"def\s+skill\s*\(", code):
        return False, "Skill code must define a top-level `def skill(**kwargs)`."
    reg = _read(agent_id)
    if slug in reg:
        return False, f'Skill "{slug}" already exists.'
    now_ms = int(time.time() * 1000)
    skill = Skill(
        slug=slug,
        signature=signature[:500],
        code=code,
        justification=justification[:500],
        proposed_by=agent_id,
        tier="speculative",
        runs=[],
        created_at=now_ms,
        updated_at=now_ms,
    )
    reg[slug] = skill
    _write(agent_id, reg)
    return True, skill


def record_run(agent_id: str, slug: str, run: SkillRun) -> tuple[bool, Skill | None]:
    """Returns (promoted, skill)."""
    reg = _read(agent_id)
    skill = reg.get(slug)
    if not skill:
        return False, None
    skill.runs.append(run)
    skill.updated_at = int(time.time() * 1000)
    promoted = False
    if skill.tier == "speculative":
        successes = sum(1 for r in skill.runs if r.ok)
        failures = sum(1 for r in skill.runs if not r.ok)
        if successes >= PROMOTION_THRESHOLD and failures == 0:
            skill.tier = "trusted"
            promoted = True
    reg[slug] = skill
    _write(agent_id, reg)
    return promoted, skill
