"""
Monty sidecar — Python execution gatekeeper for synthetic-colleague skills.

Architecture:
- unicorn-intelligence-backend (Node) sends `{code, inputs}` to POST /execute
- We run the code in a sandbox and return `{output, error, runtime_ms}`
- Real Monty (Samuel Colvin's Rust-based Python sandbox) is preferred;
  subprocess fallback keeps the demo functional if Monty isn't installed yet.

The contract:
- `code` defines exactly one top-level function `skill(**inputs)` returning
  any JSON-serializable value.
- `inputs` is a dict of kwargs forwarded to that function.
- Wall-clock limit: SKILL_TIMEOUT_S (default 3s).
- Output cap: 8KB stringified JSON.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

SKILL_TIMEOUT_S = float(os.environ.get("SKILL_TIMEOUT_S", "3.0"))
SHARED_SECRET = os.environ.get("MONTY_SIDECAR_SECRET", "")
OUTPUT_CAP = 8 * 1024  # 8KB

# Try the native sandbox first; fall back to subprocess if unavailable.
NATIVE_SANDBOX_AVAILABLE = False
try:
    # Real Monty package name TBD on PyPI — try the most likely candidates.
    import pydantic_monty as _monty  # type: ignore
    NATIVE_SANDBOX_AVAILABLE = True
    NATIVE_SANDBOX_NAME = "pydantic_monty"
except ImportError:
    try:
        import monty as _monty  # type: ignore
        NATIVE_SANDBOX_AVAILABLE = True
        NATIVE_SANDBOX_NAME = "monty"
    except ImportError:
        _monty = None  # noqa: F841
        NATIVE_SANDBOX_NAME = "subprocess-fallback"

app = FastAPI(title="monty-sidecar", version="0.1.0")


class ExecuteRequest(BaseModel):
    code: str = Field(..., description="python source defining def skill(**inputs)")
    inputs: dict[str, Any] = Field(default_factory=dict)


class ExecuteResponse(BaseModel):
    ok: bool
    output: Any = None
    error: str | None = None
    runtime_ms: int
    sandbox: str


def _check_auth(authorization: str | None) -> None:
    if not SHARED_SECRET:
        return  # auth disabled for local dev
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    if authorization.removeprefix("Bearer ").strip() != SHARED_SECRET:
        raise HTTPException(403, "bad token")


def _run_subprocess(code: str, inputs: dict[str, Any]) -> tuple[bool, Any, str | None]:
    """Run user code in a fresh python -I subprocess with strict timeout.

    Not as safe as Monty (no syscall sandbox, no module restrictions) but
    keeps the API contract identical so the rest of the system doesn't care.
    """
    runner = (
        "import sys, json\n"
        "_payload = json.loads(sys.stdin.read())\n"
        "_user_code = _payload['code']\n"
        "_inputs = _payload.get('inputs', {})\n"
        "_ns: dict = {}\n"
        "exec(_user_code, _ns)\n"
        "if 'skill' not in _ns: raise RuntimeError('code must define def skill(**kwargs)')\n"
        "_result = _ns['skill'](**_inputs)\n"
        "sys.stdout.write(json.dumps({'ok': True, 'output': _result}))\n"
    )
    payload = json.dumps({"code": code, "inputs": inputs})
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-c", runner],
            input=payload,
            capture_output=True,
            text=True,
            timeout=SKILL_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return (False, None, f"timeout after {SKILL_TIMEOUT_S}s")
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()[-1500:]
        return (False, None, err or f"exit {proc.returncode}")
    raw = proc.stdout.strip()
    if not raw:
        return (False, None, "no output")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return (False, None, "skill returned non-JSON")
    if not parsed.get("ok"):
        return (False, None, str(parsed.get("error", "unknown")))
    return (True, parsed.get("output"), None)


def _run_native(code: str, inputs: dict[str, Any]) -> tuple[bool, Any, str | None]:
    """Placeholder for the real Monty path.

    The Monty API is not yet pinned in this codebase; once the import succeeds
    on a real install, swap this body for the official sandbox call. For now
    we delegate to the subprocess path so behaviour is consistent.
    """
    return _run_subprocess(code, inputs)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "sandbox": NATIVE_SANDBOX_NAME,
        "native_available": NATIVE_SANDBOX_AVAILABLE,
        "timeout_s": SKILL_TIMEOUT_S,
    }


@app.post("/execute", response_model=ExecuteResponse)
def execute(req: ExecuteRequest, authorization: str | None = Header(default=None)) -> ExecuteResponse:
    _check_auth(authorization)

    started = time.perf_counter()
    runner = _run_native if NATIVE_SANDBOX_AVAILABLE else _run_subprocess
    ok, output, err = runner(req.code, req.inputs)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    if ok:
        # Cap the output size so a runaway list doesn't bloat the WS frame
        try:
            blob = json.dumps(output)
            if len(blob) > OUTPUT_CAP:
                return ExecuteResponse(
                    ok=False,
                    error=f"output exceeded {OUTPUT_CAP} bytes",
                    runtime_ms=elapsed_ms,
                    sandbox=NATIVE_SANDBOX_NAME,
                )
        except (TypeError, ValueError):
            return ExecuteResponse(
                ok=False,
                error="skill output is not JSON-serializable",
                runtime_ms=elapsed_ms,
                sandbox=NATIVE_SANDBOX_NAME,
            )

    return ExecuteResponse(
        ok=ok,
        output=output,
        error=err,
        runtime_ms=elapsed_ms,
        sandbox=NATIVE_SANDBOX_NAME,
    )
