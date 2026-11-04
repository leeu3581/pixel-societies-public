"""asyncpg connection pool, attached to the FastAPI lifespan.

One pool per process. Use `get_pool()` from request handlers, or
`acquire()` for a brief context-managed connection:

    from .db import acquire

    async with acquire() as conn:
        row = await conn.fetchrow("select 1")
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator
from urllib.parse import urlparse

import asyncpg

from .observability import log_db_pool_ready

_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    """Create the global pool. Call once at app startup."""
    global _pool
    if _pool is not None:
        return _pool
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL not set — cannot create asyncpg pool")
    max_size = 10
    _pool = await asyncpg.create_pool(
        dsn=db_url,
        min_size=1,
        max_size=max_size,
        command_timeout=30,
    )
    parsed = urlparse(db_url)
    log_db_pool_ready(dsn_host=f"{parsed.hostname}:{parsed.port or ''}", max_size=max_size)
    return _pool


async def close_pool() -> None:
    """Tear the pool down at app shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """Return the live pool. Raises if init_pool() was not called."""
    if _pool is None:
        raise RuntimeError("asyncpg pool not initialised — was lifespan attached?")
    return _pool


@asynccontextmanager
async def acquire() -> AsyncIterator[asyncpg.Connection]:
    """Brief connection checkout."""
    pool = get_pool()
    async with pool.acquire() as conn:
        yield conn
