"""Ephemeral voice preview. Saving and sharing remain explicit existing actions."""
import asyncio
import io
import json
import os
import wave

import httpx
from fastapi import HTTPException
from opentelemetry.instrumentation.utils import suppress_instrumentation

from ..integrations.gmail_context import clean
from ..meta import META_BASE_URL, DEFAULT_VOICE_MODEL, api_key

MAX_AUDIO_BYTES = 3_000_000
MAX_SECONDS = 60
_SLOTS = asyncio.Semaphore(2)


def validate_wav(audio: bytes) -> int:
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise ValueError('Use a WAV recording of at most 60 seconds and 3 MB.')
    try:
        with wave.open(io.BytesIO(audio), 'rb') as clip:
            rate = clip.getframerate()
            frames = clip.getnframes()
            if (clip.getnchannels() != 1 or clip.getsampwidth() != 2
                    or rate not in (16000, 24000) or clip.getcomptype() != 'NONE'
                    or frames <= 0 or frames > rate * MAX_SECONDS):
                raise ValueError('Use mono PCM16 WAV at 16 or 24 kHz, at most 60 seconds.')
            if len(clip.readframes(frames)) != frames * 2:
                raise ValueError('The WAV recording is incomplete.')
            return round(frames * 1000 / rate)
    except (wave.Error, EOFError) as exc:
        raise ValueError('The recording must be a valid PCM WAV file.') from exc


async def transcribe(audio: bytes) -> dict:
    # This separate opt-in does not enable unrelated paid agent loops.
    if os.getenv('META_VOICE_ENABLED', '').strip() != '1':
        raise HTTPException(503, 'Voice updates are disabled.')
    try:
        key = api_key()
    except RuntimeError:
        raise HTTPException(503, 'Voice updates are not configured.') from None
    try:
        duration = validate_wav(audio)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    settings = {'model': DEFAULT_VOICE_MODEL, 'audioEncoding': 'WAV', 'mode': 'PUSH_TO_TALK'}
    # Never log raw audio, transcript, credentials or upstream error bodies.
    try:
        async with asyncio.timeout(55), _SLOTS:
            with suppress_instrumentation():
                async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
                    response = await client.post(META_BASE_URL+'asr/transcribe',
                        headers={'Authorization': 'Bearer '+key, 'Accept': 'application/json'},
                        files={'request': (None, json.dumps(settings), 'application/json'),
                               'audio': ('update.wav', audio, 'audio/wav')})
                    response.raise_for_status()
                    payload = response.json()
    except (httpx.HTTPError, TimeoutError, ValueError):
        raise HTTPException(502, 'Meta transcription is unavailable. Please try again.') from None
    if not isinstance(payload, dict) or not isinstance(payload.get('transcript'), str):
        raise HTTPException(502, 'Meta returned an invalid transcript.')
    text = clean(payload['transcript']).strip()
    if not 10 <= len(text) <= 4000:
        raise HTTPException(422, 'Record a clear update between 10 and 4000 text characters.')
    return {'text': text, 'model': DEFAULT_VOICE_MODEL, 'duration_ms': duration}
