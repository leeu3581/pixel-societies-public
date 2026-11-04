"""Live synthetic reference-image smoke; no database or object storage writes."""
import argparse
import asyncio
import hashlib
import io
import json
from pathlib import Path
import sys
import time

from meta_smoke import load_meta_config, ROOT
sys.path.insert(0, str(ROOT/'backend'))
from PIL import Image
from app.meta_images import generate_image, IMAGE_MODEL
from app.sprites import generate_portrait, generate_spritesheet


async def run(stage, directory):
    load_meta_config()
    directory.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if stage == 'reference':
        result = await generate_image('A studio headshot photograph of a fictional adult with short curly auburn hair, '
            'round dark glasses and a teal crew-neck sweater. Warm medium skin tone. Front facing, neutral friendly '
            'expression, shoulders visible, plain pale gray background. This is a synthetic test identity, not a real person. '
            'No text or logos.', [], size='1024x1024')
    elif stage == 'portrait':
        result = await generate_portrait((directory/'reference.png').read_bytes())
    else:
        from app import sprites
        original = sprites.generate_image
        async def capture(*args, **kwargs):
            raw = await original(*args, **kwargs)
            (directory/'sheet-raw.png').write_bytes(raw)
            return raw
        sprites.generate_image = capture
        result = await generate_spritesheet((directory/'portrait.png').read_bytes())
    target = directory / (stage+'.png')
    target.write_bytes(result)
    image = Image.open(io.BytesIO(result)).convert('RGBA')
    report = {'stage': stage, 'model': IMAGE_MODEL, 'synthetic': True, 'seconds': round(time.monotonic()-started, 2),
              'size': list(image.size), 'sha256': hashlib.sha256(result).hexdigest(), 'path': str(target)}
    if stage == 'sheet':
        assert image.size == (896, 1024)
        counts = []
        for row in range(4):
            for col in range(7):
                alpha = image.crop((col*128, row*256, (col+1)*128, (row+1)*256)).getchannel('A')
                counts.append(sum(alpha.histogram()[129:]))
        assert all(100 < count < 128*256*0.9 for count in counts), 'Empty or opaque sprite cell'
        report['cell_foreground_pixels'] = counts
    (directory/(stage+'.json')).write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['reference', 'portrait', 'sheet'])
    parser.add_argument('--output-dir', type=Path, default=ROOT/'backend/data/meta-sprite-smoke')
    args = parser.parse_args()
    try:
        asyncio.run(run(args.stage, args.output_dir))
    except Exception as exc:
        print(json.dumps({'status': 'failed', 'error_type': type(exc).__name__,
                          'message': str(exc) if isinstance(exc, RuntimeError) else None}))
        sys.exit(1)
