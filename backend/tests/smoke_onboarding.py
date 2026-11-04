"""Opt-in local HTTP/Postgres onboarding smoke test.

Run from backend: ./venv/bin/python tests/smoke_onboarding.py
Requires the local backend and seeded cafe. Refuses non-local API/DB.
Creates and removes one synthetic account; never reads real chat histories.
Uses a placeholder portrait so no paid image-generation call is made.
Checks real authentication, upload, persistence, reimport, roster and matches.
"""

import asyncio, json, os, uuid
from pathlib import Path
from urllib.parse import urlparse
import httpx, asyncpg
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / '.env')
async def main():
    base=os.environ.get('TEST_BACKEND_URL','http://127.0.0.1:4001').rstrip('/')
    assert urlparse(base).hostname in ('localhost','127.0.0.1')
    assert urlparse(os.environ['SUPABASE_DB_URL']).hostname in ('localhost','127.0.0.1')
    email='onboarding-smoke-'+uuid.uuid4().hex[:10]+'@pixel.local'
    password='LocalSyntheticSmoke42!'
    uid=None
    conn=await asyncpg.connect(os.environ['SUPABASE_DB_URL'])
    async with httpx.AsyncClient(timeout=90) as client:
      try:
        r=await client.post(base+'/api/auth/signup',json={'email':email,'password':password,'display_name':'Onboarding Smoke'})
        assert r.status_code in (200,201), 'test account creation failed'
        uid=r.json()['user']['id']
        r=await client.post(base+'/api/auth/login',json={'email':email,'password':password})
        assert r.status_code==200, 'test sign-in failed'
        auth={'Authorization':'Bearer '+r.json()['access_token']}
        r=await client.get(base+'/api/auth/session',headers=auth)
        assert r.status_code==200 and r.json()['id']==uid, 'session verification failed'
        assert (await client.get(base+'/api/ingest/claude-code')).status_code==401
        r=await client.patch(base+'/api/me/profile',headers=auth,json={'display_name':'Onboarding Smoke'})
        assert r.status_code==200, 'profile update failed'
        r=await client.get(base+'/api/integrations/gmail',headers=auth)
        assert r.status_code==200 and not r.json()['connected'], 'Gmail status failed'
        r=await client.get(base+'/api/ingest/claude-code',headers=auth)
        assert r.status_code==200 and not r.json()['imported'], 'initial onboarding state failed'
        wid=await conn.fetchval("select id from public.worlds where owner_user_id=$1 and slug='home'",uuid.UUID(uid))
        assert wid, 'signup did not provision home world'
        aid=await conn.fetchval("select id from public.agents where owner_user_id=$1 and world_id=$2 and canonical_id is null order by created_at,id limit 1",uuid.UUID(uid),wid)
        if not aid:
          aid=await conn.fetchval("insert into public.agents(world_id,owner_user_id,display_name,tile_x,tile_y) values($1,$2,'Onboarding Smoke',16,14) returning id",wid,uuid.UUID(uid))
        await conn.execute("update public.agents set portrait_url='/team-office/characters/char_0.png' where id=$1",aid)
        record={'type':'assistant','sessionId':'synthetic-session','uuid':'synthetic-one','cwd':'/synthetic/agents-devtools','timestamp':'2026-11-02T10:00:00Z','message':{'content':[{'type':'tool_use','name':'Write','input':{'file_path':'frontend/components/view.tsx','content':"import React from 'react'"}}]}}
        human={**record,'type':'user','uuid':'synthetic-human','message':{'content':'I build agent tools. Contact synthetic@example.test. API_KEY=synthetic-value'}}
        fixture='\n'.join(json.dumps(x) for x in [record,human]).encode()
        for attempt in range(2):
          r=await client.post(base+'/api/ingest/claude-code',headers=auth,files=[('files',('session.jsonl',fixture,'application/octet-stream'))])
          assert r.status_code==200, 'upload status '+str(r.status_code)
          result=r.json()
          assert result['agent_id']==str(aid) and result['imported']
          assert result['profile']['role_lean']=='interface'
        assert await conn.fetchval('select count(*) from public.builder_profiles where agent_id=$1',aid)==1
        persona=await conn.fetchval('select persona_md from public.agents where id=$1',aid)
        assert persona.count('## Builder memory')==1 and 'synthetic@example.test' not in persona
        r=await client.get(base+'/api/ingest/claude-code',headers=auth)
        assert r.status_code==200 and r.json()['imported']
        r=await client.get(base+'/api/world-groups/by-slug/cofounder-cafe/agents',headers=auth)
        assert r.status_code==200 and any(a['agent_id']==str(aid) for a in r.json()['agents']), 'twin not in cafe roster'
        r=await client.get(base+'/api/world-groups/by-slug/cofounder-cafe/matches',params={'agent_id':str(aid)},headers=auth)
        assert r.status_code==200 and r.json()['matches'], 'no matches returned'
        assert all(str(aid) in (m['agent_a']['agent_id'],m['agent_b']['agent_id']) for m in r.json()['matches'])
        print(json.dumps({'live_onboarding':'passed','repeat_import_same_twin':True,'persisted_memory_redacted':True,'cafe_roster_contains_twin':True,'match_count':len(r.json()['matches']),'best_score':r.json()['matches'][0]['score']}))
      finally:
        try:
          if uid:
            await conn.execute('delete from auth.users where id=$1',uuid.UUID(uid))
        finally:
          await conn.close()
if __name__ == "__main__":
    asyncio.run(main())
