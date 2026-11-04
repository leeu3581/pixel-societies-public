"""Self-hosted auth — replaces Supabase Auth.

Issues HS256 JWTs signed with SUPABASE_JWT_SECRET, using the SAME claim
shape the app already expects (`sub`=user uuid, `email`, `role`). Because
the existing `app.auth.decode_token` verifies HS256 with that secret, these
tokens flow through every `Depends(get_current_user)` unchanged.

Users live in `auth.users` (migrated from Supabase with bcrypt password
hashes intact, so existing passwords keep working). New signups insert a
row; the `on_auth_user_created` trigger auto-creates the profile.

Endpoints (mounted under /api/auth):
  POST /signup   {email, password, display_name?} -> {access_token, user}
  POST /login    {email, password}                -> {access_token, user}
  GET  /session                                   -> current user (needs bearer)
"""
from __future__ import annotations

import os
import time
import uuid

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from jose import jwt
from pydantic import BaseModel, Field, field_validator

from .auth import CurrentUser, get_current_user
from .db import acquire

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Token lifetime. Stateless JWT — logout is client-side (drop the token).
_TOKEN_TTL_S = int(os.environ.get("AUTH_TOKEN_TTL_S", str(7 * 24 * 3600)))


def _jwt_secret() -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="server misconfigured: SUPABASE_JWT_SECRET (signing key) not set",
        )
    return secret


def _issue_token(user_id: str, email: str | None, role: str = "authenticated") -> str:
    now = int(time.time())
    claims = {
        "sub": user_id,
        "email": email,
        "role": role,
        "aud": "authenticated",
        "iat": now,
        "exp": now + _TOKEN_TTL_S,
    }
    return jwt.encode(claims, _jwt_secret(), algorithm="HS256")


def _hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(pw: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        # bcrypt.checkpw handles $2a$/$2b$ (Supabase uses $2a$).
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# Light email check only — deliberately NOT EmailStr, which rejects
# reserved TLDs like `.test` (RFC 2606) that Supabase accepted. We must
# not be stricter than the system that created these accounts.
def _valid_email(v: str) -> str:
    v = v.strip().lower()
    if "@" not in v or "." not in v.split("@")[-1] or len(v) > 254:
        raise ValueError("invalid email address")
    return v


class SignupIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = None

    _norm_email = field_validator("email")(classmethod(lambda cls, v: _valid_email(v)))


class LoginIn(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=128)

    _norm_email = field_validator("email")(classmethod(lambda cls, v: _valid_email(v)))


class AuthUser(BaseModel):
    id: str
    email: str | None
    role: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthUser


@router.post("/signup", response_model=AuthResponse)
async def signup(body: SignupIn) -> AuthResponse:
    email = body.email.strip().lower()
    async with acquire() as conn:
        existing = await conn.fetchval(
            "select id from auth.users where lower(email) = $1", email
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="an account with this email already exists",
            )
        user_id = str(uuid.uuid4())
        meta = {}
        if body.display_name:
            meta["display_name"] = body.display_name
        # The on_auth_user_created trigger creates the profile from this row.
        await conn.execute(
            """
            insert into auth.users
                (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
            values ($1, $2, $3, now(), $4::jsonb)
            """,
            user_id,
            email,
            _hash_password(body.password),
            __import__("json").dumps(meta),
        )
    token = _issue_token(user_id, email)
    return AuthResponse(
        access_token=token, user=AuthUser(id=user_id, email=email, role="authenticated")
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginIn) -> AuthResponse:
    email = body.email.strip().lower()
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select id, email, encrypted_password from auth.users where lower(email) = $1",
            email,
        )
    # Same 401 whether the email is unknown or the password is wrong.
    if row is None or not _verify_password(body.password, row["encrypted_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )
    user_id = str(row["id"])
    token = _issue_token(user_id, row["email"])
    return AuthResponse(
        access_token=token,
        user=AuthUser(id=user_id, email=row["email"], role="authenticated"),
    )


@router.get("/session", response_model=AuthUser)
async def session(user: CurrentUser = Depends(get_current_user)) -> AuthUser:
    return AuthUser(id=user.id, email=user.email, role=user.role)
