"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FloatingChrome from "./FloatingChrome";
import PixelOffice from "./PixelOffice";
import { fetchSession } from "@/lib/authClient";
import { apiGet } from "@/lib/api";

import { wsUrl } from "@/lib/backend";

type Agent = {
  id: string;
  name: string;
  role: string;
  description: string;
  color: string;
};

type ChatItem =
  | { kind: "text"; role: "user" | "agent"; text: string }
  | { kind: "gif" | "image"; url: string; caption?: string }
  | { kind: "file"; url: string; filename: string; caption?: string }
  | {
      kind: "poll";
      question: string;
      options: string[];
      selectableCount: number;
    };

type StoredItem = ChatItem & { ts: number };

// Pixel sprite avatar for the chat drawer. Renders a single 16×32 frame
// (front-facing idle) from the character sheet at 3× scale, keeping the
// pixel-art crispness.
function PixelAvatar({ paletteIndex, size = 3 }: { paletteIndex: number; size?: number }) {
  const w = 16 * size;
  const h = 32 * size;
  // Sheet is 7 cols × 3 rows of 16×32 frames → 112×96 native.
  return (
    <div
      style={{
        width: w,
        height: h,
        backgroundImage: `url(/team-office/characters/char_${paletteIndex}.png)`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "0 0",
        backgroundSize: `${112 * size}px ${96 * size}px`,
        imageRendering: "pixelated",
      }}
      aria-hidden
    />
  );
}

const FALLBACK_AGENTS: Agent[] = [
  { id: "sales",       name: "Robin",   role: "The Sounding Board", description: "", color: "#6366f1" },
  { id: "support",     name: "Joon",   role: "The Storyteller",    description: "", color: "#10b981" },
  { id: "marketing",   name: "Ellis",   role: "The Trend-Spotter",  description: "", color: "#f59e0b" },
  { id: "product",     name: "Nat",    role: "The Explorer",       description: "", color: "#3b82f6" },
  { id: "success",     name: "Sage", role: "The Hype Friend",    description: "", color: "#14b8a6" },
  { id: "engineering", name: "Yuri",   role: "The Artist",         description: "", color: "#ef4444" },
];

// Short bios shown in the drawer as a profile card. Keyed by agent id.
// Non-tech, non-corporate — these are just fun people in the society.
const BIOS: Record<string, { tag: string; bio: string; likes: string[] }> = {
  sales: {
    tag: "The Sounding Board",
    bio: "Consultant turned founder turned investor. Here to be your sounding board, firm believer, advocate, team extension and therapist.",
    likes: [
      "Fitness studios and tennis courts",
      "Ski slopes",
      "Cocktail bars after hours",
    ],
  },
  support: {
    tag: "The Storyteller",
    bio: "Always has a story. Been places, cooked weird things, met strangers on trains. A night owl with a running list of anecdotes.",
    likes: [
      "Swapping travel stories",
      "Food — especially the 'what's in the fridge' game",
      "Random anecdotes and obscure histories",
    ],
  },
  marketing: {
    tag: "The Trend-Spotter",
    bio: "Watches what's bubbling up online before it hits. Music, film, internet moments, small corners of culture.",
    likes: [
      "What's genuinely having a moment",
      "Taste recs — music, podcasts, indie films",
      "Gut-checks on creative ideas",
    ],
  },
  product: {
    tag: "The Explorer",
    bio: "The friend who gets lost in a rabbit hole by midnight. Curious about ideas, people, psychology, history.",
    likes: [
      "Thinking out loud about something stuck",
      "Asking the question you haven't asked yourself",
      "Big-picture 'why do we do what we do?'",
    ],
  },
  success: {
    tag: "The Hype Friend",
    bio: "Big energy, genuinely believes in you. Will hype you up AND keep you honest. Runs on coffee and 5am alarms.",
    likes: [
      "Turning 'I want to' into a first step today",
      "Building a habit that actually sticks",
      "Finding what's really blocking you",
    ],
  },
  engineering: {
    tag: "The Artist",
    bio: "Always midway through a little creative project. Paints, shoots film, makes playlists that tell stories, collects ticket stubs.",
    likes: [
      "Talking about something you're making",
      "Film, photography, indie music recs",
      "Unsticking a creative block",
    ],
  },
};

const VISITOR_KEY = "crowdsource-intelligence-visitor";

function messagesKey(agentId: string) {
  return `crowdsource-intelligence-messages-${agentId}`;
}

function resolveVisitorId(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("s");
  if (fromUrl && /^[a-zA-Z0-9_-]{8,64}$/.test(fromUrl)) {
    localStorage.setItem(VISITOR_KEY, fromUrl);
    return fromUrl;
  }
  const fromStorage = localStorage.getItem(VISITOR_KEY);
  if (fromStorage) return fromStorage;
  const fresh = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  localStorage.setItem(VISITOR_KEY, fresh);
  return fresh;
}

function syncVisitorIdToUrl(id: string) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("s") === id) return;
  params.set("s", id);
  const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, "", newUrl);
}

function loadStoredItems(agentId: string): StoredItem[] {
  try {
    const raw = localStorage.getItem(messagesKey(agentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return parsed.filter(
      (m): m is StoredItem =>
        m &&
        typeof m === "object" &&
        typeof (m as StoredItem).ts === "number" &&
        (m as StoredItem).ts > weekAgo &&
        typeof (m as StoredItem).kind === "string",
    );
  } catch {
    return [];
  }
}

function saveStoredItem(agentId: string, item: ChatItem) {
  const existing = loadStoredItems(agentId);
  existing.push({ ...item, ts: Date.now() });
  localStorage.setItem(messagesKey(agentId), JSON.stringify(existing.slice(-100)));
}

type Viewer = {
  sessionId: string;
  displayName: string;
  bio?: string;
};

export default function TeamChat({ backendHost }: { backendHost: string }) {
  const [agents, setAgents] = useState<Agent[]>(FALLBACK_AGENTS);
  const [currentAgent, setCurrentAgent] = useState<Agent | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"offline" | "connecting" | "online">("offline");
  const [typing, setTyping] = useState(false);
  const viewerRef = useRef<Viewer | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const agentRef = useRef<Agent | null>(null);

  // Palette index per agent — matches the engine's i%6 assignment.
  const paletteFor = useCallback(
    (agentId: string) => {
      const idx = agents.findIndex((a) => a.id === agentId);
      return (idx < 0 ? 0 : idx) % 6;
    },
    [agents],
  );

  useEffect(() => {
    const id = resolveVisitorId();
    syncVisitorIdToUrl(id);
  }, []);

  // Load Supabase viewer + profile once. If signed in, we'll prefer their
  // auth.uid() as the chat session id and pass display_name/bio into the
  // agent's system prompt via the WS connect frame.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await fetchSession();
        if (cancelled || !auth) return;
        const me = await apiGet<{
          profile: { display_name: string | null; bio: string | null } | null;
        }>("/api/me");
        const displayName =
          me.profile?.display_name?.trim() || auth.email?.split("@")[0] || "friend";
        const bio = me.profile?.bio?.trim() || undefined;
        if (cancelled) return;
        const v: Viewer = { sessionId: auth.id, displayName, bio };
        viewerRef.current = v;
        syncVisitorIdToUrl(v.sessionId);
      } catch {
        /* stay anonymous on error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`https://${backendHost}/api/agents`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { agents: Agent[] };
        if (cancelled) return;
        if (data.agents?.length) setAgents(data.agents);
      } catch {
        /* stay on fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendHost]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [items, typing, scrollToBottom]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    setStatus("offline");
  }, []);

  const connect = useCallback(
    (agent: Agent) => {
      if (typeof window === "undefined") return;
      const existing = wsRef.current;
      if (existing) {
        const state = existing.readyState;
        if (state === WebSocket.CONNECTING || state === WebSocket.OPEN) return;
      }
      setStatus("connecting");
      const v = viewerRef.current;
      const sessionId = v?.sessionId || resolveVisitorId();
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = 1000;
        const connectFrame: {
          type: "connect";
          agentId: string;
          sessionId: string;
          profile?: { displayName: string; bio?: string };
        } = { type: "connect", agentId: agent.id, sessionId };
        if (v) {
          connectFrame.profile = v.bio
            ? { displayName: v.displayName, bio: v.bio }
            : { displayName: v.displayName };
        }
        ws.send(JSON.stringify(connectFrame));
      };

      ws.onmessage = (event) => {
        let data: {
          type: string;
          text?: string;
          isTyping?: boolean;
          question?: string;
          options?: string[];
          selectableCount?: number;
          url?: string;
          caption?: string;
          filename?: string;
          message?: string;
        };
        try { data = JSON.parse(event.data); } catch { return; }

        switch (data.type) {
          case "connected":
            setStatus("online");
            break;
          case "message":
            if (typeof data.text === "string") {
              const item: ChatItem = { kind: "text", role: "agent", text: data.text };
              setItems((prev) => [...prev, item]);
              const current = agentRef.current;
              if (current) saveStoredItem(current.id, item);
            }
            setTyping(false);
            break;
          case "typing":
            setTyping(Boolean(data.isTyping));
            break;
          case "poll":
            if (data.question && Array.isArray(data.options)) {
              const item: ChatItem = {
                kind: "poll",
                question: data.question,
                options: data.options,
                selectableCount: data.selectableCount ?? 1,
              };
              setItems((prev) => [...prev, item]);
              const current = agentRef.current;
              if (current) saveStoredItem(current.id, item);
            }
            setTyping(false);
            break;
          case "gif":
          case "image":
            if (data.url) {
              const item: ChatItem = {
                kind: data.type === "gif" ? "gif" : "image",
                url: data.url,
                caption: data.caption,
              };
              setItems((prev) => [...prev, item]);
              const current = agentRef.current;
              if (current) saveStoredItem(current.id, item);
            }
            setTyping(false);
            break;
          case "file":
            if (data.url) {
              const item: ChatItem = {
                kind: "file",
                url: data.url,
                filename: data.filename || "file",
                caption: data.caption,
              };
              setItems((prev) => [...prev, item]);
              const current = agentRef.current;
              if (current) saveStoredItem(current.id, item);
            }
            setTyping(false);
            break;
          case "error":
            console.error("Chat server error:", data.message);
            break;
        }
      };

      ws.onclose = () => {
        setStatus("offline");
        if (!agentRef.current) return;
        reconnectTimerRef.current = setTimeout(() => {
          if (agentRef.current) connect(agentRef.current);
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 16000);
        }, reconnectDelayRef.current);
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };
    },
    [backendHost],
  );

  const openChat = useCallback(
    (agent: Agent) => {
      const prev = agentRef.current;
      if (prev && prev.id !== agent.id) disconnect();
      agentRef.current = agent;
      setCurrentAgent(agent);

      const stored = loadStoredItems(agent.id);
      setItems(stored.map(({ ts: _ts, ...rest }) => rest as ChatItem));

      const sessionId = viewerRef.current?.sessionId || resolveVisitorId();
      fetch(
        `https://${backendHost}/api/chat-history?agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`,
        { cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.items)) return;
          if (agentRef.current?.id !== agent.id) return;
          const rehydrated: ChatItem[] = data.items.map(
            ({ ts: _ts, ...rest }: { ts: number } & ChatItem) => rest as ChatItem,
          );
          setItems((local) =>
            rehydrated.length >= local.length ? rehydrated : local,
          );
        })
        .catch(() => { /* stay on localStorage view */ });

      connect(agent);
    },
    [backendHost, connect, disconnect],
  );

  const closeChat = useCallback(() => {
    agentRef.current = null;
    disconnect();
    setCurrentAgent(null);
    setItems([]);
    setTyping(false);
  }, [disconnect]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!agentRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "message", text }));
    const item: ChatItem = { kind: "text", role: "user", text };
    setItems((prev) => [...prev, item]);
    saveStoredItem(agentRef.current.id, item);
    setInput("");
  }, [input]);

  useEffect(() => () => disconnect(), [disconnect]);

  const statusLabel = useMemo(
    () => (status === "online" ? "Online" : status === "connecting" ? "Connecting…" : "Offline"),
    [status],
  );

  return (
    <>
      <PixelOffice agents={agents} onAgentClick={openChat} />
      <FloatingChrome />

      {/* Tiny fixed-corner credit (MIT requires the notice; kept unobtrusive) */}
      <div className="pointer-events-auto fixed right-2 bottom-2 z-30 text-[10px] leading-tight text-white/60">
        <a
          className="underline decoration-white/30 underline-offset-2 hover:text-white"
          href="https://jik-a-4.itch.io/metrocity-free-topdown-character-pack"
          target="_blank"
          rel="noopener noreferrer"
        >
          JIK-A-4 · Metro City
        </a>
        {" · "}
        <a
          className="underline decoration-white/30 underline-offset-2 hover:text-white"
          href="https://github.com/pablodelucca/pixel-agents"
          target="_blank"
          rel="noopener noreferrer"
        >
          pixel-agents (MIT)
        </a>
      </div>

      {currentAgent && (
        <>
          <button
            type="button"
            aria-label="Close chat"
            onClick={closeChat}
            className="fixed inset-0 z-40 bg-black/25"
          />
          <aside className="fixed inset-y-3 right-3 z-50 flex w-[calc(100%-1.5rem)] max-w-md flex-col border-[3px] border-[#1f2a3c] bg-[#f6f4ea]/92 text-[#1f2a3c] shadow-[-5px_0_0_#1f2a3c] backdrop-blur-md sm:inset-y-4 sm:right-4 sm:w-[calc(100%-2rem)]">
            {/* Slim top bar — status + close. Main profile is below. */}
            <header className="flex items-center justify-between border-[#1f2a3c] border-b-[3px] bg-[#e9e2cf] px-4 py-2.5">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider">
                <span
                  className={`inline-block h-2 w-2 ${
                    status === "online" ? "bg-green-600" : status === "connecting" ? "bg-amber-500" : "bg-neutral-500"
                  }`}
                />
                {statusLabel}
              </div>
              <button
                type="button"
                onClick={closeChat}
                className="flex h-8 w-8 shrink-0 items-center justify-center border-[3px] border-[#1f2a3c] bg-[#fffaf0] font-mono font-bold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c]"
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
              {/* Hero profile card — big centered avatar, name, tag, bio, likes */}
              <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[5px_5px_0_#1f2a3c]">
                <div className="flex flex-col items-center gap-3 border-[#1f2a3c] border-b-[3px] border-dashed bg-[#dcecf4] px-4 pt-6 pb-4">
                  <div className="flex h-[104px] w-[72px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]">
                    <PixelAvatar paletteIndex={paletteFor(currentAgent.id)} size={3} />
                  </div>
                  <div className="text-center">
                    <div className="font-bold text-[26px] leading-tight">{currentAgent.name}</div>
                    {BIOS[currentAgent.id] && (
                      <div className="mt-1.5 inline-block bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                        {BIOS[currentAgent.id].tag}
                      </div>
                    )}
                  </div>
                </div>

                {BIOS[currentAgent.id] && (
                  <div className="space-y-4 p-4">
                    <p className="text-[14px] leading-relaxed">{BIOS[currentAgent.id].bio}</p>

                    <div>
                      <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#4f5c6d]">
                        Good for
                      </div>
                      <ul className="space-y-2 font-mono text-[12px] leading-snug">
                        {BIOS[currentAgent.id].likes.map((l, i) => (
                          <li key={i} className="flex items-start gap-2.5">
                            <span className="mt-[3px] inline-block h-2.5 w-2.5 shrink-0 border-[2px] border-[#1f2a3c] bg-[#e8f1ff]" />
                            <span>{l}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {items.length === 0 && (
                      <div className="border-[3px] border-dashed border-[#9fb0bf] bg-[#f6f4ea] px-3 py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-[#4f5c6d]">
                        Say hi to {currentAgent.name} ↓
                      </div>
                    )}
                  </div>
                )}
              </div>

              {items.map((item, i) => {
                if (item.kind === "text") {
                  const isUser = item.role === "user";
                  return (
                    <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] whitespace-pre-wrap break-words border-[3px] border-[#1f2a3c] px-3.5 py-2 text-sm leading-relaxed shadow-[3px_3px_0_#1f2a3c] ${
                          isUser ? "bg-[#e8f1ff]" : "bg-[#fffaf0]"
                        }`}
                      >
                        {item.text}
                      </div>
                    </div>
                  );
                }
                if (item.kind === "gif" || item.kind === "image") {
                  const isVideo = item.kind === "gif" && /\.(mp4|webm|mov)(\?|$)/i.test(item.url);
                  return (
                    <div key={i} className="flex justify-start">
                      <div className="max-w-[85%] overflow-hidden border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]">
                        {isVideo ? (
                          <video src={item.url} autoPlay loop muted playsInline className="block w-full" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.url} alt={item.caption || ""} className="block w-full" />
                        )}
                        {item.caption && (
                          <div className="border-[#1f2a3c] border-t-[3px] border-dashed px-3 py-2 text-[11px] text-[#4f5c6d]">
                            {item.caption}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                if (item.kind === "file") {
                  return (
                    <div key={i} className="flex justify-start">
                      <a
                        href={item.url}
                        download={item.filename}
                        className="flex max-w-[85%] items-center gap-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3.5 py-2.5 text-sm shadow-[3px_3px_0_#1f2a3c] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c]"
                      >
                        <span className="font-mono text-[11px] font-bold uppercase tracking-wider">↓</span>
                        <div className="min-w-0">
                          <div className="truncate font-bold">{item.filename}</div>
                          {item.caption && <div className="truncate text-[11px] text-[#4f5c6d]">{item.caption}</div>}
                        </div>
                      </a>
                    </div>
                  );
                }
                if (item.kind === "poll") {
                  return (
                    <div key={i} className="flex justify-start">
                      <div className="max-w-[90%] border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3 text-sm shadow-[3px_3px_0_#1f2a3c]">
                        <div className="mb-2 font-bold">{item.question}</div>
                        <ul className="space-y-1.5 font-mono text-[12px]">
                          {item.options.map((opt, j) => (
                            <li key={j} className="border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-2.5 py-1.5">
                              {opt}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  );
                }
                return null;
              })}

              {typing && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1 border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3.5 py-2.5 shadow-[3px_3px_0_#1f2a3c]">
                    <span className="h-1.5 w-1.5 animate-pulse bg-[#1f2a3c] [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-pulse bg-[#1f2a3c] [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-pulse bg-[#1f2a3c]" />
                  </div>
                </div>
              )}
            </div>

            <footer className="border-[#1f2a3c] border-t-[3px] bg-[#e9e2cf] p-3">
              <form
                onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                className="flex items-end gap-2"
              >
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  rows={1}
                  placeholder={status === "online" ? "Type a message…" : "Connecting…"}
                  disabled={status !== "online"}
                  className="max-h-32 min-h-[2.5rem] flex-1 resize-none border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 text-sm font-semibold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98] disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || status !== "online"}
                  className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1f2a3c] bg-[#e8f1ff] font-mono font-bold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea] disabled:opacity-60"
                  aria-label="Send"
                >
                  →
                </button>
              </form>
            </footer>
          </aside>
        </>
      )}
    </>
  );
}
