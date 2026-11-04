"""Create / refresh a Mubit agent card for every wiki entry.

Walks `data/wikis/<slug>/personality.md`, parses name + role + one-line
the same way `app/agents.py` does, then calls Mubit's control plane
once per agent. Idempotent — `create_agent_definition` errors out as
AlreadyExistsError if the card exists, in which case we fall back to
`update_agent_definition` so re-running picks up wiki edits.

Reads MUBIT_API_KEY + MUBIT_PROJECT_ID from env.

Usage:
    cd backend && source .venv/bin/activate
    python scripts/bootstrap_mubit_agents.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.agents import _parse_persona  # noqa: E402  — reuse the existing parser

WIKIS = ROOT / "data" / "wikis"


def main() -> int:
    proj = os.environ.get("MUBIT_PROJECT_ID")
    if not proj:
        print("MUBIT_PROJECT_ID not set in env — bail", file=sys.stderr)
        return 1
    if not os.environ.get("MUBIT_API_KEY"):
        print("MUBIT_API_KEY not set in env — bail", file=sys.stderr)
        return 1

    from mubit import Client, AlreadyExistsError  # noqa: E402
    client = Client()

    # Snapshot what's already on Mubit so we know which path each agent takes.
    listed = client.advanced.list_agent_definitions(payload={"project_id": proj})
    existing = {a["agent_id"] for a in listed.get("agents", [])}
    print(f"Mubit currently has {len(existing)} agent card(s).")

    created = updated = skipped = 0
    failures: list[tuple[str, str]] = []

    for sub in sorted(WIKIS.iterdir()):
        if not sub.is_dir() or sub.name.startswith("_"):
            continue
        persona_path = sub / "personality.md"
        if not persona_path.exists():
            continue
        slug = sub.name
        text = persona_path.read_text(encoding="utf-8")
        info = _parse_persona(text)
        # Strip the "Who I Am —" prefix the parser leaves on the name.
        name = info["name"].removeprefix("Who I Am — ").strip() or slug
        role = info["subtitle"] or "Colleague"
        description = info["one_line"] or f"Colleague with the {role} archetype."
        # The full markdown body (frontmatter included) is fine as the prompt
        # — Mubit just stores it as `system_prompt_content` for reference.
        prompt = text

        payload = {
            "project_id": proj,
            "agent_id": slug,
            "role": role,
            "description": description,
            "system_prompt_content": prompt,
        }
        try:
            if slug in existing:
                client.advanced.update_agent_definition(payload=payload)
                updated += 1
                tag = "↻ updated"
            else:
                client.advanced.create_agent_definition(payload=payload)
                created += 1
                tag = "+ created"
        except AlreadyExistsError:
            # Race / out-of-sync snapshot — fall back to update.
            try:
                client.advanced.update_agent_definition(payload=payload)
                updated += 1
                tag = "↻ updated (race)"
            except Exception as exc:  # noqa: BLE001
                failures.append((slug, str(exc)[:120]))
                print(f"  ✗ {slug:24} update failed after dup: {exc}")
                continue
        except Exception as exc:  # noqa: BLE001
            failures.append((slug, str(exc)[:120]))
            print(f"  ✗ {slug:24} {type(exc).__name__}: {str(exc)[:120]}")
            continue

        print(f"  {tag}  {slug:24} role={role!r}  name={name!r}")

    print()
    print(f"Done — created {created}, updated {updated}, skipped {skipped}, failed {len(failures)}.")
    if failures:
        print("Failures:")
        for slug, msg in failures:
            print(f"  {slug}: {msg}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
