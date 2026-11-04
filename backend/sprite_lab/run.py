"""Standalone Gemini sprite-generation lab.

Iterate on prompts and reference images without touching the live
pipeline (backend/app/sprites.py), the DB, or Supabase Storage.

Two-step flow:
  Step 1: photo + chibi-portrait reference → pixel character portrait
  Step 2: portrait (from step 1) + spritesheet reference → full sheet

Usage:
  # Step 1 — photo to pixel portrait
  backend/.venv/bin/python backend/sprite_lab/run.py \\
      --input public/profiles/joon.jpg \\
      --ref public/characters/new_single_sprite/keerth_example.jpg \\
      --prompt backend/sprite_lab/prompts/step1.txt \\
      --n 3

  # Step 2 — pixel portrait to spritesheet (feed step 1's best output)
  backend/.venv/bin/python backend/sprite_lab/run.py \\
      --input backend/sprite_lab/out/step1__joon__1715000000000__1.png \\
      --ref public/characters/new_spritesheet_formats/spritesheet.webp \\
      --prompt backend/sprite_lab/prompts/step2.txt \\
      --aspect-ratio 3:4 \\
      --n 3

Outputs land in backend/sprite_lab/out/ as:
  step1__joon__1715000000000__0.png   (raw Gemini output)
  step1__joon__1715000000000__0.txt   (sidecar — model, inputs, prompt)

The lab is intentionally minimal:
  - input image is resized if its long edge > 1024 px; format preserved
    (PNG/WebP stay PNG so pixel art isn't JPEG-degraded)
  - reference image is sent verbatim
  - Gemini response is saved as-is — no normalization, no white-to-alpha
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import os
import sys
import time
from pathlib import Path

import httpx
from PIL import Image

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
TIMEOUT_S = 120

HERE = Path(__file__).resolve().parent
DEFAULT_PROMPT = HERE / "prompts" / "step1.txt"
DEFAULT_OUT = HERE / "out"
BACKEND_ENV = HERE.parent / ".env"


def load_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    if BACKEND_ENV.exists():
        for line in BACKEND_ENV.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("GEMINI_API_KEY not set in env or backend/.env")


def guess_mime(path: Path) -> str:
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "image/png")


def preprocess_image(path: Path, max_edge: int = 1024) -> tuple[bytes, str]:
    """Resize so the longest edge ≤ max_edge. Preserve format: JPEGs stay
    JPEG, PNG/WebP stay PNG (pixel art keeps its alpha and avoids
    lossy artifacts that would mislead Gemini in step 2)."""
    suffix = path.suffix.lower()
    is_pixel = suffix in (".png", ".webp")
    img = Image.open(path)
    img = img.convert("RGBA" if is_pixel else "RGB")

    w, h = img.size
    longest = max(w, h)
    if longest > max_edge:
        scale = max_edge / longest
        resample = Image.NEAREST if is_pixel else Image.LANCZOS
        img = img.resize((round(w * scale), round(h * scale)), resample)

    buf = io.BytesIO()
    if is_pixel:
        img.save(buf, format="PNG")
        return buf.getvalue(), "image/png"
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue(), "image/jpeg"


async def call_gemini(
    api_key: str,
    model: str,
    prompt: str,
    input_image: tuple[bytes, str],
    ref: tuple[bytes, str] | None,
    temperature: float,
    aspect_ratio: str | None,
) -> bytes:
    input_bytes, input_mime = input_image
    parts: list[dict] = [
        {
            "inlineData": {
                "mimeType": input_mime,
                "data": base64.b64encode(input_bytes).decode("ascii"),
            }
        }
    ]
    if ref is not None:
        ref_bytes, ref_mime = ref
        parts.append(
            {
                "inlineData": {
                    "mimeType": ref_mime,
                    "data": base64.b64encode(ref_bytes).decode("ascii"),
                }
            }
        )
    parts.append({"text": prompt})

    generation_config: dict = {
        "responseModalities": ["IMAGE"],
        "temperature": temperature,
    }
    if aspect_ratio:
        generation_config["imageConfig"] = {"aspectRatio": aspect_ratio}

    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation_config,
    }
    url = f"{GEMINI_BASE}/{model}:generateContent?key={api_key}"
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        resp = await client.post(url, json=body)
    if resp.status_code != 200:
        raise RuntimeError(f"http {resp.status_code}: {resp.text[:300]}")
    payload = resp.json()
    for cand in payload.get("candidates") or []:
        for part in (cand.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise RuntimeError(f"no image part. payload head: {str(payload)[:400]}")


async def run_one(
    idx: int,
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image: tuple[bytes, str],
    ref: tuple[bytes, str] | None,
    temperature: float,
    aspect_ratio: str | None,
    out_dir: Path,
    stem: str,
    timestamp_ms: int,
    input_path: Path,
    ref_path: Path | None,
    prompt_path: Path,
) -> Path | Exception:
    t0 = time.monotonic()
    try:
        png = await call_gemini(
            api_key, model, prompt, input_image, ref, temperature, aspect_ratio
        )
    except Exception as e:  # noqa: BLE001
        return e
    out_path = out_dir / f"{stem}__{timestamp_ms}__{idx}.png"
    out_path.write_bytes(png)
    meta = (
        f"model: {model}\n"
        f"temperature: {temperature}\n"
        f"aspect_ratio: {aspect_ratio or '(default)'}\n"
        f"input: {input_path}\n"
        f"ref: {ref_path or '(none)'}\n"
        f"prompt_file: {prompt_path}\n"
        f"elapsed_s: {time.monotonic() - t0:.1f}\n"
        f"output_bytes: {len(png)}\n"
        "---\n"
        f"{prompt}\n"
    )
    out_path.with_suffix(".txt").write_text(meta)
    return out_path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Gemini sprite-generation lab")
    p.add_argument(
        "--input",
        required=True,
        help="Path to the input image. Step 1 → a profile photo. Step 2 → "
        "a pixel-portrait PNG (typically a step 1 output).",
    )
    p.add_argument("--ref", help="Path to the reference image (style or layout)")
    p.add_argument(
        "--prompt",
        default=str(DEFAULT_PROMPT),
        help=f"Prompt text file (default: prompts/{DEFAULT_PROMPT.name})",
    )
    p.add_argument(
        "--model",
        default=os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"),
        help="Gemini image model (default: gemini-2.5-flash-image)",
    )
    p.add_argument("--n", type=int, default=1, help="How many parallel calls to make")
    p.add_argument("--temperature", type=float, default=0.4)
    p.add_argument(
        "--aspect-ratio",
        default="3:4",
        help="Gemini imageConfig.aspectRatio (default 3:4). Pass '' to let "
        "the model pick.",
    )
    p.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT),
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    return p.parse_args()


async def main_async() -> int:
    args = parse_args()
    api_key = load_api_key()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"input not found: {input_path}", file=sys.stderr)
        return 2
    input_image = preprocess_image(input_path)

    ref: tuple[bytes, str] | None = None
    ref_path: Path | None = None
    if args.ref:
        ref_path = Path(args.ref)
        if not ref_path.exists():
            print(f"ref not found: {ref_path}", file=sys.stderr)
            return 2
        ref = (ref_path.read_bytes(), guess_mime(ref_path))

    prompt_path = Path(args.prompt)
    prompt = prompt_path.read_text()
    aspect_ratio = args.aspect_ratio or None

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp_ms = int(time.time() * 1000)
    stem = f"{prompt_path.stem}__{input_path.stem}"

    print(
        f"model={args.model} n={args.n} aspect={aspect_ratio or '(default)'} "
        f"input={input_path.name} "
        f"ref={ref_path.name if ref_path else '(none)'} "
        f"prompt={prompt_path.name}"
    )

    tasks = [
        run_one(
            i,
            api_key=api_key,
            model=args.model,
            prompt=prompt,
            input_image=input_image,
            ref=ref,
            temperature=args.temperature,
            aspect_ratio=aspect_ratio,
            out_dir=out_dir,
            stem=stem,
            timestamp_ms=timestamp_ms,
            input_path=input_path,
            ref_path=ref_path,
            prompt_path=prompt_path,
        )
        for i in range(args.n)
    ]
    results = await asyncio.gather(*tasks)

    failures = 0
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            print(f"  [{i}] FAILED: {r}")
            failures += 1
        else:
            print(f"  [{i}] {r}")
    return 1 if failures and failures == len(results) else 0


def main() -> None:
    sys.exit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
