"""Freeform-text ingester — handles `.txt`, `.md`, and pasted text.

Different shape from the WhatsApp pipeline: there's no chat structure,
no two senders. Just one subject and a body of prose. We chunk by
paragraph at a sensible character cap.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TextDoc:
    text: str
    char_count: int

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


def parse_text(raw: str) -> TextDoc:
    text = raw.replace("﻿", "").strip()
    return TextDoc(text=text, char_count=len(text))


def chunk_text(text: str, max_chars: int = 12_000) -> list[str]:
    """Greedily group paragraphs into ~max_chars-each chunks.

    Falls back to a hard char split if a single paragraph is bigger
    than max_chars (rare for chat-style or markdown docs).
    """
    paragraphs = [p.strip() for p in text.split("\n\n")]
    paragraphs = [p for p in paragraphs if p]
    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for p in paragraphs:
        plen = len(p) + 2
        if plen > max_chars:
            # Single oversized paragraph — flush buffer, hard-split it.
            if buf:
                chunks.append("\n\n".join(buf))
                buf = []
                buf_len = 0
            for i in range(0, len(p), max_chars):
                chunks.append(p[i : i + max_chars])
            continue
        if buf_len + plen > max_chars and buf:
            chunks.append("\n\n".join(buf))
            buf = [p]
            buf_len = plen
        else:
            buf.append(p)
            buf_len += plen
    if buf:
        chunks.append("\n\n".join(buf))
    return chunks


def render_chunk_for_prompt(chunk: str, max_chars: int = 30_000) -> str:
    if len(chunk) <= max_chars:
        return chunk
    return chunk[:max_chars] + "\n[... truncated for length ...]"
