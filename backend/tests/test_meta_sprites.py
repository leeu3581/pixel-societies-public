"""Offline transport and production sprite pipeline validation."""
import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image
from app import meta_images, sprites


def png(color='teal', size=(64, 96)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, 'PNG')
    return buffer.getvalue()


def mock_api(monkeypatch, handler):
    monkeypatch.setenv('META_API_KEY', 'synthetic-key')
    factory = httpx.AsyncClient
    monkeypatch.setattr(meta_images.httpx, 'AsyncClient', lambda **kw:
        factory(transport=httpx.MockTransport(handler), **kw))


def test_meta_reference_wire_format_and_png_output(monkeypatch):
    photo, style = png(), png('red')
    def handler(request):
        assert str(request.url) == 'https://api.meta.ai/v1/images/edits'
        assert request.headers['authorization'] == 'Bearer synthetic-key'
        body = json.loads(request.content)
        assert body['model'] == 'muse-image-1.0'
        assert body['n'] == 1 and body['response_format'] == 'b64_json'
        assert body['tool_enablement'] == dict(enable_web_search=False, enable_image_search=False, enable_shell=False)
        assert len(body['images']) == 2
        assert base64.b64decode(body['images'][0]['image_url'].split(',')[1]) == photo
        assert base64.b64decode(body['images'][1]['image_url'].split(',')[1]) == style
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(photo).decode()}]})
    mock_api(monkeypatch, handler)
    result = asyncio.run(meta_images.generate_image('Synthetic test', [(photo, 'image/png'), (style, 'image/png')]))
    image = Image.open(io.BytesIO(result))
    assert image.format == 'PNG' and image.mode == 'RGBA'


@pytest.mark.parametrize('status,payload', [(429, {'error': 'private upstream text'}), (200, {'data': []}),
    (200, {'data': [{'b64_json': 'not base64'}]}), (200, {'data': [{'b64_json': base64.b64encode(b'not image').decode()}]})])
def test_meta_image_failure_no_retry_or_response_leak(monkeypatch, status, payload):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(status, json=payload)
    mock_api(monkeypatch, handler)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(meta_images.generate_image('Synthetic', [(png(), 'image/png')]))
    assert len(seen) == 1
    assert 'private upstream text' not in str(exc.value)


def test_no_gemini_fallback(monkeypatch):
    monkeypatch.delenv('META_API_KEY', raising=False)
    monkeypatch.setenv('GEMINI_API_KEY', 'must-not-use')
    with pytest.raises(RuntimeError, match='META_API_KEY'):
        asyncio.run(sprites.generate_portrait(png()))


def test_committed_references_resolve_in_checkout():
    for path in (sprites.PORTRAIT_REF, sprites.SHEET_REF):
        assert 'backend/public' not in str(path)
        with Image.open(path) as image:
            image.verify()


def test_all_sprite_stages_use_meta_and_preserve_grid(monkeypatch):
    calls = []
    async def fake_generate(prompt, inputs, **kwargs):
        calls.append((prompt, inputs, kwargs))
        # Synthetic stand-in response, explicitly NOT claimed as model output.
        image = Image.new('RGB', (400, 600), 'white')
        from PIL import ImageDraw
        draw = ImageDraw.Draw(image)
        for row in range(3):
            for col in range(4):
                draw.rectangle((col*100+30, row*200+30, col*100+70, row*200+180), fill='teal')
        output = io.BytesIO()
        image.save(output, 'PNG')
        return output.getvalue()
    monkeypatch.setattr(sprites, 'generate_image', fake_generate)
    async def run():
        portrait = await sprites.generate_portrait(png())
        sheet = await sprites.generate_spritesheet(portrait)
        edited = await sprites.regenerate_portrait_with_edits(portrait, ['Add glasses'])
        return portrait, sheet, edited
    portrait, sheet, edited = asyncio.run(run())
    assert len(calls) == 3
    assert len(calls[0][1]) == len(calls[1][1]) == 2
    assert calls[0][1][1][0] == sprites.PORTRAIT_REF.read_bytes()
    assert calls[1][1][0][0] == portrait
    assert calls[1][1][1][0] == sprites.SHEET_REF.read_bytes()
    assert calls[1][2]['size'] == '1024x1536'
    assert 'Add glasses' in calls[2][0] and len(calls[2][1]) == 1
    image = Image.open(io.BytesIO(sheet))
    assert image.size == (896, 1024) and image.mode == 'RGBA'
    assert image.getpixel((0, 0))[3] == 0
    from PIL import ImageChops, ImageOps
    right = image.crop((0, 256, 128, 512))
    left = image.crop((0, 512, 128, 768))
    # Centering can differ by one pixel for odd widths; the actual pose pixels match.
    assert ImageChops.difference(ImageOps.mirror(right.crop(right.getbbox())), left.crop(left.getbbox())).getbbox() is None


def test_grid_validation_rejects_missing_or_clipped_cells():
    with pytest.raises(RuntimeError, match='three separated rows'):
        sprites.pack_animation_sheet(png('teal', (400, 600)))
    image = Image.new('RGBA', (400, 600), (0, 0, 0, 0))
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    with pytest.raises(RuntimeError, match='three separated rows'):
        sprites.pack_animation_sheet(buffer.getvalue())
