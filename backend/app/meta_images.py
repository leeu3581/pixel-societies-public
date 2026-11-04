"""Meta's documented image API. Reference bytes stay out of logs and storage."""
import asyncio
import base64
import binascii
import io

import httpx
from PIL import Image, UnidentifiedImageError
from opentelemetry.instrumentation.utils import suppress_instrumentation

from .meta import META_BASE_URL, api_key

IMAGE_MODEL = 'muse-image-1.0'
IMAGE_TIMEOUT_SECONDS = 180
MAX_IMAGE_BYTES = 20_000_000


async def generate_image(prompt: str, inputs: list[tuple[bytes, str]], *, size='1024x1536') -> bytes:
    """One image per call, no automatic paid retries or provider fallback.

    Meta-specific JSON images[].image_url format (not OpenAI multipart).
    Images endpoint size specifies aspect ratio; caller normalizes exact dimensions.
    """
    key = api_key()
    if not prompt.strip() or len(inputs) > 4:
        raise ValueError('Provide a prompt and at most four reference images.')
    for data, mime in inputs:
        if not data or len(data) > MAX_IMAGE_BYTES or mime not in ('image/png', 'image/jpeg', 'image/webp'):
            raise ValueError('Invalid image reference.')
    body = {'model': IMAGE_MODEL, 'prompt': prompt, 'n': 1, 'size': size,
            'response_format': 'b64_json', 'output_format': 'png', 'reasoning_strength': 'low',
            'tool_enablement': {'enable_image_search': False, 'enable_web_search': False, 'enable_shell': False}}
    endpoint = 'images/generations'
    if inputs:
        endpoint = 'images/edits'
        body['images'] = [{'image_url': f'data:{mime};base64,'+base64.b64encode(data).decode('ascii')}
                          for data, mime in inputs]
    try:
        async with asyncio.timeout(IMAGE_TIMEOUT_SECONDS):
            with suppress_instrumentation():
                async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT_SECONDS, follow_redirects=False) as client:
                    response = await client.post(META_BASE_URL+endpoint,
                        headers={'Authorization': 'Bearer '+key}, json=body)
                    response.raise_for_status()
                    payload = response.json()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f'Meta image request failed (HTTP {exc.response.status_code}).') from None
    except (httpx.HTTPError, TimeoutError, ValueError):
        raise RuntimeError('Meta image request failed or timed out.') from None
    try:
        encoded = payload['data'][0]['b64_json']
        if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 4:
            raise ValueError('Invalid size')
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if not 0 < image.width * image.height <= 16_000_000:
                raise ValueError('Invalid dimensions')
            image.load()
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
            return output.getvalue()
    except (KeyError, IndexError, TypeError, ValueError, binascii.Error, OSError, UnidentifiedImageError):
        raise RuntimeError('Meta returned no valid image.') from None
