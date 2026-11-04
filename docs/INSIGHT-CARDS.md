# Insight cards — the structured wiki output

Conversations don't produce free-form essays. They produce **typed
insight cards** — one structured artifact per extraction, with named
fields enforced at the tool-schema level.

## The shape

Every insight has six required fields:

| Field | Purpose | Example |
|---|---|---|
| `concept` | the named idea — 2-4 words | `Early Attempt`, `Decision Making` |
| `kind` | `reframe` (positive new angle) OR `risk` (danger exposed) | `reframe` |
| `point` | the single phrase that captures the new thinking | `Probe, not final statement` |
| `use_when` | the trigger condition for applying this | `Feeling blocked by perfectionism` |
| `action` | the concrete next move when the trigger fires | `Build a small test before judging` |
| `quoted_from_peer` | the exact peer sentence that seeded the insight | `"Small attempts that create feedback. Not final statements."` |
| `peer_challenge` | the exact peer sentence that pushed back on the speaker's position | `"isn't that just procrastination dressed up?"` |

The `peer_challenge` is the **anti-sycophancy gate**: an insight is only
worth a wiki page if the peer pushed back on something and the speaker
defended or updated. Pure agreement doesn't earn a page.

## What this prevents

Without the schema, models write essays. With the schema, the model
literally cannot output a 600-word philosophical paragraph because there's
no `essay` field — only the six named slots.

The structured output also flows through three places:

1. **The wiki page on disk** — rendered as a Hermes-style markdown card
   (Concept / Reframe-or-Risk / Use When / Action / Skill Learned From /
   peer quote)
2. **The transcript card in the UI** — coloured-border card inline in
   the conversation panel; green for `reframe`, red for `risk`
3. **The Logfire span** — typed attributes on the `wiki_change` event
   so the Logfire dashboard can filter by concept, kind, source agent

## Sample card on disk

```markdown
---
created: 2026-04-25T16:24:37Z
updated: 2026-04-25T16:24:37Z
agent: marketing
---

# Concept: Venue Co-Creation

- **Reframe:** Context shapes what emerges, not just where it's delivered
- **Skill Learned From:** Yuri
- **Use When:** Choosing where to build, present, or deploy something
- **Action:** Ask "what will this place let it be?" not just "where will people find it?"

> Quoted from Yuri: *"the venue doesn't just deliver the thing — it co-creates what the thing becomes."*
```

## Tool signature (Python)

```python
@agent.tool
async def create_wiki_page(
    ctx: RunContext[TurnDeps],
    slug: str,                    # short kebab-case ID
    concept: str,                 # 2-4 words
    kind: Literal["reframe", "risk"],
    point: str,                   # one phrase
    use_when: str,                # trigger condition
    action: str,                  # concrete next move
    quoted_from_peer: str,        # exact peer sentence (provenance)
    peer_challenge: str,          # exact peer challenge (anti-sycophancy)
    quoted_from_peer_slug: str = "",   # optional cross-graph edge
) -> str: ...
```

## Why this works as a demo primitive

Insight cards are the unit of cross-pollination. When a judge looks at
the screen, they see two agents talking AND named, structured artifacts
appearing inline as the conversation produces them. The artifact is
trivially shareable on a slide ("here's the insight Yuri took from
Ellis") and trivially measurable (the concreteness eval can score it).
