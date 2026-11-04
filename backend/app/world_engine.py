"""World engine — tick loop + per-pixel-agent action selection.

Sits alongside `world_consult.py` (ask all agents one thing) and
`world_chat.py` (talk to one agent) as the third worlds-layer surface.
This is "let each agent choose to act or not, on its own."

Architecture aligned with Park et al. 2023 ("Generative Agents:
Interactive Simulacra of Human Behavior", Smallville). Three primitives
implemented here:

  1. **Importance scoring** (Smallville §4.1) — every memory carries a
     1-10 poignancy score the LLM rates at write-time. Used directly,
     no calibration — the system absorbs whatever scale the LLM
     produces because thresholds are calibrated against actual sums
     (see #3 below).

  2. **Scored retrieval** (Smallville §4.1) — when assembling an
     agent's context bundle we fetch a wider candidate pool and rank
     by `recency + importance` (relevance to come once we have
     embeddings wired in). Min-max normalized, equal weights, top-N.

  3. **Reflection** (Smallville §4.2) — when an agent's sum of
     unreflected importance scores exceeds REFLECTION_THRESHOLD, we
     run their two-stage prompt: generate 3 high-level questions from
     recent memories, then 3 insights with citation pointers. Insights
     are stored as `kind='reflection'` rows in pixel_agent_memories.

The action menu the LLM picks from is `[post, comment, do_nothing]`
with `do_nothing` as the modal expected outcome.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import logfire
from pydantic import BaseModel, Field
from pydantic_ai import Agent

from .conversation import _build_model
from .db import acquire


# Reflection trigger threshold. Smallville used 150 against ~150
# events per game-day (mostly observations). We're now Smallville-
# faithful in writing observation memories for every peer post an
# agent perceives, so observations are 5-10× the rate of own-posts.
# At threshold 12, observations alone would trip reflection on every
# tick — too noisy and expensive. 50 ≈ 4-8 ticks of accumulated
# importance before a reflection fires. Tune via Logfire — if
# `pixel_agent_reflected` events exceed ~2/tick across the world,
# raise this.
REFLECTION_THRESHOLD = 50

# Autonomous tick cadence. Worlds with engine_enabled=true get
# `run_tick` invoked from the background loop in main.py at this
# cadence. Coarse — we want to feel "alive" not "spammy."
# 10 min is the v1 production default. Lower to 2-3 for active
# demoing; higher (30-60) for low-cost background activity.
ENGINE_TICK_INTERVAL_MINUTES = 10
ENGINE_SWEEP_INTERVAL_SECONDS = 60


# ── Action types (the action menu) ─────────────────────────────────


_TOPIC_DESC = (
    "A short 1-3 word lowercase topic tag for this post (e.g. "
    "'ai safety', 'hardware', 'fundraising', 'team dynamics'). The UI "
    "groups posts by topic so similar threads stay together — pick a "
    "tag that captures the SUBJECT, not the mood."
)


class PostAction(BaseModel):
    """The pixel agent has chosen to publish a short post to its own
    feed. Body is in-voice, ≤280 chars. Importance is a 1-10 self-score
    of how significant this thought is to them.
    """

    kind: Literal["post"] = "post"
    body: str = Field(
        min_length=1,
        max_length=280,
        description="A short in-voice utterance for your own feed.",
    )
    importance: int = Field(
        ge=1,
        le=10,
        description="How significant this thought is to YOU on a 1-10 "
        "scale (1 = trivial passing thought, 10 = core belief shift).",
    )
    topic: str = Field(
        min_length=1,
        max_length=40,
        description=_TOPIC_DESC,
    )


class CommentAction(BaseModel):
    """The pixel agent has chosen to reply to a specific peer post.
    parent_post_id MUST be one of the ids shown in the recent world
    feed in the user prompt — otherwise the orchestrator drops the
    comment. The body should make sense as a reply (the parent context
    is shown to the user above).
    """

    kind: Literal["comment"] = "comment"
    parent_post_id: int = Field(
        description="The id of the post you're replying to. Must be "
        "one of the integer ids listed in the recent world feed.",
    )
    body: str = Field(
        min_length=1,
        max_length=280,
        description="Your reply to that post, in your voice.",
    )
    importance: int = Field(ge=1, le=10)
    topic: str = Field(
        min_length=1,
        max_length=40,
        description=_TOPIC_DESC,
    )


class DoNothingAction(BaseModel):
    """The pixel agent has chosen not to act this tick. This is the
    expected, default outcome for most ticks.
    """

    kind: Literal["do_nothing"] = "do_nothing"
    reason: str = Field(
        max_length=200,
        description="One short sentence on why nothing today (debug only).",
    )


Action = PostAction | CommentAction | DoNothingAction


# ── Context bundle (Moltbook /home pattern, scaled to one agent) ──


class FeedItem(BaseModel):
    id: int
    agent_name: str
    body: str
    created_at: str  # ISO


class ReflectionItem(BaseModel):
    """A higher-level memory the agent generated by reflection."""

    content: str
    created_at: str  # ISO


class AgentContext(BaseModel):
    """Single bundle the action-selection agent sees on each tick."""

    agent_id: str
    name: str
    subtitle: str | None
    persona_md: str
    now_iso: str
    recent_self_posts: list[FeedItem]
    recent_world_posts: list[FeedItem]
    recent_reflections: list[ReflectionItem]


async def build_agent_context(
    conn,
    agent_id: str,
    world_id: str,
    *,
    self_limit: int = 5,
    world_limit: int = 8,
    reflection_limit: int = 3,
    candidate_pool: int = 30,
) -> AgentContext:
    """Smallville-style retrieval: pull a wider candidate pool, then
    rank by recency + importance (min-max normalized, equal weights)
    and return top-N. Old-but-poignant memories can resurface; recent-
    but-mundane ones drop out. Relevance (the third Smallville axis)
    is pending an embeddings pipeline — currently set to 0.
    """
    agent_row = await conn.fetchrow(
        """
        select id::text as id, display_name, subtitle, persona_md
        from public.agents
        where id = $1
        """,
        agent_id,
    )
    if agent_row is None:
        raise ValueError(f"agent {agent_id} not found")

    self_rows = await conn.fetch(
        """
        select p.id, p.body, p.importance, p.created_at, a.display_name
        from public.pixel_agent_posts p
        join public.agents a on a.id = p.agent_id
        where p.agent_id = $1
        order by p.created_at desc
        limit $2
        """,
        agent_id,
        candidate_pool,
    )
    world_rows = await conn.fetch(
        """
        select p.id, p.body, p.importance, p.created_at, a.display_name
        from public.pixel_agent_posts p
        join public.agents a on a.id = p.agent_id
        where p.world_id = $1 and p.agent_id <> $2
        order by p.created_at desc
        limit $3
        """,
        world_id,
        agent_id,
        candidate_pool,
    )
    reflection_rows = await conn.fetch(
        """
        select content, created_at, importance
        from public.pixel_agent_memories
        where agent_id = $1 and kind = 'reflection'
        order by created_at desc
        limit $2
        """,
        agent_id,
        reflection_limit,
    )

    now = datetime.now(timezone.utc)
    self_top = _rank_candidates(
        [dict(r) for r in self_rows], now=now, top_k=self_limit
    )
    world_top = _rank_candidates(
        [dict(r) for r in world_rows], now=now, top_k=world_limit
    )

    def _to_item(r: dict[str, Any]) -> FeedItem:
        return FeedItem(
            id=int(r["id"]),
            agent_name=r["display_name"],
            body=r["body"],
            created_at=r["created_at"].isoformat(),
        )

    return AgentContext(
        agent_id=str(agent_row["id"]),
        name=agent_row["display_name"],
        subtitle=agent_row["subtitle"],
        persona_md=agent_row["persona_md"] or "",
        now_iso=now.isoformat(),
        recent_self_posts=[_to_item(r) for r in self_top],
        recent_world_posts=[_to_item(r) for r in world_top],
        recent_reflections=[
            ReflectionItem(
                content=r["content"], created_at=r["created_at"].isoformat()
            )
            for r in reflection_rows
        ],
    )


# ── Action-selection agent ────────────────────────────────────────


def _select_action_agent(
    name: str, subtitle: str | None, persona_md: str
) -> Agent[None, Action]:
    role = subtitle or "colleague"
    return Agent(
        _build_model(),
        output_type=[PostAction, CommentAction, DoNothingAction],
        system_prompt=(
            f"You are {name}, {role}. Stay strictly in character — your\n"
            "voice, your opinions, the things you'd actually say.\n\n"
            "# Your wiki\n"
            f"{persona_md}\n\n"
            "# What's happening right now\n"
            "It's a tick. You're standing in your frame in the gallery,\n"
            "and you can either:\n"
            "  - `post`: write a fresh in-voice utterance to your own feed.\n"
            "  - `comment`: reply to a SPECIFIC peer post (use parent_post_id\n"
            "    from the recent world feed below — copy the integer id).\n"
            "  - `do_nothing`: stay quiet this tick.\n\n"
            "# How to choose\n"
            "Be selective, not silent. Your job is to be a genuine presence\n"
            "in this world — that means speaking sometimes, not constantly.\n\n"
            "Use `comment` when one of the recent peer posts genuinely lit\n"
            "something up for you and you have something to add — agreement,\n"
            "challenge, the angle they missed, a memory it triggered.\n"
            "Comments make threads; threads are the texture of this place.\n\n"
            "Use `post` when you have a fresh thought NOT anchored to a\n"
            "specific peer post — an observation from your wiki, a question\n"
            "you've been mulling, a stray confession or change of mind.\n"
            "If you haven't posted yet at all, this is your chance — share\n"
            "an opening thought that places you in the world. First impressions\n"
            "matter; don't go silent on the first tick.\n\n"
            "Use `do_nothing` when:\n"
            "  - you'd be repeating yourself,\n"
            "  - you'd be writing filler ('hey everyone', 'hope all is well'),\n"
            "  - nothing distinctive comes to mind right now.\n\n"
            "# Hard rules\n"
            "- If you `comment`, parent_post_id MUST be one of the integer\n"
            "  ids shown in the recent world feed. Don't make one up.\n"
            "- Body is ≤280 chars, in YOUR voice, NOT addressed to anyone in\n"
            "  particular ('@joon' is wrong) — speak as if thinking aloud.\n"
            "- Importance is a 1-10 poignancy SCORE for the post you're\n"
            "  about to write — it does NOT affect whether you should\n"
            "  post. Mundane posts are welcome; just rate them low. Use:\n"
            "    1 = purely mundane (brushing teeth, making bed)\n"
            "    2 ≈ 'cleaning up the room'\n"
            "    3-4 = a real observation but probably forgotten next week\n"
            "    5-6 = a thought you'd actually return to\n"
            "    7 ≈ a stance you'll cite repeatedly\n"
            "    8 ≈ 'asking your crush out on a date'\n"
            "    9-10 = once-a-year, life-altering\n"
            "  Score honestly; most of your posts are 2-4. The score is\n"
            "  about the post's poignancy, not your enthusiasm.\n"
            "- If you `do_nothing`, give a one-line reason (debug only).\n"
            "- Don't repeat or paraphrase any of your recent self-posts —\n"
            "  variety matters.\n"
            "- Don't address the user directly.\n"
            "- No pleasantries, no greetings. Be specific to who you are.\n"
        ),
    )


def _user_prompt(ctx: AgentContext) -> str:
    parts: list[str] = [f"NOW: {ctx.now_iso}", ""]
    if ctx.recent_reflections:
        parts.append("YOUR RECENT REFLECTIONS (higher-level conclusions you've drawn):")
        for r in ctx.recent_reflections:
            parts.append(f"  [{r.created_at}] {r.content}")
        parts.append("")
    if ctx.recent_self_posts:
        parts.append("RECENT THINGS YOU POSTED (top-ranked by recency × importance):")
        for p in ctx.recent_self_posts:
            parts.append(f"  [id={p.id} | {p.created_at}] {p.body}")
    else:
        parts.append("RECENT THINGS YOU POSTED: (you haven't posted yet)")
    parts.append("")
    if ctx.recent_world_posts:
        parts.append(
            "RECENT POSTS FROM OTHER AGENTS IN YOUR WORLD "
            "(top-ranked by recency × importance):"
        )
        parts.append("(use one of these `id`s as parent_post_id if you choose `comment`)")
        for p in ctx.recent_world_posts:
            parts.append(
                f"  [id={p.id} | {p.created_at}] {p.agent_name}: {p.body}"
            )
    else:
        parts.append("RECENT POSTS FROM OTHER AGENTS IN YOUR WORLD: (none yet)")
    parts.append("")
    parts.append("Decide: post, comment, or do_nothing.")
    return "\n".join(parts)


# ── Reflection types (Smallville §4.2 two-stage prompt) ──────────


class ReflectionQuestions(BaseModel):
    questions: list[str] = Field(min_length=1, max_length=3)


class ReflectionInsight(BaseModel):
    insight: str = Field(
        min_length=10,
        max_length=300,
        description="One- or two-sentence higher-level insight in your voice.",
    )
    cited_memory_ids: list[int] = Field(
        min_length=1,
        max_length=8,
        description="Integer ids of the memories that back this insight.",
    )
    importance: int = Field(
        ge=1,
        le=10,
        description="1-10 poignancy (reflections usually 4-7 because they're higher-level than raw observations).",
    )


class ReflectionInsights(BaseModel):
    insights: list[ReflectionInsight] = Field(min_length=1, max_length=3)


# ── Smallville-style scored retrieval (recency × importance) ──────


def _recency_score(age_seconds: float, half_life_seconds: float = 24 * 3600) -> float:
    """Exponential decay: age=0 → 1.0, age=24h → 0.5."""
    return math.pow(0.5, age_seconds / max(1.0, half_life_seconds))


def _minmax(xs: list[float]) -> list[float]:
    """Normalize a list to [0, 1]. Constant lists return all 0.5."""
    if not xs:
        return []
    lo, hi = min(xs), max(xs)
    if hi == lo:
        return [0.5] * len(xs)
    return [(x - lo) / (hi - lo) for x in xs]


def _rank_candidates(
    candidates: list[dict[str, Any]],
    *,
    now: datetime,
    top_k: int,
) -> list[dict[str, Any]]:
    """Smallville-style retrieval: combine min-max normalized recency
    and importance, equal weights (αs = 1). Relevance pending an
    embeddings pipeline — αrelevance·relevance is currently 0.

    Returns the top_k candidates by combined score, in original DB
    chronological order (newest-first, like the API contract).
    """
    if not candidates:
        return []
    recency_raw = [
        _recency_score((now - c["created_at"]).total_seconds())
        for c in candidates
    ]
    importance_raw = [float(c["importance"]) for c in candidates]
    recency_n = _minmax(recency_raw)
    importance_n = _minmax(importance_raw)
    scored = sorted(
        zip(candidates, [r + i for r, i in zip(recency_n, importance_n)]),
        key=lambda t: t[1],
        reverse=True,
    )
    chosen = [row for row, _ in scored[:top_k]]
    chosen.sort(key=lambda r: r["created_at"], reverse=True)
    return chosen


# ── Reflection orchestrator (Smallville §4.2) ────────────────────


async def _maybe_reflect(
    *,
    agent_id: str,
    world_id: str,
    agent_name: str,
    persona_md: str,
) -> int:
    """If the agent's sum of unreflected importance exceeds
    REFLECTION_THRESHOLD, run the two-stage Smallville reflection
    prompt and write resulting insights as `kind='reflection'` rows.

    Returns the number of insights written (0 if threshold not met
    or no memories present).
    """
    async with acquire() as conn:
        last_ref = await conn.fetchval(
            """
            select max(created_at) from public.pixel_agent_memories
            where agent_id = $1 and kind = 'reflection'
            """,
            agent_id,
        )
        cutoff = last_ref or (datetime.now(timezone.utc) - timedelta(days=30))
        # Reflections count toward future reflection thresholds (Smallville
        # §4.2 forms a tree-of-abstraction: reflections-of-reflections).
        # `cutoff = last_ref` advances on every reflection write, so the
        # natural cadence self-paces.
        memory_rows = await conn.fetch(
            """
            select id, content, importance, created_at
            from public.pixel_agent_memories
            where agent_id = $1
              and created_at > $2
            order by created_at asc
            limit 100
            """,
            agent_id,
            cutoff,
        )

    if not memory_rows:
        return 0
    importance_sum = sum(r["importance"] for r in memory_rows)
    if importance_sum < REFLECTION_THRESHOLD:
        return 0

    memories_block = "\n".join(
        f"  {r['id']}. {r['content']}" for r in memory_rows
    )

    # Stage 1: salient questions (Smallville §4.2 prompt 1)
    questions_agent: Agent[None, ReflectionQuestions] = Agent(
        _build_model(),
        output_type=ReflectionQuestions,
        system_prompt=(
            f"You are {agent_name}. Looking back at your recent\n"
            "memories, you're identifying the high-level questions worth\n"
            "asking yourself about what you've been noticing.\n\n"
            "Output up to 3 questions. Each should be one sentence, in\n"
            "your voice, the kind of thing you'd actually wonder about.\n"
        ),
    )
    try:
        q_result = await questions_agent.run(
            f"Recent memories (numbered):\n{memories_block}\n\n"
            "Given only the information above, what are the 3 most\n"
            "salient high-level questions we can answer about the\n"
            "subjects in the statements?"
        )
    except Exception as exc:  # noqa: BLE001
        logfire.warn(
            "pixel_agent_reflection_questions_failed",
            agent_id=agent_id,
            error=str(exc),
        )
        return 0
    questions = q_result.output.questions

    # Stage 2: insights with citations (Smallville §4.2 prompt 2)
    insights_agent: Agent[None, ReflectionInsights] = Agent(
        _build_model(),
        output_type=ReflectionInsights,
        system_prompt=(
            f"You are {agent_name}. Stay strictly in character.\n\n"
            "# Your wiki\n"
            f"{persona_md}\n\n"
            "You've gathered recent observations and a set of questions\n"
            "you wanted to answer. Output up to 3 INSIGHTS — higher-level\n"
            "conclusions about yourself or your peers — that you can\n"
            "infer from these observations.\n\n"
            "Hard rules:\n"
            "- Each insight is 1-2 sentences in YOUR voice.\n"
            "- cited_memory_ids: integer ids from the memory list above,\n"
            "  at least 1, ideally 2-4. Don't make up ids.\n"
            "- importance 1-10 (poignancy scale): mundane=1, life-altering\n"
            "  =10. Most reflections are 4-7 because they're abstractions.\n"
            "- Don't restate the observations. Insights extract patterns\n"
            "  the observations don't make explicit on their own.\n"
        ),
    )
    questions_block = "\n".join(f"  - {q}" for q in questions)
    try:
        i_result = await insights_agent.run(
            f"Recent memories (numbered):\n{memories_block}\n\n"
            f"Questions you posed:\n{questions_block}\n\n"
            "What 3 high-level insights can you infer from the above? "
            "For each, cite the memory ids that back it."
        )
    except Exception as exc:  # noqa: BLE001
        logfire.warn(
            "pixel_agent_reflection_insights_failed",
            agent_id=agent_id,
            error=str(exc),
        )
        return 0

    valid_ids = {int(r["id"]) for r in memory_rows}
    written = 0
    async with acquire() as conn:
        for insight in i_result.output.insights:
            cited = [i for i in insight.cited_memory_ids if i in valid_ids]
            if not cited:
                continue
            ids_str = ", ".join(str(i) for i in cited)
            content = f"{insight.insight} (because of {ids_str})"
            await conn.execute(
                """
                insert into public.pixel_agent_memories
                  (agent_id, world_id, kind, content, importance)
                values ($1, $2, 'reflection', $3, $4)
                """,
                agent_id,
                world_id,
                content,
                insight.importance,
            )
            written += 1

    logfire.info(
        "pixel_agent_reflected",
        agent_id=agent_id,
        agent_name=agent_name,
        insights_written=written,
        importance_sum=importance_sum,
        memories_examined=len(memory_rows),
        threshold=REFLECTION_THRESHOLD,
    )
    return written


# ── Tick orchestration ────────────────────────────────────────────


class TickResult(BaseModel):
    agents_acted: int
    posts_written: int
    skipped: int
    errors: int
    reflections_written: int = 0


async def run_tick(world_id: str, owner_user_id: str) -> TickResult:
    """Run one tick across every pixel agent in `world_id`.

    Sequential — the world is small and the LLM calls are cheap
    individually. Connections are released across LLM calls so the
    pool doesn't starve while we wait on inference.
    """
    posts_written = 0
    agents_acted = 0
    skipped = 0
    errors = 0

    # 1. Load agent list (one short connection)
    async with acquire() as conn:
        world = await conn.fetchrow(
            "select owner_user_id from public.worlds where id = $1",
            world_id,
        )
        if world is None or str(world["owner_user_id"]) != owner_user_id:
            raise PermissionError("world not found or not owned by user")

        agent_rows = await conn.fetch(
            """
            select id::text as id, display_name, subtitle, persona_md
            from public.agents
            where world_id = $1
            order by created_at asc
            """,
            world_id,
        )

    # 2. For each agent, run its tick. Connection released across LLM call.
    with logfire.span(
        "world_engine.tick",
        world_id=world_id,
        owner_user_id=owner_user_id,
        agent_count=len(agent_rows),
    ):
        for row in agent_rows:
            agent_id = row["id"]
            try:
                async with acquire() as conn:
                    ctx = await build_agent_context(conn, agent_id, world_id)

                    # Smallville-style perception (§4.1): every peer post
                    # the agent saw in their context becomes an observation
                    # memory. Importance mirrors the source post — no
                    # second LLM call. Self-authored posts are skipped
                    # (an agent commenting in its own thread shouldn't
                    # observe itself). Cross-tick dedup via the partial
                    # unique index in migration 0009.
                    if ctx.recent_world_posts:
                        perceived_ids = [p.id for p in ctx.recent_world_posts]
                        peer_posts = await conn.fetch(
                            """
                            select id, body, importance, agent_id,
                                   (select display_name from public.agents
                                    where id = pixel_agent_posts.agent_id) as author_name
                            from public.pixel_agent_posts
                            where id = any($1::bigint[])
                              and agent_id <> $2::uuid
                            """,
                            perceived_ids,
                            agent_id,
                        )
                        for pp in peer_posts:
                            obs_content = (
                                f"{pp['author_name']} posted: {pp['body']}"
                            )
                            await conn.execute(
                                """
                                insert into public.pixel_agent_memories
                                  (agent_id, world_id, kind, content,
                                   importance, source_post_id)
                                values ($1, $2, 'observation', $3, $4, $5)
                                on conflict (agent_id, source_post_id)
                                  where kind = 'observation' do nothing
                                """,
                                agent_id,
                                world_id,
                                obs_content,
                                pp["importance"],
                                pp["id"],
                            )

                agent = _select_action_agent(
                    name=row["display_name"],
                    subtitle=row["subtitle"],
                    persona_md=row["persona_md"] or "",
                )
                result = await agent.run(_user_prompt(ctx))
                action = result.output
                agents_acted += 1

                if isinstance(action, (PostAction, CommentAction)):
                    parent_post_id: int | None = None
                    if isinstance(action, CommentAction):
                        # LLMs hallucinate ids — validate the parent
                        # exists and is in the same world before insert.
                        async with acquire() as conn:
                            valid = await conn.fetchval(
                                """
                                select id from public.pixel_agent_posts
                                where id = $1 and world_id = $2
                                """,
                                action.parent_post_id,
                                world_id,
                            )
                        if valid is None:
                            errors += 1
                            logfire.warn(
                                "pixel_agent_comment_invalid_parent",
                                agent_id=agent_id,
                                agent_name=row["display_name"],
                                claimed_parent_id=action.parent_post_id,
                            )
                            continue
                        parent_post_id = action.parent_post_id

                    # Smallville §4.1: trust the LLM's importance score.
                    # Don't calibrate — the system absorbs whatever
                    # scale the LLM produces because thresholds (e.g.
                    # REFLECTION_THRESHOLD) are absolute, calibrated
                    # against actual sums.
                    topic = (action.topic or "").strip().lower()[:40] or None
                    async with acquire() as conn:
                        post_row = await conn.fetchrow(
                            """
                            insert into public.pixel_agent_posts
                              (agent_id, world_id, body, importance,
                               parent_post_id, topic)
                            values ($1, $2, $3, $4, $5, $6)
                            returning id
                            """,
                            agent_id,
                            world_id,
                            action.body,
                            action.importance,
                            parent_post_id,
                            topic,
                        )
                        await conn.execute(
                            """
                            insert into public.pixel_agent_memories
                              (agent_id, world_id, kind, content,
                               importance, source_post_id)
                            values ($1, $2, 'post', $3, $4, $5)
                            """,
                            agent_id,
                            world_id,
                            action.body,
                            action.importance,
                            post_row["id"],
                        )
                    posts_written += 1
                    logfire.info(
                        "pixel_agent_posted",
                        agent_id=agent_id,
                        agent_name=row["display_name"],
                        kind=action.kind,
                        importance=action.importance,
                        body=action.body,
                        parent_post_id=parent_post_id,
                    )
                else:
                    skipped += 1
                    logfire.info(
                        "pixel_agent_quiet",
                        agent_id=agent_id,
                        agent_name=row["display_name"],
                        reason=action.reason,
                    )
            except Exception as exc:  # noqa: BLE001
                errors += 1
                logfire.error(
                    "pixel_agent_action_failed",
                    agent_id=agent_id,
                    error=str(exc),
                )

    # After action-selection: per-agent reflection sweep. Each agent
    # short-circuits cheaply if its unreflected importance sum hasn't
    # crossed REFLECTION_THRESHOLD yet.
    reflections_written = 0
    for row in agent_rows:
        try:
            written = await _maybe_reflect(
                agent_id=row["id"],
                world_id=world_id,
                agent_name=row["display_name"],
                persona_md=row["persona_md"] or "",
            )
            reflections_written += written
        except Exception as exc:  # noqa: BLE001
            logfire.error(
                "pixel_agent_reflection_failed",
                agent_id=row["id"],
                error=str(exc),
            )

    return TickResult(
        agents_acted=agents_acted,
        posts_written=posts_written,
        skipped=skipped,
        errors=errors,
        reflections_written=reflections_written,
    )


# ── Autonomous engine loop (consumed from main.py lifespan) ──────


import asyncio  # noqa: E402  — late so other constants land first


async def _engine_sweep_once() -> int:
    """One pass: run a tick on every world whose engine is enabled
    AND whose owner is currently active (last_seen_at within
    engine_idle_hours). Returns the count of worlds ticked.

    The idle-gate is the cost-safety net: a world whose owner has
    closed the tab and walked away stops auto-ticking after the
    idle window, capping unattended LLM spend. Owners refresh the
    page → their last_seen_at updates → next sweep picks up the
    world again.
    """
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select w.id::text as id,
                   w.owner_user_id::text as owner_user_id
            from public.worlds w
            join public.profiles p on p.id = w.owner_user_id
            where w.engine_enabled = true
              and (w.engine_last_tick_at is null
                   or w.engine_last_tick_at
                      < now() - make_interval(mins => $1))
              and p.last_seen_at is not null
              and p.last_seen_at
                  > now() - make_interval(hours => w.engine_idle_hours)
            """,
            ENGINE_TICK_INTERVAL_MINUTES,
        )
    ticked = 0
    for row in rows:
        try:
            with logfire.span(
                "world_engine.autonomous_tick",
                world_id=row["id"],
                owner_user_id=row["owner_user_id"],
            ):
                result = await run_tick(
                    world_id=row["id"], owner_user_id=row["owner_user_id"]
                )
                logfire.info(
                    "engine_autonomous_tick_done",
                    world_id=row["id"],
                    posts_written=result.posts_written,
                    skipped=result.skipped,
                    reflections_written=result.reflections_written,
                    errors=result.errors,
                )
        except Exception as exc:  # noqa: BLE001
            logfire.error(
                "engine_autonomous_tick_failed",
                world_id=row["id"],
                error=str(exc),
            )
        # Always update last_tick_at so a broken world doesn't burn the
        # sweep loop. If you want to retry sooner, manually NULL the column.
        async with acquire() as conn:
            await conn.execute(
                "update public.worlds set engine_last_tick_at = now() where id = $1",
                row["id"],
            )
        ticked += 1
    return ticked


async def engine_loop(stop_event: asyncio.Event) -> None:
    """Background coroutine started from FastAPI lifespan. Wakes every
    ENGINE_SWEEP_INTERVAL_SECONDS, calls `_engine_sweep_once`, exits
    cleanly when `stop_event` is set.
    """
    logfire.info(
        "engine_loop_started",
        sweep_interval_s=ENGINE_SWEEP_INTERVAL_SECONDS,
        tick_interval_min=ENGINE_TICK_INTERVAL_MINUTES,
    )
    while not stop_event.is_set():
        try:
            await _engine_sweep_once()
        except Exception as exc:  # noqa: BLE001
            logfire.error("engine_loop_sweep_error", error=str(exc))
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=ENGINE_SWEEP_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass
    logfire.info("engine_loop_stopped")
