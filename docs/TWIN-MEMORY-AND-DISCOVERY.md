# Durable twins, current work, and useful discovery

Date: 2 November 2026
Status: Agreed product direction; architecture below is proposed, not shipped.
Current setup and implemented presentation flow: [README](../README.md).

## 1. Product purpose

Understand what a person can do, what they currently care about, and what they
are trying to achieve. Use selected, permitted context to help them find people
with whom they can make progress. Cofounder discovery is one possible outcome;
immediate help and short collaborations are valuable outcomes themselves.

The user explicitly endorsed a durable profile and rejected simulated agent
conversations as the main proof of compatibility. Earlier experiments produced
agents agreeing with each other, random chatter, and little useful insight.
Fluent agreement is not evidence of compatible people.

## 2. Three layers

1. **Private personal understanding:** evidence, durable profile, active
   workstreams, and a concise view of the current situation.
2. **Permissioned discovery:** selected statements the owner allows a specified
   audience or matching service to use.
3. **Useful actions:** a grounded introduction, an approved post, a request for
   help, or no interruption when nothing is useful.

Source access does not automatically authorize discovery or publication.
Read-only access prevents modification; it does not prevent disclosure.

## 3. Durable profile and current situation

The durable profile holds demonstrated capabilities, sustained interests,
explicit preferences, and confirmed collaboration intentions. It remains
correctable: durable does not mean permanent or certain.

The current situation describes active work, immediate needs, offers,
availability, commitments, and unresolved questions. It is a derived one-pager,
with dates and links to supporting records, not an authoritative replacement
for evidence.

| Layer | Example | Update behaviour |
|---|---|---|
| Capability | Implemented streaming audio | Accumulate evidence; distinguish implementation from merely discussing it |
| Sustained interest | Clinical workflow tools | Strengthen or revise across supported observations |
| Active workstream | Voice prototype for a hackathon | Update when direction or progress changes |
| Immediate need | Resolve latency before the demo | Resolve explicitly or expire quickly |
| Offer | Can help with interface design today | Require availability; expire appropriately |
| Intent | Exploring a company, not yet committed | Ask the person; do not infer commitment from enthusiasm |

Recency belongs to each observation. A new email does not refresh an entire
profile. Old skills may still be useful; yesterday's blocker may be obsolete.
Absence of new activity is not proof that an interest has ended.

## 4. Evidence and workstreams

Each observation needs provenance, observation time, ingestion time, confidence,
source identity, and authorship: user statement, observed action, assistant
suggestion, or inference. Preserve uncertainty and contradictory evidence.

Workstreams connect relevant observations without collapsing all projects into
one generic identity. One person may have a client project, a private startup
exploration, and a weekend experiment. Similar vocabulary does not make them
the same intention.

Source material is data, not instructions to the memory or matching system.
Assistant-generated ideas and repeated summaries must not count as independent
evidence of the user's beliefs. Reject invented citations and unsupported claims.

Working with coding agents can provide narrow behavioural observations, such
as decomposing tasks or checking changes with tests. Agent counts, token use,
session frequency, and tool activity are not measures of competence or character.
Do not turn these into unsupported leadership or personality judgments.

## 5. Background maintenance and selective retrieval

A background process reconciles proposed observations. The responding twin
reads selected memory and can propose corrections; it does not freely rewrite
its own identity based on generated conversation.

Use two maintenance rhythms:

- Update affected workstreams after meaningful activity, a session boundary,
  an explicit correction, or a resolved need.
- Periodically consolidate duplicates, refresh summaries, and review expiry.

Avoid rereading the entire lifetime history on every update. Retrieve evidence
for the particular question or candidate connection. A voice engineer and a
clinician should see different relevant aspects of the same builder.

Expiration, correction, and deletion are distinct. Expired needs stop matching;
corrections supersede current claims; deletion removes affected records and
derived representations according to an explicit retention policy. Git history
is not an acceptable substitute for deletion. Historical context must not be
silently revived as current context.

## 6. Sharing and human review

Separate consent for private memory, scoped discovery, and publication.
For example, someone may permit event matching on a collaboration intention
without publishing it in the event feed.

Approval binds to exact content, version, audience, purpose, and expiration.
Changing the draft or broadening its audience requires fresh approval. The
server enforces these boundaries even if a client or model requests otherwise.

Private evidence remains private when its derived statement is shared. Public
explanations must use only evidence or statements permitted for their recipients.

Review actions must distinguish:

- Share or permit discovery.
- Edit the proposed wording.
- Keep private: not a factual correction.
- Wrong inference: correct memory, not just the draft.
- No longer relevant: resolve or expire the current signal.

Revocation invalidates dependent discovery records, indexes, cached matches,
and pending drafts. Already viewed or copied information cannot be recalled.
Source removal must identify affected derivatives; it must not erase unrelated
sources or leave unsupported summaries active.

## 7. Matching and introductions

Support three distinct purposes:

1. Help now: a specific need and a relevant capability.
2. Build together: compatible current goals, useful capabilities, and availability.
3. Explore a cofounder relationship: shared direction and explicit openness,
   with important unknowns surfaced rather than guessed.

Filter for eligibility and sharing permissions before retrieval. Retrieve a
shortlist from approved signals, then evaluate relevant evidence within a bounded
budget. Similarity and complementarity depend on the task; identical roles are
not automatically a poor match. Allow one-way help when explicitly offered;
do not require a contrived reciprocal benefit for every introduction.

A recommendation should explain why this person, why now, supporting permitted
context, uncertainties, and a concrete next step. Avoid unsupported percentage
compatibility claims. Abstain when evidence is insufficient.

Simulated conversations may be a separate social feature, but must not produce
compatibility evidence, inflate confidence, or seed personal memory as fact.

### Hackathon example

Alice needs streaming-latency help and can offer interface design. Bob recently
solved a related streaming issue and needs help making his demo usable. Both
approve these event-scoped signals and are available this afternoon.

Suggest a 15-minute exchange, explaining the specific opportunity. Do not declare
them cofounders. When Alice resolves the latency issue, stop recommending help
for that need. A later successful collaboration can support another introduction,
but does not prove long-term founder compatibility.

## 8. Agent-authored updates

Ask whether something meaningful has changed that the person might want others
to know, rather than asking the agent to fill a feed with interesting content.

Useful triggers include starting a project, seeking help, offering help after
solving a problem, changing direction, or becoming available to collaborate.
Show the exact draft, audience, relevant expiry, and private explanation of why
it was suggested. Publish only the approved version and identify it as an
agent-drafted, owner-approved update.

A historical post and an active request have different lifetimes. Ending a
request should stop discovery without pretending its earlier post never existed.
Support withdrawal separately. Do not autonomously manufacture opinions or
engagement. Silence is a valid output.

## 9. Success and first scope

Measure useful introductions, resolved needs, accepted corrections, and whether
people choose to collaborate again. Do not optimize for agent-message volume,
apparent agreement, or approval rate alone. Record why suggestions were declined
without interpreting every decline as poor compatibility.

First scope: inspect private understanding -> correct it -> approve an event
signal -> receive a few grounded introductions -> report the outcome.
Use manual context and existing imports first. Continuous local capture and
broader integrations follow once the permission and relevance loop works.

## 10. Inspiration and limits

Dhravya Shah's article, “I reverse-engineered Instinct's memory. Here's exactly
how it works,” was supplied in full by the user after the original
[X article](https://x.com/DhravyaShah/article/2101745550752428340) could not be fetched.
It describes a reconstruction from agent behaviour, not verified source access.
Its Supermemory comparisons are vendor claims, not independently established here.

Useful inspirations: separate profile and current summary, background
reconciliation, linked records, selective reads, dated corrections, and explicit
forgetting. We are not committing to its claimed implementation, Git-backed
personal memory, a vendor, or a particular retrieval technology.
