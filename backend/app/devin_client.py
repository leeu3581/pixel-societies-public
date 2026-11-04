"""Minimal Devin v1 REST client (service-key mode).

This module validates env config, makes HTTP calls, and normalizes
upstream errors so FastAPI routes can return clear status codes/messages
without duplicating boilerplate.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


class DevinConfigError(Exception):
    """Raised when required Devin environment variables are missing."""


class DevinClientError(Exception):
    """Raised for upstream Devin API/network failures."""

    def __init__(self, status_code: int, detail: str, payload: Any | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.payload = payload


def _api_key() -> str:
    return os.environ.get("DEVIN_SERVICE_API_KEY", "").strip()

def devin_enabled() -> bool:
    return bool(_api_key())


def _base_url() -> str:
    return os.environ.get("DEVIN_API_BASE", "https://api.devin.ai/v1").strip().rstrip("/")


def _timeout_s() -> float:
    raw = os.environ.get("DEVIN_TIMEOUT_SECONDS", "20").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 20.0
    return min(max(v, 1.0), 120.0)


def _require_config() -> str:
    key = _api_key()
    if not key:
        raise DevinConfigError("Devin service key missing. Set DEVIN_SERVICE_API_KEY in backend/.env.")
    return key


def _extract_detail(res: httpx.Response) -> tuple[str, Any | None]:
    try:
        payload = res.json()
    except ValueError:
        body = (res.text or "").strip()
        return (body or f"Devin API HTTP {res.status_code}"), None

    detail = (
        payload.get("detail")
        or payload.get("message")
        or payload.get("error")
        or f"Devin API HTTP {res.status_code}"
    )
    return str(detail), payload


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    key = _require_config()
    url = f"{_base_url()}/{path.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=_timeout_s()) as client:
            res = await client.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json_body,
            )
    except httpx.HTTPError as exc:
        raise DevinClientError(502, f"Failed to reach Devin API: {exc}") from exc

    if res.status_code >= 400:
        detail, payload = _extract_detail(res)
        raise DevinClientError(res.status_code, detail, payload)

    if not res.content:
        return {}
    try:
        data = res.json()
    except ValueError as exc:
        raise DevinClientError(502, "Devin API returned non-JSON response.") from exc
    if isinstance(data, dict):
        return data
    return {"items": data}


def _clean_devin_id(devin_id: str) -> str:
    v = str(devin_id or "").strip()
    if not v or "/" in v or ".." in v:
        raise DevinClientError(400, "Invalid devin_id.")
    return v


async def list_sessions(*, first: int = 20, after: str | None = None) -> dict[str, Any]:
    first = max(1, min(int(first), 200))
    params: dict[str, Any] = {"first": first}
    if after:
        params["after"] = after
    return await _request("GET", "sessions", params=params)


async def create_session(
    *,
    prompt: str,
    title: str | None = None,
    create_as_user_id: str | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    p = prompt.strip()
    if not p:
        raise DevinClientError(400, "prompt is required.")
    # v1 baseline shape (compatible with docs curl example).
    body: dict[str, Any] = {"prompt": p}
    return await _request("POST", "sessions", json_body=body)


async def get_session(devin_id: str) -> dict[str, Any]:
    return await _request("GET", f"sessions/{_clean_devin_id(devin_id)}")


async def list_messages(
    devin_id: str,
    *,
    first: int = 100,
    after: str | None = None,
) -> dict[str, Any]:
    first = max(1, min(int(first), 200))
    params: dict[str, Any] = {"first": first}
    if after:
        params["after"] = after
    return await _request(
        "GET",
        f"sessions/{_clean_devin_id(devin_id)}/messages",
        params=params,
    )


async def send_message(
    devin_id: str,
    *,
    message: str,
    message_as_user_id: str | None = None,
) -> dict[str, Any]:
    msg = message.strip()
    if not msg:
        raise DevinClientError(400, "message is required.")
    body: dict[str, Any] = {"message": msg}
    if message_as_user_id:
        body["message_as_user_id"] = message_as_user_id
    return await _request(
        "POST",
        f"sessions/{_clean_devin_id(devin_id)}/messages",
        json_body=body,
    )
