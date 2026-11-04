"""Auditor — the self-improvement loop.

After every conversation completes, an auditor LLM reviews the recording
+ the wiki delta and produces a typed `AuditReport`. The report's
`next_run_guidance` field gets read by `_build_system_prompt` on future
conversations as a "lessons from prior runs" block, so the system
literally improves over time without us touching the persona prompts.

This implements the **Lint** operation from the LLM Wiki pattern doc,
but applied to *conversation outcomes* rather than wiki content.

Files written per audit:
  data/audits/{ts}-{agentA}-{agentB}.md   — full report, Obsidian-friendly
  data/audits/log.md                       — append-only chronological index
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from .agents import get_agent

# Audits live INSIDE the wiki vault (backend/data/wikis/_audits/) so they
# show up in Obsidian's graph view. The leading `_` keeps them sorted
# above the per-agent folders in the file tree and visually distinct.
AUDITS_DIR = Path(
    os.environ.get(
        "AUDITS_DIR",
        str(Path(__file__).resolve().parent.parent / "data" / "wikis" / "_audits"),
    )
)
MAX_RECENT_GUIDANCE = int(os.environ.get("AUDIT_RECENT_GUIDANCE_COUNT", "5"))


# ── Typed audit primitives ──────────────────────────────────────────────


FailureModeName = Literal[
    "query_loop",
    "no_writes",
    "peer_vs_self_confusion",
    "epistemic_loop",
    "premature_end",
    "wiki_vandalism",
    "shallow_synthesis",
    "other",
]


class FailureMode(BaseModel):
    """A specific failure pattern observed in the conversation."""

    name: FailureModeName
    evidence: str = Field(
        description="One-sentence quote or turn reference, e.g. 'turn 4: Yuri said \"I don't have that page\" while querying Ellis'"
    )
    severity: Literal["low", "medium", "high"]
    suggestion: str = Field(
        description="One concrete change for next time. Action-oriented, not abstract."
    )


class AuditReport(BaseModel):
    """The typed output of an audit pass over a finished conversation."""

    summary: str = Field(
        description="One paragraph (≤80 words) describing what the conversation actually did."
    )
    pages_created: int
    pages_appended: int
    queries_made: int
    knowledge_score: int = Field(
        description="Number of net wiki changes (created + appended pages, excluding indexes)."
    )
    failure_modes: list[FailureMode] = Field(
        default_factory=list,
        description="Empty list if the conversation went well.",
    )
    key_insight: str = Field(
        description="One sentence — the single most useful observation from this conversation, regardless of whether it was filed to the wiki."
    )
    next_run_guidance: str = Field(
        description="One concise bullet (≤25 words) added to future system prompts so subsequent conversations don't repeat this run's mistakes. This is the self-improvement signal — make it actionable."
    )


# ── Auditor agent ───────────────────────────────────────────────────────


def _build_audit_prompt() -> str:
    return """You are an objective post-mortem reviewer of conversations between two
synthetic colleagues. Your job: read a transcript + the wiki state before
and after, and produce an honest typed audit.

These conversations are designed to leave behind durable knowledge —
markdown wiki pages on each agent's side. Chat without artifacts is
considered a partial failure. Your audit is the system's primary signal
for self-improvement: the `next_run_guidance` field will be injected
into future conversations' system prompts.

## Failure modes to look for

- `query_loop` — agents repeatedly call `query_peer_wiki` but never write
- `no_writes` — conversation completed with zero `create_wiki_page` or `append_to_wiki_page` calls
- `peer_vs_self_confusion` — an agent treats one of their OWN pages as the peer's, or vice versa (e.g. queries for a slug they already have, or denies having a page they have)
- `epistemic_loop` — both agents agree they don't know X and stop without writing the question down
- `premature_end` — agents called `end_conversation` before genuinely exhausting the topic
- `wiki_vandalism` — an agent overwrote or appended low-quality content to a peer-relevant page
- `shallow_synthesis` — agents wrote pages but the content is platitudes, not specifics

## What "good" looks like

- Both agents wrote at least one page each
- Pages have `quoted_from_peer` provenance pointing to specific sentences
- Cross-agent backlinks (`> Source: [[../<peer>/<slug>]]`) are present
- Specific names/numbers/claims, not vibes

## Output rules

- `next_run_guidance` is the most important field. Make it short, concrete, and prompt-ready: it'll be appended to the next conversation's system prompt verbatim. Examples of good guidance:
  - "When a peer mentions a wikilink that's clearly on YOUR side, speak about it directly — don't re-query."
  - "By turn 4 each side should have written one page; if not, write a 'shape of the question' page."
  - "If you ground in a peer page, end the turn with a `create_wiki_page` call quoting that page."

Avoid:
  - Generic cheerleading ("be more specific!") — name the actual mechanism
  - References to fields the next conversation can't see
  - Anything longer than 25 words

Now produce the AuditReport for the conversation supplied."""


_audit_agent: Agent[None, AuditReport] | None = None


def _get_audit_agent() -> Agent[None, AuditReport]:
    global _audit_agent
    if _audit_agent is not None:
        return _audit_agent
    # Reuse the conversation's model selection (gateway-or-direct).
    # Local import to avoid circular dep at module load.
    from .conversation import _build_model
    _audit_agent = Agent(
        _build_model(),
        output_type=AuditReport,
        system_prompt=_build_audit_prompt(),
    )
    return _audit_agent


# ── Recording → digest input ────────────────────────────────────────────


def _digest_recording(recording_path: Path) -> dict[str, Any]:
    """Compress a JSONL recording into a structured input the auditor can
    reason about cheaply (full transcript text + tool-call summary)."""
    if not recording_path.exists():
        return {"transcript": [], "tool_calls": [], "events": []}

    transcript: list[dict[str, str]] = []
    tool_calls: list[dict[str, Any]] = []
    wiki_changes: list[dict[str, Any]] = []
    skill_events: list[dict[str, Any]] = []
    final_event: dict[str, Any] | None = None
    turn_text: dict[int, str] = {}
    turn_speaker: dict[int, str] = {}

    with recording_path.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = evt.get("type")
            if t == "turn_start":
                turn_speaker[evt["turnIndex"]] = evt["speaker"]
            elif t == "turn_delta":
                turn_text.setdefault(evt["turnIndex"], "")
                turn_text[evt["turnIndex"]] += evt.get("text", "")
            elif t == "tool_call_start":
                tool_calls.append({
                    "turn": evt.get("turnIndex"),
                    "speaker": evt.get("speaker"),
                    "tool": evt.get("tool"),
                    "args": evt.get("args", {}),
                })
            elif t == "wiki_change":
                wiki_changes.append({
                    "agent_id": evt.get("agentId"),
                    "slug": evt.get("slug"),
                    "action": evt.get("action"),
                    "quoted_from_peer": evt.get("quotedFromPeer"),
                    "peer_slug": evt.get("quotedFromPeerSlug"),
                })
            elif t in ("skill_proposed", "skill_run", "skill_promoted", "skill_called"):
                skill_events.append({"type": t, **{k: v for k, v in evt.items() if k != "type"}})
            elif t == "conversation_done":
                final_event = evt

    for turn in sorted(turn_text):
        transcript.append({
            "turn": turn,
            "speaker": turn_speaker.get(turn, "?"),
            "text": turn_text[turn].strip(),
        })

    return {
        "transcript": transcript,
        "tool_calls": tool_calls,
        "wiki_changes": wiki_changes,
        "skill_events": skill_events,
        "done": final_event or {},
    }


def _format_digest_for_audit(
    digest: dict[str, Any],
    agent_a: str,
    agent_b: str,
    wiki_before: dict[str, dict[str, str]],
    wiki_after: dict[str, dict[str, str]],
) -> str:
    """Render the digest as a single string the auditor reads."""
    a_name = (get_agent(agent_a).name if get_agent(agent_a) else agent_a)
    b_name = (get_agent(agent_b).name if get_agent(agent_b) else agent_b)

    lines: list[str] = [
        f"# Conversation: {a_name} ↔ {b_name}",
        "",
        f"**Outcome:** {digest['done'].get('reason', 'unknown')}, "
        f"knowledge_score={digest['done'].get('knowledgeScore', '?')}",
        "",
        "## Transcript",
        "",
    ]
    for t in digest["transcript"]:
        lines.append(f"### Turn {t['turn']} — {t['speaker']}")
        lines.append(t["text"])
        lines.append("")

    lines += ["## Tool calls", ""]
    if not digest["tool_calls"]:
        lines.append("(none)")
    else:
        for tc in digest["tool_calls"]:
            args_short = json.dumps(tc.get("args", {}))[:120]
            lines.append(f"- turn {tc['turn']} {tc['speaker']}: `{tc['tool']}({args_short})`")
    lines.append("")

    lines += ["## Wiki changes", ""]
    if not digest["wiki_changes"]:
        lines.append("(none — this is itself a finding)")
    else:
        for wc in digest["wiki_changes"]:
            lines.append(
                f"- {wc['agent_id']} {wc['action']} `{wc['slug']}.md` "
                f"(peer:{wc.get('peer_slug') or '∅'})"
            )
            if wc.get("quoted_from_peer"):
                lines.append(f"  > {wc['quoted_from_peer'][:200]}")
    lines.append("")

    lines += ["## Wiki state delta (filenames only)", ""]
    for ag, before in wiki_before.items():
        after = wiki_after.get(ag, {})
        added = sorted(set(after) - set(before))
        modified = sorted(k for k in before if k in after and before[k] != after[k])
        lines.append(f"- {ag}: +{len(added)} added, ~{len(modified)} modified")
        if added:
            lines.append(f"  added: {', '.join(added)}")
        if modified:
            lines.append(f"  modified: {', '.join(modified)}")
    lines.append("")

    return "\n".join(lines)


# ── Persistence ─────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts_filename() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def _ensure_audits_dir() -> None:
    AUDITS_DIR.mkdir(parents=True, exist_ok=True)
    log = AUDITS_DIR / "log.md"
    if not log.exists():
        log.write_text("# Audit log\n\nChronological index of conversation audits.\n\n", encoding="utf-8")


def _record_lesson_for_agent(
    *,
    agent_id: str,
    peer_id: str,
    guidance: str,
    audit_filename: str,
    summary: str,
) -> None:
    """Append a lesson entry to the agent's `lessons.md` page (creates it
    on first call). The lesson page lives inside the agent's own folder
    so it appears in the graph as a child node of the agent's hub.

    Format mirrors the global log: each entry has a `- guidance:` line
    that `recent_guidance(agent_id=...)` can grep without parsing
    structured frontmatter."""
    from .wiki.store import (
        _agent_dir,
        _append_index_entry,
        _bump_updated_in_frontmatter,
        _build_frontmatter,
        ensure_agent_dir,
    )

    ensure_agent_dir(agent_id)
    lessons_path = _agent_dir(agent_id) / "lessons.md"
    now = _now_iso()
    peer_name = (get_agent(peer_id).name if get_agent(peer_id) else peer_id)
    self_name = (get_agent(agent_id).name if get_agent(agent_id) else agent_id)
    audit_slug = audit_filename.removesuffix(".md")

    new_entry = (
        f"\n## [{now}] with {peer_name}\n"
        f"- guidance: {guidance.strip()}\n"
        f"- summary: {summary.strip()}\n"
        f"- source: [[../_audits/{audit_slug}]]\n\n"
    )

    if lessons_path.exists():
        existing = lessons_path.read_text(encoding="utf-8")
        existing = _bump_updated_in_frontmatter(existing, now).rstrip()
        lessons_path.write_text(existing + "\n" + new_entry, encoding="utf-8")
    else:
        body = (
            _build_frontmatter(agent_id, created=now, updated=now)
            + f"# {self_name}'s Lessons\n\n"
            + "*What I've learned from past conversations. Auto-appended by "
              "the auditor after each conversation completes.*\n"
            + new_entry
        )
        lessons_path.write_text(body, encoding="utf-8")
        # Wire the new lessons page into the agent's hub via [[wikilink]]
        # so the graph view shows the connection.
        _append_index_entry(
            agent_id, "lessons", "what I've learned from past conversations"
        )


def _write_audit_md(
    *,
    report: AuditReport,
    session_id: str,
    agent_a: str,
    agent_b: str,
    turns_used: int,
) -> Path:
    _ensure_audits_dir()
    a_name = get_agent(agent_a).name if get_agent(agent_a) else agent_a
    b_name = get_agent(agent_b).name if get_agent(agent_b) else agent_b
    fname = f"{_ts_filename()}-{agent_a}-{agent_b}.md"
    path = AUDITS_DIR / fname

    fm = (
        "---\n"
        f"session_id: {session_id}\n"
        f"agent_a: {agent_a}\n"
        f"agent_b: {agent_b}\n"
        f"ts: {_now_iso()}\n"
        f"turns_used: {turns_used}\n"
        f"pages_created: {report.pages_created}\n"
        f"pages_appended: {report.pages_appended}\n"
        f"queries_made: {report.queries_made}\n"
        f"knowledge_score: {report.knowledge_score}\n"
        "---\n\n"
    )

    body: list[str] = [
        f"# Audit · {a_name} ↔ {b_name}",
        "",
        "## Summary",
        report.summary.strip(),
        "",
        "## Outcomes",
        f"- pages_created: **{report.pages_created}**, pages_appended: **{report.pages_appended}**",
        f"- queries_made: {report.queries_made}, knowledge_score: {report.knowledge_score}",
        "",
        "## Failure modes",
    ]
    if report.failure_modes:
        for fm_item in report.failure_modes:
            body.append(f"### `{fm_item.name}` · severity: {fm_item.severity}")
            body.append(f"**Evidence:** {fm_item.evidence}")
            body.append(f"**Suggestion:** {fm_item.suggestion}")
            body.append("")
    else:
        body.append("_None — clean run._")
        body.append("")

    body += [
        "## Key insight",
        report.key_insight.strip(),
        "",
        "## Guidance for next runs",
        f"> {report.next_run_guidance.strip()}",
        "",
    ]
    path.write_text(fm + "\n".join(body), encoding="utf-8")

    log = AUDITS_DIR / "log.md"
    log_entry = (
        f"## [{_now_iso()}] {a_name}↔{b_name} · "
        f"created={report.pages_created} appended={report.pages_appended} "
        f"queries={report.queries_made}\n"
        f"- [[{fname.removesuffix('.md')}]]\n"
        f"- guidance: {report.next_run_guidance.strip()[:140]}\n\n"
    )
    with log.open("a", encoding="utf-8") as f:
        f.write(log_entry)

    return path


# ── Public API ──────────────────────────────────────────────────────────


async def audit_conversation(
    *,
    session_id: str,
    agent_a: str,
    agent_b: str,
    turns_used: int,
    recording_path: Path,
    wiki_before: dict[str, dict[str, str]],
    wiki_after: dict[str, dict[str, str]],
) -> AuditReport | None:
    """Run the auditor on a finished conversation, write the audit
    markdown, return the typed report. Logs and swallows errors so a
    failed audit can never break a successful conversation."""
    try:
        digest = _digest_recording(recording_path)
        prompt = _format_digest_for_audit(
            digest, agent_a, agent_b, wiki_before, wiki_after,
        )
        agent = _get_audit_agent()
        result = await agent.run(prompt)
        report: AuditReport = result.output
        path = _write_audit_md(
            report=report,
            session_id=session_id,
            agent_a=agent_a,
            agent_b=agent_b,
            turns_used=turns_used,
        )
        # Append the same lesson to BOTH participants' personal lessons
        # files. Each agent now has a [[lessons]] node in their own
        # folder, connected to their hub by an index entry, with edges
        # back to every audit they've contributed to.
        for self_id, peer_id in ((agent_a, agent_b), (agent_b, agent_a)):
            try:
                _record_lesson_for_agent(
                    agent_id=self_id,
                    peer_id=peer_id,
                    guidance=report.next_run_guidance,
                    audit_filename=path.name,
                    summary=report.summary,
                )
            except Exception as e:  # noqa: BLE001
                print(f"[auditor] lesson record failed for {self_id}: {e}")
        print(f"[auditor] wrote {path.name} (next_run_guidance: {report.next_run_guidance[:80]})")
        return report
    except Exception as e:  # noqa: BLE001
        print(f"[auditor] FAILED: {e}")
        return None


_FRONTMATTER_AGENT_A = re.compile(r"^agent_a:\s*(.+)$", re.MULTILINE)
_FRONTMATTER_AGENT_B = re.compile(r"^agent_b:\s*(.+)$", re.MULTILINE)
_GUIDANCE_LINE = re.compile(r"^>\s*(.+)$", re.MULTILINE)


def _parse_audit_file(path: Path) -> tuple[str | None, str | None, str | None]:
    """Return (agent_a, agent_b, guidance) for an audit file.
    Returns (None, None, None) on parse failure. Lightweight regex —
    no pyyaml dep."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, None, None
    a = _FRONTMATTER_AGENT_A.search(text)
    b = _FRONTMATTER_AGENT_B.search(text)
    # Guidance is in a `## Guidance for next runs\n> {bullet}` block.
    g_section = text.split("## Guidance for next runs", 1)
    guidance = None
    if len(g_section) == 2:
        m = _GUIDANCE_LINE.search(g_section[1])
        if m:
            guidance = m.group(1).strip()
    return (
        a.group(1).strip() if a else None,
        b.group(1).strip() if b else None,
        guidance,
    )


def recent_guidance(
    agent_id: str | None = None,
    limit: int = MAX_RECENT_GUIDANCE,
) -> list[str]:
    """Return `next_run_guidance` lines from the most recent audits.

    - When `agent_id` is None: returns global guidance from any audit (the
      same behaviour as the original log-based reader). Generic lessons
      that apply across all pairs.
    - When `agent_id` is set: walks the audit files, parses frontmatter,
      keeps only audits where the given agent was a participant (agent_a
      or agent_b). Personal lessons specific to that character.

    Both blocks are rendered into the per-turn system prompt by the
    conversation loop (hybrid mode)."""
    if not AUDITS_DIR.exists():
        return []

    if agent_id is None:
        # Global path: read log.md (cheap, one-file).
        log = AUDITS_DIR / "log.md"
        if not log.exists():
            return []
        lines = [
            line.removeprefix("- guidance: ").strip()
            for line in log.read_text(encoding="utf-8").splitlines()
            if line.startswith("- guidance: ")
        ]
        return lines[-limit:][::-1]  # newest first

    # Agent-specific path: read the agent's own `lessons.md` page, which
    # the auditor appends to after every conversation that agent participated
    # in. Same `- guidance:` line format as the global log so the parser
    # is identical.
    from .wiki.store import _agent_dir
    lessons_path = _agent_dir(agent_id) / "lessons.md"
    if not lessons_path.exists():
        return []
    lines = [
        line.removeprefix("- guidance: ").strip()
        for line in lessons_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("- guidance: ")
    ]
    return lines[-limit:][::-1]  # newest first
