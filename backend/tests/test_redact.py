import re

import pytest

from app.ingest.redact import fingerprint, redact, redact_record, redact_with_counts


# Independent detectors from the handoff: don't test the implementation with itself.
LEAKS = [
    r"sk-[A-Za-z0-9_\-]{16,}", r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+",
    r"AKIA[0-9A-Z]{12,}", r"gh[pousr]_[A-Za-z0-9]{20,}",
    r"\b[A-Z][A-Z0-9_]{4,}(KEY|SECRET|TOKEN|PASSWORD|DSN)\s*=\s*\S+",
    r"postgres(ql)?://[^\s\"']+", r"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY",
    r"[\w.+-]+@[\w-]+\.[\w.]+",
]


@pytest.mark.parametrize("text,kind", [
    ("sk-" + "a" * 40, "api_key"),
    ("eyJ" + "a" * 24 + ".bbbb.cccc", "jwt"),
    ("AKIA" + "A" * 16, "aws_key"),
    ("ghp_" + "b" * 30, "github_token"),
    ("github_pat_" + "b" * 30, "github_token"),
    ('MY_API_KEY="secret with spaces"', "env_secret"),
    ("PASSWORD=secret", "env_secret"),
    ("postgresql://user:password@db.internal/db", "database_url"),
    ("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----", "private_key"),
    ("BEGIN EC PRIVATE KEY\ntruncated secret", "private_key"),
    ("Bearer abcdefghijklmnopqrstuvwxyz", "bearer"),
    ("https://user:password@private.test", "credential_url"),
])
def test_redaction_is_pure_stable_and_removes_complete_secret(text, kind):
    result, tally = redact_with_counts(text)
    assert result == f"<REDACTED:{kind}>"
    assert tally == {kind: 1}
    assert redact(text) == result == redact(result)
    assert not any(re.search(pattern, result) for pattern in LEAKS)


def test_email_identity_and_recursive_boundary():
    assert redact("Builder@example.test") == redact("builder@example.test")
    assert redact("one@example.test") != redact("two@example.test")
    raw = {"cwd": "/Users/person/my-project", "message": {"content": [
        {"type": "tool_result", "content": "sk-" + "a" * 30},
    ]}, "_path_fingerprint": "attacker-controlled"}
    safe, counts = redact_record(raw)
    assert safe["cwd"] == "my-project"
    assert safe["_path_fingerprint"] == fingerprint(raw["cwd"])
    assert counts == {"api_key": 1}
    assert raw["message"]["content"][0]["content"].startswith("sk-")


def test_json_secret_field_and_email_assignment():
    value = redact('{"ACCESS_TOKEN": "secret", "email": "one@example.test"}')
    assert '"secret"' not in value
    assert "<REDACTED:env_secret>" in value
    assert "<REDACTED:email:" in value
