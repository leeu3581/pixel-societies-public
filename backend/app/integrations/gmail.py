"""Gmail connection and review/commit lifecycle; every route requires owner JWT."""
import asyncio
import base64
import hashlib
import json
import os
import secrets
from datetime import datetime, timezone
from urllib.parse import urlencode
from uuid import UUID

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from opentelemetry.instrumentation.utils import suppress_instrumentation

from ..auth import CurrentUser, get_current_user
from ..db import acquire
from ..ingest.onboarding import _self_agent
from .gmail_context import evidence, synthesize
from ..twin_memory import service as memory_service

router = APIRouter(prefix='/api/integrations/gmail', tags=['Gmail context'])
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
API = 'https://gmail.googleapis.com/gmail/v1/users/me/'


def cipher():
    try:
        return Fernet(os.environ['GMAIL_TOKEN_ENCRYPTION_KEY'].encode())
    except (KeyError, ValueError):
        raise HTTPException(503, 'Gmail token encryption is not configured') from None


def config():
    names = ('GOOGLE_GMAIL_CLIENT_ID', 'GOOGLE_GMAIL_CLIENT_SECRET', 'GOOGLE_GMAIL_REDIRECT_URI')
    values = [os.getenv(n, '').strip() for n in names]
    if not all(values):
        raise HTTPException(503, 'Gmail connection is not configured')
    cipher()
    return values


def decrypt(value):
    try:
        return cipher().decrypt(value.encode()).decode()
    except InvalidToken:
        raise HTTPException(503, 'Gmail encryption key changed; restore the configured key') from None


async def request(method, url, **kwargs):
    # Prevent OAuth credentials, message content and query parameters from traces.
    with suppress_instrumentation():
        async with httpx.AsyncClient(timeout=20) as client:
            for attempt in range(3):
                try:
                    response = await client.request(method, url, **kwargs)
                except httpx.RequestError:
                    if attempt == 2:
                        raise HTTPException(502, 'Google is temporarily unavailable') from None
                    await asyncio.sleep(2 ** attempt)
                    continue
                if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(2 ** attempt)
                    continue
                if not response.is_success:
                    raise HTTPException(409 if response.status_code in (400, 401, 403) else 502,
                                        'Gmail access failed; reconnect or retry')
                return response.json() if response.content else {}


@router.get('')
async def status(user: CurrentUser = Depends(get_current_user)):
    try:
        config()
        configured = True
    except HTTPException:
        configured = False
    async with acquire() as conn:
        await conn.execute('delete from public.gmail_context_previews where owner_user_id=$1 and expires_at<=now()', user.id)
        await conn.execute('delete from public.gmail_oauth_states where owner_user_id=$1 and expires_at<=now()', user.id)
        row = await conn.fetchrow('select last_sync_at,last_error from public.gmail_connections where owner_user_id=$1', user.id)
        context = await conn.fetchval("select context from public.twin_source_context where owner_user_id=$1 and source='gmail'", user.id)
    return {'configured': configured, 'connected': row is not None,
            'last_sync_at': row['last_sync_at'] if row else None,
            'last_error': row['last_error'] if row else None,
            'context': json.loads(context) if isinstance(context, str) else context}


@router.post('/connect')
async def connect(user: CurrentUser = Depends(get_current_user)):
    client_id, _, redirect = config()
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    async with acquire() as conn:
        await conn.execute("""insert into public.gmail_oauth_states(owner_user_id,state_hash,verifier,expires_at)
          values($1,$2,$3,now()+interval '10 minutes') on conflict(owner_user_id) do update set
          state_hash=excluded.state_hash,verifier=excluded.verifier,expires_at=excluded.expires_at""",
          user.id, hashlib.sha256(state.encode()).hexdigest(), cipher().encrypt(verifier.encode()).decode())
    return {'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
        'client_id': client_id, 'redirect_uri': redirect, 'response_type': 'code', 'scope': SCOPE,
        'state': state, 'access_type': 'offline', 'prompt': 'consent',
        'code_challenge': challenge, 'code_challenge_method': 'S256'})}


class Callback(BaseModel):
    state: str = Field(min_length=20, max_length=200)
    code: str = Field(min_length=1, max_length=4096)


@router.post('/callback')
async def callback(body: Callback, user: CurrentUser = Depends(get_current_user)):
    client_id, secret, redirect = config()
    async with acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow("""delete from public.gmail_oauth_states
              where owner_user_id=$1 and state_hash=$2 and expires_at>now() returning verifier""",
              user.id, hashlib.sha256(body.state.encode()).hexdigest())
            if not row:
                raise HTTPException(400, 'Connection expired or already used; connect again')
            token = await request('POST', 'https://oauth2.googleapis.com/token', data={
                'client_id': client_id, 'client_secret': secret, 'redirect_uri': redirect,
                'grant_type': 'authorization_code', 'code': body.code, 'code_verifier': decrypt(row['verifier'])})
            if SCOPE not in token.get('scope', '').split() or not token.get('refresh_token'):
                raise HTTPException(400, 'Read-only Gmail permission and offline access are required; reconnect')
            encrypted = cipher().encrypt(token['refresh_token'].encode()).decode()
            await conn.execute("""insert into public.gmail_connections(owner_user_id,refresh_token)
                values($1,$2) on conflict(owner_user_id) do update set refresh_token=excluded.refresh_token,
                generation=gen_random_uuid(),last_error=null""", user.id, encrypted)
            await conn.execute('delete from public.gmail_context_previews where owner_user_id=$1', user.id)
    return {'connected': True}


class PreviewRequest(BaseModel):
    days: int = Field(default=30, ge=1, le=90)
    max_messages: int = Field(default=40, ge=1, le=100)


@router.post('/preview')
async def preview(body: PreviewRequest, user: CurrentUser = Depends(get_current_user)):
    client_id, secret, _ = config()
    async with acquire() as conn:
        connection = await conn.fetchrow('select * from public.gmail_connections where owner_user_id=$1', user.id)
        agent = await _self_agent(conn, user.id)
    if not connection:
        raise HTTPException(409, 'Connect Gmail first')
    if not agent or not agent['character_started']:
        raise HTTPException(409, 'Create your character first')
    try:
        token = await request('POST', 'https://oauth2.googleapis.com/token', data={
            'client_id': client_id, 'client_secret': secret, 'grant_type': 'refresh_token',
            'refresh_token': decrypt(connection['refresh_token'])})
        headers = {'Authorization': 'Bearer ' + token['access_token']}
        items, seen, page = [], set(), None
        # Bounded selection, with pagination and explicit SENT membership checks.
        while len(seen) < body.max_messages:
            params = {'q': f'in:sent newer_than:{body.days}d', 'maxResults': body.max_messages-len(seen)}
            if page:
                params['pageToken'] = page
            batch = await request('GET', API+'messages', headers=headers, params=params)
            for ref in batch.get('messages', []):
                if ref['id'] in seen:
                    continue
                seen.add(ref['id'])
                message = await request('GET', API+'messages/'+ref['id'], headers=headers, params={
                    'format': 'full', 'fields': 'id,internalDate,labelIds,payload'})
                item = evidence(message)
                if item:
                    items.append(item)
                if len(seen) >= body.max_messages:
                    break
            next_page = batch.get('nextPageToken')
            if not next_page or next_page == page or not batch.get('messages'):
                break
            page = next_page
        with suppress_instrumentation():
            context = await synthesize(items, body.days)
        async with acquire() as conn:
            async with conn.transaction():
                current = await conn.fetchval('select generation from public.gmail_connections where owner_user_id=$1 for update', user.id)
                if current != connection['generation']:
                    raise HTTPException(409, 'Connection changed; preview again')
                row = await conn.fetchrow("""insert into public.gmail_context_previews(owner_user_id,generation,context,expires_at)
                  values($1,$2,$3::jsonb,now()+interval '15 minutes') on conflict(owner_user_id) do update set
                  id=gen_random_uuid(),generation=excluded.generation,context=excluded.context,expires_at=excluded.expires_at returning id""",
                  user.id, current, json.dumps(context))
                await conn.execute('update public.gmail_connections set last_error=null where owner_user_id=$1', user.id)
        return {'preview_id': str(row['id']), 'context': context, 'messages_scanned': len(seen)}
    except Exception as exc:
        async with acquire() as conn:
            await conn.execute("update public.gmail_connections set last_error='Context refresh failed; retry or reconnect' where owner_user_id=$1 and generation=$2", user.id, connection['generation'])
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(502, 'Context refresh failed; retry later') from None


class CommitRequest(BaseModel):
    preview_id: UUID


@router.post('/commit')
async def commit(body: CommitRequest, tasks: BackgroundTasks, user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        async with conn.transaction():
            generation = await conn.fetchval('select generation from public.gmail_connections where owner_user_id=$1 for update', user.id)
            row = await conn.fetchrow("""delete from public.gmail_context_previews
              where owner_user_id=$1 and id=$2 and generation=$3 and expires_at>now() returning context""",
              user.id, body.preview_id, generation)
            if not row:
                raise HTTPException(409, 'Preview expired or replaced; refresh again')
            agent = await _self_agent(conn, user.id, lock=True)
            if not agent:
                raise HTTPException(409, 'Create your character first')
            context = json.loads(row['context']) if isinstance(row['context'], str) else row['context']
            await conn.execute("""insert into public.twin_source_context(owner_user_id,source,agent_id,context)
              values($1,'gmail',$2,$3::jsonb) on conflict(owner_user_id,source) do update set
              agent_id=excluded.agent_id,context=excluded.context,updated_at=now()""", user.id, agent['id'], json.dumps(context))
            await conn.execute('update public.gmail_connections set last_sync_at=now(),last_error=null where owner_user_id=$1', user.id)
            await memory_service.sync_gmail(conn, user.id, context)
    tasks.add_task(memory_service.analyze, user.id)
    return {'imported': True}


@router.delete('/preview')
async def cancel(user: CurrentUser = Depends(get_current_user)):
    async with acquire() as conn:
        await conn.execute('delete from public.gmail_context_previews where owner_user_id=$1', user.id)
    return {'cancelled': True}


@router.delete('')
async def disconnect(user: CurrentUser = Depends(get_current_user)):
    # Serialize with commit/preview; local deletion is effective even if Google is down.
    async with acquire() as conn:
        async with conn.transaction():
            await conn.execute('delete from public.gmail_oauth_states where owner_user_id=$1', user.id)
            connection = await conn.fetchrow('delete from public.gmail_connections where owner_user_id=$1 returning refresh_token', user.id)
            await conn.execute('delete from public.gmail_context_previews where owner_user_id=$1', user.id)
            await conn.execute("delete from public.twin_source_context where owner_user_id=$1 and source='gmail'", user.id)
            await memory_service.sync_gmail(conn, user.id, None)
    revoked = True
    if connection:
        try:
            await request('POST', 'https://oauth2.googleapis.com/revoke', data={'token': decrypt(connection['refresh_token'])})
        except HTTPException:
            revoked = False
    return {'disconnected': True, 'revoked': revoked}
