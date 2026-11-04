"""Per-agent wiki on disk — markdown files with edit-trail provenance comments.

Page format
-----------
Every page begins with YAML frontmatter:

    ---
    created: 2026-04-25T14:00:00Z
    updated: 2026-04-25T14:30:00Z
    agent: marketing
    ---

`created` is set once when the page is first written and never changes;
`updated` rewrites on every append. This gives a future timeline UI two
clean signals (page-creation events and most-recent-touch events) without
having to parse the whole edit log.

Every edit also drops a trailing `<!-- edited by X @ turn N · ISO -->`
comment for granular per-edit history.

Same slugify rule + same 2KB per-edit cap as the Node version.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

WIKIS_ROOT = Path(
    os.environ.get(
        "WIKIS_DIR", str(Path(__file__).resolve().parent.parent.parent / "data" / "wikis")
    )
)
MAX_BYTES_PER_EDIT = 4096
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def slugify(raw: str) -> str:
    s = raw.lower().strip()
    s = re.sub(r"\.md$", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return s[:63]


def is_valid_slug(slug: str) -> bool:
    return bool(SLUG_RE.match(slug))


def _agent_dir(agent_id: str) -> Path:
    return WIKIS_ROOT / agent_id


def _index_filename(agent_id: str) -> str:
    """The agent's hub file is named after the agent (e.g. `Ellis.md`,
    `Yuri.md`) so the Obsidian graph view shows a personal name as the
    central node instead of six identical `index` nodes."""
    # Late import to avoid circular: agents → (nothing); wiki → agents is fine
    from ..agents import get_agent
    a = get_agent(agent_id)
    return f"{a.name}.md" if a else "index.md"


def ensure_agent_dir(agent_id: str) -> None:
    _agent_dir(agent_id).mkdir(parents=True, exist_ok=True)
    idx = _agent_dir(agent_id) / _index_filename(agent_id)
    if not idx.exists():
        # H1 mirrors filename so Obsidian preview header shows the agent's name.
        # Frontmatter gives the timeline UI a creation timestamp for the hub.
        from ..agents import get_agent
        a = get_agent(agent_id)
        title = a.name if a else "Index"
        role = a.role if a else ""
        now = _now_iso()
        body = _build_frontmatter(agent_id, created=now, updated=now)
        body += f"# {title}\n\n*{role}*\n\n" if role else f"# {title}\n\n"
        idx.write_text(body, encoding="utf-8")


def read_page(agent_id: str, slug: str) -> str | None:
    p = _agent_dir(agent_id) / f"{slug}.md"
    return p.read_text(encoding="utf-8") if p.exists() else None


def read_index(agent_id: str) -> str:
    ensure_agent_dir(agent_id)
    return (_agent_dir(agent_id) / _index_filename(agent_id)).read_text(encoding="utf-8")


def list_slugs(agent_id: str) -> list[str]:
    ensure_agent_dir(agent_id)
    index_name = _index_filename(agent_id)
    return sorted(
        f.stem
        for f in _agent_dir(agent_id).iterdir()
        if f.suffix == ".md" and f.name != index_name
    )


def read_wiki(agent_id: str) -> dict[str, str]:
    ensure_agent_dir(agent_id)
    return {
        f.name: f.read_text(encoding="utf-8")
        for f in _agent_dir(agent_id).iterdir()
        if f.suffix == ".md"
    }


def snapshot(agent_id: str) -> dict[str, str]:
    return read_wiki(agent_id)


def _peer_source_block(
    peer_agent_id: str | None,
    peer_slug: str | None,
    quoted_from_peer: str | None,
) -> str:
    """Build the bidirectional-graph source line that gets appended after
    every wiki edit driven by a peer quote. Uses Obsidian-flavoured
    `[[../{agent}/{slug}]]` so the graph view can render the cross-agent
    edge."""
    if not peer_agent_id or not peer_slug:
        return ""
    quote = (quoted_from_peer or "").strip().replace("\n", " ")
    if len(quote) > 200:
        quote = quote[:200].rsplit(" ", 1)[0] + "…"
    quote_part = f' — quoted: *"{quote}"*' if quote else ""
    return f"\n\n> **Source:** [[../{peer_agent_id}/{peer_slug}]]{quote_part}\n"


def _now_iso() -> str:
    """ISO-8601 UTC, second-precision, ends in Z. Easy to sort/parse."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _trailing_comment(agent_id: str, turn: int | None) -> str:
    turn_part = "seed" if turn is None else f"turn {turn}"
    return f"\n<!-- edited by {agent_id} @ {turn_part} · {_now_iso()} -->\n"


def _build_frontmatter(agent_id: str, created: str, updated: str | None = None) -> str:
    """YAML frontmatter at the top of every wiki page. `created` never
    changes after first write; `updated` rewrites on every append. Both
    are ISO-8601 UTC. A future timeline UI reads these via Dataview or a
    simple regex without parsing the edit-trail comments."""
    upd = updated or created
    return (
        "---\n"
        f"created: {created}\n"
        f"updated: {upd}\n"
        f"agent: {agent_id}\n"
        "---\n\n"
    )


_FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n+", re.DOTALL)
_UPDATED_FIELD_RE = re.compile(r"^(updated:\s*).+$", re.MULTILINE)


def _bump_updated_in_frontmatter(text: str, new_updated: str) -> str:
    """Rewrite the `updated:` line inside the frontmatter block. If the
    page somehow lacks frontmatter (legacy seeds), prepend a fresh one
    with the same timestamp for both `created` and `updated`."""
    fm_match = _FRONTMATTER_RE.match(text)
    if not fm_match:
        return text
    fm = fm_match.group(0)
    new_fm = _UPDATED_FIELD_RE.sub(f"updated: {new_updated}", fm, count=1)
    return new_fm + text[fm_match.end():]


def _append_index_entry(agent_id: str, slug: str, summary: str) -> None:
    """Index entries use Obsidian wikilinks so the graph view picks up the
    page-to-index relationship and the per-agent hub becomes a real node
    named after the agent (e.g. `Ellis`, `Yuri`)."""
    ensure_agent_dir(agent_id)
    idx = _agent_dir(agent_id) / _index_filename(agent_id)
    content = idx.read_text(encoding="utf-8") if idx.exists() else "# Index\n\n"
    if not content.endswith("\n"):
        content += "\n"
    if not re.search(rf"^- \[\[{re.escape(slug)}\]\]", content, re.MULTILINE):
        content += f"- [[{slug}]] — {summary.strip()}\n"
        idx.write_text(content, encoding="utf-8")


def render_insight_card(
    *,
    agent_id: str,
    peer_agent_id: str,
    peer_name: str,
    concept: str,
    kind: str,            # "reframe" | "risk"
    point: str,
    use_when: str,
    action: str,
    quoted_from_peer: str,
) -> str:
    """Render the canonical insight-card body (the format that shows up in
    the transcript and the wiki page). Mirrors the structure the user
    asked for — Concept / Reframe-or-Risk / Skill Learned From / Use When
    / Action — so the same shape is visible in chat AND on disk."""
    label = "Risk" if kind.lower() == "risk" else "Reframe"
    return (
        f"# Concept: {concept.strip()}\n\n"
        f"- **{label}:** {point.strip()}\n"
        f"- **Skill Learned From:** {peer_name}\n"
        f"- **Use When:** {use_when.strip()}\n"
        f"- **Action:** {action.strip()}\n\n"
        f"> Quoted from {peer_name}: *\"{quoted_from_peer.strip()}\"*\n"
    )


def create_page(
    agent_id: str,
    slug: str,
    content: str,
    summary: str,
    turn: int | None,
    *,
    peer_agent_id: str | None = None,
    peer_slug: str | None = None,
    quoted_from_peer: str | None = None,
) -> tuple[bool, str]:
    """Returns (ok, message_or_error).

    When `peer_agent_id` + `peer_slug` are provided, a bidirectional-graph
    source link is appended to the page body so Obsidian renders an edge
    from this page to the peer's page in the graph view.
    """
    ensure_agent_dir(agent_id)
    if not is_valid_slug(slug):
        return False, f'Invalid slug "{slug}". Lowercase a-z 0-9 and hyphens only.'
    page = _agent_dir(agent_id) / f"{slug}.md"
    if page.exists():
        return False, f'Page "{slug}" already exists. Use append_to_wiki_page instead.'
    now = _now_iso()
    body = (
        _build_frontmatter(agent_id, created=now, updated=now)
        + content.strip()
        + _peer_source_block(peer_agent_id, peer_slug, quoted_from_peer)
        + _trailing_comment(agent_id, turn)
    )
    if len(body.encode("utf-8")) > MAX_BYTES_PER_EDIT:
        return False, f"Page exceeds {MAX_BYTES_PER_EDIT} byte cap."
    page.write_text(body, encoding="utf-8")
    _append_index_entry(agent_id, slug, summary)
    return True, f"Created page {slug}.md ({len(body.encode('utf-8'))} bytes)."


def append_page(
    agent_id: str,
    slug: str,
    section: str,
    turn: int | None,
    *,
    peer_agent_id: str | None = None,
    peer_slug: str | None = None,
    quoted_from_peer: str | None = None,
) -> tuple[bool, str]:
    ensure_agent_dir(agent_id)
    if not is_valid_slug(slug):
        return False, f'Invalid slug "{slug}".'
    page = _agent_dir(agent_id) / f"{slug}.md"
    if not page.exists():
        return False, f'Page "{slug}" does not exist. Use create_wiki_page first.'
    now = _now_iso()
    addition = (
        "\n\n"
        + section.strip()
        + _peer_source_block(peer_agent_id, peer_slug, quoted_from_peer)
        + _trailing_comment(agent_id, turn)
    )
    if len(addition.encode("utf-8")) > MAX_BYTES_PER_EDIT:
        return False, f"Section exceeds {MAX_BYTES_PER_EDIT} byte cap."
    existing = page.read_text(encoding="utf-8")
    # Bump the `updated:` line in the frontmatter so a future timeline UI
    # sees both creation and most-recent-touch without parsing comments.
    existing = _bump_updated_in_frontmatter(existing, now).rstrip()
    page.write_text(existing + addition, encoding="utf-8")
    return True, f"Appended to {slug}.md ({len(addition.encode('utf-8'))} bytes)."
