"""Render a ProfilePage into the canonical wiki shape.

Three artefacts per profile, mirroring the role-agent layout
(`marketing/Ellis.md` + `marketing/personality.md` + topic pages):

- **Hub** (`<Name>.md`) — identity + index. Short. Links out to the
  personality file, every topic page, key relationships, and projects.
  This is the named node in Obsidian and the README link target.
- **Personality** (`personality.md`) — how they speak and think.
  Overview, communication style, recurring themes. This is what the
  consult system-prompt loader reads.
- **Topic pages** (`<topic-slug>.md` × N) — one per interest cluster +
  one per project. Each back-links to the hub.

Preview markdown (what the UI shows live) is hub + personality + topic
list concatenated so the user sees the whole shape in one panel.
"""

from __future__ import annotations

import re
from datetime import date

from .models import ProfilePage


def _slug(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "untitled"


def _frontmatter(*, tags: list[str], ingest_date: date | None, slug: str) -> list[str]:
    today = (ingest_date or date.today()).isoformat()
    return [
        "---",
        f"tags: [{', '.join(tags)}]",
        f"date: {today}",
        f"agent: {slug}",
        "---",
        "",
    ]


def _short_topic_blurb(bullets: list[str]) -> str:
    """One-line summary used next to a [[topic]] link in the hub."""
    if not bullets:
        return ""
    first = bullets[0].strip().rstrip(".")
    if len(first) > 90:
        first = first[:87].rsplit(" ", 1)[0] + "…"
    return first


def render_hub_md(
    profile: ProfilePage,
    slug: str,
    ingest_date: date | None = None,
    name: str | None = None,
) -> str:
    """Short identity-and-index file — the named Obsidian node.

    `name` lets the caller override the display name (used when assigning
    an ingest to an existing colleague slot — e.g. write Joon's chat into
    `support/` but keep the agent named "Joon").
    """
    display_name = name or profile.name
    subtitle = (profile.subtitle or "Ingested colleague").strip().rstrip(".")
    lines = _frontmatter(tags=["person", "ingested"], ingest_date=ingest_date, slug=slug)
    lines += [
        f"# {display_name}",
        "",
        f"*{subtitle}.*",
        "",
        "> See [[personality]] for the bio. Index: [[README]].",
        "",
    ]

    if profile.overview.strip():
        lines += [
            "## What they do",
            profile.overview.strip().split("\n\n")[0],
            "",
        ]

    if profile.interests:
        lines += ["## Topics", ""]
        for cluster in profile.interests:
            topic_slug = _slug(cluster.title)
            blurb = _short_topic_blurb(cluster.bullets)
            suffix = f" — {blurb}" if blurb else ""
            lines.append(f"- [[{topic_slug}|{cluster.title}]]{suffix}")
        lines.append("")

    if profile.relationships:
        lines += ["## Key relationships", ""]
        for rel in profile.relationships[:12]:
            summary = rel.summary.strip().split(".")[0]
            lines.append(f"- [[{rel.name}]] — {summary}")
        lines.append("")

    if profile.projects:
        lines += ["## Projects", ""]
        for p in profile.projects:
            proj_slug = _slug(p.name)
            url_part = f" ({p.url})" if p.url else ""
            short = p.description.strip().split(".")[0]
            lines.append(f"- [[{proj_slug}|{p.name}]] — {short}{url_part}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_personality_md(
    profile: ProfilePage,
    slug: str,
    ingest_date: date | None = None,
    name: str | None = None,
) -> str:
    """Bio file — overview, communication style, recurring themes.

    Same shape as the role agents' `personality.md` (Who I Am, How I
    speak, Recurring themes). What `_load_persona` pulls into the
    consult system prompt.
    """
    display_name = name or profile.name
    subtitle = (profile.subtitle or "Ingested colleague").strip().rstrip(".")
    lines = _frontmatter(tags=["persona", "ingested"], ingest_date=ingest_date, slug=slug)
    lines += [
        f"# Who I Am — {display_name}",
        "",
        f"*{subtitle}.*",
        "",
        f"> Hub: [[{display_name}]]. Index: [[README]].",
        "",
    ]

    if profile.overview.strip():
        paragraphs = [p.strip() for p in profile.overview.split("\n\n") if p.strip()]
        if paragraphs:
            lines += ["## In one line", paragraphs[0], ""]
        if len(paragraphs) > 1:
            lines += ["## Background", "\n\n".join(paragraphs[1:]), ""]

    work = profile.work
    if work.day_job.strip() or work.side_projects.strip() or work.investment_or_business_interests.strip():
        lines += ["## What I do", ""]
        if work.day_job.strip():
            lines += ["**Day job.**", work.day_job.strip(), ""]
        if work.side_projects.strip():
            lines += ["**Side projects.**", work.side_projects.strip(), ""]
        if work.investment_or_business_interests.strip():
            lines += ["**Business interests.**", work.investment_or_business_interests.strip(), ""]

    cs = profile.communication_style
    if cs.one_line.strip() or cs.traits:
        lines += ["## How I speak", ""]
        if cs.one_line.strip():
            lines += [f"*{cs.one_line.strip()}*", ""]
        if cs.traits:
            lines.append("**Key traits:**")
            for t in cs.traits:
                lines.append(f"- {t.strip()}")
            lines.append("")

    if profile.recurring_themes:
        lines += ["## Recurring themes", ""]
        for theme in profile.recurring_themes:
            lines += [f"### {theme.title}", theme.body.strip(), ""]

    return "\n".join(lines).rstrip() + "\n"


def render_topic_pages(profile: ProfilePage, hub_name: str) -> dict[str, str]:
    """One .md per interest cluster + one per project, back-linking to the hub."""
    pages: dict[str, str] = {}

    for cluster in profile.interests:
        slug = _slug(cluster.title)
        body = [
            "---",
            "tags: [topic, ingested]",
            "---",
            f"# {cluster.title}",
            "",
            f"*Topic page for [[{hub_name}]].*",
            "",
        ]
        for bullet in cluster.bullets:
            body.append(f"- {bullet.strip()}")
        body.append("")
        body.append(f"> Source: [[{hub_name}]]")
        pages[slug] = "\n".join(body) + "\n"

    for project in profile.projects:
        slug = _slug(project.name)
        body = [
            "---",
            "tags: [project, ingested]",
            "---",
            f"# {project.name}",
            "",
            f"*Project page for [[{hub_name}]].*",
            "",
            project.description.strip(),
            "",
        ]
        if project.url:
            body += [f"URL: {project.url}", ""]
        body.append(f"> Source: [[{hub_name}]]")
        pages[slug] = "\n".join(body) + "\n"

    return pages


def render_preview_md(
    *,
    hub_md: str,
    personality_md: str,
    topic_pages: dict[str, str],
) -> str:
    """The combined view shown in the UI's right-hand panel."""
    sep = "\n\n---\n\n"
    parts = [
        f"# Hub — `<Name>.md`\n\n{hub_md}",
        f"# Persona — `personality.md`\n\n{personality_md}",
    ]
    for slug, md in topic_pages.items():
        parts.append(f"# Topic — `{slug}.md`\n\n{md}")
    return sep.join(parts)
