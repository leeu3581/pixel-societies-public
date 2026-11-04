import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.ingest.claude_code import parse_claude_code_export
from app.ingest.redact import fingerprint
from tests.test_redact import LEAKS

FIXTURE = Path(__file__).parent / "fixtures" / "cc_synthetic.jsonl"


def write_records(path, records):
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
    return path


def record(text="A human intention", **kwargs):
    return {"type": "user", "timestamp": "2026-10-01T12:00:00Z", "cwd": "/private/project",
            "sessionId": "one", "message": {"role": "user", "content": text}, **kwargs}


def test_synthetic_privacy_gate_and_profile():
    result = parse_claude_code_export(FIXTURE)
    serialized = result.model_dump_json()
    assert not any(re.search(pattern, serialized) for pattern in LEAKS)
    assert not any(value in serialized for value in [
        "/Users/synthetic", "PRIVATE_TOOL_RESULT_CONTENT", "SIDECHAIN_MUST_NOT_APPEAR",
        "ATTACHMENT_MUST_NOT_APPEAR", "from fastapi import", "abc123",
    ])
    assert result.stats["malformed_lines"] == 1
    assert result.stats["sidechain_records"] == 1
    assert result.stats["invalid_timestamps"] == 1
    assert result.stats["records_seen"] == 11
    assert result.stats["records_kept"] == 6
    assert result.profile.total_sessions == 3
    assert result.profile.cadence.active_days == 2
    assert result.profile.cadence.longest_streak_days == 2
    assert result.profile.cadence.hour_histogram[23] == 1
    assert result.profile.cadence.sessions_per_week == 3
    assert result.profile.stacks == ["FastAPI", "Python"]
    assert result.profile.tools == ["Write", "mcp__docs__search"]
    assert result.profile.projects[0].path_fingerprint == fingerprint("/Users/synthetic/projects/instinct")
    assert len(result.excerpts) == 3
    assert result == parse_claude_code_export(FIXTURE)


def test_empty_malformed_and_missing(tmp_path):
    empty = tmp_path / "empty.jsonl"
    empty.touch()
    assert parse_claude_code_export(empty).profile.total_sessions == 0
    bad = tmp_path / "bad.jsonl"
    bad.write_bytes(b'null\n[]\n{"type":\n\xff\n{}\n')
    result = parse_claude_code_export(tmp_path)
    assert result.stats["malformed_lines"] == 4
    assert result.stats["records_kept"] == 0
    with pytest.raises(ValueError, match="Export root"):
        parse_claude_code_export(tmp_path / "absent")


def test_dedupe_and_project_identity(tmp_path):
    a = record(uuid="same")
    write_records(tmp_path / "a.jsonl", [a, a])
    write_records(tmp_path / "b.jsonl", [record(uuid="other", cwd="/different/project")])
    result = parse_claude_code_export(tmp_path)
    assert result.stats["duplicates"] == 1
    assert len(result.profile.projects) == 2
    assert {p.name for p in result.profile.projects} == {"project"}
    assert result.profile.total_sessions == 1


def test_ranking_cap_and_chronological_session_intent(tmp_path):
    records = [record("long " * 80, uuid=str(i), timestamp="2026-10-02T12:00:00Z") for i in range(230)]
    records.append(record("FIRST_INTENT", uuid="first"))
    records.append(record([{"type": "tool_result", "content": "DO_NOT_INCLUDE"},
                           {"type": "text", "text": "LOWER_SIGNAL"}], uuid="mixed"))
    result = parse_claude_code_export(write_records(tmp_path / "rank.jsonl", records))
    assert len(result.excerpts) == 200
    assert result.excerpts[0].text == "FIRST_INTENT"
    assert all(len(e.text) <= 600 for e in result.excerpts)
    assert "LOWER_SIGNAL" not in result.model_dump_json()


def test_cli_summary_and_optional_artifact(tmp_path):
    out = tmp_path / "profile.json"
    proc = subprocess.run([sys.executable, "-m", "app.ingest.claude_code", str(FIXTURE), "--out", str(out)], capture_output=True, text=True)
    assert proc.returncode == 0
    summary = json.loads(proc.stdout)
    assert "excerpts" not in summary
    assert "Build a memory" not in proc.stdout
    assert not proc.stderr
    artifact = json.loads(out.read_text())
    assert len(artifact["excerpts"]) == 3
    for key in ("domains", "role_lean", "headline"):
        assert summary[key] == artifact["profile"][key]
    assert artifact == parse_claude_code_export(FIXTURE).model_dump(mode="json")


def test_detect_format_and_typed_registration(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key-no-network")
    from app.ingest.runner import detect_format, register_upload, _JOBS
    for name, expected in [("export.JSONL", "claude_code"),
                           ("chat.zip", "whatsapp_zip"), ("notes.md", "text_doc"),
                           ("notes.txt", "text_doc"), ("notes.markdown", "text_doc"), ("a.pdf", "unsupported")]:
        assert detect_format(name) == expected
    job = register_upload(file_path=FIXTURE, file_name="export.jsonl")
    assert job.detected_format == "claude_code"
    _JOBS.pop(job.job_id)


def test_format_uses_supplied_path_not_server_cwd(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key-no-network")
    from app.ingest.runner import detect_format, register_upload, _JOBS

    monkeypatch.chdir(tmp_path)
    (tmp_path / "notes.txt").mkdir()
    assert detect_format("notes.txt") == "text_doc"
    actual = tmp_path / "actual-export"
    actual.mkdir()
    assert detect_format("upload-label", file_path=actual) == "claude_code"
    job = register_upload(file_path=actual, file_name="upload-label")
    try:
        assert job.detected_format == "claude_code"
    finally:
        _JOBS.pop(job.job_id)


def activity(path, content="", **kwargs):
    return record(type="assistant", message={"role": "assistant", "content": [
        {"type": "tool_use", "name": "Write", "input": {"file_path": path, "content": content}},
    ]}, **kwargs)


@pytest.mark.parametrize("records,expected", [
    ([activity("backend/database/service.py", "from fastapi import FastAPI")], "infra"),
    ([activity("frontend/components/view.tsx", "import React from 'react'")], "interface"),
    ([activity("notebooks/experiment.ipynb", "import torch")], "research"),
    ([activity("docs/onboarding/welcome.md")], "product"),
    ([record()], "generalist"),
    ([activity("a.py")] * 40, "generalist"),
    ([activity("backend/service.py", "from fastapi import FastAPI"),
      activity("components/view.tsx", "import React from 'react'")], "generalist"),
    ([], "generalist"),
])
def test_role_from_observed_signals(tmp_path, records, expected):
    result = parse_claude_code_export(write_records(tmp_path / "role.jsonl", records))
    assert result.profile.role_lean == expected
    assert result.profile.role_lean in {"infra", "interface", "product", "research", "generalist"}
    if not records:
        assert result.profile.domains == []
        assert result.profile.headline is None


def test_closed_domains_aliases_boundaries_and_stable_headline(tmp_path):
    from typing import get_args
    from app.ingest.cc_models import Domain
    from app.ingest.builder_profile import _DOMAIN_ALIASES, _DOMAIN_PHRASES

    assert set(_DOMAIN_ALIASES) == set(_DOMAIN_PHRASES) == set(get_args(Domain))
    a = parse_claude_code_export(write_records(tmp_path / "a.jsonl", [
        activity("src/tool.py", cwd="/private/dev-tools", gitBranch="feat/vector-search"),
    ]))
    b = parse_claude_code_export(write_records(tmp_path / "b.jsonl", [
        activity("src/tool.py", cwd="/private/developerTools", gitBranch="feat/vector_search"),
    ]))
    assert a.profile.domains == b.profile.domains == ["devtools", "retrieval"]
    assert a.profile.headline == b.profile.headline == "Builds developer tools with Python"
    assert len(a.profile.headline) < 70
    assert not a.profile.headline.endswith(".")
    empty = parse_claude_code_export(write_records(tmp_path / "unknown.jsonl", [
        record(cwd="/private/unstated", gitBranch="feature/paying-docstring-reagent"),
    ]))
    assert empty.profile.domains == []


def test_new_fields_never_copy_names_or_tool_results(tmp_path):
    secret = "sk-" + "a" * 30
    result = parse_claude_code_export(write_records(tmp_path / "privacy.jsonl", [
        activity("src/service.py", cwd="/private/agents-" + secret,
                 gitBranch="memory/builder@example.test"),
        record([{"type": "tool_result", "content": "fintech payments backend database"}]),
        record(cwd="/private/unknown", gitBranch="postgres://user:password@host/db"),
    ]))
    assert result.profile.domains == ["agents", "memory"]
    assert result.profile.headline == "Builds AI agents with Python"
    assert not any(re.search(pattern, result.model_dump_json()) for pattern in LEAKS)


def test_profile_schema_rejects_invalid_matching_values():
    from pydantic import ValidationError
    from app.ingest.cc_models import BuilderProfile

    data = parse_claude_code_export(FIXTURE).profile.model_dump()
    with pytest.raises(ValidationError):
        BuilderProfile.model_validate({**data, "role_lean": "backend"})
    with pytest.raises(ValidationError):
        BuilderProfile.model_validate({**data, "domains": ["dev-tools"]})


def test_runner_receives_only_redacted_evidence(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key-no-network")
    from app.ingest import runner
    from app.ingest.models import ChunkExtraction

    calls = []
    frames = []

    class Socket:
        async def send_text(self, text):
            frames.append(json.loads(text))

    async def extract(**kwargs):
        calls.append(kwargs)
        return ChunkExtraction(summary="Observed builder")

    async def synthesise(**kwargs):
        # Stop before any persistence; test the actual dispatch/chunk boundary.
        raise ValueError("synthetic stop before persistence")

    monkeypatch.setattr(runner, "extract_chunk", extract)
    monkeypatch.setattr(runner, "synthesise_profile", synthesise)
    job = runner.register_upload(file_path=FIXTURE, file_name="export.jsonl")
    try:
        asyncio.run(runner.run_ingest(ws=Socket(), job_id=job.job_id, target_sender="Synthetic Builder"))
    finally:
        runner._JOBS.pop(job.job_id)
    assert calls and all(call["mode"] == "text_doc" for call in calls)
    payload = json.dumps(calls)
    assert not any(re.search(pattern, payload) for pattern in LEAKS)
    assert "PRIVATE_TOOL_RESULT_CONTENT" not in payload
    assert "/Users/synthetic" not in payload
    assert any(frame["type"] == "ingest_parsed" for frame in frames)
