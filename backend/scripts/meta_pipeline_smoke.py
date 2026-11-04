"""Opt-in live synthetic pipeline; no app startup, DB, fixtures or publication writes.

Run after meta_smoke.py. At most four text stages plus one optional voice call.
Printed outputs are real model responses to explicitly fictional synthetic evidence.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from meta_smoke import load_meta_config, ROOT
sys.path.insert(0, str(ROOT/'backend'))


async def run(audio_path=None):
    load_meta_config()
    os.environ.update(LLM_PROVIDER='meta', TWIN_MEMORY_AI_ENABLED='1', LLM_DISABLED='1',
                      META_VOICE_ENABLED='1', DISABLE_ENGINE_LOOP='1', DISABLE_SOCIETY_LOOP='1')
    from app.twin_memory.analysis import evidence_from_sources, interpret
    from app.twin_memory.wiki import synthesize
    from app.twin_memory.matching import rank_published, _CACHE
    from app.twin_memory.voice import transcribe
    now = datetime.now(timezone.utc).isoformat()
    initial_text = 'I am building Pixel Societies, a tool that uses approved work context to explain useful introductions. I am currently implementing the graph and evidence panel.'
    sources = [{'id': 'synthetic-session', 'kind': 'claude_code', 'created_at': now,
                'payload': {'profile': {}, 'excerpts': [{'role': 'user', 'text': initial_text, 'ts': now, 'project': 'Pixel Societies'}]}}]
    evidence = evidence_from_sources(sources)
    analysis = await interpret(evidence)
    print(json.dumps({'stage': 'interpretation', 'synthetic': True, 'insights': analysis['insights']}), flush=True)
    if not analysis['insights']:
        raise RuntimeError('No grounded insights returned')
    assert all(set(i['evidence_ids']) <= {e['id'] for e in evidence} for i in analysis['insights'])
    # Approval below is only a harness simulation over synthetic data, never a user approval.
    approved = [{**i, 'review': 'confirm'} for i in analysis['insights'] if i['kind'] != 'question']
    wiki = await synthesize(approved)
    print(json.dumps({'stage': 'wiki', 'synthetic': True, 'wiki': wiki}), flush=True)
    if not wiki['concepts']:
        raise RuntimeError('No cited wiki concepts returned')
    def part(id, person, text):
        return {'id': id, 'owner_user_id': person, 'purpose': 'profile', 'kind': 'workstream', 'body': text, 'topics': []}
    peers = [part('synthetic-research', 'fictional-researcher', 'I interview founders about promising first conversations that never become collaborations. I study follow-through and design interview questions about what happened after introductions.'),
             part('synthetic-engineering', 'fictional-engineer', 'I build graph interfaces that show the evidence behind recommendations. I have implemented provenance panels and graph navigation for research tools.')]
    mine = [part('synthetic-own', 'fictional-owner', initial_text)]
    _CACHE.clear()
    before = await rank_published(mine, peers)
    print(json.dumps({'stage': 'before', 'synthetic': True, 'model': os.getenv('META_MODEL', 'muse-spark-1.3'),
                      'insights': analysis['insights'], 'wiki': wiki,
                      'connections': [{'ids': list(k), **v} for k,v in before.items()]}, ensure_ascii=False))
    if audio_path:
        preview = await transcribe(Path(audio_path).read_bytes())
        print(json.dumps({'stage': 'voice_preview', 'synthetic': True, **preview}))
        # Simulate the user's edited/approved publication, using the actual transcript.
        mine = [part('synthetic-own-updated', 'fictional-owner', preview['text'])]
        after = await rank_published(mine, peers)
        if not after:
            raise RuntimeError('No connection after synthetic voice update')
        print(json.dumps({'stage': 'after_simulated_review_and_share', 'synthetic': True,
                          'connections': [{'ids': list(k), **v} for k,v in after.items()]}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--synthetic-wav', type=Path, help='Optional synthetic speech only, <=60 seconds PCM16 WAV')
    args = parser.parse_args()
    try:
        asyncio.run(asyncio.wait_for(run(args.synthetic_wav), timeout=240))
    except Exception as exc:
        body = getattr(exc, 'body', None)
        error = body.get('error', {}) if isinstance(body, dict) else {}
        print(json.dumps({'status': 'failed', 'error_type': type(exc).__name__,
                          'http_status': getattr(exc, 'status_code', None),
                          'error_code': error.get('code'), 'error_param': error.get('param'),
                          'check': str(exc) if str(exc) in {'No grounded insights returned', 'No cited wiki concepts returned',
                              'No connection after synthetic voice update'} else None}))
        sys.exit(1)
