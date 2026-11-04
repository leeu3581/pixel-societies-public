"""Opt-in local DB contract check; all test writes roll back."""
import asyncio, json, os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4
import pytest
pytestmark=pytest.mark.skipif(os.getenv('RUN_LOCAL_MEMORY_TESTS')!='1',reason='local DB opt-in')

def test_batch_publication(monkeypatch): asyncio.run(scenario(monkeypatch))

async def scenario(monkeypatch):
    import asyncpg,httpx
    from fastapi import FastAPI
    from app.auth import CurrentUser,get_current_user
    from app.twin_memory import routes,service,wiki,publication
    from app.twin_memory.graph import enrich_graph
    dsn=os.getenv('MEMORY_TEST_DSN','postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    assert urlparse(dsn).hostname in ('127.0.0.1','localhost')
    conn=await asyncpg.connect(dsn);outer=conn.transaction();await outer.start()
    try:
        owner=str(uuid4())
        await conn.execute("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",owner,f'publish-{owner}@example.test')
        source=await service.add_source(conn,owner,'manual','test','Test',{'text':'I build incrementally.'})
        group=await conn.fetchval("insert into public.world_groups(name,slug,visibility,created_by) values('Test',$1,'public',$2) returning id",owner,owner)
        await conn.execute("insert into public.world_group_members(group_id,user_id,status) values($1,$2,'accepted')",group,owner)
        insights=[dict(id=k,title='A source interpretation',summary='Building iteratively for this project.',kind='workstream',status='proposed',review='unreviewed',observed_at=datetime.now(timezone.utc).isoformat(),source_ids=[str(source)],evidence_ids=['e'],topics=['iteration']) for k in ['a','b']]
        await conn.execute("update public.twin_memory_state set status='ready',snapshot=$2::jsonb where owner_user_id=$1",owner,json.dumps({'insights':insights}))
        @asynccontextmanager
        async def acquire():yield conn
        for module in [routes,service]:monkeypatch.setattr(module,'acquire',acquire)
        async def no_compile(owner):pass
        monkeypatch.setattr(wiki,'compile_wiki',no_compile)
        calls=[]
        async def prepare(items):
            calls.append(items)
            return [dict(id=i['id'],label='Small steps',text='For this project, I build in small steps.',section='approach') for i in items]
        monkeypatch.setattr(publication,'prepare',prepare)
        app=FastAPI();app.include_router(routes.router)
        app.dependency_overrides[get_current_user]=lambda:CurrentUser(owner,None,'authenticated',{})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://test') as c:
            state=(await c.get('/api/me/memory')).json();rev=state['revision']
            preview=(await c.post('/api/me/memory/publication-preview',json={'revision':rev})).json()
            await c.post('/api/me/memory/publication-preview',json={'revision':rev})
            assert len(calls)==1 and len(preview['items'])==2
            path='/api/me/memory/publish-selected';body={'revision':rev,'group_slug':owner,'items':preview['items']}
            assert (await c.post(path,json={**body,'group_slug':'absent'})).status_code==403
            assert (await c.get('/api/me/memory')).json()['revision']==rev
            assert (await c.post(path,json={**body,'revision':rev-1})).status_code==409
            assert (await c.post(path,json={**body,'items':[preview['items'][0]]*2})).status_code==422
            insights[1]['observed_at']='2020-01-01T00:00:00Z'
            await conn.execute("update public.twin_memory_state set snapshot=jsonb_set(snapshot,'{insights}',$2::jsonb) where owner_user_id=$1",owner,json.dumps(insights))
            assert (await c.post(path,json=body)).status_code==409
            state=(await c.get('/api/me/memory')).json()
            assert not state['signals'] and state['revision']==rev
            # Select only a: b stays unreviewed and unshared.
            result=await c.post(path,json={**body,'items':preview['items'][:1]})
            assert result.status_code==200,result.text
            state=(await c.get('/api/me/memory')).json()
            assert state['revision']==rev+1 and len(state['signals'])==1
            assert state['insights'][1]['review']=='unreviewed'
            assert state['signals'][0]['body']==preview['items'][0]['text']
            assert state['wiki_status']=='pending'
            graph=enrich_graph({'nodes':[],'links':[]},state)
            assert len(graph['nodes'])==1  # Wait for conceptual synthesis; never use publication titles.
            assert state['publication_preview']['items'][0]['section']=='approach'
    finally:await outer.rollback();await conn.close()
