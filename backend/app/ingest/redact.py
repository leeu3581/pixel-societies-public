"""Pure redaction boundary. Never logs, reads files, or contacts a service.

Email fingerprints are stable pseudonyms, not anonymisation: known emails can
be guessed. Pattern redaction is deliberately conservative, not a guarantee
that arbitrary prose contains no confidential information.
"""

import hashlib
import re
from collections import Counter


PATTERNS = {
    "private_key": re.compile(
        r"(?:-----)?BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?:-----)?"
        r"[\s\S]*?(?:(?:-----)?END (?:[A-Z0-9]+ )*PRIVATE KEY(?:-----)?|\Z)"
    ),
    "env_secret": re.compile(
        r"\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DSN)\b"
        r"[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)", re.I
    ),
    "database_url": re.compile(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s\"'<>]+", re.I),
    "credential_url": re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/@<>]+:[^\s/@<>]+@[^\s<>\"']+", re.I),
    "api_key": re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    "jwt": re.compile(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)?"),
    "aws_key": re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{12,}"),
    "github_token": re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "bearer": re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I),
    "slack_token": re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
}
_PLACEHOLDER = re.compile(r"<REDACTED:[a-z_]+(?::[a-f0-9]+)?>")
_PATH = re.compile(r"(?<![\w:])(?:[A-Za-z]:[\\/]|~?/)[^\s<>\"'`,;)}\]]+")


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:12]


def redact_with_counts(text: str) -> tuple[str, dict[str, int]]:
    """Replace secrets with stable typed placeholders, preserving earlier ones."""
    counts: Counter[str] = Counter()

    def clean(part: str) -> str:
        for kind, pattern in PATTERNS.items():
            def replace(match: re.Match[str]) -> str:
                counts[kind] += 1
                suffix = ":" + fingerprint(match.group().lower().rstrip(".")) if kind == "email" else ""
                return f"<REDACTED:{kind}{suffix}>"
            part = pattern.sub(replace, part)
        return part

    # Makes repeated redaction idempotent, including placeholders in assignments.
    parts = re.split(f"({_PLACEHOLDER.pattern})", text)
    return "".join(p if _PLACEHOLDER.fullmatch(p) else clean(p) for p in parts), dict(counts)


def redact(text: str) -> str:
    """Public pure string redactor; accepts untrusted text, returns safe patterns."""
    return redact_with_counts(text)[0]


def redact_paths(text: str) -> str:
    """Remove local paths from outward-facing prose after stack detection."""
    return _PATH.sub("<REDACTED:path>", text)


def redact_record(record: dict) -> tuple[dict, dict[str, int]]:
    """Sanitise every string (including keys) before signal extraction.

    The cwd is reduced here, at the privacy boundary, so its exact fingerprint
    survives while the full private directory cannot reach the profile builder.
    """
    counts: Counter[str] = Counter()

    def walk(value):
        if isinstance(value, str):
            result, tally = redact_with_counts(value)
            counts.update(tally)
            return result
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            return {walk(key): walk(item) for key, item in value.items()}
        return value

    safe = walk(record)
    cwd = record.get("cwd")
    safe.pop("_path_fingerprint", None)
    if isinstance(cwd, str) and cwd.strip():
        safe["_path_fingerprint"] = fingerprint(cwd)
        # Derive basename BEFORE redacting, then redact it independently.
        safe["cwd"] = redact_paths(redact(cwd.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]))
    else:
        safe["cwd"] = "unknown"
        safe["_path_fingerprint"] = fingerprint("")
    return safe, dict(counts)
