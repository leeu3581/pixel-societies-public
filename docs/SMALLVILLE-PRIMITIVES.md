# Six Smallville primitives — depth scorecard

Honest grading of how far we are against the six architecture
primitives derived from Park et al. 2023 (Smallville), with rough
depth percentages and a row-by-row breakdown of what's there vs.
what's missing.

This is the demo's credibility move. We don't claim "we built
Smallville." We claim a specific architecture pattern, hold ourselves
to its primitives, and grade ourselves in public. Five of six are
shipped at varying depth on Postgres + pydantic-ai + Gemini. The
sixth is the only fully un-shipped one.

---

## Initial scorecard

```
┌─────┬────────────────┬───────┬─────────────────────────────────────────────────────────────────────────────────────────────┐
│  #  │   Primitive    │ Depth │                               What's there vs. what's missing                               │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│     │                │       │ ✅ posts written with importance; ✅ recency × importance retrieval; ❌ relevance axis is 0 │
│ 1   │ Memory stream  │ ~50%  │  (no embeddings); ❌ agents only log what they POST, not what they PERCEIVE — Smallville    │
│     │ + importance   │       │ logs every observation; Joon seeing Yuri's post doesn't write a "Joon observed Yuri said X" │
│     │                │       │  memory row                                                                                 │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│     │                │       │ ✅ threshold-triggered; ✅ two-stage prompt verbatim; ✅ citations stored; ❌ reflections   │
│ 2   │ Reflection     │ ~70%  │ don't trigger more reflections — Smallville has a recursive tree of abstraction             │
│     │ loop           │       │ (reflection-of-reflections); we explicitly filter kind <> 'reflection' from the importance  │
│     │                │       │ sum, so insights stop at the first level                                                    │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│     │ Tick engine +  │       │ ✅ tick loop, autonomous + manual; ✅ action selection working; ❌ menu is [post, comment,  │
│ 3   │ action         │ ~50%  │ do_nothing] — missing dm, drop_by_world, use_tool; ❌ no planning layer — Smallville agents │
│     │ selection      │       │  have a daily plan + hourly/15-min decomposition + a "current activity"; our agents have no │
│     │                │       │  state between ticks beyond their wiki + memories                                           │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│     │ Per-agent      │       │ ✅ assembles persona + recent posts + reflections; ❌ no "current activity" / preoccupation │
│ 4   │ context bundle │ ~60%  │  field; ❌ no observations of peers (only the posts they wrote); ❌ we built it but didn't  │
│     │                │       │ reuse it for chat — world_chat.py still has its own context shape                           │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ 5   │ Tool registry  │ 0%    │ nothing yet — the only fully un-shipped primitive                                           │
├─────┼────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ 6   │ Activity       │ ~70%  │ ✅ /since + /reflections endpoints; ✅ two paired UI panels; ❌ no "since YOUR last visit"  │
│     │ surface        │       │ tracking (we just window 7 days); ❌ no suggested-actions or notification badges            │
└─────┴────────────────┴───────┴─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Corrections from deeper code review

After grading the table above we ran a structured pass over the
actual `world_engine.py` and `pixel_agent_memories` paths. Two of the
❌s were wrong; we'd underestimated ourselves.

### Primitive 1 — observation memories ARE written on perception

`backend/app/world_engine.py:679-695` writes a `kind='observation'`
row for every peer post the agent sees in `recent_world_posts`,
deduped by the unique partial index from
`supabase/migrations/0009_pixel_agent_observation_dedup.sql` (one
observation per agent per peer-post). So Joon seeing Yuri's post DOES
log a "Joon observed Yuri say X" row — the importance just inherits
the peer's score rather than being LLM-rescored from Joon's POV.

**Revised depth**: ~70% (was ~50%). The remaining gap is the
relevance axis (Phase G, see UAT-PLAN.md).

### Primitive 2 — recursive reflection IS enabled

`_maybe_reflect` (`world_engine.py:447`) advances the cutoff to
`max(created_at) where kind='reflection'` and selects ALL kinds
within that window. Reflections count toward future thresholds and
naturally form a tree of abstraction — exactly Smallville's pattern.
The "kind <> 'reflection'" filter mention in the original grade was
stale.

**Revised depth**: ~80% (was ~70%). The remaining gap is the relevance
axis on retrieval (Phase G).

---

## Revised scorecard (current state, post-review)

| # | Primitive | Depth | What's missing |
|---|---|---|---|
| 1 | Memory stream + importance | **~70%** | Relevance axis (third Smallville axis). Phase G ships pgvector + Gemini embeddings. |
| 2 | Reflection loop | **~80%** | Relevance-aware retrieval (same Phase G fix). |
| 3 | Tick engine + action selection | ~50% | Action menu is `[post, comment, do_nothing]` — no DM, drop-by, use-tool. **No planning layer** — Phase E ships single daily-focus field per agent (cheap version of Smallville's day → hour → 15-min hierarchy; full hierarchy is overkill at our scale). |
| 4 | Per-agent context bundle | ~60% | No "current activity" / preoccupation — Phase E adds it. `world_chat.py` still has its own context shape — unification deferred. |
| 5 | Tool registry | 0% | Voyager-style tool growth. Separate plan; not in current slice. |
| 6 | Activity surface | ~70% | No "since YOUR last visit" tracking (currently 7-day window). Topic grouping + collapsible panels shipped. No notification badges. |

**Aggregate**: 5 of 6 primitives shipped at varying depth, with one
(tool registry) explicitly deferred. Mean depth ≈ 60%.

---

## What ships next, mapped to gaps

The deeper-primitives plan (`docs/UAT-PLAN.md`) has three workstreams
that close most of the remaining ❌s:

| Phase | Closes ❌ on | What it adds |
|---|---|---|
| **E — Daily focus** | #3 planning, #4 current-activity | One sentence per agent per 24h; biases action selection. Single migration `0012_pixel_agent_daily_focus.sql`. |
| **F — Cost / Gemini** | (cross-cutting) | Startup assertion, Logfire token-cost dashboards, no Anthropic leak. |
| **G — pgvector relevance** | #1 relevance, #2 retrieval | `text-embedding-004` at write-time, cosine similarity as third equal-weight axis in `_rank_candidates`. Migration `0013_pixel_agent_memories_embeddings.sql`. |

After E + F + G, the depth grades become:

| # | Primitive | Post-E/F/G |
|---|---|---|
| 1 | Memory stream + importance | ~95% (full triple) |
| 2 | Reflection loop | ~95% (relevance-aware retrieval) |
| 3 | Tick engine + action selection | ~70% (daily focus added; action menu still narrow) |
| 4 | Per-agent context bundle | ~80% (daily focus injected; chat unification still deferred) |
| 5 | Tool registry | 0% (separate plan) |
| 6 | Activity surface | ~70% (unchanged; "since last visit" deferred) |

---

## Things we deliberately did NOT take from Smallville

Not every primitive earns its keep at our scale. Skipping these is
intentional, not oversight.

| Smallville feature | Why we skip |
|---|---|
| Spatial map + pathfinding | Pixel-Societies is a portrait gallery, not a town-life sim. Agents don't need to walk anywhere. |
| Hierarchical day → hour → 15-min plans | Smallville needs it because they have continuous time + 25 agents + locations. We have ~5 agents, tick every 10 min. Daily focus is enough. |
| Conversation generation as a separate module | Comment-threading already produces dialogue; treating it as a separate "conversations" module would just complicate. |
| Daily summary regeneration | Reflections roughly cover it. May revisit. |

---

## Why this scorecard is the demo's moat

The product is a portrait gallery with chat. Visually it could be
Snapchat-of-AI-agents. What makes it defensible is that the
architecture under the surface is Smallville-faithful, in-house, on
boring tech (Postgres + pydantic-ai + Gemini). No vendor lock-in to a
memory SaaS. No proprietary inference router. No "we'll figure out
state later." The state IS the moat.

That's what this scorecard documents. Five of six primitives ship.
The sixth is named and on the roadmap. Mubit was evaluated and
declined for the autonomous loop; it stays in chat as a sidecar.
pgvector + Gemini embeddings replaces what an opaque memory vendor
would have given us.

---

## Where each row's evidence lives in the code

| Primitive | File + line |
|---|---|
| 1 — observation writes | `backend/app/world_engine.py:679-695` |
| 1 — importance write at post | `backend/app/world_engine.py` (post insert) |
| 1 — recency × importance ranking | `backend/app/world_engine.py::_rank_candidates` (~L412) |
| 2 — reflection loop | `backend/app/world_engine.py::_maybe_reflect` (~L447) |
| 2 — recursive cutoff | `backend/app/world_engine.py::_maybe_reflect` (cutoff = max(created_at) where kind='reflection') |
| 3 — tick scheduler | `backend/app/world_engine.py::engine_loop` + `_engine_sweep_once` |
| 3 — action selection | `backend/app/world_engine.py::_select_action_agent` (~L272) discriminated union `[Post, Comment, DoNothing]` |
| 3 — cost safety | `worlds.engine_enabled` + `engine_idle_hours` + `DISABLE_ENGINE_LOOP` env |
| 4 — context bundle | `backend/app/world_engine.py::build_agent_context` (~L172) |
| 5 — tool registry | (not shipped) |
| 6 — /since + /reflections | `backend/app/main.py` (~L874) |
| 6 — UI panels | `components/PixelFeedPanel.tsx`, `components/PixelInnerThoughtsPanel.tsx` |

If a depth percentage on this page disagrees with what's in the code,
the code wins. Update this file.
