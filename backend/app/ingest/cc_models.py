"""Portable, deterministic evidence for a builder twin (not a personality diagnosis)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Domain = Literal[
    "devtools", "evals", "observability", "data-infra", "agents", "memory",
    "retrieval", "fintech", "payments", "local-first", "sync", "simulation",
    "games", "dataviz", "design-systems", "frontend", "voice", "realtime",
    "compilers", "build-systems", "docs", "growth", "ops-tooling", "logistics",
    "optimization", "security", "infra", "ml",
]
RoleLean = Literal["infra", "interface", "product", "research", "generalist"]


class Project(BaseModel):
    name: str
    path_fingerprint: str
    first_seen: datetime
    last_seen: datetime
    session_count: int
    message_count: int
    branches: list[str]


class Cadence(BaseModel):
    active_days: int
    sessions_per_week: float
    hour_histogram: dict[int, int]
    longest_streak_days: int


class BuilderProfile(BaseModel):
    """Observed activity only. No LLM in this path."""

    projects: list[Project]
    stacks: list[str]
    tools: list[str]
    cadence: Cadence
    total_sessions: int
    span_days: int
    domains: list[Domain] = Field(default_factory=list)
    role_lean: RoleLean | None = "generalist"
    headline: str | None = Field(default=None, max_length=69)


class RedactedExcerpt(BaseModel):
    ts: datetime
    project: str
    role: Literal["user", "assistant"]
    text: str = Field(max_length=600)


class ClaudeCodeExtract(BaseModel):
    profile: BuilderProfile
    excerpts: list[RedactedExcerpt] = Field(max_length=200)
    stats: dict[str, int]
