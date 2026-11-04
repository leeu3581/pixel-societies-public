// Build API/WS URLs for the FastAPI backend.
//
// `NEXT_PUBLIC_CHAT_BACKEND_HOST` is host:port (no scheme). We pick
// http(s) / ws(s) based on whether that host is local — so a localhost
// dev frontend can point at a deployed Azure backend (https/wss) and
// still use plain http/ws when both run locally.

const HOST =
  process.env.NEXT_PUBLIC_CHAT_BACKEND_HOST?.trim() || "localhost:4000";

const IS_LOCAL =
  HOST.startsWith("localhost") || HOST.startsWith("127.0.0.1");

export const BACKEND_HOST = HOST;

export function apiUrl(path = ""): string {
  const scheme = IS_LOCAL ? "http" : "https";
  return `${scheme}://${HOST}${path.startsWith("/") ? path : `/${path}`}`;
}

export function wsUrl(path = ""): string {
  const scheme = IS_LOCAL ? "ws" : "wss";
  const suffix = path.startsWith("/") ? path : path ? `/${path}` : "";
  return `${scheme}://${HOST}${suffix}`;
}
