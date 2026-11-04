"use client";

// Pokemon-style RPG dialog box for in-world agent chat.
//
// Replaces the heavy ChatDrawer with a compact, game-integrated dialog
// anchored to the bottom of the screen. Agent speech also appears as a
// bubble above their sprite in the Phaser canvas — the bubble picks up
// the last message on mount so the agent "greets" you naturally.
//
// Design cues: Pokemon text boxes, Stardew Valley dialog, Undertale.
// Keep it tight — portrait, text, input. No profile/inventory chrome.

import { useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/authClient";
import { wsUrl } from "@/lib/backend";
import { photoForAgent } from "@/lib/profile-photos";
import SpriteFrame from "@/components/SpriteFrame";

type Msg = {
  id: number | string;
  role: "user" | "agent";
  body: string;
  pending?: boolean;
};

type Props = {
  agentId: string;
  agentDisplayName: string;
  canonicalId?: string | null;
  agentSpriteUrl: string;
  agentPortraitUrl?: string | null;
  onClose: () => void;
};

export default function RPGDialog({
  agentId,
  agentDisplayName,
  canonicalId,
  agentSpriteUrl,
  agentPortraitUrl,
  onClose,
}: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const greetedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Slide-in on mount.
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Pull access token.
  useEffect(() => {
    (async () => {
      setToken(getToken());
    })();
  }, []);

  // WebSocket lifecycle — mirrors ChatDrawer's protocol.
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
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      const t = frame.type as string;

      if (t === "chat.history") {
        const incoming = (frame.messages as Msg[]) || [];
        setMessages(incoming);
        // "Pick up" — show last agent message as a speech bubble so it
        // feels like the agent remembers you.
        const lastAgent = [...incoming].reverse().find((m) => m.role === "agent");
        if (lastAgent) {
          dispatchBubble(agentId, firstSentence(lastAgent.body));
        }
        // First encounter — ask the agent to introduce themselves in
        // one short sentence. The prompt is hidden from the UI so the
        // conversation starts clean with just the agent's intro.
        if (incoming.length === 0 && !greetedRef.current) {
          greetedRef.current = true;
          setBusy(true);
          const prompt = "Introduce yourself in one short sentence.";
          ws.send(JSON.stringify({ type: "chat.user_msg", agent_id: agentId, body: prompt }));
        }
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
          if (!last?.pending) return prev;
          return [...prev.slice(0, -1), { ...last, body: (last.body || "") + delta }];
        });
      } else if (t === "chat.agent_done") {
        const fullText = String(frame.full_text || "");
        const messageId = frame.message_id as number;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.pending) {
            return [...prev, { id: messageId, role: "agent", body: fullText }];
          }
          return [...prev.slice(0, -1), { id: messageId, role: "agent", body: fullText }];
        });
        streamingRef.current = false;
        setBusy(false);
        dispatchBubble(agentId, firstSentence(fullText));
        // Machine notification sound — agent replied to you.
        try { new Audio("/sfx/machine-notification.mp3").play(); } catch {}
      } else if (t === "chat.rate_limited") {
        const retry = Number(frame.retry_after_seconds || 0);
        setError(`Rate-limited — try again in ${retry}s`);
        setBusy(false);
        streamingRef.current = false;
      } else if (t === "chat.error") {
        setError(String(frame.message || "chat error"));
        setBusy(false);
        streamingRef.current = false;
      }
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

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-focus the input.
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 150);
  }, []);

  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", body },
    ]);
    setDraft("");
    ws.send(JSON.stringify({ type: "chat.user_msg", agent_id: agentId, body }));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
    // X or Escape closes the dialog (matches Phaser B-button mapping).
    if (e.key === "Escape" || (e.key === "x" && !draft)) {
      e.preventDefault();
      onClose();
      return;
    }
    // Stop Phaser from eating keystrokes while typing.
    e.stopPropagation();
  };

  const photo = photoForAgent(canonicalId ?? null);
  const recent = messages.slice(-8);

  return (
    <div
      className={
        "fixed bottom-3 left-1/2 z-40 w-[min(460px,calc(100vw-1.5rem))] -translate-x-1/2 " +
        "transition-all duration-200 ease-out " +
        (visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0")
      }
    >
      {/* ── Name plate tab ── */}
      <div className="ml-3 inline-block">
        <div
          className={
            "border-[3px] border-b-0 border-[#1f2a3c] bg-[#fffaf0] px-3 py-0.5 " +
            "font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#1f2a3c]"
          }
        >
          {agentDisplayName}
        </div>
      </div>

      {/* ── Dialog box ── */}
      <div className="overflow-hidden border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_rgba(31,42,60,0.18)]">
        {/* Content row: portrait + messages */}
        <div className="flex gap-3 p-3 pb-2">
          {/* Portrait */}
          <div className="flex shrink-0 flex-col items-center">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo}
                alt=""
                className="h-[52px] w-[38px] border-[2px] border-[#1f2a3c] object-cover"
              />
            ) : (
              <div className="flex h-[52px] w-[38px] items-center justify-center border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
                {agentPortraitUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={agentPortraitUrl}
                    alt=""
                    className="max-h-full max-w-full object-contain"
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <SpriteFrame src={agentSpriteUrl} size={1.5} title="" />
                )}
              </div>
            )}
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="min-h-[48px] max-h-[130px] flex-1 overflow-y-auto pr-1"
          >
            {recent.length === 0 ? (
              <p className="pt-1 text-[13px] italic text-[#9a9285]">
                Say hello…
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {recent.map((m) => (
                  <p key={String(m.id)} className="text-[13px] leading-[1.4]">
                    {m.role === "user" ? (
                      <span className="text-[#5b7fa8]">
                        <span className="mr-1 font-mono text-[9px] font-bold uppercase tracking-wide text-[#8a9eb5]">
                          You
                        </span>
                        {m.body}
                      </span>
                    ) : (
                      <span className="text-[#1f2a3c]">
                        {m.body}
                        {m.pending && (
                          <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#1f2a3c] align-middle" />
                        )}
                      </span>
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            className="self-start p-0.5 font-mono text-[10px] text-[#c5bfb4] transition-colors hover:text-[#1f2a3c]"
            title="Close (B)"
          >
            ✕
          </button>
        </div>

        {/* ── Input row ── */}
        <div className="flex items-center gap-2 border-t-[2px] border-[#e8e2d4] bg-[#f6f4ea] px-3 py-1.5">
          <span className="font-mono text-[11px] text-[#c5bfb4]">▸</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="…"
            disabled={busy}
            className="flex-1 bg-transparent text-[13px] text-[#1f2a3c] outline-none placeholder:text-[#c5bfb4] disabled:opacity-50"
          />
          {draft.trim() && !busy && (
            <button
              type="button"
              onClick={send}
              className="font-mono text-[10px] font-bold uppercase tracking-wide text-[#637387] transition-colors hover:text-[#1f2a3c]"
            >
              ▶
            </button>
          )}
          {busy && (
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#637387]" />
          )}
        </div>

        {/* Error notice */}
        {error && (
          <div className="border-t-[2px] border-[#e8e2d4] bg-[#fef0ee] px-3 py-1 font-mono text-[10px] text-[#a04040]">
            {error}
          </div>
        )}
      </div>

      {/* Close hint */}
      <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.16em] text-[rgba(255,250,240,0.35)]">
        B to close
      </p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function dispatchBubble(agentId: string, text: string) {
  if (!text || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("phaser:agent-bubble", {
      detail: { agent_id: agentId, text },
    }),
  );
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  const sentenceBreak = cleaned.search(/[.!?]\s/);
  const candidate =
    sentenceBreak > 0 ? cleaned.slice(0, sentenceBreak + 1) : cleaned;
  return candidate.length > 100 ? candidate.slice(0, 99) + "…" : candidate;
}
