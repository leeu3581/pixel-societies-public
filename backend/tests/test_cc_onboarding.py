import copy
import json
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.ingest import onboarding
from app.ingest.claude_code import parse_claude_code_export
from tests.test_redact import LEAKS
import re

FIXTURE = Path(__file__).parent / "fixtures" / "cc_synthetic.jsonl"


class Store:
    def __init__(self):
        self.agent = {"id": "self-twin", "persona_md": "Original voice interview", "character_started": True}
        self.private_import = None
        self.profile = None
        self.joined = False
        self.fail_join = False
        self.owner = "owner"

    @asynccontextmanager
    async def transaction(self):
        snapshot = copy.deepcopy((self.agent, self.profile, self.joined, self.private_import))
        try:
            yield
        except Exception:
            self.agent, self.profile, self.joined, self.private_import = snapshot
            raise

    async def fetchrow(self, sql, *args):
        if "from public.agents a" in sql:
            return self.agent if args[0] == self.owner else None
        if "from public.world_groups" in sql:
            return {"id": "cafe", "visibility": "public", "roster_owner_only": False}
        if "from public.builder_profiles" in sql:
            assert args[1] == self.owner
            return self.profile
        raise AssertionError("Unexpected query")

    async def execute(self, sql, *args):
        if "insert into public.builder_profiles" in sql:
            assert args[0] == self.agent["id"] and args[1] == self.owner
            self.profile = dict(zip(
                ["projects", "stacks", "tools", "cadence", "total_sessions", "span_days", "domains", "role_lean", "headline"], args[2:]))
        elif "update public.agents" in sql:
            assert args[1] == self.agent["id"] and args[2] == self.owner
            self.agent["persona_md"] = args[0]
        elif "insert into public.world_group_members" in sql:
            if self.fail_join:
                raise RuntimeError("synthetic transaction failure")
            assert args == ("cafe", self.owner)
            self.joined = True


@pytest.fixture
def setup(monkeypatch):
    store = Store()

    @asynccontextmanager
    async def acquire():
        yield store

    monkeypatch.setattr(onboarding, "acquire", acquire)
    async def record_import(conn, owner, extract):
        assert conn is store and owner == store.owner
        store.private_import = extract
    async def analyze(owner):
        pass
    monkeypatch.setattr(onboarding.memory_service, 'record_import', record_import)
    monkeypatch.setattr(onboarding.memory_service, 'analyze', analyze)
    app = FastAPI()
    app.include_router(onboarding.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser("owner", None, "authenticated", {})
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, store, app


def post(client, body=None, name="session.jsonl"):
    return client.post("/api/ingest/claude-code", files=[("files", (name, body if body is not None else FIXTURE.read_bytes(), "application/octet-stream"))])


def test_upload_status_memory_membership_and_idempotence(setup):
    client, store, app = setup
    assert client.get("/api/ingest/claude-code").json()["imported"] is False
    response = post(client)
    assert response.status_code == 200
    data = response.json()
    assert data["agent_id"] == "self-twin"
    assert data["imported"] and store.joined
    assert data["profile"] == onboarding.BuilderSummary.model_validate(parse_claude_code_export(FIXTURE).profile.model_dump()).model_dump(mode="json")
    assert "excerpts" not in data
    assert store.agent["persona_md"].startswith("Original voice interview")
    assert "Builder memory" not in store.agent["persona_md"]
    assert store.private_import is not None
    assert store.private_import.excerpts
    assert not any(re.search(pattern, store.agent["persona_md"]) for pattern in LEAKS)
    assert client.get("/api/ingest/claude-code").json()["profile"] == data["profile"]
    assert post(client).json()["agent_id"] == data["agent_id"]
    assert store.agent["persona_md"] == "Original voice interview"


def test_anonymous_and_other_owner_cannot_import_into_twin(setup):
    client, store, app = setup
    app.dependency_overrides[get_current_user] = lambda: CurrentUser("other", None, "authenticated", {})
    assert client.get("/api/ingest/claude-code").json()["agent_id"] is None
    assert post(client).status_code == 409
    assert store.profile is None and not store.joined
    app.dependency_overrides.clear()
    assert post(client).status_code == 401


def test_signup_placeholder_does_not_skip_photo_step(setup):
    client, store, _ = setup
    store.agent["character_started"] = False
    assert client.get("/api/ingest/claude-code").json()["character_started"] is False
    assert post(client).status_code == 409
    assert store.profile is None


def test_existing_seed_profile_can_resume_onboarding(setup):
    client, store, _ = setup
    store.profile = {"projects": json.dumps([{"name": "Demo tools", "fingerprint": "abc", "sessions": 8}]),
                     "stacks": ["python"], "domains": ["devtools"], "cadence": "{}",
                     "role_lean": "infra", "headline": "Builds developer tools", "total_sessions": 8}
    response = client.get("/api/ingest/claude-code")
    assert response.status_code == 200
    assert response.json()["imported"]
    assert response.json()["profile"]["projects"] == [{"name": "Demo tools"}]


@pytest.mark.parametrize("body,name,expected", [
    (b"", "empty.jsonl", 422), (b"{broken\nnull", "bad.jsonl", 422),
    (b"unrelated", "export.zip", 415),
])
def test_bad_upload_leaves_twin_unchanged(setup, body, name, expected):
    client, store, _ = setup
    assert post(client, body, name).status_code == expected
    assert store.profile is None and not store.joined
    assert store.agent["persona_md"] == "Original voice interview"


def test_size_count_limits_and_cleanup(setup, monkeypatch):
    client, store, _ = setup
    directories = []
    original = onboarding.tempfile.TemporaryDirectory

    def temp(**kwargs):
        directory = original(**kwargs)
        directories.append(Path(directory.name))
        return directory

    monkeypatch.setattr(onboarding.tempfile, "TemporaryDirectory", temp)
    monkeypatch.setattr(onboarding, "MAX_UPLOAD_BYTES", 10)
    assert post(client).status_code == 413
    assert directories and all(not p.exists() for p in directories)
    monkeypatch.setattr(onboarding, "MAX_FILES", 1)
    assert client.post("/api/ingest/claude-code", files=[("files", ("a.jsonl", b"")), ("files", ("b.jsonl", b""))]).status_code == 413
    assert store.profile is None


def test_transaction_rolls_back_and_raw_upload_deleted_on_failure(setup, monkeypatch):
    client, store, _ = setup
    roots = []

    def parse(root):
        roots.append(root)
        return parse_claude_code_export(root)

    monkeypatch.setattr(onboarding, "parse_claude_code_export", parse)
    store.fail_join = True
    assert post(client).status_code == 500
    assert roots and all(not root.exists() for root in roots)
    assert store.profile is None and not store.joined
    assert store.agent["persona_md"] == "Original voice interview"


def test_many_files_and_filename_traversal_are_safe(setup, monkeypatch):
    client, store, _ = setup
    assert post(client, name="../../escape.jsonl").status_code == 200
    response = client.post("/api/ingest/claude-code", files=[
        ("files", ("one.jsonl", FIXTURE.read_bytes())), ("files", ("two.jsonl", FIXTURE.read_bytes())),
    ])
    assert response.status_code == 200
    assert response.json()["stats"]["files_seen"] == 2
    assert response.json()["stats"]["duplicates"] > 0
