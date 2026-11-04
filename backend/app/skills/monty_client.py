"""HTTP client for the Monty sidecar."""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
from pydantic import BaseModel

SIDECAR_URL = os.environ.get("MONTY_SIDECAR_URL", "")
SIDECAR_SECRET = os.environ.get("MONTY_SIDECAR_SECRET", "")


class ExecutionResult(BaseModel):
    ok: bool
    output: Any | None = None
    error: str | None = None
    ms: int
    sandbox: str


def monty_enabled() -> bool:
    return bool(SIDECAR_URL)


async def execute_skill(code: str, inputs: dict[str, Any]) -> ExecutionResult:
    if not monty_enabled():
        return ExecutionResult(
            ok=False,
            error="Monty sidecar disabled (set MONTY_SIDECAR_URL).",
            ms=0,
            sandbox="disabled",
        )
    headers = {"Content-Type": "application/json"}
    if SIDECAR_SECRET:
        headers["Authorization"] = f"Bearer {SIDECAR_SECRET}"
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(
                f"{SIDECAR_URL.rstrip('/')}/execute",
                json={"code": code, "inputs": inputs},
                headers=headers,
            )
            if res.status_code != 200:
                return ExecutionResult(
                    ok=False,
                    error=f"sidecar HTTP {res.status_code}",
                    ms=int((time.perf_counter() - started) * 1000),
                    sandbox="unknown",
                )
            data = res.json()
            return ExecutionResult(
                ok=bool(data.get("ok")),
                output=data.get("output"),
                error=data.get("error"),
                ms=int(data.get("runtime_ms") or (time.perf_counter() - started) * 1000),
                sandbox=str(data.get("sandbox") or "unknown"),
            )
    except (httpx.HTTPError, ValueError) as e:
        return ExecutionResult(
            ok=False,
            error=str(e),
            ms=int((time.perf_counter() - started) * 1000),
            sandbox="network",
        )
