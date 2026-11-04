# Self-improvement loop — how the system gets better between runs

After every conversation, an **auditor** LLM reviews the recording and
the wiki delta, then writes guidance that gets injected into future
conversations' system prompts. The system literally improves itself
between runs without anyone editing the personas.

## The full loop

```
conversation
  ↓
recording (JSONL of every WS frame)
  ↓
auditor (pydantic_ai.Agent, output_type=AuditReport)
  ↓
data/wikis/_audits/{ts}-{agentA}-{agentB}.md   ← typed report
  ↓
data/wikis/_audits/log.md                       ← chronological index
  ↓
data/wikis/{agent}/lessons.md (×2)              ← per-agent learning record
  ↓
recent_guidance() reads global + per-agent
  ↓
_build_system_prompt injects two blocks:
  - "Lessons across all prior conversations" (global pool)
  - "Lessons specific to your past conversations" (per-agent pool)
  ↓
next conversation                               ← lessons land in turn-1 context
```

## What the auditor produces

The auditor's typed `AuditReport`:

```python
class AuditReport(BaseModel):
    summary: str              # ≤ 80 words: what the conversation actually did
    pages_created: int
    pages_appended: int
    queries_made: int
    knowledge_score: int
    failure_modes: list[FailureMode]   # query_loop / no_writes / peer_vs_self_confusion / ...
    key_insight: str          # the single most useful observation
    next_run_guidance: str    # ≤ 25 words — injected into future system prompts
```

Failure mode categories:

- `query_loop` — agents repeatedly query each other's wikis but never write
- `no_writes` — conversation completed with zero `create_wiki_page` calls
- `peer_vs_self_confusion` — agent treats one of their own pages as the peer's
- `epistemic_loop` — both agents agree they don't know X and stop
- `premature_end` — `end_conversation` called before topic was exhausted
- `wiki_vandalism` — overwriting good pages with worse content
- `shallow_synthesis` — pages were written but content is platitudes

## Hybrid guidance (global + per-agent)

`recent_guidance(agent_id=...)` returns two bands:

- **Global pool** — last 5 `next_run_guidance` lines from any pair's audits.
  Applies to everyone.
- **Per-agent pool** — last 5 lines from audits where this agent was a
  participant. Only fires when this specific character speaks.

The conversation system prompt injects them as separate blocks:

```
**Lessons across all prior conversations** (auto-distilled by an auditor):
- Establish ownership of mentioned pages early; don't re-query if peer cited.
- When a peer offers a perfect phrase, create a wiki page that same turn.

**Lessons specific to your past conversations** (audits where you were a participant):
- Build on peer insights immediately — when they offer specifics, capture in own voice.
```

## Where lessons live on disk

| Path | Purpose |
|---|---|
| `data/wikis/_audits/{ts}-{a}-{b}.md` | Full audit report per conversation. Typed, indexed in graph. |
| `data/wikis/_audits/log.md` | Append-only chronological index of all audits. |
| `data/wikis/{agent}/lessons.md` | Per-agent rolling learning record. Linked from the agent's hub in the graph. |

Each `lessons.md` entry has:

```
## [2026-04-25T14:18:25Z] with Ellis
- guidance: Build on peer insights immediately — when they offer perfect phrasing, create a wiki page that same turn.
- summary: Two agents discussed playlist architecture and neural rewiring...
- source: [[../_audits/2026-04-25T14-18-25Z-engineering-marketing]]
```

The `source:` link makes lessons traceable back to the audit that
produced them in the Obsidian graph view.

## Empirical proof of the loop

Same agents (Sage ↔ Robin), same architecture, two consecutive runs:

| Run | Prior guidance loaded | Wiki pages created |
|---|---|---|
| Run 1 | (none — first audit) | 1 |
| Run 2 | Run 1's guidance: *"prioritize creating knowledge artifacts over extended exploration"* | 4 |

Run 2 used the same model, same prompt scaffold, same agents. The only
difference was the auditor's guidance from Run 1. Wiki pages went up
4×. The system literally got better.

## Why this isn't dangerous (the self-reinforcing-error problem)

The literature's main warning about reflective memory: if the agent
draws a wrong lesson and then applies it indefinitely, it'll drift into
deeper failure modes (Reflexion, ExpeL papers).

Our defences:
1. **The auditor is independent** — different prompt, different LLM
   instance, different role. It's not the conversation agents
   reflecting on themselves.
2. **Challenge-survival gating** ([friction-design.md](FRICTION-DESIGN.md))
   means only insights that survived peer pushback get written to the
   wiki in the first place. The auditor reviews those, not the chat.
3. **Concreteness eval** ([concreteness-eval.md](CONCRETENESS-EVAL.md))
   gates whether conversations were grounded enough to learn from.
   Sycophantic conversations can't earn a high score, so their lessons
   are de-weighted.

Together: the loop only learns from conversations that had real stakes,
real specifics, and real friction.
