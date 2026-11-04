import copy
import json
from contextlib import asynccontextmanager
from urllib.parse import urlparse, parse_qs
from uuid import uuid4
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.auth import CurrentUser, get_current_user
from app.integrations import gmail

class Store:
    def __init__(self):
        self.connection = self.state = self.preview = self.context = None
        self.fail_write = False
        self.agent = {'id': uuid4(), 'persona_md': 'Existing Claude memory', 'character_started': True}
    @asynccontextmanager
    async def transaction(self):
        snapshot = copy.deepcopy(self.__dict__)
        try: yield
        except Exception:
            self.__dict__.update(snapshot)
            raise
    async def fetchrow(self, sql, *args):
        if args[0] != 'owner': return None
        if 'from public.agents' in sql: return self.agent
        if 'delete from public.gmail_oauth_states' in sql:
            if self.state and self.state['hash'] == args[1]:
                result, self.state = self.state, None
                return result
            return None
        if 'insert into public.gmail_context_previews' in sql:
            self.preview = {'id': uuid4(), 'generation': args[1], 'context': args[2]}
            return self.preview
        if 'delete from public.gmail_context_previews' in sql:
            if self.preview and self.preview['id'] == args[1] and self.preview['generation'] == args[2]:
                result, self.preview = self.preview, None
                return result
            return None
        if 'delete from public.gmail_connections' in sql:
            result, self.connection = self.connection, None
            return result
        if 'from public.gmail_connections' in sql: return self.connection
        raise AssertionError(sql)
    async def fetchval(self, sql, *args):
        if args[0] != 'owner': return None
        if 'select generation' in sql: return self.connection['generation'] if self.connection else None
        if 'twin_source_context' in sql: return self.context
        raise AssertionError(sql)
    async def execute(self, sql, *args):
        if args[0] != 'owner':
            assert 'delete from' in sql
            return
        if 'insert into public.gmail_oauth_states' in sql: self.state = {'hash': args[1], 'verifier': args[2]}
        elif 'insert into public.gmail_connections' in sql:
            self.connection = {'refresh_token': args[1], 'generation': uuid4(), 'last_sync_at': None, 'last_error': None}
        elif 'delete from public.gmail_oauth_states' in sql: self.state = None
        elif 'delete from public.gmail_context_previews' in sql: self.preview = None
        elif 'insert into public.twin_source_context' in sql:
            if self.fail_write: raise RuntimeError('Synthetic DB failure')
            self.context = args[2]
        elif 'delete from public.twin_source_context' in sql: self.context = None
        elif 'update public.gmail_connections' in sql: pass
        else: raise AssertionError(sql)

@pytest.fixture
def setup(monkeypatch):
    for key, value in {'GOOGLE_GMAIL_CLIENT_ID': 'synthetic-client', 'GOOGLE_GMAIL_CLIENT_SECRET': 'synthetic-secret',
        'GOOGLE_GMAIL_REDIRECT_URI': 'http://localhost:3000/profile/gmail', 'GMAIL_TOKEN_ENCRYPTION_KEY': Fernet.generate_key().decode()}.items():
        monkeypatch.setenv(key, value)
    store = Store()
    @asynccontextmanager
    async def acquire(): yield store
    monkeypatch.setattr(gmail, 'acquire', acquire)
    async def sync_memory(conn, owner, context):
        assert owner == 'owner'
        store.memory_context = context
    async def analyze(owner):
        pass
    monkeypatch.setattr(gmail.memory_service, 'sync_gmail', sync_memory)
    monkeypatch.setattr(gmail.memory_service, 'analyze', analyze)
    calls = []
    async def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if 'token' in url: return {'access_token': 'synthetic-access', 'refresh_token': 'synthetic-refresh', 'scope': gmail.SCOPE}
        if url.endswith('messages'): return {'messages': []}
        return {}
    monkeypatch.setattr(gmail, 'request', request)
    app = FastAPI(); app.include_router(gmail.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser('owner', None, 'authenticated', {})
    with TestClient(app, raise_server_exceptions=False) as client: yield client, store, app, calls

P = '/api/integrations/gmail'
def connect(client):
    query = parse_qs(urlparse(client.post(P+'/connect').json()['url']).query)
    assert query['scope'] == [gmail.SCOPE] and query['code_challenge_method'] == ['S256']
    state = query['state'][0]
    assert client.post(P+'/callback', json={'state': state, 'code': 'synthetic-code'}).status_code == 200
    return state

def test_owner_bound_one_time_encrypted(setup):
    client, store, app, calls = setup
    state = connect(client)
    assert store.connection['refresh_token'] != 'synthetic-refresh'
    assert gmail.decrypt(store.connection['refresh_token']) == 'synthetic-refresh'
    assert client.post(P+'/callback', json={'state': state, 'code': 'synthetic-code'}).status_code == 400
    assert 'refresh_token' not in client.get(P).text
    app.dependency_overrides[get_current_user] = lambda: CurrentUser('other', None, 'authenticated', {})
    assert client.get(P).json()['connected'] is False
    assert client.post(P+'/preview', json={}).status_code == 409
    app.dependency_overrides.clear()
    assert client.get(P).status_code == 401

def test_preview_commit_refresh_disconnect_preserve_private_persona(setup):
    client, store, app, calls = setup
    connect(client)
    assert client.post(P+'/preview', json={'days': 91}).status_code == 422
    preview = client.post(P+'/preview', json={'days': 7}).json()
    assert store.context is None
    response = client.post(P+'/commit', json={'preview_id': preview['preview_id']})
    assert response.status_code == 200
    assert json.loads(store.context)['source'] == 'gmail'
    assert store.agent['persona_md'] == 'Existing Claude memory'
    assert client.post(P+'/commit', json={'preview_id': preview['preview_id']}).status_code == 409
    preview2 = client.post(P+'/preview', json={}).json()
    assert client.post(P+'/commit', json={'preview_id': preview2['preview_id']}).status_code == 200
    assert client.delete(P).json()['revoked']
    assert store.context is None and store.connection is None and store.preview is None
    assert any(url.endswith('/revoke') for _, url, _ in calls)

def test_cancel_and_rollback(setup):
    client, store, app, calls = setup
    connect(client)
    preview = client.post(P+'/preview', json={}).json()
    store.fail_write = True
    assert client.post(P+'/commit', json={'preview_id': preview['preview_id']}).status_code == 500
    assert store.preview is not None and store.context is None
    client.delete(P+'/preview')
    assert store.preview is None

def test_reconnect_invalidates_preview(setup):
    client, store, app, calls = setup
    connect(client)
    preview = client.post(P+'/preview', json={}).json()
    connect(client)
    assert client.post(P+'/commit', json={'preview_id': preview['preview_id']}).status_code == 409
