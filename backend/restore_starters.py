"""Restore the four original wiki-backed companions without replacing existing agents.
Local-only repair: python restore_starters.py --owner <user UUID>
"""
import argparse
import asyncio
import os
from uuid import UUID

# This utility never connects to the configured production database.
os.environ['LOGFIRE_SEND_TO_LOGFIRE'] = 'false'
from seed_canonical import WIKIS_DIR, build_full_persona_md, parse_personality
import asyncpg

STARTERS = [('support',5,5,'#10b981'),('engineering',12,5,'#3b82f6'),
            ('marketing',20,5,'#ec4899'),('product',26,5,'#a855f7')]

async def restore(owner):
    conn = await asyncpg.connect('postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    try:
        async with conn.transaction():
            world = await conn.fetchval("select id from public.worlds where owner_user_id=$1 and slug='home' for update", owner)
            if not world:
                raise RuntimeError('Owner has no home world')
            for slug,x,y,tint in STARTERS:
                wiki = WIKIS_DIR / slug
                name, subtitle = parse_personality((wiki/'personality.md').read_text(),slug)
                persona = build_full_persona_md(wiki)
                await conn.execute('''insert into public.canonical_agents(id,display_name,subtitle,persona_md,default_tint)
                    values($1,$2,$3,$4,$5) on conflict(id) do nothing''',slug,name,subtitle,persona,tint)
                await conn.execute('''insert into public.agents(world_id,owner_user_id,canonical_id,display_name,subtitle,persona_md,sprite_url,tint,tile_x,tile_y)
                    select $1,$2,c.id,c.display_name,c.subtitle,c.persona_md,c.default_sprite_url,coalesce(c.default_tint,$6),$4,$5
                    from public.canonical_agents c where c.id=$3 and not exists
                    (select 1 from public.agents a where a.world_id=$1 and a.canonical_id=c.id)''',world,owner,slug,x,y,tint)
                print(f'Restored/verified {name}: {len(list(wiki.glob("*.md")))} wiki pages')
    finally:
        await conn.close()

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner',type=UUID,required=True)
    asyncio.run(restore(parser.parse_args().owner))
