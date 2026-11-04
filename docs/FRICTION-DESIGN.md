# Friction design — preventing sycophantic mush

Multi-agent LLM conversations have a default failure mode: agents
converge into mutual praise and "yes, and" elaboration. The literature
calls this **sycophancy**, and naively prompting "be critical" makes it
worse. The fix has to be structural.

This system handles sycophancy with three independent levers. Any one
of them helps; together they produce real friction.

## 1. Beliefs as contrarian positions, not vibes

Each agent's wiki holds 3 beliefs that are explicit, opinionated, and
**designed to disagree with another agent's positions**.

Examples:

- **Yuri:** *"Most creativity advice is cope. Three-frames works because
  constraints force commitment, not because spontaneity is sacred. People
  who chase 'flow' are usually avoiding the work of getting good."*
- **Sage:** *"Specificity beats willpower every time. Anyone telling
  you to 'try harder' is either ignorant or selling something."*
- **Ellis:** *"Most rigor in cultural criticism is just slower taste. The
  honest critic admits when they're calling it; the dishonest invent
  rigor to launder a gut reaction."*
- **Nat:** *"Most arguments are about a single noun doing two jobs.
  People who refuse to define terms are usually trying to win on vibes."*

Any pair of these will friction on something. Yuri vs Sage on
discipline. Ellis vs Nat on rigor. Robin vs anyone on speed. The friction
is **structural**, not exhortative.

## 2. No-pure-agreement rules in the system prompt

The conversation system prompt has a **HARD RULES** section listing:

**Forbidden moves:**
- Praising the peer's phrasing ("that gravity metaphor is perfect").
- "Yes, and" elaboration — taking the peer's claim and extending it
  without challenge.
- Coining a new abstract phrase together and treating it as established.
- Mirroring the peer's voice or vocabulary.

**Required moves — every turn must do ONE of these:**
- (a) Advance a NEW specific claim of your own (with a name, year, example).
- (b) Challenge a SPECIFIC thing the peer said.
- (c) Admit you don't know — "I don't have a take on that."
- (d) Change the subject deliberately.

Pure elaboration of the peer's previous turn is **not an allowed move**.

## 3. Challenge-survival on insight recording

The structured `create_wiki_page` tool has a mandatory `peer_challenge`
field — the exact peer sentence that pushed back on the speaker's
position. An insight is only worth a wiki page if the peer pushed back
and the speaker defended (or updated).

> *"Refused: peer_challenge is required. An insight is only worth
> recording if your peer pushed back on your position and you defended
> or updated. If they only agreed, you don't have an insight yet — keep
> talking until there's friction."*

This converts what looked like 4 wiki pages of mutual-praise into 1 wiki
page of earned insight. Quality over quantity.

## Empirical effect

Same agents, same model, identical prompt scaffolding except for these
three levers. Single 8-turn conversation:

| Lever state | Real specifics in chat | Concreteness score | Wiki pages | Pages with peer challenge |
|---|---|---|---|---|
| **Off** (vibe beliefs, no rules) | 0 | 0.25 | 4 | 0 |
| **On** (sharp beliefs, no-agreement, challenge-survival) | 12 (titles, years, names) | 0.83 | 1 | 1 |

The system writes fewer pages. The pages it writes are real.

## Inspiration

This design is grounded in actual research on multi-agent sycophancy:

- *Peacemaker or Troublemaker* (arXiv): optimal multi-agent outcomes
  emerge from structural roles where one agent is inclined to push
  back, not from prompts asking everyone to be critical.
- *Sycophancy in LLM debates* (ACL Anthology): models default to
  agreement; correctness-payoff prompts often make this worse.
- *Reflective memory and self-reinforcing error* (arXiv): if agents
  store reflections from sycophantic conversations, they learn the
  wrong things faster. Friction-design has to come before
  self-improvement.

The challenge-survival gate above is specifically a defence against
the third risk — we only file lessons that were earned.
