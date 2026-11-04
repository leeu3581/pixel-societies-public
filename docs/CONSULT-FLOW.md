# Consult flow

`/consult` in the frontend (and `wiki-mafia/consult.py` as the
A2A-distributed twin) lets you ask the team a question and get a
synthesised verdict back, with each colleague's typed answer in between.

## Why it exists

The two-agent `/conversation` page produces rich transcripts but takes
6+ turns to converge on anything actionable. For a hackathon judge or
a quick "what should we do" question, that's too long. The consult
flow lands the answer in one screen:

- one question box at the top
- the pixel office on the left (all six colleagues visible the whole time)
- streaming Answer cards on the right (color-matched to each agent)
- a Verdict box at the bottom with consensus / disagreements

It also fixes the "everyone defaults to the consultant median" failure
mode that the parallel version of this hit (see [Sequential rebuttal](#sequential-rebuttal-the-fix-for-vibe-collapse) below).

## The pipeline

```
question
   │
   ▼
┌─────────┐
│ Router  │  reads /api/agents (id, name, role, expertise tags)
└────┬────┘  output: Routing(chosen_ids: list[str], reasoning: str)
     │
     │ for pid in chosen_ids:
     ▼
┌────────────────┐
│ profile agent  │  built per-call from data/wikis/<pid>/personality.md
│  (one of six)  │  + belief pages. Sees PRIOR_ANSWERS so far.
└────────┬───────┘  output: Answer(position, reasoning, angle, conf, caveats)
         │
         │ append, repeat for next chosen_id
         ▼
┌──────────────┐
│ Synthesizer  │  output: Verdict(summary, consensus, disagreements)
└──────────────┘
         │
         │ orchestrator overrides contributing_ids = [a.profile_id for a in answers]
         ▼
       UI render
```

## Sequential rebuttal — the fix for vibe-collapse

The first version of this ran agents **in parallel** — all chosen
agents queried at once with the same prompt. Result: every expert gave
the same generic SaaS-playbook answer ("improves cash flow, reduces
churn, increases LTV"). The personas were ignored because each LLM was
optimising independently for the consultant median.

Sequential mode fixes it. Each agent receives the prior answers and
this hard rule in their system prompt:

> `angle`: ONE sentence naming the lens you bring that the
> PRIOR_ANSWERS did not cover. If they fully covered it, set confidence
> ≤ 0.5 and say so in caveats.

Empirically: distinct angles, low overlap, real lens divergence. Robin
talks measurement infrastructure, Ellis talks cultural signal, Nat
quotes her own *Analogies mostly mislead* belief.

Cost: roughly N× latency vs parallel (where N = number of chosen
agents). For 3–4 experts at ~5s each, that's 15–20s end-to-end.
Acceptable for a deliberate "consult the team" gesture.

## Two implementations of the same shape

| | unicorn `/consult` (`backend/app/consult.py`) | `wiki-mafia/consult.py` |
|---|---|---|
| Transport | function calls inside one FastAPI process | A2A JSON-RPC over HTTP, one uvicorn per agent |
| Discovery | `/api/agents` REST | `/.well-known/agent-card.json` per agent |
| State | streamed over the existing `/` WebSocket | streamed to stdout (UI is the next iteration) |
| Deploy | one Render service | eight Render services |
| When to use | demo on one URL, fast iteration | the "agents as deployable microservices" story |

The two share the model definitions in spirit but not in code (each has
its own `Routing` / `Answer` / `Verdict`). Worth unifying once the
shape stops moving.

## Where to look in the code

- `backend/app/consult.py` — the in-process version. Routing / per-profile
  Agent factory / synthesizer. ~250 LOC.
- `backend/app/main.py` — `start_consult` WS handler, `/api/agents` adds
  the curated `expertise` tag list per agent.
- `frontend/app/consult/ConsultView.tsx` — UI. Reuses
  `app/team/office-engine.js` so the canvas matches the rest of the site.
- `wiki-mafia/agents/profile_agent.py` — A2A version of the per-profile
  agent. Same prompt shape; different transport.
- `wiki-mafia/consult.py` — A2A orchestrator. Discovery + sequential
  fan-out + synthesis.

## Mechanical override that matters

`Verdict.contributing_ids` and `Answer.profile_id` are set by the
orchestrator AFTER the LLM call returns, overwriting whatever the LLM
put there. Reason: even Sonnet 4.6 with explicit "copy the ids verbatim"
instructions reliably hallucinates plausible role-name-shaped strings
("ceo", "api_product_manager", "product_manager") in place of the
actual slugs. Source-of-truth is the orchestrator; don't let the LLM
forge a field it didn't choose.

## Adding a new colleague

1. Create `data/wikis/<id>/personality.md` and any belief `.md` files
2. Add the agent to `backend/app/agents.py`'s `AGENTS` list
3. Add the curated expertise tags to `EXPERTISE` in `backend/app/consult.py`
4. (For wiki-mafia) drop `wiki-mafia/profiles/<id>.md` with frontmatter
   `id`/`name`/`role`/`expertise`/`voice` + `## Bio` + `## Opinions`,
   then `./scripts/run_team.sh` allocates a port automatically

The Router will pick them up on the next restart — no orchestrator
changes needed. Discovery is the point.
