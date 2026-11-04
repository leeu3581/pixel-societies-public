"""Opt-in local PostgreSQL/HTTP contract tests. All fixtures roll back; no model calls.
Run: RUN_LOCAL_MEMORY_TESTS=1 ./venv/bin/python -m pytest tests/test_twin_memory_db.py -q
"""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4
import pytest

pytestmark=pytest.mark.skipif(os.getenv('RUN_LOCAL_MEMORY_TESTS')!='1',reason='explicit local DB opt-in required')

def test_private_pipeline_http_and_database(monkeypatch):
    asyncio.run(scenario(monkeypatch))


async def scenario(monkeypatch):
    import asyncpg,httpx
    from fastapi import FastAPI,Request,HTTPException
    from app.auth import CurrentUser,get_current_user
    from app.twin_memory import service,routes,discovery,wiki,matching
    from app.twin_memory.analysis import normalize_interpretation
    from app.twin_memory.models import Interpretation,Insight
    from app.ingest import onboarding
    dsn=os.getenv('MEMORY_TEST_DSN','postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    if urlparse(dsn).hostname not in ('127.0.0.1','localhost'):
        raise RuntimeError('Memory integration tests require a local database')
    conn=await asyncpg.connect(dsn)
    outer=conn.transaction();await outer.start()
    try:
        owners=[str(uuid4()) for _ in range(3)]
        agents=[]
        for n,owner in enumerate(owners):
            await conn.execute("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)",owner,f'memory-test-{owner}@example.test',json.dumps({'display_name':f'Memory Test {n}'}))
            world=await conn.fetchval("select id from public.worlds where owner_user_id=$1 and slug='home'",owner)
            aid=await conn.fetchval("select id from public.agents where owner_user_id=$1 and world_id=$2 and canonical_id is null limit 1",owner,world)
            if not aid:
                aid=await conn.fetchval("insert into public.agents(owner_user_id,world_id,display_name,tile_x,tile_y) values($1,$2,'Test',16,14) returning id",owner,world)
            agents.append(aid)
            await conn.execute("update public.agents set portrait_url='/placeholder.png',persona_md='Public voice' where id=$1",aid)
        group=await conn.fetchval("insert into public.world_groups(name,slug,description,visibility,created_by) values('Memory test',$1,'Test','public',$2) returning id",'memory-test-'+owners[0][:8],owners[0])
        slug=await conn.fetchval('select slug from public.world_groups where id=$1',group)
        for owner in owners[:2]:
            await conn.execute("insert into public.world_group_members(group_id,user_id,status) values($1,$2,'accepted')",group,owner)
        @asynccontextmanager
        async def acquire():yield conn
        for module in [service,routes,discovery,onboarding]:monkeypatch.setattr(module,'acquire',acquire)
        async def fake_wiki(approved):return {"overview":"", "concepts":[], "connections":[]}
        monkeypatch.setattr(wiki,"synthesize",fake_wiki)
        real_analyze=service.analyze
        async def no_background(owner):pass
        monkeypatch.setattr(service,'analyze',no_background)
        async def interpret(ev):
            output=[]
            for e in ev:
                if e['authorship']!='user_statement':continue
                kind=e.get('hint_kind') if e.get('hint_kind') in ('need','offer','capability','intent','workstream') else 'need'
                output.append(Insight(kind=kind,title='Streaming latency',summary=e['text'],evidence_ids=[e['id']],confidence='medium',uncertainty='Availability requires confirmation.',topics=['streaming latency']))
            return normalize_interpretation(Interpretation(insights=output[:32]),ev)
        monkeypatch.setattr(service,'interpret',interpret)
        monkeypatch.setenv('LLM_DISABLED','0')
        app=FastAPI();app.include_router(routes.router);app.include_router(discovery.router);app.include_router(onboarding.router)
        async def auth(request:Request):
            owner=request.headers.get('x-test-owner')
            if owner not in owners:raise HTTPException(401)
            return CurrentUser(owner,None,'authenticated',{})
        app.dependency_overrides[get_current_user]=auth
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            async def req(method,path,owner=0,**kwargs):
                r=await client.request(method,path,headers={'x-test-owner':owners[owner]},**kwargs)
                return r
            assert (await client.get('/api/me/memory')).status_code==401
            # Actual upload parser -> private source -> no public persona mutation.
            record={'type':'user','sessionId':'local-test','uuid':'one','cwd':'/synthetic/voice','timestamp':datetime.now(timezone.utc).isoformat(),'message':{'content':'I need help reducing streaming latency before the demo. Contact private@example.test.'}}
            raw=json.dumps(record).encode()
            for _ in range(2):
                r=await req('POST','/api/ingest/claude-code',files=[('files',('test.jsonl',raw))]);assert r.status_code==200,r.text
            assert await conn.fetchval('select count(*) from public.twin_memory_sources where owner_user_id=$1',owners[0])==1
            assert await conn.fetchval('select persona_md from public.agents where id=$1',agents[0])=='Public voice'
            payload=await conn.fetchval('select payload from public.twin_memory_sources where owner_user_id=$1',owners[0]);assert 'private@example.test' not in payload
            assert (await req('GET','/api/me/memory',owner=1)).json()['sources']==[]
            await real_analyze(owners[0])
            a=(await req('GET','/api/me/memory')).json();assert a['status']=='ready' and a['insights']
            aid=a['insights'][0]['id'];source_id=a['sources'][0]['id']
            assert (await req('DELETE','/api/me/memory/sources/'+source_id,owner=1)).status_code==404
            share={'revision':a['revision'],'purpose':'help','group_slug':slug,'text':'I need help reducing streaming latency.','available':'Thursday afternoon','days':7}
            assert (await req('POST',f'/api/me/memory/insights/{aid}/share',json=share)).status_code==409
            assert (await req('PATCH',f'/api/me/memory/insights/{aid}',json={'revision':a['revision'],'action':'confirm'})).status_code==200
            # Stale content approval is rejected.
            assert (await req('POST',f'/api/me/memory/insights/{aid}/share',json=share)).status_code==409
            a=(await req('GET','/api/me/memory')).json();share['revision']=a['revision']
            r=await req('POST',f'/api/me/memory/insights/{aid}/share',json=share);assert r.status_code==200,r.text
            # No synthetic builders leak into actual introductions.
            path=f'/api/world-groups/by-slug/{slug}/introductions'
            assert (await req('GET',path)).json()['introductions']==[]
            assert (await req('GET',path,owner=2)).status_code==403
            r=await req('POST','/api/me/memory/notes',owner=1,json={'kind':'offer','text':'I can help profile streaming latency on Thursday afternoon.'});assert r.status_code==200,r.text
            await real_analyze(owners[1]);b=(await req('GET','/api/me/memory',owner=1)).json();bid=b['insights'][0]['id']
            assert (await req('PATCH',f'/api/me/memory/insights/{bid}',owner=1,json={'revision':b['revision'],'action':'confirm'})).status_code==200
            b=(await req('GET','/api/me/memory',owner=1)).json()
            r=await req('POST',f'/api/me/memory/insights/{bid}/share',owner=1,json={**share,'revision':b['revision'],'text':'I can help profile streaming latency.'});assert r.status_code==200,r.text
            matches=(await req('GET',path)).json()['introductions'];assert len(matches)==1
            assert 'evidence' not in matches[0] and 'source_ids' not in matches[0]
            # Publish with only reviewed text; no purpose, schedule or deadline fields.
            pa=await req('POST',f'/api/me/memory/insights/{aid}/share',json={'revision':a['revision'],'text':'Building interactive tools for thoughtful collaboration.','group_slug':slug})
            pb=await req('POST',f'/api/me/memory/insights/{bid}/share',owner=1,json={'revision':b['revision'],'text':'I study how small teams make decisions together.','group_slug':slug})
            assert pa.status_code==200 and pb.status_code==200
            async def rank(own,peers):
                assert all('payload' not in r for r in own+peers)
                return {(pa.json()['signal_id'],pb.json()['signal_id']):{'purpose':'conversation','reason':'A tool builder and a researcher can compare approaches.','next_step':'Compare one workflow.','uncertainty':'Interest in working together is unknown.','topics':[]}}
            monkeypatch.setattr(matching,'rank_published',rank)
            semantic=(await req('GET',path)).json()['introductions']
            assert semantic[0]['purpose']=='conversation' and semantic[0]['availability']==''
            public_path=f'/api/world-groups/by-slug/{slug}/published-profiles/{owners[0]}'
            assert len((await req('GET',public_path,owner=1)).json()['parts'])==1
            assert (await req('GET',public_path,owner=2)).status_code==403
            iid=matches[0]['id']
            assert (await req('POST',f'/api/me/introductions/{iid}/feedback',owner=2,json={'outcome':'useful'})).status_code==404
            assert (await req('POST',f'/api/me/introductions/{iid}/feedback',json={'outcome':'useful'})).status_code==200
            # Source deletion removes projections and dependent introductions immediately.
            assert (await req('DELETE','/api/me/memory/sources/'+source_id)).status_code==200
            assert (await req('GET',path)).json()['introductions']==[]
            assert not (await req('GET','/api/me/memory')).json().get('insights')
            assert await conn.fetchval('select count(*) from public.twin_introductions where id=$1',iid)==0
            # Expiry is checked at read time, independent of any maintenance job.
            await conn.execute("update public.twin_discovery_signals set expires_at=now()-interval '1 second' where owner_user_id=$1",owners[1])
            assert (await req('GET','/api/me/memory',owner=1)).json()['signals']==[]
            # Stale worker must not resurrect deleted evidence.
            await req('POST','/api/me/memory/notes',json={'text':'I need help with streaming latency again.','kind':'need'})
            started=asyncio.Event();release=asyncio.Event()
            async def slow(ev):started.set();await release.wait();return await interpret(ev)
            monkeypatch.setattr(service,'interpret',slow)
            worker=asyncio.create_task(real_analyze(owners[0]));await started.wait()
            a=(await req('GET','/api/me/memory')).json()
            await req('DELETE','/api/me/memory/sources/'+a['sources'][0]['id'])
            release.set();await worker
            assert not (await req('GET','/api/me/memory')).json().get('insights')
            # A late second-stage wiki result cannot restore a removed source.
            started_wiki=asyncio.Event();release_wiki=asyncio.Event()
            async def slow_wiki(approved):
                started_wiki.set();await release_wiki.wait()
                return {'overview':'stale private prose','concepts':[],'connections':[]}
            monkeypatch.setattr(wiki,'synthesize',slow_wiki)
            await conn.execute("update public.twin_memory_state set snapshot=snapshot - 'wiki_revision' where owner_user_id=$1",owners[1])
            worker=asyncio.create_task(wiki.compile_wiki(owners[1]));await started_wiki.wait()
            b=(await req('GET','/api/me/memory',owner=1)).json()
            await req('DELETE','/api/me/memory/sources/'+b['sources'][0]['id'],owner=1)
            release_wiki.set();await worker
            assert not (await req('GET','/api/me/memory',owner=1)).json().get('wiki')
            # RLS is enabled and client roles have no direct private-table permissions.
            for table in ['twin_memory_sources','twin_memory_state','twin_discovery_signals','twin_introductions']:
                assert not await conn.fetchval("select has_table_privilege('authenticated',$1,'SELECT')",'public.'+table)
    finally:
        await outer.rollback();await conn.close()
