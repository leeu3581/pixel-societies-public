"""Private review API. Every lookup is scoped to the authenticated owner."""
import json
from datetime import datetime, timezone, timedelta
from uuid import UUID, uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File
from ..auth import CurrentUser, get_current_user
from ..db import acquire
from ..integrations.gmail_context import clean
from . import service
from .models import Note, Review, Share, PublishSelected, PreviewRequest

router = APIRouter(prefix='/api/me/memory', tags=['Private twin memory'])


@router.post('/voice/transcribe')
async def voice_preview(audio: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    from .voice import MAX_AUDIO_BYTES, transcribe
    try:
        clip = await audio.read(MAX_AUDIO_BYTES + 1)
    finally:
        await audio.close()
    return await transcribe(clip)


@router.get('')
async def get_memory(user: CurrentUser = Depends(get_current_user)):
    return await service.view(user.id)


@router.post('/analyze')
async def analyze(tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    tasks.add_task(service.analyze, user.id)
    return {'queued': True}


@router.post('/notes')
async def note(body: Note, tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            payload = {'text': clean(body.text), 'kind': body.kind}
            await service.add_source(conn, user.id, 'manual', 'manual:'+service.digest(payload), 'Your own context', payload)
    tasks.add_task(service.analyze, user.id)
    return {'saved': True}


@router.delete('/sources/{source_id}')
async def remove_source(source_id: UUID, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            await service.ensure_state(conn, user.id)
            row = await conn.fetchval('delete from public.twin_memory_sources where id=$1 and owner_user_id=$2 returning kind', source_id, user.id)
            if not row:
                raise HTTPException(404, 'Source not found')
            if row == 'gmail':
                await conn.execute("delete from public.twin_source_context where owner_user_id=$1 and source='gmail'", user.id)
            await service.invalidate(conn, user.id)
            # Rejected/corrected claims can contain deleted-source text too.
            state = await service.ensure_state(conn, user.id)
            reviews = {k:v for k,v in service.decoded(state['reviews'],{}).items() if str(source_id) not in v.get('insight',{}).get('source_ids',[])}
            await conn.execute('update public.twin_memory_state set reviews=$2::jsonb where owner_user_id=$1', user.id, json.dumps(reviews))
    return {'removed': True, 'message':'Source and derived analysis removed. Reanalyze remaining sources when ready.'}


@router.delete('')
async def forget(user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            await service.ensure_state(conn, user.id)
            await conn.execute('delete from public.twin_memory_sources where owner_user_id=$1', user.id)
            await service.invalidate(conn, user.id)
            await conn.execute("update public.twin_memory_state set reviews='{}',status='empty' where owner_user_id=$1", user.id)
            await conn.execute('delete from public.builder_profiles where owner_user_id=$1', user.id)
            await conn.execute('delete from public.twin_source_context where owner_user_id=$1', user.id)
    return {'removed':True}


@router.patch('/insights/{insight_id}')
async def review(insight_id: str, body: Review, tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            state = await service.ensure_state(conn, user.id)
            if state['revision'] != body.revision or state['status'] != 'ready':
                raise HTTPException(409,'Your memory changed. Refresh before reviewing.')
            insights = service.decoded(state['snapshot'],{}).get('insights',[])
            original = next((i for i in insights if i['id']==insight_id), None)
            if not original:
                raise HTTPException(404,'Insight not found')
            if body.action == 'correct' and not body.summary:
                raise HTTPException(422,'Write the corrected interpretation')
            reviews = service.decoded(state['reviews'],{})
            reviews[insight_id] = dict(insight=original,action=body.action,summary=clean(body.summary) if body.summary else None,at=datetime.now(timezone.utc).isoformat())
            await conn.execute('delete from public.twin_discovery_signals where owner_user_id=$1 and insight_id=$2',user.id,insight_id)
            # Advance revision to prevent concurrent analysis or stale approvals overwriting this review.
            await conn.execute('''update public.twin_memory_state set reviews=$2::jsonb,revision=revision+1,
                analyzed_revision=revision+1,snapshot=snapshot || '{"wiki":{},"wiki_status":"pending"}'::jsonb,updated_at=now() where owner_user_id=$1''',user.id,json.dumps(reviews))
    from .wiki import compile_wiki
    tasks.add_task(compile_wiki, user.id)
    return {'saved':True}


async def share_one(conn, user, insight_id, body, title=None):
    state = await service.ensure_state(conn,user.id)
    if state['revision'] != body.revision or state['status'] != 'ready':
        raise HTTPException(409,'Memory changed. Review the current wording before approving.')
    item = next((i for i in service.reviewed_snapshot(state).get('insights',[]) if i['id']==insight_id),None)
    if not item:
        raise HTTPException(404,'Insight not found')
    if item.get('review') not in ('confirm','correct'):
        raise HTTPException(409,'Confirm or correct this interpretation before sharing it.')
    if item['status'] == 'historical':
        raise HTTPException(409,'This is historical. Add a current note before sharing it as current.')
    group = await conn.fetchval('''select g.id from public.world_groups g
        join public.world_group_members m on m.group_id=g.id
        where g.slug=$1 and m.user_id=$2 and m.status='accepted' for share of m''',body.group_slug,user.id)
    if not group:
        raise HTTPException(403,'Join this group before allowing discovery there.')
    expires = datetime.now(timezone.utc) + timedelta(days=body.days)
    sources = await conn.fetch('select payload,kind from public.twin_memory_sources where owner_user_id=$1 and id=any($2::uuid[])', user.id, [UUID(s) for s in item['source_ids']])
    for source in sources:
        until = service.decoded(source['payload'], {}).get('valid_until') if source['kind'] == 'gmail' else None
        if until:
            expires = min(expires, datetime.fromisoformat(until))
    if item['kind'] in ('workstream','need','offer','intent'):
        expires = min(expires, datetime.fromisoformat(item['observed_at'].replace('Z','+00:00')).replace(tzinfo=timezone.utc) + timedelta(days=30))
    if expires <= datetime.now(timezone.utc):
        raise HTTPException(409, 'This evidence has expired. Add current context before sharing.')
    # The exact submitted text is approved; reject if server redaction would change it.
    if clean(body.text) != body.text or clean(body.available) != body.available:
        raise HTTPException(422,'Remove private paths or secret patterns from the proposed text and approve again.')
    signal = await conn.fetchval('''insert into public.twin_discovery_signals
        (owner_user_id,group_id,insight_id,approved_revision,purpose,kind,title,body,topics,availability,expires_at,source_ids)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict(owner_user_id,group_id,insight_id,purpose) do update set
        approved_revision=excluded.approved_revision,body=excluded.body,title=excluded.title,
        topics=excluded.topics,availability=excluded.availability,expires_at=excluded.expires_at,
        source_ids=excluded.source_ids returning id''',user.id,group,insight_id,body.revision,body.purpose,
        item['kind'],title or item['title'],body.text,item['topics'],body.available,expires,[UUID(s) for s in item['source_ids']])
    # Existing introductions may reflect previous approved text.
    await conn.execute('delete from public.twin_introductions where signal_a=$1 or signal_b=$1',signal)
    return signal


@router.post('/insights/{insight_id}/share')
async def share(insight_id: str, body: Share, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            signal = await share_one(conn, user, insight_id, body)
    return {'shared':True,'signal_id':str(signal)}


@router.delete('/signals/{signal_id}')
async def revoke(signal_id: UUID,user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        result = await conn.fetchval('delete from public.twin_discovery_signals where id=$1 and owner_user_id=$2 returning id',signal_id,user.id)
    if not result:
        raise HTTPException(404,'Signal not found')
    return {'revoked':True}


@router.post('/wiki')
async def rebuild_wiki(tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    from .wiki import compile_wiki
    tasks.add_task(compile_wiki,user.id)
    return {'queued':True}


@router.post('/publication-preview')
async def publication_preview(body: PreviewRequest, user: CurrentUser = Depends(get_current_user)):
    from .publication import prepare, PREVIEW_VERSION
    async with acquire() as conn:
        async with conn.transaction():
            state = await service.ensure_state(conn, user.id)
            if state['revision'] != body.revision or state['status'] != 'ready':
                raise HTTPException(409, 'Your notes changed. Refresh before preparing a preview.')
            snapshot = service.reviewed_snapshot(state)
            items = [i for i in snapshot.get('insights', []) if i['status'] != 'historical']
            cached = snapshot.get('publication_preview', {})
            if cached.get('version') == PREVIEW_VERSION and cached.get('revision') == body.revision and {i['id'] for i in cached.get('items', [])} == {i['id'] for i in items}:
                return cached
    try:
        drafts = await prepare([{k: i.get(k) for k in ('id','kind','title','summary','uncertainty','workstream','observed_at')} for i in items])
    except Exception:
        raise HTTPException(502, 'Could not prepare readable profile text. Please retry; nothing was published.') from None
    preview = {'revision': body.revision, 'version': PREVIEW_VERSION, 'items': drafts}
    async with acquire() as conn:
        updated = await conn.fetchval('''update public.twin_memory_state
            set snapshot=jsonb_set(snapshot,'{publication_preview}',$3::jsonb)
            where owner_user_id=$1 and revision=$2 and status='ready' returning revision''', user.id, body.revision, json.dumps(preview))
    if updated is None:
        raise HTTPException(409, 'Your notes changed while the preview was being prepared. Refresh and try again.')
    return preview


@router.post('/publish-selected')
async def publish_selected(body: PublishSelected, tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    from .publication import PREVIEW_VERSION
    ids = [item.id for item in body.items]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, 'Select each note only once.')
    for item in body.items:
        if len(item.label.split()) > 5 or clean(item.label) != item.label or clean(item.text) != item.text or clean(item.reading) != item.reading:
            raise HTTPException(422, 'Use a short graph label and remove private patterns before publishing.')
    async with acquire() as conn:
        async with conn.transaction():
            state = await service.ensure_state(conn, user.id)
            if state['revision'] != body.revision or state['status'] != 'ready':
                raise HTTPException(409, 'Your notes changed. Review the current wording before publishing.')
            snapshot = service.reviewed_snapshot(state)
            eligible = {i['id']: i for i in snapshot.get('insights', []) if i['status'] != 'historical'}
            if not set(ids) <= eligible.keys():
                raise HTTPException(409, 'A selected note is missing or historical. Refresh your selection.')
            reviews = service.decoded(state['reviews'], {})
            for item in body.items:
                reviews[item.id] = dict(insight=eligible[item.id], action='correct', summary=item.text,
                    at=datetime.now(timezone.utc).isoformat())
            preview = {i['id']: i for i in snapshot.get('publication_preview', {}).get('items', [])}
            preview.update({i.id: i.model_dump() for i in body.items})
            patch = {'wiki': {}, 'wiki_status': 'pending', 'publication_preview': {'revision': body.revision + 1, 'version': PREVIEW_VERSION, 'items': list(preview.values())}}
            await conn.execute('''update public.twin_memory_state set reviews=$2::jsonb,
                revision=revision+1,analyzed_revision=revision+1,snapshot=snapshot || $3::jsonb,updated_at=now()
                where owner_user_id=$1''', user.id, json.dumps(reviews), json.dumps(patch))
            signals = []
            for item in body.items:
                signal = await share_one(conn, user, item.id,
                    Share(revision=body.revision+1, group_slug=body.group_slug, text=item.text), title=item.label)
                signals.append(str(signal))
    from .wiki import compile_wiki
    tasks.add_task(compile_wiki, user.id)
    return {'shared': True, 'count': len(signals), 'revision': body.revision+1, 'signal_ids': signals}
