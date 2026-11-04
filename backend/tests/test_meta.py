"""Synthetic, database-free tests. No real keys or provider network calls."""
import asyncio
import io
import json
import wave

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.meta import build_meta_model, analysis_cache_identity
from app.llm import build_model
from app.twin_memory.analysis import build_analysis_model
from app.twin_memory import voice


@pytest.fixture(autouse=True)
def config(monkeypatch):
    for key in ('META_API_KEY', 'META_MODEL', 'META_VOICE_ENABLED', 'LLM_PROVIDER',
                'LLM_DISABLED', 'TWIN_MEMORY_AI_ENABLED', 'PYDANTIC_AI_GATEWAY_API_KEY'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('META_API_KEY', 'synthetic-key')
    monkeypatch.setenv('LLM_PROVIDER', 'meta')


def wav(seconds=1, channels=1, rate=24000, width=2):
    data = io.BytesIO()
    with wave.open(data, 'wb') as clip:
        clip.setnchannels(channels)
        clip.setsampwidth(width)
        clip.setframerate(rate)
        clip.writeframes(b'\0' * (int(seconds*rate)*channels*width))
    return data.getvalue()


def test_explicit_meta_wins_over_azure_and_gateway(monkeypatch):
    monkeypatch.setenv('AZURE_OPENAI_ENDPOINT', 'https://unused.openai.azure.com/openai/v1/')
    monkeypatch.setenv('PYDANTIC_AI_GATEWAY_API_KEY', 'unused')
    model = build_model()
    assert model.model_name == 'muse-spark-1.3'
    assert str(model.client.base_url) == 'https://api.meta.ai/v1/'
    assert model.settings['openai_store'] is False
    assert model.client.max_retries == 0


def test_missing_meta_key_fails_closed(monkeypatch):
    monkeypatch.delenv('META_API_KEY')
    monkeypatch.setenv('OPENAI_API_KEY', 'must-not-fallback')
    with pytest.raises(RuntimeError, match='META_API_KEY'):
        build_model()


def test_private_opt_in_does_not_enable_global_agents(monkeypatch):
    from pydantic_ai import Agent
    monkeypatch.setenv('LLM_DISABLED', '1')
    monkeypatch.setenv('TWIN_MEMORY_AI_ENABLED', '1')
    assert build_analysis_model().model_name == 'muse-spark-1.3'
    with pytest.raises(RuntimeError, match='disabled'):
        Agent(build_model()).run_sync('No network permitted')


def test_contributor_mode_rejected_and_cache_tracks_model(monkeypatch):
    first = analysis_cache_identity()
    monkeypatch.setenv('META_MODEL', 'muse-wonder-1.0')
    assert analysis_cache_identity() != first
    monkeypatch.setenv('META_MODEL', 'muse-spark-1.3-contributor')
    with pytest.raises(RuntimeError, match='Standard-mode'):
        build_meta_model()


def test_cache_identity_changes_when_private_inference_disabled(monkeypatch):
    monkeypatch.setenv('TWIN_MEMORY_AI_ENABLED', '1')
    before = analysis_cache_identity()
    monkeypatch.setenv('TWIN_MEMORY_AI_ENABLED', '0')
    assert before != analysis_cache_identity()


def test_local_launcher_refuses_remote_database(monkeypatch):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).parents[1] / 'scripts/run_meta_backend.py'
    spec = importlib.util.spec_from_file_location('run_meta_backend_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'dotenv_values', lambda path: {})
    monkeypatch.setenv('SUPABASE_DB_URL', 'postgresql://synthetic:synthetic@remote.example.test/demo')
    with pytest.raises(RuntimeError, match='remote startup refused'):
        module.configure()


def test_local_launcher_keeps_paid_loops_off(monkeypatch):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).parents[1] / 'scripts/run_meta_backend.py'
    spec = importlib.util.spec_from_file_location('run_meta_backend_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'dotenv_values', lambda path: {})
    monkeypatch.setenv('SUPABASE_DB_URL', 'postgresql://synthetic:synthetic@127.0.0.1/demo')
    # Track these environment changes through monkeypatch so they are restored.
    import os
    for key in ('DISABLE_ENGINE_LOOP', 'DISABLE_SOCIETY_LOOP', 'TWIN_DISCOVERY_ENABLED', 'LOGFIRE_TOKEN', 'LOGFIRE_SEND_TO_LOGFIRE'):
        monkeypatch.setenv(key, '')
    module.configure()
    assert os.environ['LLM_DISABLED'] == '1'
    assert os.environ['DISABLE_ENGINE_LOOP'] == os.environ['DISABLE_SOCIETY_LOOP'] == '1'


def mock_text(monkeypatch, handler):
    import openai
    import httpx2
    factory = openai.AsyncOpenAI
    monkeypatch.setattr(openai, 'AsyncOpenAI', lambda **kw: factory(
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), **kw))


def test_native_schema_wire_and_citation_validation(monkeypatch):
    import httpx2
    from app.twin_memory.analysis import interpret
    from datetime import datetime, timezone
    seen = []
    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        assert request.url.path == '/v1/responses'
        assert body['store'] is False
        assert body['text']['format']['type'] == 'json_schema'
        assert not body.get('tools')
        assert body['reasoning']['effort'] == 'low'
        claim = {'kind': 'workstream', 'title': 'Synthetic project',
                 'summary': 'Building a tool for useful introductions.',
                 'evidence_ids': ['invented'], 'confidence': 'medium',
                 'uncertainty': 'Scope remains unknown.', 'topics': [], 'workstream': '', 'next_step': ''}
        good = {**claim, 'evidence_ids': ['synthetic-evidence']}
        return httpx2.Response(200, json={'id': 'resp_synthetic', 'object': 'response', 'created_at': 1,
            'status': 'completed', 'model': 'muse-spark-1.3', 'output': [{'type': 'message', 'id': 'msg_synthetic',
            'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'annotations': [],
            'text': json.dumps({'insights': [good, claim]})}]}],
            'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}})
    mock_text(monkeypatch, handler)
    monkeypatch.setenv('TWIN_MEMORY_AI_ENABLED', '1')
    output = asyncio.run(interpret([{'id': 'synthetic-evidence', 'text': 'Building a tool for useful introductions.',
        'observed_at': datetime.now(timezone.utc).isoformat(), 'source_ids': ['synthetic-source']}]))
    assert len(seen) == 1
    assert len(output['insights']) == 1
    assert output['insights'][0]['source_ids'] == ['synthetic-source']


def test_meta_http_failure_does_not_retry_or_fallback(monkeypatch):
    import httpx2
    from pydantic_ai import Agent
    from pydantic_ai.exceptions import ModelHTTPError
    seen = []
    def handler(request):
        seen.append(str(request.url))
        return httpx2.Response(429, json={'error': {'message': 'Synthetic quota exhausted', 'type': 'rate_limit_error'}})
    mock_text(monkeypatch, handler)
    with pytest.raises(ModelHTTPError):
        Agent(build_meta_model()).run_sync('Synthetic failure test')
    assert seen == ['https://api.meta.ai/v1/responses']


@pytest.mark.parametrize('audio', [b'not audio', wav(61), wav(channels=2), wav(rate=44100), wav(width=1), wav()[:-10]])
def test_reject_invalid_audio(audio):
    with pytest.raises(ValueError):
        voice.validate_wav(audio)


def test_voice_disabled_before_network():
    with pytest.raises(HTTPException) as error:
        asyncio.run(voice.transcribe(wav()))
    assert error.value.status_code == 503


def mock_voice(monkeypatch, handler):
    factory = httpx.AsyncClient
    monkeypatch.setenv('META_VOICE_ENABLED', '1')
    monkeypatch.setattr(voice.httpx, 'AsyncClient', lambda **kw: factory(transport=httpx.MockTransport(handler), **kw))


def test_voice_wire_format_and_redacted_preview(monkeypatch):
    def handler(request):
        assert str(request.url) == 'https://api.meta.ai/v1/asr/transcribe'
        assert request.headers['authorization'] == 'Bearer synthetic-key'
        body = request.content
        assert b'name="request"' in body and b'name="audio"' in body
        assert b'"audioEncoding": "WAV"' in body and b'"mode": "PUSH_TO_TALK"' in body
        assert b'muse-voice-transcribe-1.0' in body
        return httpx.Response(200, json={'transcript': 'I study first conversations. Contact private@example.test.',
            'sessionId': 'synthetic', 'audioDurationMs': 1000, 'turns': []})
    mock_voice(monkeypatch, handler)
    output = asyncio.run(voice.transcribe(wav()))
    assert 'private@example.test' not in output['text']
    assert output['duration_ms'] == 1000
    assert set(output) == {'text', 'model', 'duration_ms'}


@pytest.mark.parametrize('status,payload,expected', [
    (429, {'error': 'secret upstream detail'}, 502),
    (200, {'transcript': ''}, 422),
    (200, {'transcript': 123}, 502),
    (200, {'unexpected': 'shape'}, 502),
])
def test_voice_failure_is_safe(monkeypatch, status, payload, expected):
    mock_voice(monkeypatch, lambda request: httpx.Response(status, json=payload))
    with pytest.raises(HTTPException) as error:
        asyncio.run(voice.transcribe(wav()))
    assert error.value.status_code == expected
    assert 'secret upstream detail' not in str(error.value.detail)


def test_voice_route_requires_authentication():
    from app.twin_memory.routes import router
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        response = client.post('/api/me/memory/voice/transcribe', files={'audio': ('clip.wav', wav(), 'audio/wav')})
    assert response.status_code in (401, 403)


def test_voice_route_has_no_persistence(monkeypatch):
    from app.auth import get_current_user
    from app.twin_memory.routes import router
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: object()
    mock_voice(monkeypatch, lambda request: httpx.Response(200, json={'transcript': 'I want to study why first conversations stall.'}))
    # No DB pool is initialized. This would fail if transcription saved anything.
    with TestClient(app) as client:
        response = client.post('/api/me/memory/voice/transcribe', files={'audio': ('clip.wav', wav(), 'audio/wav')})
    assert response.status_code == 200
    assert response.json()['text'].startswith('I want')
