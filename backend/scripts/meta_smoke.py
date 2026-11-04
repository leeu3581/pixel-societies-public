"""Bounded live Meta check. Synthetic data only; never imports the app or database."""
import asyncio
import json
import os
from pathlib import Path
import sys

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from app.meta import META_BASE_URL, api_key, text_model, DEFAULT_VOICE_MODEL


def load_meta_config():
    # Deliberately read ONLY these keys. Never import a stored remote DB URL.
    for path in [ROOT/'.env', ROOT/'.env.local', ROOT/'backend/.env', ROOT/'backend/.env.local']:
        if path.is_file():
            values = dotenv_values(path)
            for name in ('META_API_KEY', 'META_MODEL'):
                if values.get(name) and not os.getenv(name):
                    os.environ[name] = values[name]


async def smoke():
    load_meta_config()
    key = api_key()
    model = text_model()
    async with httpx.AsyncClient(timeout=50, follow_redirects=False) as client:
        headers = {'Authorization': 'Bearer '+key}
        catalog = await client.get(META_BASE_URL+'models', headers=headers)
        catalog.raise_for_status()
        available = sorted(item['id'] for item in catalog.json()['data'])
        print(json.dumps({'check': 'account_models', 'models': available}))
        if model not in available:
            raise RuntimeError('Configured text model is not available to this account')
        response = await client.post(META_BASE_URL+'responses', headers=headers, json={
            'model': model, 'store': False, 'max_output_tokens': 1200,
            'reasoning': {'effort': 'low'},
            'input': 'Synthetic smoke test: return status ok and evidence_ids containing only synthetic-1.',
            'text': {'format': {'type': 'json_schema', 'name': 'Smoke', 'strict': True,
                'schema': {'type': 'object', 'properties': {
                    'status': {'type': 'string', 'enum': ['ok']},
                    'evidence_ids': {'type': 'array', 'items': {'type': 'string'}}},
                    'required': ['status', 'evidence_ids'], 'additionalProperties': False}}}})
        response.raise_for_status()
        body = response.json()
        if body.get('status') != 'completed':
            raise RuntimeError('Incomplete Meta response')
        content = ''.join(part['text'] for item in body.get('output', []) if item.get('type') == 'message'
                          for part in item.get('content', []) if part.get('type') == 'output_text')
        output = json.loads(content)
        if output != {'status': 'ok', 'evidence_ids': ['synthetic-1']}:
            raise RuntimeError('Structured synthetic output did not validate')
        print(json.dumps({'check': 'structured_smoke', 'status': 'passed', 'model': body.get('model'),
                          'voice_available': DEFAULT_VOICE_MODEL in available, 'usage': body.get('usage')}))


if __name__ == '__main__':
    try:
        asyncio.run(smoke())
    except Exception as exc:
        # SDK/HTTP exception strings can contain response bodies. Never print them.
        status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
        print(json.dumps({'status': 'failed', 'error_type': type(exc).__name__, 'http_status': status}))
        sys.exit(1)
