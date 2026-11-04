"""Supabase JWT verification.

Supabase issues access tokens signed two ways:
  - Legacy projects: HS256, signed with the project's JWT secret.
  - Modern projects: ES256 (asymmetric), keys published at
      `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`.

We support both. ES256 is preferred when the JWKS endpoint is reachable;
HS256 falls through automatically using `SUPABASE_JWT_SECRET`.

The frontend pulls the token off the active session and sends it on:
  - REST: `Authorization: Bearer <token>`
  - WS:   `?token=<token>` query param (browsers can't set custom WS headers)

`get_current_user` is the FastAPI dependency. `decode_token` is exposed
separately so the WebSocket handler can authenticate from a query string.
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from .observability import log_auth_failed, log_auth_ok


_bearer = HTTPBearer(auto_error=False)

# JWKS cache: { kid: jwk_dict }. Refreshed every JWKS_TTL_S seconds, or
# whenever a kid lookup misses (handles key rotation).
_JWKS_TTL_S = 300
_jwks_cache: dict[str, Any] = {}
_jwks_fetched_at: float = 0.0


@dataclass(frozen=True)
class CurrentUser:
    id: str           # uuid string from `sub` claim
    email: str | None
    role: str         # `authenticated` for normal users, `service_role`, etc.
    raw: dict[str, Any]


def _jwt_secret() -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="server misconfigured: SUPABASE_JWT_SECRET not set",
        )
    return secret


def _jwks_url() -> str | None:
    base = os.environ.get("SUPABASE_URL")
    if not base:
        return None
    return base.rstrip("/") + "/auth/v1/.well-known/jwks.json"


def _refresh_jwks(force: bool = False) -> None:
    """Pull JWKS from Supabase. Cached for _JWKS_TTL_S. Best-effort."""
    global _jwks_cache, _jwks_fetched_at
    url = _jwks_url()
    if not url:
        return
    if not force and (time.time() - _jwks_fetched_at) < _JWKS_TTL_S and _jwks_cache:
        return
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
        _jwks_cache = {jwk["kid"]: jwk for jwk in data.get("keys", []) if jwk.get("kid")}
        _jwks_fetched_at = time.time()
    except Exception:  # noqa: BLE001
        # Keep stale cache rather than blow up requests on a transient JWKS hiccup.
        return


def _decode_with_jwks(token: str) -> dict[str, Any] | None:
    """Try to verify an asymmetric (ES256/RS256) token against JWKS.
    Returns the claims, None if no matching kid, or raises JWTError."""
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    alg = header.get("alg") or "ES256"
    if not kid:
        return None
    _refresh_jwks()
    jwk = _jwks_cache.get(kid)
    if jwk is None:
        # Try one forced refresh in case of key rotation.
        _refresh_jwks(force=True)
        jwk = _jwks_cache.get(kid)
    if jwk is None:
        return None
    return jwt.decode(
        token,
        jwk,
        algorithms=[alg],
        options={"verify_aud": False},
    )


def decode_token(token: str) -> CurrentUser:
    """Verify a Supabase JWT (HS256 or ES256/RS256), extract the user.
    Raises HTTPException on failure."""
    claims: dict[str, Any] | None = None
    last_err: str | None = None

    # Asymmetric path first (modern Supabase).
    try:
        claims = _decode_with_jwks(token)
    except JWTError as e:
        last_err = f"jwks: {e}"
        claims = None

    # HS256 fallback (legacy Supabase or self-issued).
    if claims is None:
        try:
            claims = jwt.decode(
                token,
                _jwt_secret(),
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
        except JWTError as e:
            log_auth_failed(reason=last_err or str(e), has_token=bool(token))
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"invalid token: {last_err or e}",
            ) from e

    sub = claims.get("sub")
    if not sub:
        log_auth_failed(reason="missing_sub", has_token=True)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="token has no sub claim",
        )

    user = CurrentUser(
        id=str(sub),
        email=claims.get("email"),
        role=claims.get("role") or "authenticated",
        raw=claims,
    )
    log_auth_ok(user_id=user.id, role=user.role)
    return user


# In-memory throttle: don't burn a DB write on every authed request.
# 60s window per user is plenty for the engine's 6-hour idle gate.
_last_touched: dict[str, float] = {}
_TOUCH_THROTTLE_S = 60.0


async def _touch_last_seen(user_id: str) -> None:
    """Best-effort update of profiles.last_seen_at — fire-and-forget.
    Used by the autonomous engine's idle-gate to know whether the
    owner is still around. Throttled in-memory per user."""
    now = time.monotonic()
    last = _last_touched.get(user_id, 0.0)
    if now - last < _TOUCH_THROTTLE_S:
        return
    _last_touched[user_id] = now
    try:
        # Late import to avoid a circular dep at module load
        from .db import acquire

        async with acquire() as conn:
            await conn.execute(
                "update public.profiles set last_seen_at = now() where id = $1",
                user_id,
            )
    except Exception:  # noqa: BLE001
        # last_seen is non-critical; never fail a request because of it
        pass


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    """FastAPI dependency: extract the bearer token, verify, return user."""
    if creds is None or not creds.credentials:
        log_auth_failed(reason="missing_bearer", has_token=False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Authorization: Bearer token",
        )
    user = decode_token(creds.credentials)
    # Fire-and-forget: don't make every request wait on the DB write.
    # If the pool isn't ready (early in startup) the helper swallows it.
    asyncio.create_task(_touch_last_seen(user.id))
    return user


def user_from_query_token(token: str | None) -> CurrentUser | None:
    """For WS: pulls user from a `?token=` query string. Returns None on miss."""
    if not token:
        return None
    try:
        return decode_token(token)
    except HTTPException:
        return None
