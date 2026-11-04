from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field

Kind = Literal['workstream', 'capability', 'interest', 'need', 'offer', 'intent', 'question']


class Insight(BaseModel):
    kind: Kind
    title: str = Field(min_length=3, max_length=90)
    summary: str = Field(min_length=10, max_length=650)
    evidence_ids: list[str] = Field(min_length=1, max_length=8)
    confidence: Literal['low', 'medium', 'high']
    uncertainty: str = Field(min_length=5, max_length=350)
    topics: list[str] = Field(default_factory=list, max_length=6)
    workstream: str = Field(default='', max_length=90)
    next_step: str = Field(default='', max_length=240)


class Interpretation(BaseModel):
    insights: list[Insight] = Field(default_factory=list, max_length=32)


class Review(BaseModel):
    revision: int
    action: Literal['confirm', 'correct', 'dismiss', 'resolve']
    summary: str | None = Field(default=None, min_length=10, max_length=650)


class Note(BaseModel):
    text: str = Field(min_length=10, max_length=4000)
    kind: Kind = 'workstream'


class Share(BaseModel):
    revision: int
    purpose: Literal['profile', 'help', 'collaborate', 'cofounder'] = 'profile'
    group_slug: str = Field(default='cofounder-cafe', max_length=100)
    text: str = Field(min_length=10, max_length=650)
    available: str = Field(default='', max_length=160)
    days: int = Field(default=30, ge=1, le=30)


class Feedback(BaseModel):
    outcome: Literal['useful', 'not_useful', 'contacted', 'collaborated']
    note: str = Field(default='', max_length=500)


class PublicationItem(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=2, max_length=40)
    text: str = Field(min_length=10, max_length=650)
    section: Literal['building', 'approach', 'thinking', 'values'] = 'thinking'
    reading: str = Field(default='',max_length=75)


class PreviewRequest(BaseModel):
    revision: int


class PublishSelected(PreviewRequest):
    items: list[PublicationItem] = Field(min_length=1, max_length=32)
    group_slug: str = Field(default='cofounder-cafe', max_length=100)
