// Self-hosted auth client — replaces Supabase Auth on the frontend.
//
// Talks to the FastAPI backend's /api/auth/* endpoints and persists the
// issued JWT in localStorage. Every authed request in lib/api.ts reads the
// token via getToken(); the backend verifies it (HS256) in app/auth.py.
//
// Migration note: this intentionally mirrors the small slice of the
// supabase-js `.auth` surface the app actually used (getSession → token,
// getUser, signInWithPassword, signUp, signOut), so call sites migrate with
// minimal churn. Google OAuth (signInWithOAuth) is intentionally omitted
// until an OIDC flow is wired server-side — see FRONTEND-MIGRATION.md.

import { apiUrl } from "./backend";

const TOKEN_KEY = "ps_access_token";
const USER_KEY = "ps_user";

export interface AuthUser {
  id: string;
  email: string | null;
  role: string;
}

interface AuthResponse {
  access_token: string;
  token_type: string;
  user: AuthUser;
}

// ── token/user persistence ────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  // Mobile WebView bootstrap: a ?token=<jwt> in the URL wins once and is
  // persisted (mirrors the old supabase setSession bootstrap).
  try {
    const url = new URLSearchParams(window.location.search);
    const fromUrl = url.get("token");
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      return fromUrl;
    }
  } catch {
    /* ignore */
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function persist(res: AuthResponse): AuthUser {
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, res.access_token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
  }
  return res.user;
}

// ── auth actions ──────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<AuthResponse> {
  const resp = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? (data as { detail: unknown }).detail
        : null) ?? resp.statusText;
    throw new Error(typeof detail === "string" ? detail : "auth request failed");
  }
  return data as AuthResponse;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  return persist(await post("/api/auth/login", { email, password }));
}

export async function signup(
  email: string,
  password: string,
  display_name?: string,
): Promise<AuthUser> {
  return persist(await post("/api/auth/signup", { email, password, display_name }));
}

export function logout(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Verify the current token against the backend; returns the user or null. */
export async function fetchSession(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const resp = await fetch(apiUrl("/api/auth/session"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    if (resp.status === 401) logout();
    return null;
  }
  return (await resp.json()) as AuthUser;
}

export function isAuthenticated(): boolean {
  return Boolean(getToken());
}
