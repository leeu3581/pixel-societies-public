"""Parse a WhatsApp `_chat.txt` export into structured messages.

Format (iOS export, with leading bracket and U+200E LRM marker on
system messages):

    [16/05/2025, 18:29:23] Zoe Qin: Messages and calls are end-to-end…
    [16/05/2025, 18:29:28] Keerthanen Ravichandran: Hi
    ‎[18/05/2025, 15:24:57] Keerthanen Ravichandran: ‎image omitted

We strip the LRM, ignore "image omitted" / "video omitted" / system
notices, and bucket multi-line message bodies onto the right entry.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Optional leading U+200E (LRM) used by iOS exports on system rows.
_LINE_RE = re.compile(
    r"^‎?\[(?P<date>\d{1,2}/\d{1,2}/\d{2,4}),\s*"
    r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\]\s*"
    r"(?P<sender>[^:]+):\s*(?P<body>.*)$"
)

_OMITTED_RE = re.compile(
    r"^‎?(image|video|audio|sticker|GIF|document|Contact card)\s+omitted\.?$",
    re.IGNORECASE,
)
_SYSTEM_BODY_HINTS = (
    "Messages and calls are end-to-end encrypted",
    "Voice call",
    "Missed voice call",
    "‎created group",
    "‎changed the subject",
    "‎changed this group",
    "‎added",
    "‎removed",
)


@dataclass
class Message:
    timestamp: datetime
    sender: str
    body: str
    is_media: bool = False


@dataclass
class ParsedChat:
    messages: list[Message] = field(default_factory=list)
    senders: list[str] = field(default_factory=list)
    first_at: datetime | None = None
    last_at: datetime | None = None


def _try_parse_dt(date_str: str, time_str: str) -> datetime | None:
    # WhatsApp varies: dd/mm/yy(yy), hh:mm(:ss). Try common combos.
    for fmt in (
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%y %H:%M:%S",
        "%d/%m/%y %H:%M",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
    ):
        try:
            return datetime.strptime(f"{date_str} {time_str}", fmt)
        except ValueError:
            continue
    return None


def parse_chat_text(text: str) -> ParsedChat:
    parsed = ParsedChat()
    seen_senders: dict[str, int] = {}
    last: Message | None = None

    for raw in text.splitlines():
        if not raw.strip():
            continue
        m = _LINE_RE.match(raw)
        if not m:
            # Continuation of the previous message.
            if last is not None and not last.is_media:
                last.body = (last.body + "\n" + raw).strip()
            continue

        date_str = m.group("date")
        time_str = m.group("time")
        sender = m.group("sender").strip().lstrip("‎").strip()
        body = m.group("body")
        body_clean = body.lstrip("‎").strip()

        # System / encryption notice rows — skip but don't break parsing.
        if any(hint.lower() in body_clean.lower() for hint in _SYSTEM_BODY_HINTS):
            last = None
            continue

        ts = _try_parse_dt(date_str, time_str)
        if ts is None:
            continue

        is_media = bool(_OMITTED_RE.match(body_clean))
        msg = Message(timestamp=ts, sender=sender, body=body_clean, is_media=is_media)
        parsed.messages.append(msg)
        last = msg
        seen_senders[sender] = seen_senders.get(sender, 0) + 1

    parsed.senders = [s for s, _ in sorted(seen_senders.items(), key=lambda kv: -kv[1])]
    if parsed.messages:
        parsed.first_at = parsed.messages[0].timestamp
        parsed.last_at = parsed.messages[-1].timestamp
    return parsed


def parse_whatsapp_zip(zip_path: Path) -> ParsedChat:
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith("_chat.txt") or n.endswith(".txt")]
        if not names:
            raise ValueError("No _chat.txt found inside the WhatsApp zip.")
        # Prefer the canonical name, then fall back to whichever .txt is largest.
        target = next((n for n in names if n.endswith("_chat.txt")), None)
        if target is None:
            target = max(names, key=lambda n: zf.getinfo(n).file_size)
        with zf.open(target) as fh:
            raw = fh.read().decode("utf-8", errors="replace")
    return parse_chat_text(raw)


def chunk_messages(
    messages: list[Message],
    target_sender: str,
    max_messages_per_chunk: int = 600,
) -> list[list[Message]]:
    """Group messages into chunks for LLM extraction.

    We keep both speakers in each chunk so the target's takes have
    context (questions, replies). Boundaries try to land on day breaks
    so each chunk is a recognisable timeframe.
    """
    if not messages:
        return []

    chunks: list[list[Message]] = []
    buf: list[Message] = []
    last_day = messages[0].timestamp.date()

    for m in messages:
        if (
            len(buf) >= max_messages_per_chunk
            and m.timestamp.date() != last_day
        ):
            chunks.append(buf)
            buf = []
        buf.append(m)
        last_day = m.timestamp.date()

    if buf:
        chunks.append(buf)
    return chunks


def render_chunk_for_prompt(
    chunk: list[Message],
    target_sender: str,
    max_chars: int = 30_000,
) -> str:
    """Compact, prompt-friendly rendering. Drops media stubs."""
    lines: list[str] = []
    total = 0
    for m in chunk:
        if m.is_media:
            continue
        line = f"[{m.timestamp:%Y-%m-%d %H:%M}] {m.sender}: {m.body}"
        if total + len(line) > max_chars:
            lines.append("[... truncated for length ...]")
            break
        lines.append(line)
        total += len(line) + 1
    return "\n".join(lines)
