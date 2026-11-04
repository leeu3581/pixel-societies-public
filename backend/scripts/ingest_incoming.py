"""Bulk-ingest profiles from `backend/data/incoming/<slug>/`.

Each subfolder = one colleague. Inside the folder, drop:
  *.md / *.txt        — bio files (concatenated alphabetically, meta excluded)
  one image           — .jpg / .jpeg / .png / .webp (first one wins)
  meta.yaml           — optional: overrides display name + assign_to

Folder name → default slug + display name (e.g. `sarah-chen` →
slug `sarah-chen`, name `Sarah Chen`). Override either via meta.yaml.

Usage:
    cd backend
    source .venv/bin/activate
    python scripts/ingest_incoming.py            # all subfolders
    python scripts/ingest_incoming.py sarah-chen # one folder
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml

# Make `app.*` importable when run as a script from backend/.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.ingest.extractor import extract_chunk, synthesise_profile  # noqa: E402
from app.ingest.render import (  # noqa: E402
    render_hub_md,
    render_personality_md,
    render_topic_pages,
)
from app.ingest.runner import (  # noqa: E402
    _ensure_office_world_link,
    _ensure_readme_link,
    _save_profile,
    _slug,
)
from app.ingest.text_parser import chunk_text, parse_text  # noqa: E402

INCOMING = ROOT / "data" / "incoming"
DONE = INCOMING / "_done"
WIKIS = ROOT / "data" / "wikis"
PUBLIC_PROFILES = ROOT.parent / "frontend" / "public" / "profiles"

DONE.mkdir(parents=True, exist_ok=True)
PUBLIC_PROFILES.mkdir(parents=True, exist_ok=True)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
META_NAMES = {"meta.yaml", "meta.yml", "meta.md", "meta.txt"}

# Cap on simultaneous LLM calls. Each folder uses ~2 calls (extract + synth);
# 4 concurrent folders = ~8 in-flight requests, well under typical Anthropic
# tier limits and 3-4× faster than serial.
MAX_CONCURRENCY = int(os.environ.get("INGEST_PARALLEL", "4"))


def _titlecase_slug(slug: str) -> str:
    """`sarah-chen` → `Sarah Chen`. Best-effort default for display name."""
    return " ".join(p.capitalize() for p in slug.replace("_", "-").split("-") if p)


def _read_meta(folder: Path) -> dict:
    for name in ("meta.yaml", "meta.yml"):
        p = folder / name
        if p.exists():
            try:
                data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
                return data if isinstance(data, dict) else {}
            except yaml.YAMLError as exc:
                print(f"  ! {name} parse error: {exc} (ignoring)")
                return {}
    return {}


def _collect_bio(folder: Path) -> str:
    """All .md/.txt files (alphabetical), concat with double newlines.
    meta.* files are excluded so the LLM doesn't see the override metadata."""
    files = sorted(
        f for f in folder.iterdir()
        if f.is_file()
        and f.suffix.lower() in {".md", ".txt"}
        and f.name.lower() not in META_NAMES
    )
    if not files:
        return ""
    parts = [f.read_text(encoding="utf-8").strip() for f in files]
    return "\n\n".join(p for p in parts if p).strip()


def _find_image(folder: Path) -> Path | None:
    candidates = sorted(
        f for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS
    )
    return candidates[0] if candidates else None


def _inject_photo_into_personality(slug: str, photo_url: str) -> None:
    p = WIKIS / slug / "personality.md"
    if not p.exists():
        return
    text = p.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return
    end = text.find("\n---", 4)
    if end == -1:
        return
    try:
        fm = yaml.safe_load(text[4:end]) or {}
    except yaml.YAMLError:
        return
    if not isinstance(fm, dict):
        return
    if fm.get("photo") == photo_url:
        return
    fm["photo"] = photo_url
    new_fm = yaml.safe_dump(fm, sort_keys=False).strip()
    p.write_text(f"---\n{new_fm}\n---\n{text[end + 4 :].lstrip(chr(10))}", encoding="utf-8")


async def _process_folder(
    folder: Path,
    *,
    sem: asyncio.Semaphore,
    disk_lock: asyncio.Lock,
) -> bool:
    tag = folder.name
    print(f"[{tag}] start")
    if not folder.is_dir():
        print(f"[{tag}] ✗ not a directory")
        return False

    meta = _read_meta(folder)
    explicit_name = str(meta.get("name") or "").strip()
    folder_fallback_name = _titlecase_slug(folder.name.strip())
    # `target_sender` is what the extractor uses as the SUBJECT in its
    # prompt — folder-name is a fine starting hint. The actual display
    # name + slug are resolved AFTER synthesis so the LLM-extracted
    # full name (e.g. "Anil Kapoor") wins over a one-word folder name
    # like "Anil" when no meta.yaml is provided.
    target_sender = explicit_name or folder_fallback_name

    body = _collect_bio(folder)
    if not body:
        print(f"[{tag}] ✗ no bio content")
        return False

    doc = parse_text(body)
    chunks = chunk_text(doc.text)
    print(f"[{tag}] {doc.char_count:,} chars → {len(chunks)} chunk(s)")

    # ── LLM phase (semaphore-gated) ───────────────────────────────
    extractions = []
    async with sem:
        t0 = time.monotonic()
        for i, c in enumerate(chunks, start=1):
            label = f"chunk {i}/{len(chunks)}: {len(c):,} chars"
            try:
                ext = await extract_chunk(
                    chunk_label=label,
                    target_sender=target_sender,
                    rendered_messages=c,
                    mode="text_doc",
                )
                extractions.append(ext)
            except Exception as exc:  # noqa: BLE001
                print(f"[{tag}] chunk {i} FAILED — {exc}")

        if not extractions:
            print(f"[{tag}] ✗ no extractions")
            return False

        try:
            profile = await synthesise_profile(target_sender, extractions, "")
        except Exception as exc:  # noqa: BLE001
            print(f"[{tag}] ✗ synthesis failed: {exc}")
            return False
        elapsed_llm = time.monotonic() - t0

    name = explicit_name or (profile.name or "").strip() or folder_fallback_name
    slug = (
        str(meta.get("assign_to") or "").strip()
        or _slug(name)
        or _slug(folder.name)
        or folder.name.strip()
    )

    today = datetime.utcnow().date()
    hub_md = render_hub_md(profile, slug=slug, ingest_date=today, name=name)
    personality_md = render_personality_md(profile, slug=slug, ingest_date=today, name=name)
    topic_pages = render_topic_pages(profile, hub_name=name)

    # ── Disk phase (single-writer; README and layout JSON aren't
    # safe to mutate concurrently). _save_profile + photo + layout
    # all run together so each agent lands cleanly.
    img = _find_image(folder)
    photo_url = ""
    async with disk_lock:
        hub_path, topic_slugs = _save_profile(
            slug=slug,
            name=name,
            hub_md=hub_md,
            personality_md=personality_md,
            topic_pages=topic_pages,
        )
        if img is not None:
            ext = img.suffix.lower()
            dest = PUBLIC_PROFILES / f"{slug}{ext}"
            shutil.copy2(img, dest)
            photo_url = f"/profiles/{slug}{ext}"
            _inject_photo_into_personality(slug, photo_url)
        _ensure_readme_link(slug=slug, name=name)
        _ensure_office_world_link(slug)

        target = DONE / slug
        if target.exists():
            target = DONE / f"{slug}-{int(time.time())}"
        shutil.move(str(folder), str(target))

    photo_label = f"📸 {photo_url}" if photo_url else "no photo"
    print(
        f"[{tag}] ✓ saved → {slug}  ({len(topic_slugs)} topics, {photo_label}, "
        f"llm {elapsed_llm:.0f}s)"
    )
    return True


async def main(argv: list[str]) -> int:
    if len(argv) > 1:
        targets = [INCOMING / a for a in argv[1:]]
    else:
        targets = sorted(
            p for p in INCOMING.iterdir()
            if p.is_dir() and not p.name.startswith("_") and p.name != "_done"
        )
    if not targets:
        print(f"No profile folders in {INCOMING.relative_to(ROOT)}/ "
              f"(skipping `_*` and `_done`).")
        print("Drop a subfolder there. See _example/ for the layout.")
        return 0

    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    disk_lock = asyncio.Lock()
    print(f"Processing {len(targets)} folder(s) in parallel "
          f"(max {MAX_CONCURRENCY} concurrent LLM calls)…")
    t0 = time.monotonic()
    results = await asyncio.gather(
        *[_process_folder(p, sem=sem, disk_lock=disk_lock) for p in targets],
        return_exceptions=True,
    )
    ok = sum(1 for r in results if r is True)
    failed = [
        f"{p.name}: {r if not isinstance(r, bool) else 'returned False'}"
        for p, r in zip(targets, results)
        if r is not True
    ]
    elapsed = time.monotonic() - t0
    print(
        f"\nDone — {ok}/{len(targets)} succeeded in {elapsed:.0f}s. "
        f"Reload /consult or /graph."
    )
    if failed:
        print("Failed:")
        for f in failed:
            print(f"  {f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv)))
