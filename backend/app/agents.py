"""Agent registry — derived live from `data/wikis/`.

Source of truth: each subdirectory of `data/wikis/` with a
`personality.md` is one agent. Name, subtitle, and one-line
description are parsed straight out of that file. Edit the wiki,
restart the backend, the frontend reflects it.

Role agents (sales / support / marketing / product / success /
engineering) get their stable colours from `_ROLE_COLORS` so the pixel
office layout stays recognisable; ingested colleagues cycle through
the purple/pink palette.

A "world" is a self-contained orchestrator scope: agents only consult
and converse with peers inside the same world by default. Cross-world
calls go through the MCP bridge (`mcp_server.consult_world`), not
through the regular pickers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

GROUPS_DIR = Path(__file__).resolve().parent.parent / "groups"
WIKIS_DIR = Path(__file__).resolve().parent.parent / "data" / "wikis"

# Stable colours and display order for the six core role agents.
_ROLE_COLORS: dict[str, str] = {
    "sales":       "#6366f1",
    "support":     "#10b981",
    "marketing":   "#f59e0b",
    "product":     "#3b82f6",
    "success":     "#14b8a6",
    "engineering": "#ef4444",
}
_ROLE_ORDER: list[str] = list(_ROLE_COLORS.keys())

# Cycle for everyone else (ingested colleagues).
_INGESTED_PALETTE: list[str] = [
    "#a855f7",  # purple
    "#ec4899",  # pink
    "#0ea5e9",  # sky
    "#f97316",  # orange
    "#84cc16",  # lime
    "#06b6d4",  # cyan
]

DEFAULT_WORLD = "joon"

_AGENT_WORLDS: dict[str, str] = {"support": "joon", "success": "sage", "engineering": "yuri", "marketing": "yuri", "product": "yuri", "sales": "yuri"}


@dataclass
class Agent:
    id: str
    name: str
    role: str
    description: str
    color: str
    world: str = field(default=DEFAULT_WORLD)
    photo: str = field(default="")

    def to_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "description": self.description,
            "color": self.color,
            "world": self.world,
            "photo": self.photo,
        }


COMPANY = {"name": "Unicorn Intelligence", "tagline": "Six colleagues, one wiki. Click anyone."}


# ── Wiki parsing ────────────────────────────────────────────────────


_WHO_AM_I_RE = re.compile(r"^# (?:Who I Am[ \-—–]+)?(?P<name>.+?)\s*$")
_SUBTITLE_RE = re.compile(r"^\*+(?P<sub>[^*]+?)\*+\s*$")
_ONE_LINE_RE = re.compile(r"^## In one line\s*\n(?P<body>.+?)(?=\n##|\Z)", re.DOTALL | re.MULTILINE)


def _parse_persona(md: str) -> dict[str, str]:
    """Pull `name`, `subtitle`, `one_line`, `photo` from a personality.md.

    `photo` lives in the YAML frontmatter (e.g. `photo: /profiles/marketing.svg`)
    so the wiki is the source of truth for which image the drawer renders.
    """
    photo = ""
    body = md
    if md.startswith("---\n"):
        end = md.find("\n---", 4)
        if end != -1:
            try:
                fm = yaml.safe_load(md[4:end]) or {}
            except yaml.YAMLError:
                fm = {}
            if isinstance(fm, dict):
                photo = str(fm.get("photo") or "").strip()
            body = md[end + 4:].lstrip("\n")

    name = ""
    subtitle = ""
    for line in body.splitlines()[:60]:
        line = line.strip()
        if not name:
            m = _WHO_AM_I_RE.match(line)
            if m:
                name = m.group("name").strip()
                continue
        if name and not subtitle:
            m = _SUBTITLE_RE.match(line)
            if m:
                subtitle = m.group("sub").strip().rstrip(".")
                break
    one_line = ""
    m = _ONE_LINE_RE.search(body)
    if m:
        one_line = m.group("body").strip().split("\n")[0]
    return {"name": name, "subtitle": subtitle, "one_line": one_line, "photo": photo}


# ── Public API ──────────────────────────────────────────────────────


def list_all_agents() -> list[Agent]:
    """Scan `data/wikis/` and build the full agent list every call.

    Returns role agents in `_ROLE_ORDER` first, then ingested
    colleagues alphabetically. The frontend pixel office reads this via
    `/api/agents`, so an edit to a personality.md (after restart) shows
    up live.
    """
    if not WIKIS_DIR.exists():
        return []
    role_agents: dict[str, Agent] = {}
    ingested_agents: list[Agent] = []

    for sub in sorted(WIKIS_DIR.iterdir()):
        if not sub.is_dir() or sub.name.startswith("_"):
            continue
        persona = sub / "personality.md"
        if not persona.exists():
            continue

        info = _parse_persona(persona.read_text(encoding="utf-8"))
        slug = sub.name
        name = info["name"] or slug.replace("-", " ").title()
        world = _AGENT_WORLDS.get(slug, DEFAULT_WORLD)

        if slug in _ROLE_COLORS:
            role_agents[slug] = Agent(
                id=slug,
                name=name,
                role=info["subtitle"] or "Colleague",
                description=info["one_line"] or "",
                color=_ROLE_COLORS[slug],
                world=world,
                photo=info.get("photo", ""),
            )
        else:
            ingested_agents.append(Agent(
                id=slug,
                name=name,
                role=info["subtitle"] or "Ingested colleague",
                description=info["one_line"] or f"Ingested from chat. See data/wikis/{slug}/personality.md.",
                color=_INGESTED_PALETTE[len(ingested_agents) % len(_INGESTED_PALETTE)],
                world=world,
                photo=info.get("photo", ""),
            ))

    return [role_agents[s] for s in _ROLE_ORDER if s in role_agents] + ingested_agents


def list_role_agents() -> list[Agent]:
    return [a for a in list_all_agents() if a.id in _ROLE_COLORS]


def list_ingested_agents() -> list[Agent]:
    return [a for a in list_all_agents() if a.id not in _ROLE_COLORS]


def get_agent(agent_id: str) -> Agent | None:
    for a in list_all_agents():
        if a.id == agent_id:
            return a
    return None


def get_agents(world: str | None = None) -> list[Agent]:
    """Roster, optionally filtered to a single world."""
    if world is None:
        return list_all_agents()
    return [a for a in list_all_agents() if a.world == world]


def list_worlds() -> list[str]:
    """Distinct worlds present in the roster, in stable order."""
    seen: list[str] = []
    for a in list_all_agents():
        if a.world not in seen:
            seen.append(a.world)
    return seen


def get_system_prompt(agent_id: str) -> str:
    """Read the persona prompt.

    Tries `groups/<id>.md` first (where the six core role agents
    historically lived), then falls back to
    `data/wikis/<id>/personality.md` so ingested colleagues work in
    `/conversation` and `/consult` too.
    """
    p = GROUPS_DIR / f"{agent_id}.md"
    if p.exists():
        return p.read_text(encoding="utf-8")
    persona = WIKIS_DIR / agent_id / "personality.md"
    if persona.exists():
        return persona.read_text(encoding="utf-8")
    return f"You are {agent_id}."


def get_ingested_expertise(agent_id: str) -> list[str]:
    """Topic-page slugs for an ingested colleague — used by the Router
    so consult queries can land on them."""
    folder = WIKIS_DIR / agent_id
    if not folder.exists():
        return []
    skip_stems = {"personality", "lessons", "README"}
    persona = folder / "personality.md"
    if persona.exists():
        info = _parse_persona(persona.read_text(encoding="utf-8"))
        if info["name"]:
            skip_stems.add(info["name"])
    return [p.stem for p in sorted(folder.glob("*.md")) if p.stem not in skip_stems]


# Backwards-compat shim — many call sites do `from .agents import AGENTS`
# and treat it as a list. Keep the symbol lazy via `__getattr__` so each
# access is a fresh wiki scan.
def __getattr__(name: str):  # noqa: D401
    if name == "AGENTS":
        return list_all_agents()
    raise AttributeError(name)
