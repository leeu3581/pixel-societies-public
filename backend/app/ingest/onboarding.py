"""Authenticated, bounded Claude Code upload -> existing self twin + shared cafe.

Raw files exist only in a private temporary directory during parsing. Only the
redacted profile and selected human prose reach private persistence. Bounded AI
interpretation runs after persistence; it never receives raw upload files.
"""

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..auth import CurrentUser, get_current_user
from ..db import acquire
from ..twin_memory import service as memory_service
from .cc_models import ClaudeCodeExtract, RoleLean
from .claude_code import parse_claude_code_export

router = APIRouter(prefix="/api/ingest/claude-code", tags=["builder onboarding"])
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_FILES = 100
CAFE_SLUG = "cofounder-cafe"
_BEGIN = "<!-- claude-code-memory:start -->"
_END = "<!-- claude-code-memory:end -->"


class ProjectSummary(BaseModel):
    name: str


class BuilderSummary(BaseModel):
    """Display contract shared by full imports and older seeded profiles."""
    projects: list[ProjectSummary]
    stacks: list[str]
    domains: list[str]
    role_lean: RoleLean | None
    headline: str | None
    total_sessions: int


class IngestStatus(BaseModel):
    agent_id: str | None = None
    character_started: bool = False
    imported: bool = False
    world_slug: str = CAFE_SLUG
    profile: BuilderSummary | None = None
    stats: dict[str, int] | None = None


def memory_persona(previous: str | None, extract: ClaudeCodeExtract) -> str:
    """Compatibility helper: private imports must never be embedded in public personas."""
    return memory_service.strip_imported_memory(previous)


async def _self_agent(conn, user_id: str, *, lock: bool = False):
    return await conn.fetchrow(
        """select a.id, a.persona_md,
                  (p.photo_url is not null or a.portrait_url is not null or a.sprite_sheet_url is not null) as character_started
           from public.agents a
           join public.worlds w on w.id = a.world_id
           join public.profiles p on p.id = a.owner_user_id
           where a.owner_user_id = $1 and w.owner_user_id = $1
             and w.slug = 'home' and a.canonical_id is null
           order by a.created_at, a.id limit 1""" + (" for update of a" if lock else ""),
        user_id,
    )


@router.get("", response_model=IngestStatus)
async def status(user: CurrentUser = Depends(get_current_user)) -> IngestStatus:
    async with acquire() as conn:
        agent = await _self_agent(conn, user.id)
        if not agent:
            return IngestStatus()
        row = await conn.fetchrow(
            """select projects, stacks, tools, cadence, total_sessions, span_days,
                      domains, role_lean, headline from public.builder_profiles
               where agent_id = $1 and owner_user_id = $2""", agent["id"], user.id,
        )
    profile = None
    if row:
        data = dict(row)
        for key in ("projects", "cadence"):
            if isinstance(data[key], str):
                data[key] = json.loads(data[key])
        profile = BuilderSummary.model_validate(data)
    return IngestStatus(agent_id=str(agent["id"]), character_started=agent["character_started"], imported=profile is not None, profile=profile)


async def persist_extract(user_id: str, extract: ClaudeCodeExtract) -> str:
    """Serialize reimports on the twin row; commit profile, memory and membership together."""
    profile = extract.profile
    async with acquire() as conn:
        async with conn.transaction():
            agent = await _self_agent(conn, user_id, lock=True)
            if not agent or not agent["character_started"]:
                raise HTTPException(409, "Create your character before importing history")
            # Creates the shared space on a fresh deployment without needing seed data.
            await conn.execute(
                """insert into public.world_groups
                     (name, slug, description, visibility, created_by, simulation_program, roster_owner_only)
                   values ('Co-Founder Cafe', $1, 'Meet builders through shared interests and complementary skills',
                           'public', $2, 'coworking', false)
                   on conflict (slug) do nothing""", CAFE_SLUG, user_id,
            )
            group = await conn.fetchrow(
                "select id, visibility, roster_owner_only from public.world_groups where slug = $1", CAFE_SLUG,
            )
            if group["visibility"] != "public" or group["roster_owner_only"]:
                raise HTTPException(409, "The shared cafe is not accepting new builders yet")
            await conn.execute(
                """insert into public.builder_profiles
                   (agent_id, owner_user_id, projects, stacks, tools, cadence, total_sessions,
                    span_days, domains, role_lean, headline, source)
                   values ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'claude_code')
                   on conflict (agent_id) do update set
                     projects=excluded.projects, stacks=excluded.stacks, tools=excluded.tools,
                     cadence=excluded.cadence, total_sessions=excluded.total_sessions,
                     span_days=excluded.span_days, domains=excluded.domains,
                     role_lean=excluded.role_lean, headline=excluded.headline,
                     source=excluded.source, updated_at=now()""",
                agent["id"], user_id,
                json.dumps([p.model_dump(mode="json") for p in profile.projects]),
                profile.stacks, profile.tools, profile.cadence.model_dump_json(),
                profile.total_sessions, profile.span_days, profile.domains, profile.role_lean, profile.headline,
            )
            await memory_service.record_import(conn, user_id, extract)
            await conn.execute(
                """update public.agents set persona_md=$1, updated_at=now()
                   where id=$2 and owner_user_id=$3""",
                memory_persona(agent["persona_md"], extract), agent["id"], user_id,
            )
            await conn.execute(
                """insert into public.world_group_members (group_id,user_id,status,joined_at,auto_enabled)
                   values ($1,$2,'accepted',now(),true)
                   on conflict (group_id,user_id) do update set status='accepted',
                     joined_at=coalesce(public.world_group_members.joined_at,now())""", group["id"], user_id,
            )
    return str(agent["id"])


@router.post("", response_model=IngestStatus)
async def upload(
    tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    user: CurrentUser = Depends(get_current_user),
) -> IngestStatus:
    try:
        if not 1 <= len(files) <= MAX_FILES:
            raise HTTPException(413, "Choose between 1 and 100 JSONL files")
        if any(not (file.filename or "").lower().endswith(".jsonl") for file in files):
            raise HTTPException(415, "Choose Claude Code .jsonl session files")
        total = 0
        with tempfile.TemporaryDirectory(prefix="cc-import-") as directory:
            for index, file in enumerate(files):
                # Never use the untrusted filename as a filesystem path.
                target = Path(directory) / f"session-{index}.jsonl"
                with target.open("wb") as output:
                    while chunk := await file.read(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_UPLOAD_BYTES:
                            raise HTTPException(413, "History uploads are limited to 50 MB in total")
                        output.write(chunk)
            extract = await asyncio.to_thread(parse_claude_code_export, Path(directory))
        if not extract.stats["records_kept"]:
            raise HTTPException(422, "No usable conversation records found; choose original Claude Code session files")
        agent_id = await persist_extract(user.id, extract)
        tasks.add_task(memory_service.analyze, user.id)
        return IngestStatus(agent_id=agent_id, character_started=True, imported=True,
                            profile=BuilderSummary.model_validate(extract.profile.model_dump()), stats=extract.stats)
    finally:
        for file in files:
            await file.close()
