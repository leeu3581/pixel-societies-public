# Concreteness eval — measuring whether agents stay grounded

A failure mode of multi-agent LLM conversations: agents converge on
shared abstractions ("specific gravity", "complexity as armor") instead
of staying anchored to real names, real years, real artifacts. Looks
deep. Means nothing.

This eval scores it. Threshold 0.6 — below that, the conversation is
abstract and the prompt is failing.

## How it scores

For every turn each agent took, the eval checks for:

| Always-concrete signals (count regardless of belief overlap) | Examples |
|---|---|
| Italicised titles `*X*` | `*Sound of Metal*`, `*Illuminance*` |
| Quoted phrases `"X"` | `"demure"`, `"specific gravity"` |
| Years (`19xx` / `20xx`) | `2019`, `1989` |
| Numbers with units | `3 frames`, `$500/seat`, `8 weeks`, `12 records` |

| Citation candidates (count only if they overlap the wiki ground truth) |
|---|
| Proper nouns (capitalised mid-sentence) — must match a name from the agent's own beliefs OR their peer's beliefs |

A turn "counts as concrete" if it has any always-concrete signal OR any
citation overlap. The score is the proportion of that agent's turns
that count. Both agents score independently; the conversation passes if
the average is ≥ 0.6.

The eval also flags known abstract metaphors that have surfaced in past
failures (`specific gravity`, `complexity as armor`, `core feeling`,
`venue mismatch tax`, `space anxiety`). Each flag is reported per agent.

## API

```http
GET /api/evals/concreteness?recording=<filename>.jsonl&agentA=<id>&agentB=<id>
```

Response shape:
```json
{
  "recording": "2026-04-25T16-40-57Z-marketing-engineering.jsonl",
  "concreteness_avg": 0.83,
  "threshold": 0.6,
  "passed": true,
  "reports": {
    "engineering": {
      "turns_total": 3,
      "turns_with_specific": 2,
      "score": 0.67,
      "specifics_pool": 116,
      "specifics_used": ["1989", "2024", "Stranger in the Alps", ...],
      "abstract_metaphors_flagged": []
    },
    "marketing": { ... }
  }
}
```

## Validating the eval itself

The eval was tested against two real recordings:

| Recording | Conversation shape | Eval score | Verdict |
|---|---|---|---|
| Pre-fix | Agents coined "specific gravity", "complexity as armor", no real titles | 0.25 | ✗ failed (correctly) |
| Post-fix (sharp beliefs + no-agreement rules) | Real titles (*Sound of Metal*, *The Father*), real years (1989, 2024), peer pushback | 0.83 | ✓ passed |

Same agents, same architecture — only the prompt changed. The eval
caught the regression.

## Wired with Pydantic Evals

The scorer is also exposed as a `pydantic-evals` `Evaluator`:

```python
from app.evals.concreteness import (
  ConcreteSpecificsEvaluator,
  build_dataset_from_recordings,
)

dataset = build_dataset_from_recordings(RECORDINGS_DIR)
# `dataset.evaluators` includes ConcreteSpecificsEvaluator(threshold=0.6)
```

This makes it straightforward to add the dataset to a CI run or to
batch-score every recording when investigating a regression.

## What this gives the pitch

A falsifiable claim: **"the system produces concrete, grounded
conversations — concreteness ≥ 0.6 across recorded runs."** With the
eval the claim either holds or it doesn't. Without it, "the
conversations are good" is just narrative.
