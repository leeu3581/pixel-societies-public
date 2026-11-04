"""Pydantic models for the profile-ingest pipeline.

Per-chunk extraction → final synthesis → render. Schemas mirror the
Zoe.md target document: an Obsidian-style person page with overview,
work, interests, projects, links, relationships, voice, and themes.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ── Per-chunk extraction ─────────────────────────────────────────────


class Entity(BaseModel):
    """Anything proper-noun-shaped the target referenced."""

    name: str
    kind: Literal["person", "company", "product", "place", "tool", "concept"]
    note: str = Field(default="", description="One short clause of context.")


class EventMention(BaseModel):
    when: str = Field(description="Free-form date or timeframe — e.g. '2025-08' or 'last summer'.")
    what: str
    role: Literal["organised", "attended", "spoke_at", "judged", "won", "applied", "mentioned"] = "mentioned"


class InterestSignal(BaseModel):
    topic: str
    evidence: str = Field(description="One concrete sentence quoting or summarising support from the chat.")


class OpinionSignal(BaseModel):
    take: str = Field(description="Sharp position the target expressed.")
    when_applies: str = Field(description="Domain or trigger where this view appeared.")


class VoiceSample(BaseModel):
    text: str = Field(description="Verbatim quote ≤ 120 chars showing register/tone.")
    note: str = Field(default="", description="Why this is representative.")


class LinkMention(BaseModel):
    url: str
    purpose: str = Field(description="Why it was shared — one short clause.")


class RelationshipMention(BaseModel):
    name: str
    connection: str = Field(description="One sentence on how the target relates to them.")


class ChunkExtraction(BaseModel):
    """What one chunk of messages produced."""

    chunk_label: str = ""
    entities: list[Entity] = Field(default_factory=list)
    events: list[EventMention] = Field(default_factory=list)
    interests: list[InterestSignal] = Field(default_factory=list)
    opinions: list[OpinionSignal] = Field(default_factory=list)
    voice_samples: list[VoiceSample] = Field(default_factory=list)
    links: list[LinkMention] = Field(default_factory=list)
    relationships: list[RelationshipMention] = Field(default_factory=list)
    summary: str = Field(default="", description="One paragraph summary of this chunk.")


# ── Final synthesis ───────────────────────────────────────────────────


class WorkSection(BaseModel):
    day_job: str = Field(default="", description="Markdown bullets describing employer + role.")
    side_projects: str = Field(default="", description="Markdown bullets on community / side-project work.")
    investment_or_business_interests: str = Field(default="")


class TopicCluster(BaseModel):
    title: str = Field(description="Section heading, e.g. 'Vibe Coding'.")
    bullets: list[str] = Field(description="Markdown bullets — concrete, specific.")


class ProjectEntry(BaseModel):
    name: str
    description: str
    url: str = ""


class LinkGroup(BaseModel):
    title: str
    links: list[LinkMention]


class RelationshipEntry(BaseModel):
    name: str
    summary: str = Field(description="2-4 sentences on the relationship.")


class CommunicationStyle(BaseModel):
    one_line: str = Field(description="Adjective-rich one-line summary.")
    traits: list[str] = Field(description="Markdown bullets — register, tics, habits.")


class ThemeEntry(BaseModel):
    title: str
    body: str = Field(description="One paragraph naming the recurring tension.")


class ProfilePage(BaseModel):
    """The final document shape — mirrors the Zoe.md template."""

    name: str
    aliases: list[str] = Field(default_factory=list)
    subtitle: str = Field(
        default="",
        description=(
            "Two-to-four-word archetype prefixed with 'The'. Pick the single "
            "label that captures this person's defining pattern: e.g. 'The "
            "Community Builder', 'The Operator', 'The Connector', 'The Critic'."
        ),
    )
    overview: str = Field(description="2-paragraph executive overview with [[wikilinks]] on key entities.")
    work: WorkSection
    interests: list[TopicCluster] = Field(default_factory=list)
    projects: list[ProjectEntry] = Field(default_factory=list)
    link_groups: list[LinkGroup] = Field(default_factory=list)
    relationships: list[RelationshipEntry] = Field(default_factory=list)
    communication_style: CommunicationStyle
    recurring_themes: list[ThemeEntry] = Field(default_factory=list)


# ── Job state (server-side; not LLM output) ───────────────────────────


class IngestJob(BaseModel):
    job_id: str
    file_path: str
    file_name: str
    detected_format: Literal["whatsapp_zip", "text_doc", "text_paste", "claude_code", "unsupported"]
    # Whatsapp uses both target+self; text formats only use target (the
    # subject of the document/paste).
    target_sender: str = ""
    self_sender: str = ""
    detected_senders: list[str] = Field(default_factory=list)
    # Worlds-layer fields: present when the ingest was kicked off through
    # `/api/worlds/me/ingest/*`. The runner branches on `owner_user_id` —
    # if set, the final synthesised profile is written to public.agents
    # for that user's home world; if None, the legacy filesystem write
    # path under data/wikis/ runs instead.
    owner_user_id: str | None = None
    world_id: str | None = None
    # Filled after the DB insert so the WS `ingest_done` frame can carry
    # the new agent's id back to the frontend for deep-linking.
    agent_id: str | None = None
