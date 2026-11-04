"""Asker dossier — what the wiki network knows about the person asking.

Scans all agent wikis for references to the asker (by name) and compiles
a structured dossier of relationships, knowledge facts, and the asker's
own context. No LLM call — pure text scanning.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from .agents import WIKIS_DIR, get_agent, list_all_agents

# The asker for the hackathon demo. In production this would come from
# auth / session, but for now we hardcode Joon (the "support" agent).
DEFAULT_ASKER_ID = "support"


class RelationshipFact(BaseModel):
    agent_id: str
    agent_name: str
    relationship: str
    source_file: str = ""


class KnowledgeFact(BaseModel):
    agent_id: str
    agent_name: str
    fact: str
    topic: str = ""
    source_file: str = ""


class AskerDossier(BaseModel):
    asker_id: str
    asker_name: str
    own_context: str = Field(default="", description="Condensed self-knowledge from asker's own wiki")
    relationships: list[RelationshipFact] = Field(default_factory=list)
    knowledge: list[KnowledgeFact] = Field(default_factory=list)
    summary: str = ""


def _strip_frontmatter(md: str) -> str:
    """Remove YAML frontmatter blocks."""
    body = md
    while body.startswith("---\n"):
        end = body.find("\n---", 4)
        if end == -1:
            break
        body = body[end + 4:].lstrip("\n")
    return body


def _first_heading(md: str) -> str:
    for line in md.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _parse_relationships_section(text: str, asker_name: str) -> list[tuple[str, str]]:
    """Parse ## Key relationships for entries mentioning the asker."""
    m = re.search(r"^## Key relationships\s*\n((?:.*\n)*?)(?=^## |\Z)", text, re.MULTILINE)
    if not m:
        return []
    hits = []
    name_pat = re.compile(re.escape(asker_name), re.IGNORECASE)
    for line in m.group(1).splitlines():
        rm = re.match(r"^\s*-\s+\[\[([^\]]+)\]\]\s*—\s*(.+)$", line)
        if rm and name_pat.search(rm.group(1)):
            hits.append((rm.group(1).strip(), rm.group(2).strip()))
    return hits


def _scan_for_mentions(text: str, asker_name: str) -> list[str]:
    """Find bullet points or sentences mentioning the asker by name."""
    pat = re.compile(r"\b" + re.escape(asker_name) + r"\b", re.IGNORECASE)
    hits = []
    for line in text.splitlines():
        if pat.search(line):
            clean = line.strip().lstrip("-*").strip()
            if len(clean) > 10 and len(clean) < 500:
                hits.append(clean)
    return hits


def _build_own_context(asker_id: str, asker_name: str) -> str:
    """Load the asker's own wiki and produce a condensed self-knowledge block."""
    base = WIKIS_DIR / asker_id
    if not base.exists():
        return ""

    parts = []

    # Load personality.md for core info
    persona = base / "personality.md"
    if persona.exists():
        body = _strip_frontmatter(persona.read_text(encoding="utf-8"))
        # Extract key sections
        for heading in ["in one line", "background", "what i do"]:
            m = re.search(
                rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=^## |\Z)",
                body, re.DOTALL | re.MULTILINE | re.IGNORECASE,
            )
            if m:
                content = m.group(1).strip()
                if content:
                    parts.append(content[:500])

    # Load hub page for relationships
    hub_candidates = list(base.glob("*.md"))
    a = get_agent(asker_id)
    hub_name = a.name if a else asker_name
    hub = base / f"{hub_name}.md"
    if hub.exists():
        hub_text = hub.read_text(encoding="utf-8")
        # Extract "What they do" section
        m = re.search(r"^## What they do\s*\n(.*?)(?=^## |\Z)", hub_text, re.DOTALL | re.MULTILINE)
        if m:
            parts.append(m.group(1).strip()[:400])

    # Load topic page titles as interests
    skip = {"personality.md", "lessons.md", "README.md"}
    if a:
        skip.add(f"{a.name}.md")
    topics = []
    for p in sorted(base.glob("*.md")):
        if p.name in skip:
            continue
        title = _first_heading(p.read_text(encoding="utf-8")) or p.stem.replace("-", " ").title()
        topics.append(title)
    if topics:
        parts.append("Known interests/topics: " + ", ".join(topics))

    return "\n\n".join(parts)


def build_dossier(asker_id: str = DEFAULT_ASKER_ID) -> AskerDossier:
    """Build the asker dossier by scanning all agent wikis."""
    a = get_agent(asker_id)
    asker_name = a.name if a else asker_id
    # Also check common short names
    name_variants = {asker_name}
    first_name = asker_name.split()[0] if asker_name else ""
    if first_name and first_name != asker_name:
        name_variants.add(first_name)

    relationships: list[RelationshipFact] = []
    knowledge: list[KnowledgeFact] = []

    for agent in list_all_agents():
        if agent.id == asker_id:
            continue  # skip self

        agent_dir = WIKIS_DIR / agent.id
        if not agent_dir.exists():
            continue

        # Check hub page for relationship entries
        hub = agent_dir / f"{agent.name}.md"
        if hub.exists():
            hub_text = hub.read_text(encoding="utf-8")
            for variant in name_variants:
                for _name, context in _parse_relationships_section(hub_text, variant):
                    relationships.append(RelationshipFact(
                        agent_id=agent.id,
                        agent_name=agent.name,
                        relationship=context,
                        source_file=f"{agent.name}.md",
                    ))

        # Scan topic pages for mentions
        skip = {"personality.md", "lessons.md", "README.md", f"{agent.name}.md"}
        for p in sorted(agent_dir.glob("*.md")):
            if p.name in skip:
                continue
            text = p.read_text(encoding="utf-8")
            topic_title = _first_heading(text) or p.stem.replace("-", " ").title()
            for variant in name_variants:
                for fact in _scan_for_mentions(text, variant):
                    knowledge.append(KnowledgeFact(
                        agent_id=agent.id,
                        agent_name=agent.name,
                        fact=fact,
                        topic=topic_title,
                        source_file=p.name,
                    ))

    # Deduplicate knowledge facts by fact text
    seen_facts: set[str] = set()
    unique_knowledge = []
    for k in knowledge:
        key = k.fact[:80].lower()
        if key not in seen_facts:
            seen_facts.add(key)
            unique_knowledge.append(k)
    knowledge = unique_knowledge[:20]  # cap to avoid prompt bloat

    own_context = _build_own_context(asker_id, asker_name)

    # Build human-readable summary
    rel_agents = list({r.agent_name for r in relationships})
    summary_parts = [f"Your network knows you through {len(rel_agents)} people."]
    for r in relationships[:6]:
        summary_parts.append(f"{r.agent_name}: {r.relationship}")
    summary = " ".join(summary_parts)

    return AskerDossier(
        asker_id=asker_id,
        asker_name=asker_name,
        own_context=own_context,
        relationships=relationships,
        knowledge=knowledge,
        summary=summary,
    )


async def build_dossier_db(
    *,
    asker_user_id: str,
    asker_display_name: str,
    world_id: str,
) -> AskerDossier:
    """DB-backed sibling of `build_dossier`.

    Scans `public.agents.persona_md` for every agent in the given world
    and harvests mentions of the asker's display_name. Same output shape
    as the filesystem dossier (`AskerDossier` with relationships +
    knowledge facts), so `dossier_block_for_agent` works unchanged.

    Skips the asker's own self-agent (canonical_id IS NULL AND
    owner_user_id = asker_user_id AND display_name = asker_display_name)
    so we don't surface mentions of the asker by themselves. The
    asker's `own_context` is filled from that same self-agent's
    persona_md if present.
    """
    # Local import to avoid a top-of-module dependency on the asyncpg
    # pool — keeps the legacy `build_dossier` importable in contexts
    # without a DB (e.g. tests, the MCP CLI).
    from .db import acquire

    name_variants = {asker_display_name}
    first = asker_display_name.split()[0] if asker_display_name else ""
    if first and first != asker_display_name:
        name_variants.add(first)

    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id::text as id,
                   display_name,
                   subtitle,
                   coalesce(persona_md, '') as persona_md,
                   canonical_id,
                   owner_user_id::text as owner_user_id
            from public.agents
            where world_id = $1
            order by created_at asc
            """,
            world_id,
        )

    relationships: list[RelationshipFact] = []
    knowledge: list[KnowledgeFact] = []
    own_context = ""

    for r in rows:
        is_self = (
            r["canonical_id"] is None
            and r["owner_user_id"] == asker_user_id
            and (r["display_name"] or "") == asker_display_name
        )
        body = _strip_frontmatter(r["persona_md"] or "")
        if is_self:
            # Use the asker's own persona as their self-knowledge anchor.
            own_context = body[:2000]
            continue

        # Hub-style "## Key relationships" entries that explicitly mention us.
        for variant in name_variants:
            for _name, context in _parse_relationships_section(body, variant):
                relationships.append(
                    RelationshipFact(
                        agent_id=r["id"],
                        agent_name=r["display_name"] or "",
                        relationship=context,
                        source_file="persona_md",
                    )
                )

        # Free-text mentions across the whole bundled persona.
        topic_title = _first_heading(body) or (r["display_name"] or "")
        for variant in name_variants:
            for fact in _scan_for_mentions(body, variant):
                knowledge.append(
                    KnowledgeFact(
                        agent_id=r["id"],
                        agent_name=r["display_name"] or "",
                        fact=fact,
                        topic=topic_title,
                        source_file="persona_md",
                    )
                )

    # Dedupe knowledge by leading text and cap to keep prompts compact.
    seen: set[str] = set()
    unique: list[KnowledgeFact] = []
    for k in knowledge:
        key = k.fact[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(k)
    knowledge = unique[:20]

    rel_agents = list({r.agent_name for r in relationships})
    summary_parts = [f"Your world knows you through {len(rel_agents)} people."]
    for r in relationships[:6]:
        summary_parts.append(f"{r.agent_name}: {r.relationship}")
    summary = " ".join(summary_parts)

    return AskerDossier(
        asker_id=asker_user_id,
        asker_name=asker_display_name,
        own_context=own_context,
        relationships=relationships,
        knowledge=knowledge,
        summary=summary,
    )


def dossier_block_for_agent(agent_id: str, dossier: AskerDossier) -> str:
    """Build a markdown context block tailored to a specific agent.

    Shows what THIS agent knows about the asker (prioritized),
    plus a condensed view of what the wider network knows.
    """
    lines = [f"The person asking is {dossier.asker_name}."]

    # What this specific agent knows
    my_rels = [r for r in dossier.relationships if r.agent_id == agent_id]
    my_facts = [k for k in dossier.knowledge if k.agent_id == agent_id]

    if my_rels or my_facts:
        lines.append(f"\nWhat YOU specifically know about {dossier.asker_name}:")
        for r in my_rels:
            lines.append(f"- Your relationship: {r.relationship}")
        for f in my_facts[:5]:
            lines.append(f"- {f.fact}")
    else:
        lines.append(f"\nYou don't have a direct personal relationship with {dossier.asker_name}.")

    # Self-knowledge (condensed)
    if dossier.own_context:
        lines.append(f"\nAbout {dossier.asker_name} (from their profile):")
        # Take first ~600 chars to keep it compact
        lines.append(dossier.own_context[:600])

    # What the wider network knows (excluding this agent's facts)
    other_rels = [r for r in dossier.relationships if r.agent_id != agent_id]
    other_facts = [k for k in dossier.knowledge if k.agent_id != agent_id]
    if other_rels or other_facts:
        lines.append(f"\nWhat the wider network knows about {dossier.asker_name}:")
        for r in other_rels[:4]:
            lines.append(f"- {r.agent_name}: {r.relationship}")
        for f in other_facts[:5]:
            lines.append(f"- ({f.agent_name}) {f.fact}")

    return "\n".join(lines)
