"use client";

// Full-page chat — two-column layout with agent roster (left) and
// threaded conversation (right). Uses the same WS protocol as
// ChatDrawer but in a dedicated page format. Layout adapted from
// the UMhack ChatView; styling matches pixel-societies brutalist UI.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession, getToken } from "@/lib/authClient";
import { apiGet, ApiError } from "@/lib/api";
import { wsUrl } from "@/lib/backend";
import BrandChip from "@/components/BrandChip";
import SpriteFrame from "@/components/SpriteFrame";
import { getProfilePhoto } from "@/lib/profilePhotos";

const MAP_BG = "/onboarding/map-bg.png";

const PLACEHOLDER_SPRITES = [
  "/team-office/characters/char_0.png",
  "/team-office/characters/char_1.png",
  "/team-office/characters/char_2.png",
  "/team-office/characters/char_3.png",
  "/team-office/characters/char_4.png",
  "/team-office/characters/char_5.png",
];

function pickPlaceholder(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PLACEHOLDER_SPRITES[Math.abs(hash) % PLACEHOLDER_SPRITES.length];
}

type Msg = {
  id: number | string;
  role: "user" | "agent";
  body: string;
  created_at?: string;
  pending?: boolean;
};

type Agent = {
  id: string;
  display_name: string;
  subtitle: string | null;
  canonical_id: string | null;
  sprite_url: string | null;
  tile_x: number;
  tile_y: number;
};

type WorldAgentsResponse = {
  world_id: string;
  owner_user_id: string;
  mode: "own" | "visit";
  agents: Agent[];
};

type WorldsMeResponse = {
  id: string;
  slug: string;
  display_name: string | null;
  tile_w: number;
  tile_h: number;
  bg_palette: number;
  owner_user_id: string;
};

export default function ChatPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // ── Auth + data fetch ────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/chat");
        return;
      }
      setToken(getToken());

      try {
        const world = await apiGet<WorldsMeResponse>("/api/worlds/me");
        const agentsRes = await apiGet<WorldAgentsResponse>(
          `/api/worlds/${encodeURIComponent(world.id)}/agents`,
        );
        setAgents(agentsRes.agents);
        if (agentsRes.agents.length > 0) {
          setSelectedId(agentsRes.agents[0].id);
        }
      } catch (err) {
        const msg =
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
        setPageError(msg);
      }
    })();
  }, [router]);

  // ── WebSocket — reconnects when selected agent changes ───────
  useEffect(() => {
    if (!token || !selectedId) return;

    setMessages([]);
    setBusy(false);
    setError(null);
    streamingRef.current = false;

    const url = `${wsUrl("/")}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.start", agent_id: selectedId }));
    });

    ws.addEventListener("message", (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const t = frame.type as string;

      if (t === "chat.history") {
        setMessages((frame.messages as Msg[]) || []);
      } else if (t === "chat.agent_chunk") {
        const delta = String(frame.delta || "");
        setMessages((prev) => {
          if (!streamingRef.current) {
            streamingRef.current = true;
            return [
              ...prev,
              {
                id: `pending-${Date.now()}`,
                role: "agent",
                body: delta,
                pending: true,
              },
            ];
          }
          const last = prev[prev.length - 1];
          if (!last || !last.pending) return prev;
          return [
            ...prev.slice(0, -1),
            { ...last, body: (last.body || "") + delta },
          ];
        });
      } else if (t === "chat.agent_done") {
        const fullText = String(frame.full_text || "");
        const messageId = frame.message_id as number;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || !last.pending) {
            return [...prev, { id: messageId, role: "agent", body: fullText }];
          }
          return [
            ...prev.slice(0, -1),
            { id: messageId, role: "agent", body: fullText },
          ];
        });
        streamingRef.current = false;
        setBusy(false);
      } else if (t === "chat.rate_limited") {
        setError(
          `Rate-limited — try again in ${Number(frame.retry_after_seconds || 0)}s`,
        );
        setBusy(false);
        streamingRef.current = false;
      } else if (t === "chat.error") {
        setError(String(frame.message || "Chat error"));
        setBusy(false);
        streamingRef.current = false;
      }
    });

    ws.addEventListener("close", () => {});

    return () => {
      try {
        ws.close();
      } catch {}
      wsRef.current = null;
      streamingRef.current = false;
    };
  }, [token, selectedId]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection not open — try again.");
      return;
    }
    setError(null);
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", body },
    ]);
    setDraft("");
    ws.send(
      JSON.stringify({ type: "chat.user_msg", agent_id: selectedId, body }),
    );
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // ── Render ───────────────────────────────────────────────────
  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.82), rgba(12, 22, 38, 0.90)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (pageError) {
    return (
      <main
        className="relative h-dvh w-full overflow-hidden bg-[#0c1626]"
        style={bgStyle}
      >
        <BrandChip />
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <div className="max-w-lg border-[3px] border-[#1f2a3c] bg-[#f7ddd7] p-4 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[4px_4px_0_#1f2a3c]">
            {pageError}
          </div>
        </div>
      </main>
    );
  }

  if (agents.length === 0) {
    return (
      <main
        className="relative h-dvh w-full overflow-hidden bg-[#0c1626]"
        style={bgStyle}
      >
        <BrandChip />
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
            Loading your world...
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0c1626] px-3 pb-6 sm:px-6" style={bgStyle}>
      <BrandChip />

      {/* Header */}
      <div className="mx-auto max-w-6xl pt-16 pb-4 sm:pt-20 sm:pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98]">
              Pixel Societies · /chat
            </p>
            <h1 className="mt-1 font-mono text-3xl font-bold uppercase leading-tight text-[#fffaf0] sm:text-4xl">
              Chat with your world
            </h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#9fb0bf]">
              Pick an agent and ask them anything. Switching agents
              preserves each conversation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              ← Back to world
            </Link>
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* ── Roster ──────────────────────────────────────────── */}
        <div className="flex h-[calc(100dvh-14rem)] flex-col overflow-hidden border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] shadow-[4px_4px_0_#1f2a3c]">
          <div className="border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Your agents ({agents.length})
            </p>
          </div>
          <ul className="flex-1 space-y-1 overflow-y-auto p-2">
            {agents.map((a) => {
              const active = a.id === selectedId;
              const spriteUrl = a.sprite_url || pickPlaceholder(a.id);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(a.id)}
                    className={
                      "flex w-full items-center gap-3 border-[3px] px-3 py-2 text-left transition-colors " +
                      (active
                        ? "border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]"
                        : "border-transparent hover:border-[#1f2a3c] hover:bg-[#fffaf0]")
                    }
                  >
                    <div className="shrink-0 border-[2px] border-[#1f2a3c] bg-[#f6f4ea] overflow-hidden" style={{ width: 44, height: 44 }}>
                      {getProfilePhoto(a.canonical_id) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={getProfilePhoto(a.canonical_id)!}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="p-0.5">
                          <SpriteFrame src={spriteUrl} size={1.5} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-sm font-bold uppercase leading-tight text-[#1f2a3c]">
                        {a.display_name}
                      </div>
                      {a.subtitle && (
                        <div className="truncate text-[11px] leading-snug text-[#637387]">
                          {a.subtitle}
                        </div>
                      )}
                    </div>
                    {a.canonical_id && (
                      <span className="shrink-0 bg-[#ffe17d] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#1f2a3c]">
                        {a.canonical_id}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ── Chat thread ─────────────────────────────────────── */}
        <div className="flex h-[calc(100dvh-14rem)] flex-col overflow-hidden border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] shadow-[4px_4px_0_#1f2a3c]">
          {/* Chat header */}
          <div className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
                Talking to
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="truncate font-mono text-lg font-bold uppercase leading-tight text-[#1f2a3c]">
                  {selected?.display_name ?? "..."}
                </span>
                {selected?.subtitle && (
                  <span className="hidden truncate text-[12px] text-[#637387] sm:inline">
                    · {selected.subtitle}
                  </span>
                )}
              </div>
            </div>
            {selected && (
              <div className="shrink-0 border-[3px] border-[#1f2a3c] bg-[#f6f4ea] p-1 shadow-[2px_2px_0_#1f2a3c]">
                <SpriteFrame
                  src={selected.sprite_url || pickPlaceholder(selected.id)}
                  size={2}
                />
              </div>
            )}
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto bg-[#f6f4ea] px-4 py-4 sm:px-6"
          >
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
                  {selected
                    ? `Send ${selected.display_name} a message to start.`
                    : "Pick an agent on the left."}
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={String(m.id)}
                  className={
                    m.role === "user" ? "flex justify-end" : "flex justify-start"
                  }
                >
                  <div
                    className={
                      "max-w-[85%] border-[3px] border-[#1f2a3c] px-4 py-2.5 shadow-[3px_3px_0_#1f2a3c] " +
                      (m.role === "user"
                        ? "bg-[#e8f1ff]"
                        : "bg-[#fffaf0]")
                    }
                  >
                    <p className="mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                      {m.role === "user" ? "You" : selected?.display_name}
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#1f2a3c]">
                      {m.body}
                      {m.pending && (
                        <span className="ml-1 inline-block h-2 w-2 animate-pulse bg-[#1f2a3c]" />
                      )}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Error notice */}
          {error && (
            <div className="border-t-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
              {error}
            </div>
          )}

          {/* Composer */}
          <div className="flex items-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 sm:px-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                selected
                  ? `Message ${selected.display_name}...`
                  : "Pick an agent first"
              }
              disabled={!selected}
              rows={2}
              className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98] disabled:opacity-50"
            />
            <button
              type="button"
              onClick={send}
              disabled={busy || !draft.trim() || !selected}
              className="border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-2 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
