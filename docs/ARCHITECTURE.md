# Architecture

## High-level

```
┌────────────────────────────────────────────────────────────────────┐
│ frontend/  Next.js 16 + Tailwind  on :3000                          │
│   /conversation                                                     │
│     PixelOfficePicker  ──click two characters──▶  selection state   │
│     TranscriptPanel     ◀── streaming text + tool callouts          │
│     WikiLivePanel       ◀── live wiki diff + skill registry         │
│           ▲                                                         │
│           │ WebSocket  (start_conversation / stop_conversation /    │
│           │             ↩ turn_start / turn_delta / wiki_change /   │
│           │               skill_promoted / conversation_done)       │
└───────────┼────────────────────────────────────────────────────────┘
            │
┌───────────┼────────────────────────────────────────────────────────┐
│ backend/  FastAPI + pydantic-ai  on :4000                           │
│           │                                                         │
│           ▼                                                         │
│   main.py  ── HTTP routes + WS handler                              │
│        │                                                            │
│        ▼                                                            │
│   conversation.py  ── pydantic_ai.Agent[TurnDeps, str]              │
│        │   @agent.system_prompt  builds per-turn from RunContext    │
│        │   @agent.tool×6  query_peer_wiki, create_wiki_page,        │
│        │                  append_to_wiki_page, end_conversation,    │
│        │                  propose_skill, call_peer_skill            │
│        │                                                            │
│        ├─▶ wiki/   markdown pages on disk + edit-trail comments     │
│        ├─▶ skills/ JSON registry with speculative/trusted tiers     │
│        ├─▶ models.py  Belief, PeerQuery, Skill, SkillRun (typed)    │
│        ├─▶ observability.py  Logfire spans + custom info events     │
│        │                                                            │
│        └─▶ skills/monty_client.py  ──HTTP──┐                        │
└────────────────────────────────────────────┼────────────────────────┘
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ sandbox/  FastAPI + Monty (or subprocess fallback)  on :8001        │
│   POST /execute {code, inputs} → {ok, output, error, runtime_ms}    │
└────────────────────────────────────────────────────────────────────┘
```

## Conversation lifecycle

For each two-agent run:

```
1. UI sends WS frame: { type: "start_conversation", agentA, agentB, maxTurns, sessionId }
2. backend snapshots both agents' wikis (wiki_before)
3. emits conversation_started (UI seeds wiki view)
4. for turn in 1..maxTurns:
     a. determine speaker = agent_a if turn%2==1 else agent_b, peer = the other
     b. open Logfire `turn` span with attributes
     c. build system prompt per turn (includes own wiki, peer index, own skills,
        peer trusted skills) — from a callable @agent.system_prompt
     d. agent.run_stream(prompt, deps=TurnDeps, message_history=...)
        - text deltas → emit turn_delta WS frames as they stream
        - tool calls intercepted by @agent.tool functions:
            * query_peer_wiki  → reads peer page or returns peer index on miss
            * create/append_wiki_page → writes to disk with quoted_from_peer
            * propose_skill    → writes registry, runs each test_input through
                                 Monty, records runs, promotes if 3+ ok
            * call_peer_skill  → only if peer's tier == trusted; runs through Monty
            * end_conversation → only allowed turn ≥ 4
        - each tool emits tool_call_start + tool_call_end WS frames
        - each wiki/skill mutation emits a typed Logfire info event
     e. close turn span; append to transcript
5. snapshot wikis again → wiki_after, knowledge_score = pages added/changed
6. emit conversation_done; close conversation span with end attributes
```

## Why Pydantic AI (not raw Anthropic SDK)

- **Tool schemas inferred from Python type hints** — no hand-rolled JSON
  schemas. Every tool's `slug: str`, `inputs: dict[str, Any]`, etc, gets a
  proper schema for the model.
- **`RunContext[TurnDeps]`** lets each tool reach the session, speaker,
  peer, and turn index without globals.
- **`@agent.system_prompt`** for dynamic per-call prompts that depend on
  conversation state.
- **`message_history`** with explicit `ModelRequest`/`ModelResponse`
  parts, lets us feed the alternating transcript with the right roles
  per speaker.
- **Logfire auto-instrumentation** — every Agent.run, every tool call,
  every chat is a span without writing instrumentation code.

## Why typed Beliefs (not free-text wiki)

The wiki layer uses markdown files for human readability, but the deeper
goal is provenance:

```python
class Belief(BaseModel):
    id: UUID
    agent_id: str
    subject: str
    predicate: str
    object: str
    confidence: float = Field(ge=0, le=1)
    source: Literal["user_stated", "inferred", "peer_agent",
                    "tool_result", "seed"]
    quoted_from: str | None = None
    contradicts: list[UUID] | None = None
```

The type system enforces that no claim exists without a confidence and a
source. `quoted_from_peer` is captured on every wiki edit (the agent
must paste the exact peer sentence that taught it the claim) — this is
what makes the "trust" framing real instead of decorative.

## Why Monty for skills

Wiki pages are *prompt templates* — not executable, can't be tested,
fail in plausible-but-wrong ways. Skills are *Python functions* that:

- run in a Monty sandbox (or subprocess fallback) with a wall-clock timeout
- get scored across N test inputs at proposal time
- are promoted from `speculative` → `trusted` only after 3 successful runs
  with zero failures
- become callable by peers only once trusted

The promotion event itself is a typed Logfire event with the run count
as an attribute, so you can query "skills that took N attempts to
promote" directly from the dashboard.

## Why three services

Mirrors the production architecture for a real multi-agent org:

- Frontend isolated from backend (deploy separately, scale separately)
- Backend isolated from sandbox (sandbox can crash without taking down
  the agents — and it *should* crash sometimes; that's the failure path)
- All three communicate over HTTP/WS — language-agnostic transports
