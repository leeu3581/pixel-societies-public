// Authenticated fetch wrapper for the FastAPI backend.
//
// Pulls the active Supabase access token off the browser session and adds
// it as `Authorization: Bearer …` so anything behind `get_current_user`
// works. Throws on non-2xx so callers can `try/catch` cleanly.

import { apiUrl } from "./backend";
import { getToken } from "./authClient";

async function authHeader(): Promise<Record<string, string>> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function unwrap(resp: Response): Promise<unknown> {
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  if (!resp.ok) {
    const detail =
      (typeof body === "object" && body && "detail" in body
        ? (body as { detail: unknown }).detail
        : null) ?? resp.statusText;
    throw new ApiError(resp.status, body, `${resp.status} ${detail}`);
  }
  return body;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    headers: { ...(await authHeader()) },
    credentials: "omit",
  });
  return (await unwrap(resp)) as T;
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
    },
    body: JSON.stringify(body),
    credentials: "omit",
  });
  return (await unwrap(resp)) as T;
}

export async function apiPostForm<T = unknown>(
  path: string,
  form: FormData,
): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "POST",
    headers: { ...(await authHeader()) },
    body: form,
    credentials: "omit",
  });
  return (await unwrap(resp)) as T;
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "DELETE",
    headers: { ...(await authHeader()) },
    credentials: "omit",
  });
  return (await unwrap(resp)) as T;
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
    },
    body: JSON.stringify(body),
    credentials: "omit",
  });
  return (await unwrap(resp)) as T;
}
