"""Smoke test for the orchestrator-to-orchestrator MCP bridge.

Verifies three things against a running backend (default localhost:4000):

  1. list_worlds returns at least one active world.
  2. consult_world against an INACTIVE world returns a clean error
     ("no agents in world '...'") instead of crashing — the orchestrator
     refuses to bridge into a world that has no roster.
  3. consult_world against an ACTIVE world produces a verdict end-to-end
     (router → answers → synthesizer all run inside the peer world).

Usage:
    source .venv/bin/activate
    python scripts/mcp_bridge_smoke.py                # full test
    python scripts/mcp_bridge_smoke.py --no-consult   # skip the LLM-heavy
                                                       # active-world call
    python scripts/mcp_bridge_smoke.py --url http://other-host:4000/mcp/

Exit code is 0 on success, non-zero if any check fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from fastmcp import Client

DEFAULT_URL = "http://localhost:4000/mcp/"
DEFAULT_QUESTION = "Briefly: should we ship a v1 today or polish one more day?"
DEFAULT_INACTIVE = "this_world_does_not_exist"


def _structured(result) -> dict:
    """fastmcp returns a CallToolResult; pull the structured payload."""
    sc = getattr(result, "structured_content", None)
    if sc is None:
        sc = getattr(result, "data", None)
    if sc is None:
        # Fall back to raw text content if structured output is missing.
        content = getattr(result, "content", []) or []
        if content and hasattr(content[0], "text"):
            return json.loads(content[0].text)
        return {}
    return sc


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--url", default=DEFAULT_URL, help=f"MCP endpoint (default {DEFAULT_URL})")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--inactive-world", default=DEFAULT_INACTIVE)
    parser.add_argument("--no-consult", action="store_true", help="Skip the real consult call (no LLM cost).")
    args = parser.parse_args()

    failures: list[str] = []
    print(f"→ MCP {args.url}")

    try:
        async with Client(args.url) as client:
            # 1. Discovery — list_worlds
            res = await client.call_tool("list_worlds", {})
            worlds = _structured(res).get("result") or []
            print(f"  list_worlds → {worlds}")
            if not worlds:
                failures.append("list_worlds returned no active worlds")
                print("  ✗ no active worlds — aborting further checks")
                _summarize(failures)
                return 1

            # 2. Inactive-world refusal
            print(f"  consult_world(world={args.inactive_world!r}) → expecting error")
            res = await client.call_tool(
                "consult_world",
                {"question": args.question, "world": args.inactive_world},
            )
            out = _structured(res)
            err = out.get("error")
            if not err:
                msg = f"expected error, got result: {json.dumps(out)[:200]}"
                failures.append(msg)
                print(f"  ✗ {msg}")
            elif "no agents" not in err.lower():
                msg = f"got error but not the expected one: {err!r}"
                failures.append(msg)
                print(f"  ✗ {msg}")
            else:
                print(f"    error (expected): {err}")

            # 3. Active-world consult
            if args.no_consult:
                print("  (skipping real active-world consult — --no-consult)")
            else:
                active = worlds[0]
                print(f"  consult_world(world={active!r}) — running full pipeline")
                res = await client.call_tool(
                    "consult_world",
                    {"question": args.question, "world": active},
                    timeout=120,
                )
                out = _structured(res)
                if out.get("error"):
                    msg = f"active-world consult errored: {out['error']}"
                    failures.append(msg)
                    print(f"  ✗ {msg}")
                elif not out.get("verdict"):
                    msg = f"no verdict returned: {json.dumps(out)[:200]}"
                    failures.append(msg)
                    print(f"  ✗ {msg}")
                else:
                    chosen = out.get("chosen_ids", [])
                    v = out["verdict"]
                    print(f"    chosen={chosen}  consensus={v['consensus']}")
                    print(f"    verdict: {v['summary']}")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"transport/protocol error: {exc}")
        print(f"  ✗ {failures[-1]}")

    _summarize(failures)
    return 0 if not failures else 1


def _summarize(failures: list[str]) -> None:
    print()
    if failures:
        print(f"✗ {len(failures)} check(s) failed:")
        for f in failures:
            print(f"  - {f}")
    else:
        print("✓ all checks passed")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
