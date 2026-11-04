"""Two-step pixel-art sprite generation via Meta Muse Image 1.0.

Pipeline (run as a FastAPI BackgroundTask):

  Step 1 — photo + simple pixel art reference → pixel portrait
    upload to sprites/{user_id}/{agent_id}/portrait-{ms}.png
    UPDATE public.agents SET portrait_url = <url>

  Step 2 — portrait + canonical sheet-layout reference → full sprite sheet
    upload to sprites/{user_id}/{agent_id}/sheet-{ms}.png
    UPDATE public.agents SET sprite_sheet_url = <url>

If step 1 fails the whole run aborts. If step 2 fails the portrait is
already persisted — the agent has a working avatar; the user can re-roll
the sheet later.

Logfire breadcrumbs:
  sprite_meta_call           — about to hit the API
  sprite_done   stage=portrait — step 1 finished
  sprite_done   stage=sheet    — step 2 finished
  sprite_failed stage=...      — step 1 or step 2 errored
"""
from __future__ import annotations

import io
import os
import time
from pathlib import Path

# Register HEIC/HEIF support so PIL.Image.open handles iPhone photos.
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

import httpx
import logfire
from PIL import Image, ImageOps

from .db import acquire
from .observability import (
    log_sprite_done,
    log_sprite_failed,
)

from .meta_images import IMAGE_MODEL, generate_image

# Per-agent in-process error cache so the polling status endpoint can
# surface a useful message. Cleared on success / on each new attempt.
SPRITE_FAILURES: dict[str, str] = {}

# Local checkout has backend/app; the Docker image has /app/app and /public.
_REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents
                  if (parent / "public" / "characters" / "refs").is_dir())
PORTRAIT_REF = _REPO_ROOT / "public" / "characters" / "refs" / "portrait.png"
SHEET_REF = _REPO_ROOT / "public" / "characters" / "refs" / "sheet.png"

# Image 1 supplies identity; image 2 supplies pixel style only.
PROMPT_PORTRAIT = (
    "Image 1 is the identity reference. Image 2 is pixel-art style only. "
    "Create one full-body pixel art character of the person in image 1, matching "
    "the style of the pixel reference image. Small body, minimal detail, "
    "classic RPG sprite proportions. Preserve hair, skin tone and clothing colors "
    "from image 1. Show the entire head and both feet with empty margin. "
    "No text, grid lines or cast shadows. Solid white background."
)

PROMPT_SHEET = (
    "Image 1 is the character identity. Image 2 is style only, NOT its layout. "
    "Create a spritesheet of the character in image 1 in the style of the reference "
    "image. Simple pixel art, small body, minimal detail. "
    "Exactly FOUR equal columns and THREE equal rows: TWELVE character poses total. "
    "Every row must contain exactly four characters. One entire character per cell, "
    "with consistent baseline and at least 10 percent empty margin inside each cell. "
    "No grid lines, labels or shadows. Row 1: four idle poses facing forward. "
    "Row 2: four DIFFERENT walking keyframes, all facing RIGHT: "
    "right leg forward, legs passing together, left leg forward, legs passing together. "
    "Make the leg and arm positions visibly different in consecutive cells. "
    "Row 3: four emote poses facing forward: wave, nod, surprised, thinking. "
    "Maintain consistent character proportions across all frames. "
    "Solid white background."
)

_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


# ── Failure cache helpers ─────────────────────────────────────────────


def get_sprite_failure(agent_id: str) -> str | None:
    return SPRITE_FAILURES.get(agent_id)


def clear_sprite_failure(agent_id: str) -> None:
    SPRITE_FAILURES.pop(agent_id, None)


def set_sprite_failure(agent_id: str, error: str) -> None:
    SPRITE_FAILURES[agent_id] = error[:500]


# ── Image helpers ─────────────────────────────────────────────────────


def preprocess_photo(photo_bytes: bytes, max_edge: int = 896) -> bytes:
    """Step 1 input. Resize so the longest edge ≤ max_edge px, re-encode
    JPEG q88. Keeps the Meta payload small + masks aspect-ratio quirks
    in random user uploads."""
    img = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
    w, h = img.size
    longest = max(w, h)
    if longest > max_edge:
        scale = max_edge / longest
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _read_ref(path: Path) -> tuple[bytes, str]:
    """Load a reference image as-is and infer its MIME type from the
    suffix. References are committed assets so we don't resize them."""
    mime = _MIME_BY_SUFFIX.get(path.suffix.lower(), "image/png")
    return path.read_bytes(), mime


def chroma_key_white(png_bytes: bytes, threshold: int = 245) -> bytes:
    """Make near-white pixels fully transparent so the character
    composites cleanly onto Phaser scenes (and onto the brutalist
    profile panel) instead of sitting in a white box. Preserves
    dimensions; only the alpha channel changes."""
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                px[x, y] = (r, g, b, 0)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _color_distance(c1: tuple[int, ...], c2: tuple[int, ...]) -> float:
    """Euclidean distance between two RGB tuples."""
    return sum((a - b) ** 2 for a, b in zip(c1[:3], c2[:3])) ** 0.5


def chroma_key_adaptive(png_bytes: bytes, tolerance: int = 40) -> bytes:
    """Remove background by detecting the dominant corner color.

    Handles white, magenta, black, or any solid-color background that
    the image model might produce. Samples all four corners, picks the most
    common color, then makes all pixels within `tolerance` distance
    of that color fully transparent.
    """
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    px = img.load()
    w, h = img.size

    # Sample corners (RGB only, ignore alpha).
    corners = [
        px[0, 0][:3],
        px[w - 1, 0][:3],
        px[0, h - 1][:3],
        px[w - 1, h - 1][:3],
    ]
    # Pick the most common corner color.
    from collections import Counter
    # Group by proximity (corners may differ slightly).
    groups: list[list[tuple[int, ...]]] = []
    for c in corners:
        placed = False
        for g in groups:
            if _color_distance(c, g[0]) < 30:
                g.append(c)
                placed = True
                break
        if not placed:
            groups.append([c])
    groups.sort(key=len, reverse=True)
    bg_color = groups[0][0]

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if _color_distance((r, g, b), bg_color) < tolerance:
                px[x, y] = (r, g, b, 0)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def normalize_sheet_grid(
    png_bytes: bytes,
    cols: int = 7,
    rows: int = 4,
    frame_w: int = 128,
    frame_h: int = 256,
) -> bytes:
    """Force a generated spritesheet into a clean, uniform grid.

    Generated spritesheets can have inconsistent frame sizes and alignment.
    This function:
    1. Divides the source image into a grid (cols × rows)
    2. Extracts each cell
    3. Resizes to exactly frame_w × frame_h
    4. Recomposes onto a clean transparent-background grid

    The output is deterministic: always cols*frame_w × rows*frame_h.
    """
    src = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    src_w, src_h = src.size
    cell_w = src_w / cols
    cell_h = src_h / rows

    out = Image.new("RGBA", (cols * frame_w, rows * frame_h), (0, 0, 0, 0))

    for row in range(rows):
        for col in range(cols):
            x0 = round(col * cell_w)
            y0 = round(row * cell_h)
            x1 = round((col + 1) * cell_w)
            y1 = round((row + 1) * cell_h)
            cell = src.crop((x0, y0, x1, y1))
            cell = cell.resize((frame_w, frame_h), Image.LANCZOS)
            out.paste(cell, (col * frame_w, row * frame_h))

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


async def generate_portrait(photo_bytes: bytes) -> bytes:
    """Step 1: photo → pixel character portrait. Chroma-keys the
    background so the character has a transparent alpha channel."""
    photo = preprocess_photo(photo_bytes)
    raw = await generate_image(
        PROMPT_PORTRAIT,
        [(photo, "image/jpeg"), _read_ref(PORTRAIT_REF)],
    )
    return chroma_key_adaptive(raw)


async def generate_spritesheet(portrait_bytes: bytes) -> bytes:
    """Generate 4×3 source poses, then pack the existing 7×4 client layout.

    Four walk poses are mirrored for leftward movement. Three unused/padding
    columns repeat the row's first poses. Do not ask a model for 28 aligned cells.
    """
    raw = await generate_image(
        PROMPT_SHEET,
        [(portrait_bytes, "image/png"), _read_ref(SHEET_REF)],
        size="1024x1536",
    )
    keyed = chroma_key_adaptive(raw)
    return pack_animation_sheet(keyed)


def _pose_bands(alpha: Image.Image, *, horizontal: bool) -> list[tuple[int, int]]:
    """Locate separated foreground bands, ignoring tiny specks and tiny gaps."""
    length, cross = (alpha.height, alpha.width) if horizontal else (alpha.width, alpha.height)
    active = []
    for index in range(length):
        line = alpha.crop((0, index, alpha.width, index+1) if horizontal
                          else (index, 0, index+1, alpha.height))
        if sum(line.histogram()[129:]) > max(3, cross*0.005):
            active.append(index)
    bands = []
    for index in active:
        if bands and index-bands[-1][1] <= max(2, round(length*0.004)):
            bands[-1] = (bands[-1][0], index+1)
        else:
            bands.append((index, index+1))
    return [(start, end) for start, end in bands if end-start >= length*0.04]


def pack_animation_sheet(keyed_png: bytes) -> bytes:
    """Extract 12 separated poses, then align them to the client's exact grid.

    Model-generated gutters are not uniform. Detect real whitespace instead of
    cutting at mathematical thirds, which can slice through a character's feet.
    """
    src = Image.open(io.BytesIO(keyed_png)).convert('RGBA')
    row_bands = _pose_bands(src.getchannel('A'), horizontal=True)
    if len(row_bands) != 3:
        raise RuntimeError('Meta sprite grid must contain three separated rows; retry the sheet.')
    poses = []
    for top, bottom in row_bands:
        strip = src.crop((0, top, src.width, bottom))
        columns = _pose_bands(strip.getchannel('A'), horizontal=False)
        if len(columns) != 4:
            raise RuntimeError('Meta sprite grid must contain four separated poses per row; retry the sheet.')
        frames = []
        for left, right in columns:
            cell = strip.crop((left, 0, right, strip.height))
            alpha = cell.getchannel('A')
            solid = alpha.point(lambda value: 255 if value > 128 else 0)
            box = solid.getbbox()
            if not box:
                raise RuntimeError('Meta sprite grid contains an empty pose; retry the sheet.')
            frames.append(cell.crop(box))
        poses.append(frames)
    # Common scale preserves proportions; consistent floor prevents vertical jitter.
    scale = min(108/max(p.width for row in poses for p in row),
                232/max(p.height for row in poses for p in row))
    out = Image.new('RGBA', (896, 1024), (0, 0, 0, 0))
    for row, source_row in enumerate((0, 1, 1, 2)):
        for col in range(7):
            pose = poses[source_row][col % 4]
            if row == 2:
                pose = ImageOps.mirror(pose)
            pose = pose.resize((max(1, round(pose.width*scale)), max(1, round(pose.height*scale))), Image.Resampling.NEAREST)
            out.paste(pose, (col*128+(128-pose.width)//2, row*256+244-pose.height))
    result = io.BytesIO()
    out.save(result, 'PNG')
    return result.getvalue()


async def regenerate_portrait_with_edits(
    original_portrait: bytes,
    edits: list[str],
) -> bytes:
    """Re-generate a portrait with modifications (add glasses, change
    hair color, etc.). The original portrait is passed as context so
    Meta preserves the character while applying the requested edits."""
    edit_text = "; ".join(edits)
    prompt = (
        f"Modify this pixel character: {edit_text}. "
        "Keep the same face, body proportions, and simple pixel art style. "
        "Small body, minimal detail. White background."
    )
    raw = await generate_image(prompt, [(original_portrait, "image/png")])
    return chroma_key_adaptive(raw)


# ── Object storage upload (Azure Blob, with Supabase fallback) ────────


async def _upload_azure_blob(
    object_path: str, content: bytes, content_type: str
) -> str:
    """PUT bytes into the public Azure Blob `sprites` container via a
    container SAS. Returns the public blob URL. Same object_path layout as
    before ({user_id}/{agent_id}/...), so migrated URLs only swap the base."""
    account = os.environ["AZURE_STORAGE_ACCOUNT"]
    sas = os.environ["AZURE_STORAGE_SPRITES_SAS"].lstrip("?")
    container = os.environ.get("AZURE_STORAGE_SPRITES_CONTAINER", "sprites")
    public_base = f"https://{account}.blob.core.windows.net/{container}"
    url = f"{public_base}/{object_path}?{sas}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            url,
            content=content,
            headers={
                "x-ms-blob-type": "BlockBlob",
                "Content-Type": content_type,
            },
        )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"blob http {resp.status_code}: {resp.text[:200]}")
    return f"{public_base}/{object_path}"


async def _upload_supabase(
    object_path: str, content: bytes, content_type: str
) -> str:
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not service_key:
        raise RuntimeError("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set")
    url = f"{base}/storage/v1/object/sprites/{object_path}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.put(
            url,
            content=content,
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": content_type,
                "x-upsert": "true",
            },
        )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"storage http {resp.status_code}: {resp.text[:200]}")
    return f"{base}/storage/v1/object/public/sprites/{object_path}"


async def upload_storage_object(
    object_path: str,
    content: bytes,
    content_type: str,
) -> str:
    """PUT bytes into the public sprites store, return the public URL.
    Uses Azure Blob when AZURE_STORAGE_ACCOUNT is set; else Supabase."""
    if os.environ.get("AZURE_STORAGE_ACCOUNT"):
        return await _upload_azure_blob(object_path, content, content_type)
    return await _upload_supabase(object_path, content, content_type)


async def _upload_versioned(
    user_id: str, agent_id: str, kind: str, png_bytes: bytes
) -> str:
    version = int(time.time() * 1000)
    return await upload_storage_object(
        f"{user_id}/{agent_id}/{kind}-{version}.png",
        png_bytes,
        "image/png",
    )


async def upload_profile_photo(user_id: str, agent_id: str, photo_bytes: bytes) -> str:
    """Persist the real onboarding photo and store its public URL on the
    user's profile."""
    photo_small = preprocess_photo(photo_bytes, max_edge=1280)
    public_url = await upload_storage_object(
        f"{user_id}/{agent_id}/photo.jpg",
        photo_small,
        "image/jpeg",
    )
    async with acquire() as conn:
        await conn.execute(
            "update public.profiles set photo_url = $1, updated_at = now() where id = $2",
            public_url,
            user_id,
        )
    return public_url


# ── Top-level entry point ─────────────────────────────────────────────


async def generate_and_persist_sprite(
    *, user_id: str, agent_id: str, photo_bytes: bytes
) -> None:
    """Run both steps end-to-end. Designed to be invoked from a FastAPI
    BackgroundTask so the HTTP handler can return 202 fast.

    The whole pipeline runs inside one logfire span so the httpx /
    asyncpg sub-events have a parent to attach to (BackgroundTasks run
    after the request span closes)."""
    with logfire.span(
        "sprite_pipeline",
        user_id=user_id,
        agent_id=agent_id,
        input_bytes=len(photo_bytes),
    ):
        clear_sprite_failure(agent_id)

        # Step 1 — portrait
        step_started = time.monotonic()
        logfire.info(
            "sprite_meta_call", model=IMAGE_MODEL,
            user_id=user_id, agent_id=agent_id, photo_bytes=len(photo_bytes)
        )
        try:
            portrait_png = await generate_portrait(photo_bytes)
        except Exception as e:  # noqa: BLE001
            log_sprite_failed(
                user_id=user_id, agent_id=agent_id, stage="portrait", error=str(e)
            )
            set_sprite_failure(
                agent_id,
                "Portrait generation failed. Try again with a clear, "
                "front-facing photo.",
            )
            return

        try:
            portrait_url = await _upload_versioned(
                user_id, agent_id, "portrait", portrait_png
            )
            async with acquire() as conn:
                await conn.execute(
                    "update public.agents "
                    "set portrait_url = $1, updated_at = now() "
                    "where id = $2",
                    portrait_url,
                    agent_id,
                )
        except Exception as e:  # noqa: BLE001
            log_sprite_failed(
                user_id=user_id, agent_id=agent_id, stage="portrait_persist",
                error=str(e),
            )
            set_sprite_failure(agent_id, "Portrait save failed. Try again.")
            return

        log_sprite_done(
            user_id=user_id,
            agent_id=agent_id,
            storage_url=portrait_url,
            source="portrait",
            duration_ms=int((time.monotonic() - step_started) * 1000),
        )

        # Step 2 — full sprite sheet
        step_started = time.monotonic()
        try:
            sheet_png = await generate_spritesheet(portrait_png)
        except Exception as e:  # noqa: BLE001
            log_sprite_failed(
                user_id=user_id, agent_id=agent_id, stage="sheet", error=str(e)
            )
            # Portrait already persisted — partial success is acceptable.
            set_sprite_failure(
                agent_id,
                "Sprite sheet generation failed. Portrait is ready; "
                "you can re-upload to retry the sheet.",
            )
            return

        try:
            sheet_url = await _upload_versioned(
                user_id, agent_id, "sheet", sheet_png
            )
            async with acquire() as conn:
                await conn.execute(
                    "update public.agents "
                    "set sprite_sheet_url = $1, updated_at = now() "
                    "where id = $2",
                    sheet_url,
                    agent_id,
                )
        except Exception as e:  # noqa: BLE001
            log_sprite_failed(
                user_id=user_id, agent_id=agent_id, stage="sheet_persist",
                error=str(e),
            )
            set_sprite_failure(agent_id, "Sprite sheet save failed. Try again.")
            return

        log_sprite_done(
            user_id=user_id,
            agent_id=agent_id,
            storage_url=sheet_url,
            source="sheet",
            duration_ms=int((time.monotonic() - step_started) * 1000),
        )
        clear_sprite_failure(agent_id)
