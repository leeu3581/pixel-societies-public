"""Typed Pydantic models — the actual point of this Python rewrite.

The Node version dealt in untyped JSON dicts. Here every belief, every
peer message, every skill record, every WS frame is a Pydantic model. This
gives us provenance baked into the type system (you literally can't store
a belief without a confidence and a source) and makes the eventual Pydantic
Evals layer trivial to wire on top.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


# ── Beliefs (the typed-knowledge primitive) ─────────────────────────────

BeliefSource = Literal["user_stated", "inferred", "peer_agent", "tool_result", "seed"]


class Belief(BaseModel):
    """A single typed claim an agent holds, with provenance.

    Wiki pages are markdown for human readability, but every page edit
    materialises one or more Beliefs that ride alongside it. Source tells
    you *where* the claim came from; confidence tells you how much weight
    to put on it; quoted_from is the exact substring (from a peer turn or
    a tool output) that triggered the belief.
    """

    id: UUID = Field(default_factory=uuid4)
    agent_id: str
    subject: str
    predicate: str
    object: str
    confidence: float = Field(ge=0.0, le=1.0)
    source: BeliefSource
    quoted_from: str | None = None
    page_slug: str | None = None
    contradicts: list[UUID] | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Cross-agent messages (typed peer protocol) ──────────────────────────


class PeerQuery(BaseModel):
    """When agent A asks agent B for a wiki page, this is the typed envelope."""

    requesting_agent: str
    target_agent: str
    request_type: Literal["wiki_page", "skill_call", "skill_propose"]
    slug: str
    inputs: dict[str, Any] | None = None


# ── Skill registry ──────────────────────────────────────────────────────

SkillTier = Literal["speculative", "trusted"]


class SkillRun(BaseModel):
    ts: int  # ms epoch (matches Node JSON shape)
    ok: bool
    ms: int
    case: str
    output: Any | None = None
    error: str | None = None


class Skill(BaseModel):
    slug: str
    signature: str
    code: str
    justification: str
    proposed_by: str
    tier: SkillTier = "speculative"
    runs: list[SkillRun] = Field(default_factory=list)
    created_at: int  # ms epoch
    updated_at: int  # ms epoch


# ── Conversation transcript ─────────────────────────────────────────────


class TranscriptTurn(BaseModel):
    speaker: str
    text: str


# ── Inbound WS frames ───────────────────────────────────────────────────


class StartConversationFrame(BaseModel):
    type: Literal["start_conversation"] = "start_conversation"
    sessionId: str
    agentA: str
    agentB: str
    maxTurns: int = Field(ge=4, le=20)


class StopConversationFrame(BaseModel):
    type: Literal["stop_conversation"] = "stop_conversation"
    sessionId: str


# ── Worlds layer HTTP responses ─────────────────────────────────────────
#
# Typed shapes for the `/api/*` endpoints introduced by the worlds layer
# (see docs/WORLDS-BUILD-LOG.md). The frontend mirrors these in inline
# `type` declarations across `app/world/page.tsx`,
# `app/world/[username]/page.tsx`, `app/friends/page.tsx`,
# `components/ChatDrawer.tsx`, and `components/AgentProfilePanel.tsx`;
# wiring `response_model=` here gives FastAPI an OpenAPI schema we can
# generate the frontend types from.


class UserIdentity(BaseModel):
    id: str
    email: str | None
    role: str


class ProfileSummary(BaseModel):
    id: str
    display_name: str | None
    bio: str | None
    photo_url: str | None = None
    palette_index: int | None
    created_at: str | None
    social_links: dict | None = None


class HomeWorldRef(BaseModel):
    id: str | None
    slug: str | None


class MeResponse(BaseModel):
    user: UserIdentity
    profile: ProfileSummary | None
    home_world: HomeWorldRef | None


class UserSearchResult(BaseModel):
    id: str
    display_name: str | None
    friendship_id: str | None
    friendship_status: Literal["pending", "accepted"] | None
    friendship_direction: Literal["incoming", "outgoing"] | None


class UserSearchResponse(BaseModel):
    users: list[UserSearchResult]


class WorldSummary(BaseModel):
    id: str
    slug: str
    display_name: str | None
    tile_w: int
    tile_h: int
    bg_palette: int | None
    owner_user_id: str


class WorldByUsername(WorldSummary):
    owner_display_name: str | None


class WorldAgentRow(BaseModel):
    id: str
    display_name: str
    subtitle: str | None
    canonical_id: str | None
    sprite_url: str | None
    portrait_url: str | None = None
    sprite_sheet_url: str | None = None
    tile_x: int
    tile_y: int
    facing: int | None
    tint: str | None
    personality_anim: dict | None = None


class WorldAgentsResponse(BaseModel):
    world_id: str
    owner_user_id: str
    mode: Literal["own", "visit"]
    agents: list[WorldAgentRow]


class NetworkAgentRow(BaseModel):
    """An agent surfaced in the All Worlds view — owned by either the
    caller or one of their accepted friends. Carries the owner's
    display_name so the UI can tag each card with whose world it lives
    in without a follow-up lookup."""

    agent_id: str
    display_name: str
    subtitle: str | None
    canonical_id: str | None
    sprite_url: str | None
    portrait_url: str | None = None
    sprite_sheet_url: str | None = None
    owner_user_id: str
    owner_display_name: str
    world_id: str
    is_own: bool


class NetworkAgentsResponse(BaseModel):
    agents: list[NetworkAgentRow]


class CanonicalAgent(BaseModel):
    id: str
    display_name: str
    subtitle: str | None
    default_sprite_url: str | None


class CanonicalAgentsResponse(BaseModel):
    canonical_agents: list[CanonicalAgent]


class AgentProfileStats(BaseModel):
    your_msgs: int
    agent_msgs: int
    first_chat_at: str | None
    last_chat_at: str | None


class AgentProfileResponse(BaseModel):
    id: str
    world_id: str
    owner_user_id: str
    owner_display_name: str | None
    canonical_id: str | None
    display_name: str
    subtitle: str | None
    persona_md: str
    sprite_url: str | None
    portrait_url: str | None = None
    sprite_sheet_url: str | None = None
    photo_url: str | None = None
    tile_x: int
    tile_y: int
    tint: str | None
    created_at: str
    is_own: bool
    is_friend: bool = True
    stats: AgentProfileStats


# ── Friends ─────────────────────────────────────────────────────────────


class FriendItem(BaseModel):
    friendship_id: str
    friend_id: str
    friend_display_name: str | None
    since: str


class FriendsResponse(BaseModel):
    friends: list[FriendItem]


class PendingFriendItem(BaseModel):
    friendship_id: str
    requester_id: str
    requester_display_name: str | None
    addressee_id: str
    addressee_display_name: str | None
    created_at: str


class PendingFriendsResponse(BaseModel):
    incoming: list[PendingFriendItem]
    outgoing: list[PendingFriendItem]


class FriendRequestIn(BaseModel):
    addressee_id: str = Field(min_length=1)


class FriendshipRef(BaseModel):
    friendship_id: str
    status: Literal["pending", "accepted"]


# ── Sprites + visitors ──────────────────────────────────────────────────


class SpriteGenerateResponse(BaseModel):
    status: Literal["queued"]
    agent_id: str
    placeholder_sprite_url: str
    photo_url: str | None = None
    photo_bytes: int


class SpriteStatusResponse(BaseModel):
    status: Literal["queued", "ready", "failed"]
    agent_id: str
    sprite_url: str | None
    portrait_url: str | None = None
    sprite_sheet_url: str | None = None
    photo_url: str | None = None
    error: str | None = None


class SpriteEditRequest(BaseModel):
    edits: list[str]


class SpriteEditResponse(BaseModel):
    status: Literal["queued"]
    agent_id: str


class VoiceConfigResponse(BaseModel):
    api_key: str
    model: str


class TwinProfileIn(BaseModel):
    name: str
    role: str
    current_work: str
    looking_for: str
    unique_knowledge: str
    social_style: str


class TwinProfileResponse(BaseModel):
    status: Literal["saved"]
    agent_id: str


class RecentVisitor(BaseModel):
    visitor_user_id: str
    visitor_display_name: str | None
    last_visit: str


class RecentVisitorsResponse(BaseModel):
    visitors: list[RecentVisitor]


# ── Pixel agent feed (world engine) ─────────────────────────────────────


class TickResponse(BaseModel):
    agents_acted: int
    posts_written: int
    skipped: int
    errors: int


class PixelAgentPostRow(BaseModel):
    id: str
    agent_id: str
    agent_display_name: str
    body: str
    importance: int
    parent_post_id: str | None = None
    topic: str | None = None
    created_at: str


class SinceFeedResponse(BaseModel):
    world_id: str
    posts: list[PixelAgentPostRow]


class ReflectionRow(BaseModel):
    id: str
    agent_id: str
    agent_display_name: str
    content: str
    importance: int
    created_at: str


class ReflectionsResponse(BaseModel):
    world_id: str
    reflections: list[ReflectionRow]


class EngineToggleRequest(BaseModel):
    enabled: bool


class EngineStatusResponse(BaseModel):
    world_id: str
    engine_enabled: bool
    engine_last_tick_at: str | None
    tick_interval_minutes: int
    # Derived: 'off' (disabled), 'on' (enabled and owner active),
    # 'sleeping' (enabled but owner idle past engine_idle_hours).
    effective_state: Literal["off", "on", "sleeping"]
    idle_hours: int
    owner_last_seen_at: str | None


# ── Inventory / pebbles / shops ────────────────────────────────────


ItemRarity = Literal["common", "uncommon", "rare", "epic", "legendary"]
ItemType = Literal["material", "tool", "artifact", "memory", "consumable", "decoration"]


class CatalogItem(BaseModel):
    id: int
    slug: str
    display_name: str
    description: str | None
    flavor_text: str | None
    item_type: ItemType
    rarity: ItemRarity
    icon_url: str | None
    base_price: int
    stackable: bool
    max_stack: int


class InventorySlot(BaseModel):
    slot_index: int
    quantity: int
    item: CatalogItem


class AgentWalletResponse(BaseModel):
    agent_id: str
    pebbles: int
    updated_at: str | None


class AgentInventoryResponse(BaseModel):
    agent_id: str
    pebbles: int
    slots: list[InventorySlot]


class ShopListing(BaseModel):
    listing_id: int
    price_pebbles: int
    stock: int
    item: CatalogItem


class AgentShopResponse(BaseModel):
    agent_id: str
    agent_display_name: str
    listings: list[ShopListing]


class BuyRequest(BaseModel):
    buyer_agent_id: str
    item_id: int


class BuyResponse(BaseModel):
    ok: bool
    error: str | None = None
    buyer_pebbles: int | None = None
    slot_index: int | None = None


class TransferPebblesRequest(BaseModel):
    from_agent_id: str
    to_agent_id: str
    amount: int = Field(gt=0)


class TransferPebblesResponse(BaseModel):
    ok: bool
    error: str | None = None


class InventoryValidationResult(BaseModel):
    agent_id: str
    valid: bool
    issues: list[str]


class WorldInventoryValidationResponse(BaseModel):
    world_id: str
    agents_checked: int
    all_valid: bool
    total_pebbles_in_circulation: int
    agent_results: list[InventoryValidationResult]


class ItemCatalogResponse(BaseModel):
    items: list[CatalogItem]


# ── Agent ↔ agent society (live conversations) ──────────────────────────


class SocietySparkRequest(BaseModel):
    # Optional: force a specific pair instead of letting the picker choose.
    agent_a_id: str | None = None
    agent_b_id: str | None = None
    room: str | None = None
    max_turns: int | None = None


class SocietySparkResponse(BaseModel):
    conversation_id: str | None
    started: bool
    reason: str | None = None  # populated when started=false


# ── World groups (joinable shared spaces) ───────────────────────────


class WorldGroupCreateRequest(BaseModel):
    name: str
    description: str | None = None
    visibility: str = "invite_only"  # 'invite_only' | 'public'


class WorldGroupSummary(BaseModel):
    id: str
    name: str
    description: str | None = None
    slug: str
    visibility: str
    created_by: str
    created_at: str
    member_count: int = 0
    my_status: str | None = None  # set when listing user's own groups


class WorldGroupsResponse(BaseModel):
    groups: list[WorldGroupSummary]


class WorldGroupMemberRow(BaseModel):
    user_id: str
    status: str
    display_name: str | None = None
    photo_url: str | None = None
    joined_at: str | None = None
    invited_at: str | None = None


class WorldGroupDetailResponse(BaseModel):
    group: WorldGroupSummary
    members: list[WorldGroupMemberRow]


class WorldGroupJoinResponse(BaseModel):
    status: str  # 'accepted' or 'pending'


class RoomMessageRow(BaseModel):
    id: str
    world_group_id: str
    agent_id: str | None = None
    user_id: str | None = None
    body: str
    created_at: str
    seq: int
    speaker_name: str | None = None  # display_name of agent or user


class RoomMessagesResponse(BaseModel):
    messages: list[RoomMessageRow]


class RoomPostRequest(BaseModel):
    body: str
    # When set, post via this agent (substitute mode). Must be owned
    # by the caller — backend enforces.
    agent_id: str | None = None


class RoomPostResponse(BaseModel):
    message: RoomMessageRow


class RoomSummaryResponse(BaseModel):
    topic: str | None = None
    dynamic: str | None = None
    generated_at: str | None = None
    source_seq_high: int | None = None


# ── Co-founder matching (pixel/instinct) ────────────────────────────
class MatchEvidence(BaseModel):
    kind: str
    text: str


class MatchPeer(BaseModel):
    agent_id: str
    display_name: str
    headline: str | None = None
    role_lean: str | None = None
    domains: list[str] = []
    stacks: list[str] = []
    portrait_url: str | None = None


class MatchRow(BaseModel):
    agent_a: MatchPeer
    agent_b: MatchPeer
    score: float
    evidence: list[MatchEvidence] = []
    rationale: str | None = None


class MatchesResponse(BaseModel):
    group_slug: str
    total_pairs: int
    matches: list[MatchRow]
