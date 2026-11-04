"""Claude Code JSONL -> redacted builder evidence for twin/memory synthesis.

Accepts one JSONL file or a recursive export directory. Does not call an LLM,
persist source history, or emit source text. CLI stdout is summary-only.
"""

import argparse
import heapq
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .builder_profile import ProfileBuilder
from .cc_models import ClaudeCodeExtract, RedactedExcerpt
from .redact import PATTERNS, fingerprint, redact_paths, redact_record

_MAX_LINE_BYTES = 8 * 1024 * 1024
_SLASH_COMMAND = re.compile(r"^/[\w:-]+(?:\s|$)")
_SYSTEM_TEXT = re.compile(r"^\s*<(?:command-name|local-command|system-reminder|task-notification|ide_opened_file|ide_selection)")


def _timestamp(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def _user_text(content) -> tuple[str, bool]:
    if isinstance(content, str):
        return content, True
    if not isinstance(content, list):
        return "", False
    # Tool results are never quoted, even when neighbouring text is useful.
    blocks = [block for block in content if isinstance(block, dict)]
    text = "\n".join(block["text"] for block in blocks
                     if block.get("type") == "text" and isinstance(block.get("text"), str))
    return text, not any(block.get("type") == "tool_result" for block in blocks)


def parse_claude_code_export(root: Path) -> ClaudeCodeExtract:
    """Stream and redact before extraction; skip malformed records, dedupe UUIDs.

    Missing/unreadable roots raise a content-free ValueError. Bad files/lines
    inside a directory are counted and skipped. Symlinks are not traversed.
    Excerpts are human user prose only: assistant/tool text is not attributed
    to the person. All valid mainline user/assistant records inform cadence.
    """
    root = Path(root).expanduser()
    if root.is_symlink() or not root.exists():
        raise ValueError("Export root is missing or is a symbolic link")
    files = sorted(root.rglob("*.jsonl")) if root.is_dir() else [root]
    stats: Counter[str] = Counter({key: 0 for key in (
        "files_seen", "files_failed", "records_seen", "records_kept", "records_dropped",
        "malformed_lines", "oversized_lines", "duplicates", "invalid_timestamps",
        "sidechain_records", "excerpt_candidates", "excerpts_selected", "redactions",
    )})
    for kind in PATTERNS:
        stats[f"redactions_{kind}"] = 0
    builder = ProfileBuilder()
    seen: set[str] = set()
    # Keep at most 200 ranked excerpts plus the earliest candidate per session;
    # first-user bonus is determined chronologically, not filesystem order.
    candidates: list[tuple] = []
    first_users: dict[str, tuple] = {}
    for file in files:
        if file.is_symlink() or not file.is_file():
            continue
        stats["files_seen"] += 1
        try:
            with file.open("rb") as stream:
                while line := stream.readline(_MAX_LINE_BYTES + 1):
                    if not line.strip():
                        continue
                    stats["records_seen"] += 1
                    if len(line) > _MAX_LINE_BYTES:
                        while line and not line.endswith(b"\n"):
                            line = stream.readline(_MAX_LINE_BYTES + 1)
                        stats["oversized_lines"] += 1
                        continue
                    try:
                        raw = json.loads(line)
                        if not isinstance(raw, dict):
                            raise ValueError
                        record, tally = redact_record(raw)
                        del raw
                    except (ValueError, UnicodeError, RecursionError):
                        stats["malformed_lines"] += 1
                        continue
                    stats.update({f"redactions_{kind}": count for kind, count in tally.items()})
                    stats["redactions"] += sum(tally.values())
                    if record.get("isSidechain"):
                        stats["sidechain_records"] += 1
                        continue
                    if record.get("type") not in ("user", "assistant"):
                        continue
                    message = record.get("message")
                    if not isinstance(message, dict) or not isinstance(message.get("content"), (str, list)):
                        continue
                    ts = _timestamp(record.get("timestamp"))
                    if ts is None:
                        stats["invalid_timestamps"] += 1
                        continue
                    session_id = record.get("sessionId")
                    session = fingerprint(session_id) if isinstance(session_id, str) and session_id else fingerprint(str(file.relative_to(root) if root.is_dir() else file.name))
                    uid = record.get("uuid")
                    if isinstance(uid, str) and uid:
                        identity = fingerprint(session + ":" + uid)
                        if identity in seen:
                            stats["duplicates"] += 1
                            continue
                        seen.add(identity)
                    stats["records_kept"] += 1
                    builder.add(record, ts, session)
                    if record["type"] != "user" or record.get("isMeta"):
                        continue
                    text, plain = _user_text(message["content"])
                    text = text.strip()
                    if not text or _SLASH_COMMAND.match(text) or _SYSTEM_TEXT.match(text):
                        continue
                    stats["excerpt_candidates"] += 1
                    excerpt = RedactedExcerpt(ts=ts, project=record["cwd"], role="user", text=redact_paths(text)[:600])
                    rank = (int(plain), int(len(text) > 200), -ts.timestamp(), excerpt.text)
                    candidate = (rank, stats["excerpt_candidates"], session, excerpt)
                    if session not in first_users or ts < first_users[session][3].ts:
                        first_users[session] = candidate
                    heapq.heappush(candidates, candidate)
                    if len(candidates) > 200:
                        heapq.heappop(candidates)
        except OSError:
            stats["files_failed"] += 1
    # Any winning non-first candidate must be in the best 200 base ranks.
    # Add every session's first candidate before applying its ranking bonus.
    unique = {item[1]: item for item in [*candidates, *first_users.values()]}
    ranked = sorted(unique.values(), key=lambda item: (
        item[0][0], int(item[1] == first_users[item[2]][1]), *item[0][1:], -item[1]
    ), reverse=True)
    excerpts = [item[3] for item in ranked[:200]]
    stats["excerpts_selected"] = len(excerpts)
    stats["records_dropped"] = stats["records_seen"] - stats["records_kept"]
    return ClaudeCodeExtract(profile=builder.build(), excerpts=excerpts, stats=dict(stats))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--out", type=Path, help="Write redacted extract JSON (includes selected prose)")
    args = parser.parse_args()
    try:
        result = parse_claude_code_export(args.root)
        if args.out:
            # Exclusive creation avoids accidentally overwriting a source export.
            with args.out.open("x", encoding="utf-8") as output:
                output.write(result.model_dump_json(indent=2))
    except (OSError, ValueError):
        print("Unable to read export or create output; check input and output locations.")
        return 1
    print(json.dumps({
        "stats": result.stats,
        "projects": [p.name for p in result.profile.projects],
        "stacks": result.profile.stacks,
        "domains": result.profile.domains,
        "role_lean": result.profile.role_lean,
        "headline": result.profile.headline,
        "total_sessions": result.profile.total_sessions,
        "span_days": result.profile.span_days,
        "cadence": result.profile.cadence.model_dump(),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
