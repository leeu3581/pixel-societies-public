"""Fix sprite_url for agents whose sprites were uploaded to Supabase Storage
but DB update failed (pool not initialized in script context).

Lists sprite files in storage via POST and matches them to agents by ID.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import asyncpg
import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


async def main() -> None:
    db_url = os.environ["SUPABASE_DB_URL"]
    supabase_url = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    conn = await asyncpg.connect(db_url)

    agents = await conn.fetch("""
        SELECT id, owner_user_id, display_name
        FROM public.agents
        WHERE sprite_url IS NULL AND canonical_id IS NOT NULL
    """)
    print(f"Found {len(agents)} agents without sprites")

    headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}

    async with httpx.AsyncClient(timeout=10) as client:
        fixed = 0
        for a in agents:
            user_id = str(a["owner_user_id"])
            agent_id = str(a["id"])

            # Supabase storage list uses POST with JSON body
            resp = await client.post(
                f"{supabase_url}/storage/v1/object/list/sprites",
                headers=headers,
                json={"prefix": f"{user_id}/{agent_id}/", "limit": 10},
            )

            if resp.status_code != 200:
                continue

            files = resp.json()
            sprite_files = [f for f in files if isinstance(f, dict) and f.get("name", "").startswith("base-")]
            if not sprite_files:
                continue

            latest = sorted(sprite_files, key=lambda f: f.get("name", ""))[-1]
            public_url = f"{supabase_url}/storage/v1/object/public/sprites/{user_id}/{agent_id}/{latest['name']}"

            await conn.execute(
                "UPDATE public.agents SET sprite_url = $1, updated_at = now() WHERE id = $2",
                public_url,
                agent_id,
            )
            fixed += 1
            print(f"  Fixed {a['display_name']}: {latest['name']}")

    print(f"\nUpdated {fixed} agents with sprite URLs")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
