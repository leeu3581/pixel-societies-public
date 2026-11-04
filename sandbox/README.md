# monty-sidecar

Tiny FastAPI service that executes synthetic-colleague skills in a Python
sandbox. Sits next to `unicorn-intelligence-backend` (Node) and is called over
HTTP whenever an agent invokes the `propose_skill` tool during a wiki
conversation.

## Why a sidecar

Real Monty (Samuel Colvin's Rust-based Python sandbox) is Python-only.
Rather than rewrite the conversation loop in Python, we keep the Node
backend and add a one-endpoint Python sidecar. Identical contract:

```
POST /execute
{ "code": "def skill(**kwargs): return ...",
  "inputs": { ... } }
→
{ "ok": true, "output": ..., "runtime_ms": 12, "sandbox": "monty" }
```

## Run locally

```bash
cd ~/Github/monty-sidecar
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 8001 --reload
```

Then in unicorn-intelligence-backend's `.env`:

```
MONTY_SIDECAR_URL=http://localhost:8001
# MONTY_SIDECAR_SECRET=change-me   # optional; if set, both sides must agree
```

Health check:

```bash
curl http://localhost:8001/health
# → { "status": "ok", "sandbox": "subprocess-fallback" or "monty", ... }
```

## Sandbox modes

| Mode | When | Safety |
|------|------|--------|
| `monty` / `pydantic_monty` | the real package is `pip install`-able | Full Monty syscall + module isolation |
| `subprocess-fallback` | Monty not installed | `python -I -c` in a fresh subprocess with a wall-clock timeout. No syscall sandbox — only run trusted-ish code in dev |

The HTTP API is identical regardless of mode, so the rest of the system
doesn't need to know which is running.

## Skill contract

The submitted `code` must define exactly one top-level callable:

```python
def skill(**inputs):
    # any pure JSON-serializable computation
    return ...
```

Constraints:
- Wall-clock timeout: 3 seconds (override via `SKILL_TIMEOUT_S`)
- Output cap: 8 KB stringified JSON
- Output must be JSON-serializable (no objects, no datetime — use ISO strings)

## Failure path is the demo

When an agent's proposed skill blows up — TypeError, ZeroDivisionError,
infinite loop — we want that visible: the registry records the run as a
failure, the skill stays "speculative", and the UI shows red. Don't try
to mask exceptions; surface them as `error` strings so the upstream
promotion rule can decide.
