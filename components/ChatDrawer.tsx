"use client";

// Slide-up brutalist chat panel that opens when the user taps an agent
// in Phaser. Owns one WebSocket per session — opens on mount, closes on
// unmount (or when the user closes the drawer). All chat traffic runs
// through the backend's `chat.*` WS envelope; React renders the streamed
// deltas into the active assistant bubble.

import { useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "@/lib/authClient";
import { wsUrl } from "@/lib/backend";
import { photoForAgent } from "@/lib/profile-photos";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import posthog from "posthog-js";
import AgentProfilePanel from "@/components/AgentProfilePanel";
import AgentInventoryPanel from "@/components/AgentInventoryPanel";
import AgentShopDrawer from "@/components/AgentShopDrawer";
import SpriteFrame from "@/components/SpriteFrame";

type Msg = {
  id: number | string;
  role: "user" | "agent";
  body: string;
  created_at?: string;
  pending?: boolean; // true while assistant is streaming
};

type Props = {
  agentId: string;
  agentDisplayName: string;
  canonicalId?: string | null;
  agentSpriteUrl: string;
  /** Two-step pipeline single-image portrait. When set, renders directly
   *  in the header instead of slicing agentSpriteUrl as a sheet. */
  agentPortraitUrl?: string | null;
  onClose: () => void;
  /** Open the sprite sheet viewer for this agent. */
  onSpriteSheet?: () => void;
};

export default function ChatDrawer({
  agentId,
  agentDisplayName,
  canonicalId,
  agentSpriteUrl,
  agentPortraitUrl,
  onClose,
  onSpriteSheet,
}: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [mode, setMode] = useState<"own" | "visit" | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [mobileMore, setMobileMore] = useState(false);
  const isMobile = useIsMobile();
  const [mobileVisible, setMobileVisible] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef<boolean>(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Slide-up animation for mobile.
  useEffect(() => {
    if (isMobile) requestAnimationFrame(() => setMobileVisible(true));
  }, [isMobile]);

  // Pull the access token once on mount.
  useEffect(() => {
    (async () => {
      setToken(getToken());
    })();
  }, []);

  // Open the WebSocket once we have a token + agent.
  useEffect(() => {
    if (!token) return;
    const url = `${wsUrl("/")}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.start", agent_id: agentId }));
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
        const incoming = (frame.messages as Msg[]) || [];
        setMessages(incoming);
        setMode((frame.mode as "own" | "visit") || null);
      } else if (t === "chat.agent_chunk") {
        const delta = String(frame.delta || "");
        setMessages((prev) => {
          if (!streamingRef.current) {
            streamingRef.current = true;
            return [
              ...prev,
              { id: `pending-${Date.now()}`, role: "agent", body: delta, pending: true },
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
        // Pop a speech bubble above the agent's sprite on the map. Use
        // the first sentence (or first line) so it fits the bubble cap.
        const bubble = firstSentence(fullText);
        if (bubble && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("phaser:agent-bubble", {
              detail: { agent_id: agentId, text: bubble },
            }),
          );
        }
        // Machine notification sound — agent replied.
        try { new Audio("/sfx/machine-notification.mp3").play(); } catch {}
      } else if (t === "chat.rate_limited") {
        const retry = Number(frame.retry_after_seconds || 0);
        setRateLimitedUntil(Date.now() + retry * 1000);
        setBusy(false);
        streamingRef.current = false;
      } else if (t === "chat.error") {
        setError(String(frame.message || "chat error"));
        setBusy(false);
        streamingRef.current = false;
      }
    });

    ws.addEventListener("close", () => {
      // Connection dropped — surface as a soft notice; don't auto-reconnect.
      // Closing the drawer triggers this as well.
    });

    return () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      streamingRef.current = false;
    };
  }, [token, agentId]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Tick down rate-limit timer.
  const [, force] = useState(0);
  useEffect(() => {
    if (rateLimitedUntil === null) return;
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [rateLimitedUntil]);

  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection isn't open yet — try again in a sec.");
      return;
    }
    setError(null);
    setBusy(true);
    posthog.capture("agent_chat_message_sent", {
      agent_id: agentId,
      agent_name: agentDisplayName,
      mode,
    });
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", body },
    ]);
    setDraft("");
    ws.send(
      JSON.stringify({ type: "chat.user_msg", agent_id: agentId, body }),
    );
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const rateLimitedRemaining = useMemo(() => {
    if (rateLimitedUntil === null) return 0;
    const sec = Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000));
    if (sec === 0) setRateLimitedUntil(null);
    return sec;
  }, [rateLimitedUntil, busy, draft]);

  // Shared sub-panels (profile, inventory, shop) rendered above either layout.
  const subPanels = (
    <>
      {profileOpen && (
        <AgentProfilePanel
          agentId={agentId}
          fallbackSpriteUrl={agentSpriteUrl}
          onClose={() => setProfileOpen(false)}
          onChat={() => setProfileOpen(false)}
        />
      )}
      {inventoryOpen && (
        <AgentInventoryPanel
          agentId={agentId}
          agentName={agentDisplayName}
          onClose={() => setInventoryOpen(false)}
        />
      )}
      {shopOpen && (
        <AgentShopDrawer
          sellerAgentId={agentId}
          buyerAgentId={agentId}
          onClose={() => setShopOpen(false)}
        />
      )}
    </>
  );

  // Shared message list.
  const messageList = (bubbleClasses: { user: string; agent: string }) => (
    messages.length === 0 ? (
      <p className="font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
        No messages yet — say hi.
      </p>
    ) : (
      <div className="flex flex-col gap-2">
        {messages.map((m) => (
          <div
            key={String(m.id)}
            className={m.role === "user" ? bubbleClasses.user : bubbleClasses.agent}
          >
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#637387]">
              {m.role === "user" ? "You" : agentDisplayName}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-snug">
              {m.body}
              {m.pending && (
                <span className="ml-1 inline-block h-2 w-2 animate-pulse bg-[#1f2a3c]" />
              )}
            </p>
          </div>
        ))}
      </div>
    )
  );

  // Shared notices.
  const notices = (error || rateLimitedRemaining > 0) ? (
    <div className="border-t-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
      {rateLimitedRemaining > 0
        ? `Rate-limited — try again in ${rateLimitedRemaining}s`
        : error}
    </div>
  ) : null;

  // ── Mobile: full-screen chat sheet ──
  if (isMobile) {
    return (
      <>
        {subPanels}
        <div
          className={
            "fixed inset-0 z-50 flex flex-col bg-[#fffaf0] text-[#1f2a3c] transition-transform duration-200 ease-out " +
            (mobileVisible ? "translate-y-0" : "translate-y-full")
          }
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] font-mono text-sm font-bold shadow-[2px_2px_0_#1f2a3c]"
            >
              ✕
            </button>
            <div className="flex h-9 w-7 items-center justify-center border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
              {agentPortraitUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={agentPortraitUrl}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <SpriteFrame src={agentSpriteUrl} size={1} title="" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
                Direct message
              </p>
              <p className="truncate text-[14px] font-bold leading-tight">{agentDisplayName}</p>
            </div>
            {/* Overflow menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMobileMore((v) => !v)}
                className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
              >
                More
              </button>
              {mobileMore && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setMobileMore(false)}
                    className="fixed inset-0 z-10"
                  />
                  <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-1 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-2 shadow-[3px_3px_0_#1f2a3c]">
                    <button
                      type="button"
                      onClick={() => { setMobileMore(false); setProfileOpen(true); }}
                      className="border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-1.5 text-left font-mono text-[10px] font-bold uppercase"
                    >
                      Profile
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMobileMore(false); setInventoryOpen(true); }}
                      className="border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-1.5 text-left font-mono text-[10px] font-bold uppercase"
                    >
                      Items
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Transcript — fills remaining space */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto bg-[#f6f4ea] px-3 py-3">
            {messageList({
              user: "ml-4 self-end border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-2 shadow-[2px_2px_0_#1f2a3c]",
              agent: "mr-4 self-start border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 shadow-[2px_2px_0_#1f2a3c]",
            })}
          </div>

          {notices}

          {/* Composer */}
          <div
            className="flex items-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder={`Message ${agentDisplayName}…`}
              rows={1}
              className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 text-[14px] shadow-[2px_2px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
            />
            <button
              type="button"
              onClick={send}
              disabled={busy || !draft.trim() || rateLimitedRemaining > 0}
              className="flex h-[44px] min-w-[44px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#d6f4d6] font-mono text-xs font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
        </div>
      </>
    );
  }

  // ── Desktop: existing bottom drawer ──
  return (
    <>
    {subPanels}
    <div className="fixed bottom-0 left-1/2 z-40 w-[min(560px,calc(100vw-1rem))] -translate-x-1/2">
      <div className="border-[3px] border-b-0 border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] shadow-[5px_5px_0_#1f2a3c]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
          <div className="flex items-center gap-2">
            {photoForAgent(canonicalId) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoForAgent(canonicalId)!}
                alt=""
                className="h-[78px] w-[54px] border-[3px] border-[#1f2a3c] object-cover shadow-[2px_2px_0_#1f2a3c]"
              />
            )}
            <div className="flex h-16 w-8 items-center justify-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] p-1 shadow-[2px_2px_0_#1f2a3c]">
              {agentPortraitUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={agentPortraitUrl}
                  alt={`${agentDisplayName} pixel portrait`}
                  className="max-h-full max-w-full object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <SpriteFrame
                  src={agentSpriteUrl}
                  size={2}
                  title={`${agentDisplayName} sprite`}
                />
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Direct message {mode === "visit" ? "· Visiting" : ""}
            </p>
            <p className="truncate text-lg font-bold leading-tight">
              {agentDisplayName}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Profile
          </button>
          {onSpriteSheet && (
            <button
              type="button"
              onClick={onSpriteSheet}
              className="border-[3px] border-[#1f2a3c] bg-[#e7f8ef] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Sprite
            </button>
          )}
          <button
            type="button"
            onClick={() => setInventoryOpen(true)}
            className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Items
          </button>
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Close
          </button>
        </div>

        {/* Transcript */}
        <div
          ref={scrollRef}
          className="max-h-[44vh] min-h-[180px] overflow-y-auto bg-[#f6f4ea] px-4 py-3"
        >
          {messageList({
            user: "ml-12 self-end border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-2 shadow-[3px_3px_0_#1f2a3c]",
            agent: "mr-12 self-start border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 shadow-[3px_3px_0_#1f2a3c]",
          })}
        </div>

        {notices}

        {/* Composer */}
        <div className="flex items-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={`Message ${agentDisplayName}…`}
            rows={2}
            className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !draft.trim() || rateLimitedRemaining > 0}
            className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-2 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

/** First sentence (or first line) of a reply, capped at 100 chars for the
 * speech bubble above the agent's sprite. Strips markdown markers so the
 * bubble reads as plain text. */
function firstSentence(text: string): string {
  const cleaned = text
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentenceBreak = cleaned.search(/[.!?]\s/);
  const candidate =
    sentenceBreak > 0 ? cleaned.slice(0, sentenceBreak + 1) : cleaned;
  return candidate.length > 100 ? candidate.slice(0, 99) + "…" : candidate;
}
